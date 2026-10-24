/**
 * Test-only `chrome` mock for the page unit tests (vitest + jsdom). Never imported by an entry point, so it is
 * never bundled. Provides runtime.sendMessage (scripted responder), runtime.connect (fake ports you can drive),
 * windows.getCurrent, tabs.query/create, runtime.openOptionsPage, runtime.id and getManifest.
 */
import type { ProfileDocument, PublicDeviceSettings, RuntimeRequest, RuntimeResponse, SyncState, UsageTotals } from '@jammarly/shared/types';
import { defaultProfile } from '@jammarly/shared/profile';

type Listener<T> = (arg: T) => void;

export interface FakePort {
  name: string;
  /** Messages the page posted, in order. */
  sent: unknown[];
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  disconnected: boolean;
  onMessage: { addListener(fn: Listener<unknown>): void; removeListener(fn: Listener<unknown>): void; hasListener(fn: Listener<unknown>): boolean };
  onDisconnect: { addListener(fn: Listener<unknown>): void; removeListener(fn: Listener<unknown>): void; hasListener(fn: Listener<unknown>): boolean };
  /** Delivers a message from the "worker" to the page. */
  emit(msg: unknown): void;
  /** Simulates the worker dropping the port. */
  fireDisconnect(): void;
}

export type Responder = (req: RuntimeRequest) => unknown | Promise<unknown>;

export interface ChromeMock {
  ports: FakePort[];
  /** Every RuntimeRequest the page sent. */
  requests: RuntimeRequest[];
  /** Replace the responder (return a RuntimeResponse, garbage, undefined, or throw/reject). */
  respond: Responder;
  openOptionsPage: { calls: number };
  tabsCreated: unknown[];
  tabs: chrome.tabs.Tab[];
  windowId: number | undefined;
  /** Make connect throw (no runtime). */
  connectThrows: boolean;
  /** What chrome.commands.getAll answers. */
  commands: chrome.commands.Command[];
  settings: PublicDeviceSettings;
  profile: ProfileDocument;
  usage: UsageTotals;
  sync: SyncState | null;
  hostStatus: Record<string, boolean>;
  /** Removes the global. */
  restore(): void;
}

function events<T>(): { addListener(fn: Listener<T>): void; removeListener(fn: Listener<T>): void; hasListener(fn: Listener<T>): boolean; fire(arg: T): void } {
  const listeners = new Set<Listener<T>>();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    fire: (arg) => {
      for (const fn of Array.from(listeners)) fn(arg);
    },
  };
}

export function fakeSettings(patch: Partial<PublicDeviceSettings> = {}): PublicDeviceSettings {
  return {
    enabled: true,
    provider: 'anthropic',
    mode: 'hybrid',
    model: 'claude-opus-5-5',
    fastModel: 'claude-haiku-5-5',
    debounceMs: 700,
    showFloatingButton: true,
    showUnderlines: true,
    colorblindMode: false,
    gdocsInline: 'auto',
    dailyBudgetUsd: 2,
    styleOwner: '',
    hasApiKey: true,
    paired: false,
    appOrigin: null,
    ...patch,
  };
}

export function fakeUsage(todayCost = 0.0123, monthCost = 0.42): UsageTotals {
  return {
    today: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: todayCost, requests: 3 },
    month: { inputTokens: 50_000, outputTokens: 9000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: monthCost, requests: 120 },
  };
}

export function fakeSync(patch: Partial<SyncState> = {}): SyncState {
  return { etag: 'W/"1"', version: 7, lastPollAt: new Date(Date.now() - 3 * 60_000).toISOString(), lastPushAt: '', lastEventUploadAt: '', pendingOps: [], status: 'ok', eventUploadsToday: 0, ...patch };
}

