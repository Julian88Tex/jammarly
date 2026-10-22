/**
 * The worker's shared services (storage -> clock -> config -> engine -> sync -> learning), created once per worker
 * start. Ports, runtime handlers and commands depend on this object only, which keeps each of them testable with
 * the chrome mock and fake providers.
 */
import type { DeviceSettings, EffectiveConfig, PublicDeviceSettings, SyncState, TokenUsage } from '@jammarly/shared/types';
import type { ProfileDocument, ProfileOp } from '@jammarly/shared/profile';
import type { DeviceClock } from './clock';
import { createDeviceClock } from './clock';
import { computeEffectiveConfig, ensureUserSaltOp } from './config';
import { createBlockCache, type BlockCache } from './engine/cache';
import { createEngine, type Engine } from './engine/orchestrator';
import { createAnthropicProvider, type ClientFactory } from './engine/anthropic';
import { createMockProvider } from './engine/mock';
import type { Provider } from './engine/provider';
import { createToneRunner } from './engine/tone';
import { appOrigin as compiledAppOrigin, extVersion as compiledExtVersion } from './env';
import { createKeepalive, type Keepalive } from './keepalive';
import { createLearning, type LearningService } from './learning/fold';
import type { ApplyOpsResult, LearnedStateView } from './shared-engine';
import { applyOps, PROMPT_VERSION } from './shared-engine';
import type { DismissalEntry, InflightRecord, Store, UsageLedger } from './storage';
import { createStore, dismissedFingerprints, sweepDismissals, withDismissal } from './storage';
import { createSyncClient, type AlarmsLike, type SyncClient } from './sync/client';
import { recordUsage, usageTotals } from './usage';
import { debounce, newDeviceId } from './util';

export interface CoreDeps {
  /** The chrome namespace (or the test mock). */
  chrome: typeof chrome | undefined;
  appOrigin?: string;
  extVersion?: string;
  fetchImpl?: typeof fetch;
  clientFactory?: ClientFactory;
  mockDelayMs?: number;
  now?: () => number;
}

export interface Core {
  ready: Promise<void>;
  store: Store;
  clock: DeviceClock;
  engine: Engine;
  cache: BlockCache;
  sync: SyncClient;
  learning: LearningService;
  keepalive: Keepalive;
  runtimeId: string;
  appOrigin: string;
  extVersion: string;
  now(): number;
  settings(): DeviceSettings;
  profile(): ProfileDocument;
  learned(): LearnedStateView;
  configFor(host: string): EffectiveConfig;
  publicSettings(): PublicDeviceSettings;
  syncState(): SyncState | null;
  usageLedger(): UsageLedger;
  usageTotals(): ReturnType<typeof usageTotals>;
  providerFor(settings: DeviceSettings): Provider;
  /** Stamps empty clocks, applies, saves, queues for push and notifies config listeners. */
  applyProfileOps(ops: readonly ProfileOp[]): Promise<ApplyOpsResult>;
  saveSettings(patch: Partial<DeviceSettings>): Promise<void>;
  /** Fires when settings, profile or learned state changed (hosts: undefined = everyone). */
  onConfigChange(cb: () => void): () => void;
  dismissed(docKey: string): Set<string>;
  addDismissal(docKey: string, entry: DismissalEntry): Promise<void>;
  applied(fieldId: string): Set<string>;
  markApplied(fieldId: string, fingerprints: readonly string[]): Promise<void>;
  sessionOff(): { hosts: string[]; fields: string[] };
  setHostSessionOff(host: string, off: boolean): Promise<void>;
  inflightRecords(): InflightRecord[];
  clearInflight(): Promise<void>;
  sweepDismissals(): Promise<void>;
  deviceId(): string;
}

export function toPublicSettings(settings: DeviceSettings, appOrigin: string): PublicDeviceSettings {
  const { apiKey, pairing, ...rest } = settings;
  return { ...rest, hasApiKey: apiKey.trim().length > 0, paired: pairing !== null, appOrigin: appOrigin.length > 0 ? appOrigin : null };
}

