/**
 * Paired-only sync client (ARCHITECTURE §3.6, research 07 §6/§9.4, 09 §1.11): device-token auth, version polling
 * with conditional GETs, debounced op pushes (<= 12 per day), 412 merge-and-retry, event uploads (<= 6 batches per
 * day, hourly or at 200 buffered events), revoked/paused/offline states and chrome.alarms scheduling.
 *
 * The web-app origin is compiled in (`__JAMMARLY_APP_ORIGIN__`); when empty, pairing is unavailable.
 */
import type { ApiErrorCode, EventsUploadRequest, EventsUploadResponse, PairRedeemRequest, PairRedeemResponse, ProfileGetResponse, ProfileOpsRequest, ProfileOpsResponse, ProfilePutConflict, ProfileVersionResponse } from '@jammarly/shared/api';
import type { FeedbackEvent, VoiceSample } from '@jammarly/shared/learning';
import type { ProfileDocument, ProfileOp } from '@jammarly/shared/profile';
import type { SyncState } from '@jammarly/shared/types';
import type { DeviceClock } from '../clock';
import { applyOps, mergeDocuments } from '../shared-engine';
import type { Store, SyncMeta } from '../storage';
import { DEFAULT_SYNC_META, DEFAULT_SYNC_STATE } from '../storage';
import { debounce, isRecord, localDate } from '../util';

export const ALARM_SYNC = 'jammarly-sync';
export const ALARM_EVENTS = 'jammarly-events';
export const ALARM_SWEEP = 'jammarly-dismissal-sweep';
export const SYNC_ACTIVE_MINUTES = 5;
export const SYNC_IDLE_MINUTES = 15;
export const EVENTS_MINUTES = 60;
export const SWEEP_MINUTES = 24 * 60;
export const PUSH_DELAY_MS = 2000;
export const MAX_PUSHES_PER_DAY = 12;
export const MAX_EVENT_UPLOADS_PER_DAY = 6;
export const EVENT_FLUSH_THRESHOLD = 200;
export const EVENT_BATCH_MAX = 500;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

export class SyncHttpError extends Error {
  override readonly name = 'SyncHttpError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class SyncNetworkError extends Error {
  override readonly name = 'SyncNetworkError';
}

function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict_retry';
    case 412:
      return 'precondition_failed';
    case 429:
      return 'rate_limited';
    default:
      return 'internal';
  }
}

export interface FetchJsonResult<T> {
  status: number;
  body: T | null;
  etag: string | null;
}

export interface AlarmsLike {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void> | void;
  clear(name: string): Promise<boolean> | void;
  get?(name: string): Promise<{ name: string; periodInMinutes?: number } | undefined> | void;
}

export interface SyncDeps {
  store: Store;
  clock: DeviceClock;
  appOrigin: string;
  fetchImpl?: typeof fetch;
  alarms?: AlarmsLike;
  now?: () => number;
  extVersion: string;
  platform: () => Promise<string>;
  userAgent?: string;
  /** Called after the local profile was replaced by a merge (poll, push, redeem). */
  onProfileReplaced?: (profile: ProfileDocument) => void | Promise<void>;
  onStateChanged?: (sync: SyncState) => void;
  /** Whether a content port is connected (5-minute cadence) or not (15). */
  contentActive?: () => boolean;
}

export interface SyncClient {
  isPaired(): boolean;
  /** Pairing is only possible when the build compiled a web-app origin. */
  available(): boolean;
  state(): SyncState | null;
  redeem(pairingId: string, code: string): Promise<{ deviceId: string; appOrigin: string }>;
  pollVersion(): Promise<void>;
  /** Appends ops to the pending queue and schedules a coalesced push 2 s later. */
  queuePush(ops: readonly ProfileOp[]): void;
  pushOps(): Promise<void>;
  uploadEvents(force?: boolean): Promise<void>;
  /** Flushes when the buffer crossed the threshold. */
  notifyEventsBuffered(): void;
  unpair(): Promise<void>;
  syncNow(): Promise<void>;
  handleAlarm(name: string): Promise<void>;
  ensureAlarms(): Promise<void>;
  /** Re-schedules the poll alarm when the content-port activity changes. */
  setActive(active: boolean): Promise<void>;
  /** Waits for a scheduled push (tests). */
  flushPush(): Promise<void>;
}