/** A well-behaved worker: answers every request with the matching RuntimeResponse. */
export function defaultResponder(mock: ChromeMock): Responder {
  return (req) => {
    switch (req.type) {
      case 'get-settings':
        return { ok: true, type: 'settings', settings: mock.settings } satisfies RuntimeResponse;
      case 'set-settings': {
        const { apiKey, pairing, ...rest } = req.patch;
        mock.settings = { ...mock.settings, ...rest, hasApiKey: apiKey !== undefined ? apiKey.length > 0 : mock.settings.hasApiKey, paired: pairing !== undefined ? pairing !== null : mock.settings.paired };
        return { ok: true, type: 'settings', settings: mock.settings } satisfies RuntimeResponse;
      }
      case 'get-profile':
        return { ok: true, type: 'profile', profile: mock.profile } satisfies RuntimeResponse;
      case 'profile-ops':
        return { ok: true, type: 'ok' } satisfies RuntimeResponse;
      case 'test-api-key':
        return { ok: true, type: 'api-key-test', valid: req.apiKey.startsWith('sk-ant-'), model: 'claude-haiku-5-5', message: req.apiKey.startsWith('sk-ant-') ? undefined : 'Invalid key' } satisfies RuntimeResponse;
      case 'pair':
        mock.settings = { ...mock.settings, paired: true, appOrigin: 'https://jammarly.example' };
        return { ok: true, type: 'paired', deviceId: 'dev-123', appOrigin: 'https://jammarly.example' } satisfies RuntimeResponse;
      case 'unpair':
        mock.settings = { ...mock.settings, paired: false, appOrigin: null };
        return { ok: true, type: 'ok' } satisfies RuntimeResponse;
      case 'get-usage':
        return { ok: true, type: 'usage', usage: mock.usage } satisfies RuntimeResponse;
      case 'get-sync-state':
        return { ok: true, type: 'sync-state', sync: mock.sync } satisfies RuntimeResponse;
      case 'get-host-status':
        return { ok: true, type: 'host-status', host: req.host, enabled: mock.hostStatus[req.host] ?? true } satisfies RuntimeResponse;
      case 'set-host-enabled':
        mock.hostStatus[req.host] = req.enabled;
        return { ok: true, type: 'ok' } satisfies RuntimeResponse;
      default:
        return { ok: true, type: 'ok' } satisfies RuntimeResponse;
    }
  };
}

export interface InstallOptions {
  respond?: Responder;
  windowId?: number;
  tabs?: chrome.tabs.Tab[];
  settings?: Partial<PublicDeviceSettings>;
  profile?: ProfileDocument;
  usage?: UsageTotals;
  sync?: SyncState | null;
}

export function installChromeMock(opts: InstallOptions = {}): ChromeMock {
  const ports: FakePort[] = [];
  const requests: RuntimeRequest[] = [];
  const mock: ChromeMock = {
    ports,
    requests,
    respond: () => undefined,
    openOptionsPage: { calls: 0 },
    tabsCreated: [],
    tabs: opts.tabs ?? [{ id: 7, url: 'https://mail.google.com/mail/u/0/#inbox', active: true, index: 0, windowId: 1, pinned: false, highlighted: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1, frozen: false } as chrome.tabs.Tab],
    windowId: opts.windowId ?? 1,
    commands: [
      { name: '_execute_action', description: '', shortcut: 'Alt+Shift+J' },
      { name: 'accept-all', description: 'Accept everything in the focused field (grammar, style and tone)', shortcut: 'Alt+Shift+A' },
      { name: 'accept-grammar', description: 'Accept all grammar fixes in the focused field', shortcut: '' },
    ],
    connectThrows: false,
    settings: fakeSettings(opts.settings),
    profile: opts.profile ?? defaultProfile(),
    usage: opts.usage ?? fakeUsage(),
    sync: opts.sync === undefined ? null : opts.sync,
    hostStatus: {},
    restore() {
      delete (globalThis as { chrome?: unknown }).chrome;
    },
  };
  mock.respond = opts.respond ?? defaultResponder(mock);

  const runtime = {
    id: 'test-extension-id',
    lastError: undefined as { message: string } | undefined,
    getManifest: () => ({ version: '0.1.0', manifest_version: 3, name: 'Jammarly' }),
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    sendMessage: (msg: unknown) => {
      requests.push(msg as RuntimeRequest);
      return new Promise<unknown>((resolve, reject) => {
        try {
          Promise.resolve(mock.respond(msg as RuntimeRequest)).then(resolve, reject);
        } catch (err) {
          reject(err);
        }
      });
    },
    connect: (info?: { name?: string }) => {
      if (mock.connectThrows) throw new Error('Extension context invalidated.');
      const onMessage = events<unknown>();
      const onDisconnect = events<unknown>();
      const port: FakePort = {
        name: info?.name ?? '',
        sent: [],
        disconnected: false,
        postMessage: (msg) => {
          if (port.disconnected) throw new Error('Attempting to use a disconnected port object');
          port.sent.push(msg);
        },
        disconnect: () => {
          port.disconnected = true;
        },
        onMessage,
        onDisconnect,
        emit: (msg) => onMessage.fire(msg),
        fireDisconnect: () => {
          port.disconnected = true;
          onDisconnect.fire(port);
        },
      };
      ports.push(port);
      return port;
    },
    openOptionsPage: () => {
      mock.openOptionsPage.calls += 1;
      return Promise.resolve();
    },
  };
  const chromeLike = {
    runtime,
    windows: { getCurrent: () => Promise.resolve({ id: mock.windowId }) },
    tabs: {
      query: () => Promise.resolve(mock.tabs),
      create: (props: unknown) => {
        mock.tabsCreated.push(props);
        return Promise.resolve({ id: 99 });
      },
    },
    commands: { getAll: () => Promise.resolve(mock.commands) },
  };
  (globalThis as { chrome?: unknown }).chrome = chromeLike;
  return mock;
}

/** Waits for pending promise callbacks (a few microtask turns). */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