export function createCore(deps: CoreDeps): Core {
  const c = deps.chrome;
  const now = deps.now ?? Date.now;
  const appOrigin = deps.appOrigin ?? compiledAppOrigin();
  const extVersion = deps.extVersion ?? compiledExtVersion();
  const runtimeId = typeof c?.runtime?.id === 'string' ? c.runtime.id : '';
  const store = createStore(c?.storage as unknown as Parameters<typeof createStore>[0]);
  const keepalive = createKeepalive(c?.runtime ? { getPlatformInfo: () => c.runtime.getPlatformInfo() } : undefined);
  const configListeners = new Set<() => void>();
  const notifyConfig = debounce(() => {
    for (const cb of configListeners) {
      try {
        cb();
      } catch (err) {
        console.debug('[jammarly] config listener failed', err);
      }
    }
  }, 10);

  // Clock: created after the store is ready (needs the device id); a placeholder issues nothing before that.
  let clock: DeviceClock | null = null;
  const persistClock = debounce(() => {
    if (clock) void store.local.set('clock', clock.last());
  }, 500);
  const clockOrThrow = (): DeviceClock => {
    if (!clock) throw new Error('core not ready');
    return clock;
  };

  const cache = createBlockCache({ promptVersion: PROMPT_VERSION, session: store.session });
  const tone = createToneRunner();

  // Providers are cached per (kind, key) so the Anthropic client is created once per key.
  let anthropicKey: string | null = null;
  let anthropicProvider: Provider | null = null;
  const mockProvider = createMockProvider(deps.mockDelayMs === undefined ? {} : { delayMs: deps.mockDelayMs });
  const providerFor = (settings: DeviceSettings): Provider => {
    if (settings.provider === 'mock') return mockProvider;
    const key = settings.apiKey.trim();
    if (anthropicProvider === null || anthropicKey !== key) {
      anthropicKey = key;
      anthropicProvider = createAnthropicProvider(key, deps.clientFactory ? { clientFactory: deps.clientFactory } : {});
    }
    return anthropicProvider;
  };

  const engine = createEngine({
    providerFor,
    cache,
    usage: {
      ledger: () => store.local.get('usage'),
      record: (usage: TokenUsage) => {
        void store.local.set('usage', recordUsage(store.local.get('usage'), usage, now()));
      },
    },
    dismissed: (docKey) => dismissedFingerprints(store.local.get('dismissals'), docKey, now()),
    applied: (fieldId) => new Set(store.session.get('appliedFingerprints')[fieldId] ?? []),
    keepalive,
    inflight: {
      add: (rec) => {
        void store.session.update('inflight', (cur) => ({ ...cur, [rec.requestId]: rec }));
      },
      remove: (id) => {
        void store.session.update('inflight', (cur) => {
          const { [id]: _gone, ...rest } = cur;
          return rest;
        });
      },
    },
    tone,
    now,
  });

  const learning = createLearning({
    store,
    clock: {
      get deviceId() {
        return clockOrThrow().deviceId;
      },
      next: () => clockOrThrow().next(),
      receive: (h) => clockOrThrow().receive(h),
      receiveProfile: (p) => clockOrThrow().receiveProfile(p),
      last: () => clockOrThrow().last(),
      stampOps: (ops) => clockOrThrow().stampOps(ops),
    },
    isPaired: () => store.local.get('settings').pairing !== null,
    now,
  });

  const alarms: AlarmsLike | undefined = c?.alarms
    ? {
        create: (name, info) => Promise.resolve(c.alarms.create(name, info as chrome.alarms.AlarmCreateInfo)).then(() => undefined),
        clear: (name) => Promise.resolve(c.alarms.clear(name)).then((r) => Boolean(r)),
        get: async (name) => {
          const a = (await c.alarms.get(name)) as chrome.alarms.Alarm | undefined;
          return a ? { name: a.name, ...(a.periodInMinutes !== undefined ? { periodInMinutes: a.periodInMinutes } : {}) } : undefined;
        },
      }
    : undefined;

  let contentActive = false;
  const sync = createSyncClient({
    store,
    clock: {
      get deviceId() {
        return clockOrThrow().deviceId;
      },
      next: () => clockOrThrow().next(),
      receive: (h) => clockOrThrow().receive(h),
      receiveProfile: (p) => clockOrThrow().receiveProfile(p),
      last: () => clockOrThrow().last(),
      stampOps: (ops) => clockOrThrow().stampOps(ops),
    },
    appOrigin,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(alarms ? { alarms } : {}),
    now,
    extVersion,
    platform: async () => {
      try {
        const info = await c?.runtime?.getPlatformInfo();
        return info?.os ?? 'unknown';
      } catch {
        return 'unknown';
      }
    },
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    onProfileReplaced: async (profile) => {
      await learning.replaceShadow(profile.learning);
      notifyConfig.call();
    },
    contentActive: () => contentActive,
  });

  async function init(): Promise<void> {
    await store.ready;
    let device = store.local.get('device');
    if (!device) {
      device = { deviceId: newDeviceId(), name: 'Chrome', platform: 'unknown', createdAt: new Date(now()).toISOString() };
      await store.local.set('device', device);
    }
    clock = createDeviceClock(device.deviceId, store.local.get('clock'), store.local.get('profile'), {
      onIssue: () => persistClock.call(),
      now,
    });
    // Unpaired devices fold into the profile copy directly: keep the shadow equal to it.
    const profile = store.local.get('profile');
    const paired = store.local.get('settings').pairing !== null;
    if (!paired) await store.local.set('learningShadow', profile.learning);
    const saltOp = ensureUserSaltOp(profile);
    if (saltOp) await core.applyProfileOps([saltOp]);
    await cache.load();
    await core.sweepDismissals();
    await sync.ensureAlarms();
  }

  // Any change to settings, profile or the shadow (own or external) re-broadcasts configs.
  store.local.onChange('settings', () => notifyConfig.call());
  store.local.onChange('profile', () => notifyConfig.call());
  store.local.onChange('learningShadow', () => notifyConfig.call());
  store.session.onChange('hostSessionOff', () => notifyConfig.call());

  const core: Core = {
    ready: Promise.resolve(),
    store,
    get clock() {
      return clockOrThrow();
    },
    engine,
    cache,
    sync,
    learning,
    keepalive,
    runtimeId,
    appOrigin,
    extVersion,
    now,
    settings: () => store.local.get('settings'),
    profile: () => store.local.get('profile'),
    learned: () => learning.learned(),
    configFor: (host) =>
      computeEffectiveConfig({
        host,
        settings: store.local.get('settings'),
        profile: store.local.get('profile'),
        learned: learning.learned(),
        sessionOff: store.session.get('hostSessionOff'),
        usage: store.local.get('usage'),
        runtimeId,
        now: now(),
      }),
    publicSettings: () => toPublicSettings(store.local.get('settings'), appOrigin),
    syncState: () => sync.state(),
    usageLedger: () => store.local.get('usage'),
    usageTotals: () => usageTotals(store.local.get('usage'), now()),
    providerFor,
    async applyProfileOps(ops) {
      const stamped = clockOrThrow().stampOps(ops);
      const result = applyOps(store.local.get('profile'), stamped);
      if (result.applied.length > 0) {
        await store.local.set('profile', result.doc);
        if (store.local.get('settings').pairing !== null) sync.queuePush(result.applied);
      }
      return result;
    },
    async saveSettings(patch) {
      await store.local.set('settings', { ...store.local.get('settings'), ...patch });
    },
    onConfigChange(cb) {
      configListeners.add(cb);
      return () => {
        configListeners.delete(cb);
      };
    },
    dismissed: (docKey) => dismissedFingerprints(store.local.get('dismissals'), docKey, now()),
    async addDismissal(docKey, entry) {
      await store.local.set('dismissals', withDismissal(store.local.get('dismissals'), docKey, entry));
    },
    applied: (fieldId) => new Set(store.session.get('appliedFingerprints')[fieldId] ?? []),
    async markApplied(fieldId, fingerprints) {
      if (fingerprints.length === 0) return;
      await store.session.update('appliedFingerprints', (cur) => ({ ...cur, [fieldId]: [...new Set([...(cur[fieldId] ?? []), ...fingerprints])] }));
    },
    sessionOff: () => store.session.get('hostSessionOff'),
    async setHostSessionOff(host, off) {
      await store.session.update('hostSessionOff', (cur) => {
        const hosts = cur.hosts.filter((h) => h !== host);
        if (off) hosts.push(host);
        return { ...cur, hosts };
      });
    },
    inflightRecords: () => Object.values(store.session.get('inflight')),
    clearInflight: () => store.session.set('inflight', {}),
    async sweepDismissals() {
      const current = store.local.get('dismissals');
      const swept = sweepDismissals(current, now());
      if (JSON.stringify(swept) !== JSON.stringify(current)) await store.local.set('dismissals', swept);
    },
    deviceId: () => store.local.get('device')?.deviceId ?? clockOrThrow().deviceId,
  };

  core.ready = init();

  // Content-port activity drives the poll cadence; the hub reports it.
  (core as Core & { setContentActive(active: boolean): void }).setContentActive = (active: boolean) => {
    if (contentActive === active) return;
    contentActive = active;
    void sync.setActive(active);
  };
  return core;
}

export type CoreWithActivity = Core & { setContentActive(active: boolean): void };