/** Short device name from a user-agent string ("Chrome on macOS"). */
export function deviceNameFrom(userAgent: string, platform: string): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = platform === 'mac' ? 'macOS' : platform === 'win' ? 'Windows' : platform === 'linux' ? 'Linux' : platform === 'cros' ? 'ChromeOS' : platform === 'android' ? 'Android' : platform || 'unknown';
  return `${browser} on ${os}`;
}

export function createSyncClient(deps: SyncDeps): SyncClient {
  const { store, clock } = deps;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const origin = deps.appOrigin.replace(/\/+$/, '');

  const settings = () => store.local.get('settings');
  const sync = () => store.local.get('sync');
  const meta = () => store.local.get('syncMeta');
  const isPaired = (): boolean => settings().pairing !== null;

  const setSync = async (patch: Partial<SyncState>): Promise<void> => {
    const next = { ...sync(), ...patch };
    await store.local.set('sync', next);
    deps.onStateChanged?.(next);
  };
  const setMeta = (patch: Partial<SyncMeta>): Promise<void> => store.local.patch('syncMeta', patch);

  const today = (): string => localDate(now());

  async function fetchJson<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}): Promise<FetchJsonResult<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.auth !== false) {
      const token = settings().pairing?.token;
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal });
    } catch (err) {
      throw new SyncNetworkError(err instanceof Error ? err.message : 'network error');
    } finally {
      clearTimeout(timer);
    }
    const etag = res.headers.get('ETag') ?? res.headers.get('etag');
    if (res.status === 304) return { status: 304, body: null, etag };
    let body: unknown = null;
    const text = await res.text().catch(() => '');
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? (body.error.code as ApiErrorCode) : codeForStatus(res.status);
      const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : `HTTP ${res.status}`;
      throw new SyncHttpError(res.status, code, message, body);
    }
    return { status: res.status, body: body as T, etag };
  }

  /** Maps a failed request onto the sync status; returns true when the caller should stop retrying. */
  async function handleFailure(err: unknown): Promise<void> {
    if (err instanceof SyncHttpError) {
      if (err.status === 401 || err.code === 'unauthorized' || err.code === 'device_revoked') {
        await setSync({ status: 'revoked' });
        await setMeta({ lastError: err.code });
        return;
      }
      if (err.code === 'quota_exceeded' || err.code === 'rate_limited') {
        const until = new Date(now());
        until.setHours(24, 0, 0, 0);
        await setSync({ status: 'paused' });
        await setMeta({ pausedUntil: until.toISOString(), lastError: err.code });
        return;
      }
      await setMeta({ lastError: err.code });
      return;
    }
    const m = meta();
    const backoff = Math.min(MAX_BACKOFF_MS, m.backoffMs > 0 ? m.backoffMs * 2 : 30_000);
    await setSync({ status: 'offline' });
    await setMeta({ backoffMs: backoff, lastError: 'network' });
  }

  function paused(): boolean {
    const m = meta();
    if (m.pausedUntil === null) return false;
    if (Date.parse(m.pausedUntil) <= now()) return false;
    return true;
  }

  async function recovered(): Promise<void> {
    const s = sync();
    const m = meta();
    if (s.status !== 'ok' || m.backoffMs !== 0 || m.pausedUntil !== null || m.lastError !== null) {
      if (s.status !== 'revoked') await setSync({ status: 'ok' });
      await setMeta({ backoffMs: 0, pausedUntil: null, lastError: null });
    }
  }

  /** Replaces the local profile with merge(local, remote) and re-applies pending local ops. */
  async function adoptRemote(remote: ProfileDocument, etag: string | null, version: number): Promise<void> {
    const local = store.local.get('profile');
    let merged = mergeDocuments(local, remote);
    const pending = sync().pendingOps;
    if (pending.length > 0) merged = applyOps(merged, pending).doc;
    merged = { ...merged, version: Math.max(merged.version, version) };
    clock.receiveProfile(merged);
    await store.local.set('profile', merged);
    await setSync({ etag: etag ?? sync().etag, version, lastPollAt: new Date(now()).toISOString() });
    await deps.onProfileReplaced?.(merged);
  }

  let pushing: Promise<void> | null = null;
  function doPush(): Promise<void> {
    if (pushing) return pushing;
    pushing = doPushOnce().finally(() => {
      pushing = null;
    });
    return pushing;
  }

  async function doPushOnce(): Promise<void> {
    if (!isPaired() || paused()) return;
    const s = sync();
    if (s.status === 'revoked') return;
    const ops = s.pendingOps;
    if (ops.length === 0) return;
    const m = meta();
    const day = today();
    const pushesToday = m.pushDay === day ? m.pushesToday : 0;
    if (pushesToday >= MAX_PUSHES_PER_DAY) return; // keep queueing; the next poll pushes
    await setMeta({ pushDay: day, pushesToday: pushesToday + 1 });
    const request: ProfileOpsRequest = { baseVersion: s.version, ops };
    try {
      let res: FetchJsonResult<ProfileOpsResponse>;
      try {
        res = await fetchJson<ProfileOpsResponse>('/api/profile/ops', { method: 'POST', body: request });
      } catch (err) {
        if (err instanceof SyncHttpError && err.status === 412 && isRecord(err.body) && isRecord(err.body.current)) {
          const current = (err.body as unknown as ProfilePutConflict).current;
          await adoptRemote(current.profile, current.etag, current.version);
          res = await fetchJson<ProfileOpsResponse>('/api/profile/ops', { method: 'POST', body: { baseVersion: current.version, ops } });
        } else {
          throw err;
        }
      }
      const body = res.body;
      // Clear the acknowledged ops first so the merge does not re-apply them.
      const remaining = sync().pendingOps.filter((op) => !ops.includes(op));
      await setSync({ pendingOps: remaining, lastPushAt: new Date(now()).toISOString() });
      if (body) await adoptRemote(body.profile, body.etag ?? res.etag, body.version);
      await recovered();
    } catch (err) {
      await handleFailure(err);
    }
  }

  const pushTimer = debounce(() => {
    void doPush();
  }, PUSH_DELAY_MS);

  async function periodFor(): Promise<number> {
    return deps.contentActive?.() ? SYNC_ACTIVE_MINUTES : SYNC_IDLE_MINUTES;
  }

  const api: SyncClient = {
    isPaired,
    available: () => origin.length > 0,
    state: () => (isPaired() ? sync() : null),

    async redeem(pairingId, code) {
      if (origin.length === 0) throw new SyncHttpError(0, 'not_found', 'Pairing is not available in this build.', null);
      const platform = await deps.platform().catch(() => 'unknown');
      const body: PairRedeemRequest = { pairingId, code, device: { name: deviceNameFrom(deps.userAgent ?? '', platform), platform, extVersion: deps.extVersion } };
      const res = await fetchJson<PairRedeemResponse>('/api/devices/pair/redeem', { method: 'POST', body, auth: false });
      const data = res.body;
      if (!data || typeof data.token !== 'string' || typeof data.deviceId !== 'string') throw new SyncHttpError(res.status, 'internal', 'Malformed pairing response', data);
      const current = settings();
      await store.local.set('settings', { ...current, pairing: { appOrigin: origin, deviceId: data.deviceId, token: data.token, pairedAt: new Date(now()).toISOString() } });
      const device = store.local.get('device');
      await store.local.set('device', { deviceId: data.deviceId, name: body.device.name, platform, createdAt: device?.createdAt ?? new Date(now()).toISOString() });
      await setSync({ ...DEFAULT_SYNC_STATE, pendingOps: sync().pendingOps, status: 'ok' });
      await setMeta({ ...DEFAULT_SYNC_META });
      await adoptRemote(data.profile, data.etag ?? res.etag, data.version);
      await api.ensureAlarms();
      if (sync().pendingOps.length > 0) pushTimer.call();
      return { deviceId: data.deviceId, appOrigin: origin };
    },

    async pollVersion() {
      if (!isPaired() || paused()) return;
      if (sync().status === 'revoked') return;
      try {
        const v = await fetchJson<ProfileVersionResponse>('/api/profile/version');
        const s = sync();
        const remoteVersion = v.body?.version ?? -1;
        const remoteEtag = v.body?.etag ?? '';
        if (remoteVersion !== s.version || (remoteEtag.length > 0 && remoteEtag !== s.etag)) {
          const headers: Record<string, string> = {};
          if (s.etag.length > 0) headers['If-None-Match'] = s.etag;
          const full = await fetchJson<ProfileGetResponse>('/api/profile', { headers });
          if (full.status !== 304 && full.body) {
            await adoptRemote(full.body.profile, full.body.etag ?? full.etag, full.body.version);
          } else {
            await setSync({ lastPollAt: new Date(now()).toISOString(), version: remoteVersion >= 0 ? remoteVersion : s.version });
          }
        } else {
          await setSync({ lastPollAt: new Date(now()).toISOString() });
        }
        await recovered();
        if (sync().pendingOps.length > 0) await doPush();
      } catch (err) {
        await handleFailure(err);
      }
    },

    queuePush(ops) {
      if (ops.length === 0) return;
      const s = sync();
      void store.local.set('sync', { ...s, pendingOps: [...s.pendingOps, ...ops] });
      if (isPaired()) pushTimer.call();
    },

    pushOps: doPush,

    async uploadEvents(force = false) {
      if (!isPaired() || paused() || sync().status === 'revoked') return;
      const events = store.local.get('eventBuffer');
      const samples = store.local.get('sampleBuffer');
      if (events.length === 0 && samples.length === 0) return;
      const m = meta();
      const day = today();
      const uploadsToday = m.uploadDay === day ? m.uploadsToday : 0;
      if (uploadsToday >= MAX_EVENT_UPLOADS_PER_DAY && !force) return;
      const batch = events.slice(0, EVENT_BATCH_MAX);
      const sampleBatch = samples.slice(0, EVENT_BATCH_MAX);
      const profile = store.local.get('profile');
      const storeSnippets = profile.settings.privacy.value.storeSnippets && profile.settings.privacy.value.learningEnabled;
      const strip = (e: FeedbackEvent): FeedbackEvent => {
        if (storeSnippets) return e;
        const { original: _o, replacement: _r, final: _f, sentence: _s, ...rest } = e;
        return rest;
      };
      const body: EventsUploadRequest = { events: batch.map(strip) };
      if (storeSnippets && sampleBatch.length > 0) body.samples = sampleBatch as VoiceSample[];
      await setMeta({ uploadDay: day, uploadsToday: uploadsToday + 1 });
      try {
        await fetchJson<EventsUploadResponse>('/api/events', { method: 'POST', body });
        const ids = new Set(batch.map((e) => e.eventId));
        await store.local.set('eventBuffer', store.local.get('eventBuffer').filter((e) => !ids.has(e.eventId)));
        if (sampleBatch.length > 0 || !storeSnippets) {
          await store.local.set('sampleBuffer', storeSnippets ? store.local.get('sampleBuffer').slice(sampleBatch.length) : []);
        }
        await setSync({ lastEventUploadAt: new Date(now()).toISOString(), eventUploadsToday: uploadsToday + 1 });
        await recovered();
      } catch (err) {
        await handleFailure(err);
      }
    },

    notifyEventsBuffered() {
      if (isPaired() && store.local.get('eventBuffer').length >= EVENT_FLUSH_THRESHOLD) void api.uploadEvents();
    },

    async unpair() {
      pushTimer.cancel();
      const current = settings();
      await store.local.set('settings', { ...current, pairing: null });
      await setSync({ ...DEFAULT_SYNC_STATE, pendingOps: [] });
      await setMeta({ ...DEFAULT_SYNC_META });
      await deps.alarms?.clear(ALARM_SYNC);
      await deps.alarms?.clear(ALARM_EVENTS);
    },

    async syncNow() {
      if (!isPaired()) return;
      await setMeta({ pausedUntil: null, backoffMs: 0 });
      if (sync().status === 'paused' || sync().status === 'offline') await setSync({ status: 'ok' });
      pushTimer.cancel();
      await api.pollVersion();
      await api.uploadEvents();
    },

    async handleAlarm(name) {
      if (name === ALARM_SYNC) await api.pollVersion();
      else if (name === ALARM_EVENTS) await api.uploadEvents();
    },

    async ensureAlarms() {
      if (!deps.alarms) return;
      await deps.alarms.create(ALARM_SWEEP, { periodInMinutes: SWEEP_MINUTES, delayInMinutes: 1 });
      if (!isPaired()) {
        await deps.alarms.clear(ALARM_SYNC);
        await deps.alarms.clear(ALARM_EVENTS);
        return;
      }
      await deps.alarms.create(ALARM_SYNC, { periodInMinutes: await periodFor(), delayInMinutes: 1 });
      await deps.alarms.create(ALARM_EVENTS, { periodInMinutes: EVENTS_MINUTES, delayInMinutes: EVENTS_MINUTES });
    },

    async setActive(active) {
      if (!deps.alarms || !isPaired()) return;
      const wanted = active ? SYNC_ACTIVE_MINUTES : SYNC_IDLE_MINUTES;
      const existing = deps.alarms.get ? await deps.alarms.get(ALARM_SYNC) : undefined;
      if (existing && existing.periodInMinutes === wanted) return;
      await deps.alarms.create(ALARM_SYNC, { periodInMinutes: wanted, delayInMinutes: wanted });
    },

    async flushPush() {
      pushTimer.cancel();
      await doPush();
    },
  };
  return api;
}
