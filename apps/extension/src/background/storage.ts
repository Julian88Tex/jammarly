/**
 * Typed, write-through-cached access to chrome.storage.local and chrome.storage.session for the service worker
 * (ARCHITECTURE §3.6). The worker is the only reader/writer; content scripts receive EffectiveConfig over the port.
 *
 * Every key has a normalizer that merges stored data over its defaults (unknown keys tolerated, wrong shapes
 * dropped), so a half-written or foreign value can never break startup. `chrome.storage.local.setAccessLevel`
 * is feature-detected (Chrome 140+) so the API key is not readable from page renderers on new Chromes.
 */
import type { CachedSuggestion, CheckPass, DeviceSettings, SyncState, TokenUsage } from '@jammarly/shared/types';
import { DEFAULT_DEVICE_SETTINGS } from '@jammarly/shared/types';
import type { ProfileDocument } from '@jammarly/shared/profile';
import type { FeedbackEvent, VoiceSample } from '@jammarly/shared/learning';
import { defaultProfile, isHlc, migrateProfile, ZERO_HLC } from './shared-engine';
import { isRecord } from './util';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  deviceId: string;
  name: string;
  platform: string;
  createdAt: string;
}

export interface DismissalEntry {
  fingerprint: string;
  rule: string;
  /** ISO time of the dismissal; entries older than DISMISSAL_TTL_MS are swept. */
  at: string;
}

export interface UsageBucket extends TokenUsage {
  requests: number;
}

export interface UsageLedger {
  /** Local date "YYYY-MM-DD" -> totals. */
  days: Record<string, UsageBucket>;
  /** Local month "YYYY-MM" -> totals. */
  months: Record<string, UsageBucket>;
}

/** Sync bookkeeping the SyncState contract has no room for. */
export interface SyncMeta {
  pushDay: string;
  pushesToday: number;
  uploadDay: string;
  uploadsToday: number;
  /** ISO time until which sync is paused after quota_exceeded; null when not paused. */
  pausedUntil: string | null;
  /** Current offline backoff in ms (doubles per failure, capped). */
  backoffMs: number;
  lastError: string | null;
}

export interface LocalSchema {
  settings: DeviceSettings;
  profile: ProfileDocument;
  sync: SyncState;
  device: DeviceRecord | null;
  learningShadow: ProfileDocument['learning'];
  /** docKey -> dismissed fingerprints (30-day TTL). */
  dismissals: Record<string, DismissalEntry[]>;
  usage: UsageLedger;
  eventBuffer: FeedbackEvent[];
  sampleBuffer: VoiceSample[];
  /** Last HLC issued by this device's clock. */
  clock: string;
  /** Event ids already folded into the shadow (bounded, oldest first). */
  seenEventIds: string[];
  syncMeta: SyncMeta;
}

export interface InflightRecord {
  requestId: string;
  fieldId: string;
  version: number;
  pass: CheckPass;
  tabId: number | null;
  frameId: number | null;
  at: string;
}

export interface BlockCacheEntry {
  pass: CheckPass;
  model: string;
  suggestions: CachedSuggestion[];
  at: number;
}

export interface SessionSchema {
  /** fieldId -> fingerprints applied in this field session (never re-suggested). */
  appliedFingerprints: Record<string, string[]>;
  /** Hosts and field ids turned off until the next visit. */
  hostSessionOff: { hosts: string[]; fields: string[] };
  inflight: Record<string, InflightRecord>;
  blockCache: { promptVersion: string; entries: [string, BlockCacheEntry][] } | null;
}

export const LIMITS = {
  EVENT_BUFFER_MAX: 5_000,
  SAMPLE_BUFFER_MAX: 2_000,
  SEEN_EVENT_IDS_MAX: 20_000,
  BLOCK_CACHE_MAX: 500,
  DISMISSAL_TTL_MS: 30 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_SYNC_STATE: SyncState = {
  etag: '',
  version: 0,
  lastPollAt: '',
  lastPushAt: '',
  lastEventUploadAt: '',
  pendingOps: [],
  status: 'ok',
  eventUploadsToday: 0,
};

export const DEFAULT_SYNC_META: SyncMeta = {
  pushDay: '',
  pushesToday: 0,
  uploadDay: '',
  uploadsToday: 0,
  pausedUntil: null,
  backoffMs: 0,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

const SETTINGS_KEYS = Object.keys(DEFAULT_DEVICE_SETTINGS) as (keyof DeviceSettings)[];

/** DeviceSettings merged over the defaults; wrong-typed fields fall back; unknown keys are dropped. */
export function normalizeSettings(raw: unknown): DeviceSettings {
  const out: DeviceSettings = { ...DEFAULT_DEVICE_SETTINGS };
  if (!isRecord(raw)) return out;
  for (const key of SETTINGS_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    switch (key) {
      case 'enabled':
      case 'showFloatingButton':
      case 'showUnderlines':
      case 'colorblindMode':
        if (typeof v === 'boolean') out[key] = v;
        break;
      case 'provider':
        if (v === 'anthropic' || v === 'mock') out.provider = v;
        break;
      case 'mode':
        if (v === 'hybrid' || v === 'quality' || v === 'economy') out.mode = v;
        break;
      case 'model':
      case 'fastModel':
      case 'apiKey':
      case 'styleOwner':
        if (typeof v === 'string') out[key] = v;
        break;
      case 'debounceMs':
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out.debounceMs = Math.round(v);
        break;
      case 'dailyBudgetUsd':
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out.dailyBudgetUsd = v;
        break;
      case 'gdocsInline':
        if (v === 'auto' || v === 'off') out.gdocsInline = v;
        break;
      case 'pairing':
        if (v === null) out.pairing = null;
        else if (isRecord(v) && typeof v.appOrigin === 'string' && typeof v.deviceId === 'string' && typeof v.token === 'string') {
          out.pairing = { appOrigin: v.appOrigin, deviceId: v.deviceId, token: v.token, pairedAt: typeof v.pairedAt === 'string' ? v.pairedAt : '' };
        }
        break;
      default:
        break;
    }
  }
  return out;
}

function normalizeSync(raw: unknown): SyncState {
  const out: SyncState = { ...DEFAULT_SYNC_STATE, pendingOps: [] };
  if (!isRecord(raw)) return out;
  if (typeof raw.etag === 'string') out.etag = raw.etag;
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) out.version = raw.version;
  for (const k of ['lastPollAt', 'lastPushAt', 'lastEventUploadAt'] as const) if (typeof raw[k] === 'string') out[k] = raw[k] as string;
  if (Array.isArray(raw.pendingOps)) out.pendingOps = raw.pendingOps.filter((op) => isRecord(op) && typeof op.op === 'string') as SyncState['pendingOps'];
  if (raw.status === 'ok' || raw.status === 'offline' || raw.status === 'paused' || raw.status === 'revoked') out.status = raw.status;
  if (typeof raw.eventUploadsToday === 'number') out.eventUploadsToday = raw.eventUploadsToday;
  return out;
}

function normalizeDevice(raw: unknown): DeviceRecord | null {
  if (!isRecord(raw) || typeof raw.deviceId !== 'string' || raw.deviceId.length === 0) return null;
  return {
    deviceId: raw.deviceId,
    name: typeof raw.name === 'string' ? raw.name : 'Chrome',
    platform: typeof raw.platform === 'string' ? raw.platform : 'unknown',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

function normalizeLearning(raw: unknown): ProfileDocument['learning'] {
  const base = defaultProfile().learning;
  if (!isRecord(raw)) return base;
  return migrateProfile({ learning: raw }).learning;
}

function normalizeDismissals(raw: unknown): Record<string, DismissalEntry[]> {
  const out: Record<string, DismissalEntry[]> = {};
  if (!isRecord(raw)) return out;
  for (const [docKey, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const entries = list.filter((e): e is DismissalEntry => isRecord(e) && typeof e.fingerprint === 'string' && typeof e.at === 'string').map((e) => ({ fingerprint: e.fingerprint, rule: typeof e.rule === 'string' ? e.rule : '', at: e.at }));
    if (entries.length > 0) out[docKey] = entries;
  }
  return out;
}

function normalizeBucket(raw: unknown): UsageBucket | null {
  if (!isRecord(raw)) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { inputTokens: n(raw.inputTokens), outputTokens: n(raw.outputTokens), cacheReadTokens: n(raw.cacheReadTokens), cacheWriteTokens: n(raw.cacheWriteTokens), costUsd: n(raw.costUsd), requests: n(raw.requests) };
}

function normalizeUsage(raw: unknown): UsageLedger {
  const out: UsageLedger = { days: {}, months: {} };
  if (!isRecord(raw)) return out;
  for (const section of ['days', 'months'] as const) {
    const src = raw[section];
    if (!isRecord(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      const b = normalizeBucket(v);
      if (b) out[section][k] = b;
    }
  }
  return out;
}

function normalizeArray<T>(raw: unknown, check: (v: unknown) => v is T, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const list = raw.filter(check);
  return list.length > max ? list.slice(list.length - max) : list;
}

const isEvent = (v: unknown): v is FeedbackEvent => isRecord(v) && typeof v.eventId === 'string' && typeof v.kind === 'string';
const isSample = (v: unknown): v is VoiceSample => isRecord(v) && typeof v.sentence === 'string';
const isString = (v: unknown): v is string => typeof v === 'string';

function normalizeSyncMeta(raw: unknown): SyncMeta {
  const out: SyncMeta = { ...DEFAULT_SYNC_META };
  if (!isRecord(raw)) return out;
  if (typeof raw.pushDay === 'string') out.pushDay = raw.pushDay;
  if (typeof raw.pushesToday === 'number') out.pushesToday = raw.pushesToday;
  if (typeof raw.uploadDay === 'string') out.uploadDay = raw.uploadDay;
  if (typeof raw.uploadsToday === 'number') out.uploadsToday = raw.uploadsToday;
  if (typeof raw.pausedUntil === 'string') out.pausedUntil = raw.pausedUntil;
  if (typeof raw.backoffMs === 'number') out.backoffMs = raw.backoffMs;
  if (typeof raw.lastError === 'string') out.lastError = raw.lastError;
  return out;
}

type Normalizers<S> = { [K in keyof S]: (raw: unknown) => S[K] };

const LOCAL_NORMALIZERS: Normalizers<LocalSchema> = {
  settings: normalizeSettings,
  profile: (raw) => migrateProfile(raw),
  sync: normalizeSync,
  device: normalizeDevice,
  learningShadow: normalizeLearning,
  dismissals: normalizeDismissals,
  usage: normalizeUsage,
  eventBuffer: (raw) => normalizeArray(raw, isEvent, LIMITS.EVENT_BUFFER_MAX),
  sampleBuffer: (raw) => normalizeArray(raw, isSample, LIMITS.SAMPLE_BUFFER_MAX),
  clock: (raw) => (isHlc(raw) ? raw : ZERO_HLC),
  seenEventIds: (raw) => normalizeArray(raw, isString, LIMITS.SEEN_EVENT_IDS_MAX),
  syncMeta: normalizeSyncMeta,
};

const SESSION_NORMALIZERS: Normalizers<SessionSchema> = {
  appliedFingerprints: (raw) => {
    const out: Record<string, string[]> = {};
    if (!isRecord(raw)) return out;
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter(isString);
    return out;
  },
  hostSessionOff: (raw) => ({
    hosts: isRecord(raw) && Array.isArray(raw.hosts) ? raw.hosts.filter(isString) : [],
    fields: isRecord(raw) && Array.isArray(raw.fields) ? raw.fields.filter(isString) : [],
  }),
  inflight: (raw) => {
    const out: Record<string, InflightRecord> = {};
    if (!isRecord(raw)) return out;
    for (const [k, v] of Object.entries(raw)) {
      if (isRecord(v) && typeof v.fieldId === 'string' && typeof v.version === 'number') out[k] = v as unknown as InflightRecord;
    }
    return out;
  },
  blockCache: (raw) => {
    if (!isRecord(raw) || typeof raw.promptVersion !== 'string' || !Array.isArray(raw.entries)) return null;
    return { promptVersion: raw.promptVersion, entries: raw.entries.filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && isRecord(e[1])) as [string, BlockCacheEntry][] };
  },
};

export const LOCAL_KEYS = Object.keys(LOCAL_NORMALIZERS) as (keyof LocalSchema)[];
export const SESSION_KEYS = Object.keys(SESSION_NORMALIZERS) as (keyof SessionSchema)[];

// ---------------------------------------------------------------------------
// Typed area
// ---------------------------------------------------------------------------

/** The subset of chrome.storage.StorageArea the store needs (promise forms). */
export interface StorageAreaLike {
  get(keys: string[] | null): Promise<Record<string, unknown>> | void;
  set(items: Record<string, unknown>): Promise<void> | void;
  remove?(keys: string | string[]): Promise<void> | void;
  setAccessLevel?: (opts: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }) => Promise<void> | void;
  onChanged?: { addListener(fn: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void): void };
}

export interface TypedArea<S> {
  /** Resolves once the cache is primed from storage. */
  ready: Promise<void>;
  /** Cached value (defaults before `ready`). */
  get<K extends keyof S>(key: K): S[K];
  set<K extends keyof S>(key: K, value: S[K]): Promise<void>;
  /** Shallow-merges `partial` into an object-valued key. */
  patch<K extends keyof S>(key: K, partial: Partial<S[K]>): Promise<void>;
  update<K extends keyof S>(key: K, fn: (current: S[K]) => S[K]): Promise<void>;
  /** Fires after any write to `key` (own or by another context). */
  onChange<K extends keyof S>(key: K, cb: (value: S[K]) => void): () => void;
  /** Resolves when every queued write has been handed to chrome.storage. */
  flush(): Promise<void>;
}

function promiseOf<T>(v: Promise<T> | void): Promise<T | undefined> {
  return v instanceof Promise ? v : Promise.resolve(undefined);
}

function createTypedArea<S extends object>(area: StorageAreaLike | undefined, normalizers: Normalizers<S>): TypedArea<S> {
  const keys = Object.keys(normalizers) as (keyof S)[];
  const cache = {} as S;
  for (const k of keys) cache[k] = normalizers[k](undefined);
  const listeners = new Map<keyof S, Set<(value: unknown) => void>>();
  const ownPending = new Map<keyof S, number>();
  let chain: Promise<unknown> = Promise.resolve();

  const notify = (key: keyof S): void => {
    const set = listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(cache[key]);
      } catch (err) {
        console.debug('[jammarly] storage listener failed', err);
      }
    }
  };

  const ready = (async () => {
    if (!area) return;
    try {
      const raw = (await promiseOf(area.get(keys as string[]))) ?? {};
      for (const k of keys) {
        if (raw[k as string] !== undefined) cache[k] = normalizers[k](raw[k as string]);
      }
    } catch (err) {
      console.debug('[jammarly] storage load failed, using defaults', err);
    }
  })();

  area?.onChanged?.addListener((changes) => {
    for (const [k, change] of Object.entries(changes)) {
      const key = k as keyof S;
      if (!keys.includes(key)) continue;
      const pending = ownPending.get(key) ?? 0;
      if (pending > 0) {
        ownPending.set(key, pending - 1);
        continue;
      }
      cache[key] = normalizers[key](change.newValue);
      notify(key);
    }
  });

  const write = (key: keyof S, value: S[keyof S]): Promise<void> => {
    cache[key] = value;
    notify(key);
    if (!area) return Promise.resolve();
    ownPending.set(key, (ownPending.get(key) ?? 0) + 1);
    const p = chain.then(async () => {
      try {
        await promiseOf(area.set({ [key as string]: value }));
      } catch (err) {
        ownPending.set(key, Math.max(0, (ownPending.get(key) ?? 1) - 1));
        console.debug('[jammarly] storage write failed', err);
      }
    });
    chain = p;
    return p;
  };

  return {
    ready,
    get(key) {
      return cache[key];
    },
    set(key, value) {
      return write(key, value);
    },
    patch(key, partial) {
      const current = cache[key];
      const next = isRecord(current) ? ({ ...(current as Record<string, unknown>), ...(partial as Record<string, unknown>) } as S[typeof key]) : (partial as S[typeof key]);
      return write(key, next);
    },
    update(key, fn) {
      return write(key, fn(cache[key]));
    },
    onChange(key, cb) {
      const set = listeners.get(key) ?? new Set();
      set.add(cb as (value: unknown) => void);
      listeners.set(key, set);
      return () => {
        set.delete(cb as (value: unknown) => void);
      };
    },
    flush() {
      return chain.then(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface Store {
  ready: Promise<void>;
  local: TypedArea<LocalSchema>;
  session: TypedArea<SessionSchema>;
  /** True when setAccessLevel('TRUSTED_CONTEXTS') was applied to storage.local. */
  localLocked: boolean;
}

export interface StorageNamespaceLike {
  local?: StorageAreaLike;
  session?: StorageAreaLike;
}

/**
 * Creates the store over a chrome.storage-like namespace. Call once per worker start; `ready` resolves when both
 * caches are primed. Secrets live in storage.local, locked to trusted contexts when the API exists.
 */
export function createStore(ns: StorageNamespaceLike | undefined): Store {
  const local = createTypedArea<LocalSchema>(ns?.local, LOCAL_NORMALIZERS);
  const session = createTypedArea<SessionSchema>(ns?.session, SESSION_NORMALIZERS);
  const store: Store = { ready: Promise.all([local.ready, session.ready]).then(() => undefined), local, session, localLocked: false };
  const fn = ns?.local?.setAccessLevel;
  if (typeof fn === 'function') {
    try {
      const r = fn.call(ns?.local, { accessLevel: 'TRUSTED_CONTEXTS' });
      store.localLocked = true;
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // Chrome < 140: the key stays readable by content scripts on this build.
    }
  }
  return store;
}

// ---------------------------------------------------------------------------
// Domain helpers (pure)
// ---------------------------------------------------------------------------

/** Drops dismissals older than the TTL and empty docKeys. */
export function sweepDismissals(dismissals: Record<string, DismissalEntry[]>, nowMs: number, ttlMs: number = LIMITS.DISMISSAL_TTL_MS): Record<string, DismissalEntry[]> {
  const out: Record<string, DismissalEntry[]> = {};
  for (const [docKey, list] of Object.entries(dismissals)) {
    const kept = list.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && nowMs - t < ttlMs;
    });
    if (kept.length > 0) out[docKey] = kept;
  }
  return out;
}

/** Adds a dismissal (deduplicated by fingerprint, refreshing `at`). */
export function withDismissal(dismissals: Record<string, DismissalEntry[]>, docKey: string, entry: DismissalEntry): Record<string, DismissalEntry[]> {
  const list = (dismissals[docKey] ?? []).filter((e) => e.fingerprint !== entry.fingerprint);
  list.push(entry);
  return { ...dismissals, [docKey]: list };
}

export function dismissedFingerprints(dismissals: Record<string, DismissalEntry[]>, docKey: string, nowMs: number, ttlMs: number = LIMITS.DISMISSAL_TTL_MS): Set<string> {
  const out = new Set<string>();
  for (const e of dismissals[docKey] ?? []) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && nowMs - t < ttlMs) out.add(e.fingerprint);
  }
  return out;
}
