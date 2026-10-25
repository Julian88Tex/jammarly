/**
 * Reusable in-memory `chrome.*` mock for unit tests of the service worker and the extension pages.
 *
 * Covers storage.local/session (promise and callback forms, onChanged, feature-detectable setAccessLevel),
 * runtime (id, getManifest, connect with linked port pairs, onConnect, onMessage, onMessageExternal, sendMessage,
 * onInstalled, onStartup, getPlatformInfo, openOptionsPage, getURL), alarms, tabs, windows, scripting, sidePanel,
 * commands and action. Every event exposes `dispatch(...)` so tests can fire it; every API records its calls.
 *
 *   const mock = installChromeMock();          // sets globalThis.chrome
 *   const { client } = mock.connect('jammarly-content', { tab: { id: 7 }, frameId: 0, url: 'https://x.com/a' });
 *   client.postMessage({ type: 'hello', ... });  await mock.flush();  client.received -> worker replies
 */

export type Listener = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MockEvent<F extends Listener = Listener> {
  addListener(fn: F): void;
  removeListener(fn: F): void;
  hasListener(fn: F): boolean;
  hasListeners(): boolean;
  /** Fires every listener with `args`; returns their return values. */
  dispatch(...args: Parameters<F>): ReturnType<F>[];
  listeners(): F[];
}

export function createEvent<F extends Listener = Listener>(): MockEvent<F> {
  const fns = new Set<F>();
  return {
    addListener(fn) {
      fns.add(fn);
    },
    removeListener(fn) {
      fns.delete(fn);
    },
    hasListener(fn) {
      return fns.has(fn);
    },
    hasListeners() {
      return fns.size > 0;
    },
    dispatch(...args) {
      return [...fns].map((fn) => fn(...args) as ReturnType<F>);
    },
    listeners() {
      return [...fns];
    },
  };
}

function clone<T>(v: T): T {
  if (v === undefined) return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

type Cb<T> = ((value: T) => void) | undefined;

function maybeCallback<T>(result: T, cb: Cb<T>): Promise<T> | void {
  if (typeof cb === 'function') {
    cb(result);
    return undefined;
  }
  return Promise.resolve(result);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface MockStorageArea {
  data: Map<string, unknown>;
  get(keys?: string | string[] | Record<string, unknown> | null, cb?: Cb<Record<string, unknown>>): Promise<Record<string, unknown>> | void;
  set(items: Record<string, unknown>, cb?: Cb<void>): Promise<void> | void;
  remove(keys: string | string[], cb?: Cb<void>): Promise<void> | void;
  clear(cb?: Cb<void>): Promise<void> | void;
  getBytesInUse(keys?: string | string[] | null, cb?: Cb<number>): Promise<number> | void;
  onChanged: MockEvent<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void>;
  setAccessLevel?: (opts: { accessLevel: string }, cb?: Cb<void>) => Promise<void> | void;
  /** Access level last requested via setAccessLevel, or null. */
  accessLevel: string | null;
  /** Number of set() calls so far. */
  writes: number;
}

function createStorageArea(name: string, root: MockEvent, withAccessLevel: boolean): MockStorageArea {
  const data = new Map<string, unknown>();
  const onChanged = createEvent<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void>();
  const area: MockStorageArea = {
    data,
    accessLevel: null,
    writes: 0,
    onChanged,
    get(keys, cb) {
      const out: Record<string, unknown> = {};
      if (keys === undefined || keys === null) {
        for (const [k, v] of data) out[k] = clone(v);
      } else if (typeof keys === 'string') {
        if (data.has(keys)) out[keys] = clone(data.get(keys));
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
      } else {
        for (const [k, dflt] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : clone(dflt);
      }
      return maybeCallback(out, cb);
    },
    set(items, cb) {
      area.writes++;
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        const oldValue = data.has(k) ? clone(data.get(k)) : undefined;
        const newValue = clone(v);
        data.set(k, newValue);
        changes[k] = oldValue === undefined ? { newValue: clone(newValue) } : { oldValue, newValue: clone(newValue) };
      }
      onChanged.dispatch(changes);
      root.dispatch(changes, name);
      return maybeCallback(undefined, cb);
    },
    remove(keys, cb) {
      const list = typeof keys === 'string' ? [keys] : keys;
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of list) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: clone(data.get(k)) };
        data.delete(k);
      }
      if (Object.keys(changes).length > 0) {
        onChanged.dispatch(changes);
        root.dispatch(changes, name);
      }
      return maybeCallback(undefined, cb);
    },
    clear(cb) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of data) changes[k] = { oldValue: clone(v) };
      data.clear();
      if (Object.keys(changes).length > 0) {
        onChanged.dispatch(changes);
        root.dispatch(changes, name);
      }
      return maybeCallback(undefined, cb);
    },
    getBytesInUse(_keys, cb) {
      let n = 0;
      for (const v of data.values()) n += JSON.stringify(v).length;
      return maybeCallback(n, cb);
    },
  };
  if (withAccessLevel) {
    area.setAccessLevel = (opts, cb) => {
      area.accessLevel = opts.accessLevel;
      return maybeCallback(undefined, cb);
    };
  }
  return area;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface MockPort {
  name: string;
  sender?: MockMessageSender;
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: MockEvent<(msg: unknown, port: MockPort) => void>;
  onDisconnect: MockEvent<(port: MockPort) => void>;
  /** Every message this side received, in order (test convenience). */
  received: unknown[];
  /** True once either side disconnected. */
  readonly closed: boolean;
}

export interface MockMessageSender {
  id?: string;
  tab?: { id: number; windowId?: number; url?: string; active?: boolean; index?: number };
  frameId?: number;
  url?: string;
  origin?: string;
  documentId?: string;
}

export interface PortPair {
  /** The end the service worker receives in `runtime.onConnect`. */
  worker: MockPort;
  /** The end the connecting page/content script holds. */
  client: MockPort;
}

export function createPortPair(name: string, sender?: MockMessageSender): PortPair {
  let closed = false;
  const make = (): MockPort => {
    const self: MockPort = {
      name,
      received: [],
      onMessage: createEvent(),
      onDisconnect: createEvent(),
      get closed() {
        return closed;
      },
      postMessage(msg: unknown) {
        if (closed) throw new Error('Attempting to use a disconnected port object');
        const other = self === worker ? client : worker;
        const copy = clone(msg);
        other.received.push(copy);
        other.onMessage.dispatch(copy, other);
      },
      disconnect() {
        if (closed) return;
        closed = true;
        const other = self === worker ? client : worker;
        other.onDisconnect.dispatch(other);
      },
    };
    return self;
  };
  const worker = make();
  const client = make();
  if (sender) worker.sender = sender;
  return { worker, client };
}

// ---------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------

export interface MockTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  index?: number;
  title?: string;
}

export interface ChromeMockOptions {
  extensionId?: string;
  manifest?: Record<string, unknown>;
  /** Whether storage.local.setAccessLevel exists (Chrome 140+). Default true. */
  localSetAccessLevel?: boolean;
  platform?: { os: string; arch: string; nacl_arch: string };
  tabs?: MockTab[];
}

export interface ChromeMock {
  chrome: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  storage: { local: MockStorageArea; session: MockStorageArea; onChanged: MockEvent };
  runtime: {
    id: string;
    onConnect: MockEvent<(port: MockPort) => void>;
    onMessage: MockEvent<(msg: unknown, sender: MockMessageSender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>;
    onMessageExternal: MockEvent<(msg: unknown, sender: MockMessageSender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>;
    onInstalled: MockEvent<(details: { reason: string; previousVersion?: string }) => void>;
    onStartup: MockEvent<() => void>;
    getPlatformInfoCalls: number;
    openOptionsPageCalls: number;
    sendMessageCalls: unknown[];
  };
  alarms: { created: Map<string, { periodInMinutes?: number; delayInMinutes?: number; when?: number }>; onAlarm: MockEvent<(alarm: { name: string }) => void>; cleared: string[] };
  tabs: { list: MockTab[]; created: Record<string, unknown>[]; onActivated: MockEvent; onUpdated: MockEvent; onRemoved: MockEvent; sent: { tabId: number; msg: unknown }[] };
  windows: { lastFocusedId: number; onFocusChanged: MockEvent };
  scripting: { executed: Record<string, unknown>[]; failFor: Set<number> };
  sidePanel: { opened: Record<string, unknown>[]; behavior: Record<string, unknown> | null; options: Record<string, unknown>[] };
  commands: { onCommand: MockEvent<(command: string, tab?: MockTab) => void> };
  action: { badges: Record<string, unknown>[]; titles: Record<string, unknown>[] };
  /** Connects a client to the worker: dispatches runtime.onConnect with the worker end and returns both ends. */
  connect(name: string, sender?: MockMessageSender): PortPair;
  /** chrome.runtime.sendMessage from a page or content script; resolves with the handler's response. */
  sendMessage(msg: unknown, sender?: MockMessageSender): Promise<unknown>;
  /** A web page's chrome.runtime.sendMessage(extensionId, msg): fires onMessageExternal. */
  sendExternalMessage(msg: unknown, sender: MockMessageSender): Promise<unknown>;
  fireAlarm(name: string): void;
  /** Lets pending promises and timers (0 ms) settle. */
  flush(rounds?: number): Promise<void>;
  /** Removes globalThis.chrome and clears state. */
  uninstall(): void;
}

export function createChromeMock(opts: ChromeMockOptions = {}): ChromeMock {
  const extensionId = opts.extensionId ?? 'mockextensionidmockextensionidab';
  const manifest = opts.manifest ?? { manifest_version: 3, name: 'Jammarly', version: '0.1.0' };
  const rootChanged = createEvent();
  const local = createStorageArea('local', rootChanged, opts.localSetAccessLevel ?? true);
  const session = createStorageArea('session', rootChanged, true);

  const runtimeState = {
    id: extensionId,
    onConnect: createEvent<(port: MockPort) => void>(),
    onMessage: createEvent<(msg: unknown, sender: MockMessageSender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>(),
    onMessageExternal: createEvent<(msg: unknown, sender: MockMessageSender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>(),
    onInstalled: createEvent<(details: { reason: string; previousVersion?: string }) => void>(),
    onStartup: createEvent<() => void>(),
    getPlatformInfoCalls: 0,
    openOptionsPageCalls: 0,
    sendMessageCalls: [] as unknown[],
  };
  const alarmsState = {
    created: new Map<string, { periodInMinutes?: number; delayInMinutes?: number; when?: number }>(),
    onAlarm: createEvent<(alarm: { name: string }) => void>(),
    cleared: [] as string[],
  };
  const tabsState = {
    list: opts.tabs ? opts.tabs.map((t) => ({ ...t })) : [{ id: 1, windowId: 1, url: 'https://example.com/', active: true }],
    created: [] as Record<string, unknown>[],
    onActivated: createEvent(),
    onUpdated: createEvent(),
    onRemoved: createEvent(),
    sent: [] as { tabId: number; msg: unknown }[],
  };
  const windowsState = { lastFocusedId: 1, onFocusChanged: createEvent() };
  const scriptingState = { executed: [] as Record<string, unknown>[], failFor: new Set<number>() };
  const sidePanelState = { opened: [] as Record<string, unknown>[], behavior: null as Record<string, unknown> | null, options: [] as Record<string, unknown>[] };
  const commandsState = { onCommand: createEvent<(command: string, tab?: MockTab) => void>() };
  const actionState = { badges: [] as Record<string, unknown>[], titles: [] as Record<string, unknown>[] };
  let nextTabId = 100;

  const dispatchMessage = (
    event: MockEvent<(msg: unknown, sender: MockMessageSender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>,
    msg: unknown,
    sender: MockMessageSender,
  ): Promise<unknown> =>
    new Promise((resolve) => {
      let settled = false;
      const sendResponse = (r: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(clone(r));
      };
      const results = event.dispatch(clone(msg), sender, sendResponse);
      const keepOpen = results.some((r) => r === true || (r !== null && typeof r === 'object' && typeof (r as Promise<unknown>).then === 'function'));
      for (const r of results) {
        if (r !== null && typeof r === 'object' && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).then(sendResponse, () => sendResponse(undefined));
        }
      }
      if (!keepOpen && !settled) {
        settled = true;
        resolve(undefined);
      }
    });

  const chromeObj = {
    storage: {
      local,
      session,
      onChanged: rootChanged,
      AccessLevel: { TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS', TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' },
    },
    runtime: {
      id: extensionId,
      lastError: undefined as { message: string } | undefined,
      getManifest: () => clone(manifest),
      getURL: (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\/+/, '')}`,
      connect: (a?: unknown, b?: unknown) => {
        const info = (typeof a === 'string' ? b : a) as { name?: string } | undefined;
        const pair = createPortPair(info?.name ?? '', { id: extensionId, url: `chrome-extension://${extensionId}/sidepanel/sidepanel.html` });
        runtimeState.onConnect.dispatch(pair.worker);
        return pair.client;
      },
      onConnect: runtimeState.onConnect,
      onMessage: runtimeState.onMessage,
      onMessageExternal: runtimeState.onMessageExternal,
      onInstalled: runtimeState.onInstalled,
      onStartup: runtimeState.onStartup,
      onSuspend: createEvent(),
      sendMessage: (...args: unknown[]) => {
        runtimeState.sendMessageCalls.push(args);
        const msg = typeof args[0] === 'string' ? args[1] : args[0];
        return dispatchMessage(runtimeState.onMessage, msg, { id: extensionId, url: `chrome-extension://${extensionId}/popup/popup.html` });
      },
      getPlatformInfo: (cb?: Cb<unknown>) => {
        runtimeState.getPlatformInfoCalls++;
        return maybeCallback(opts.platform ?? { os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' }, cb);
      },
      openOptionsPage: (cb?: Cb<void>) => {
        runtimeState.openOptionsPageCalls++;
        return maybeCallback(undefined, cb);
      },
    },
    alarms: {
      create: (a: unknown, b?: unknown, cb?: Cb<void>) => {
        const name = typeof a === 'string' ? a : '';
        const info = (typeof a === 'string' ? b : a) as { periodInMinutes?: number; delayInMinutes?: number; when?: number };
        alarmsState.created.set(name, { ...info });
        return maybeCallback(undefined, cb);
      },
      clear: (name?: string, cb?: Cb<boolean>) => {
        const existed = alarmsState.created.delete(name ?? '');
        alarmsState.cleared.push(name ?? '');
        return maybeCallback(existed, cb);
      },
      clearAll: (cb?: Cb<boolean>) => {
        alarmsState.created.clear();
        return maybeCallback(true, cb);
      },
      get: (name: string, cb?: Cb<unknown>) => {
        const a = alarmsState.created.get(name);
        return maybeCallback(a ? { name, ...a, scheduledTime: Date.now() + 60_000 } : undefined, cb);
      },
      getAll: (cb?: Cb<unknown[]>) => maybeCallback([...alarmsState.created.entries()].map(([name, a]) => ({ name, ...a })), cb),
      onAlarm: alarmsState.onAlarm,
    },
    tabs: {
      query: (q: Record<string, unknown>, cb?: Cb<MockTab[]>) => {
        let out = tabsState.list;
        if (q.active !== undefined) out = out.filter((t) => t.active === q.active);
        if (q.lastFocusedWindow === true || q.currentWindow === true) out = out.filter((t) => t.windowId === windowsState.lastFocusedId);
        if (typeof q.windowId === 'number') out = out.filter((t) => t.windowId === q.windowId);
        if (typeof q.url === 'string') {
          const pats = [q.url];
          out = out.filter((t) => pats.some((p) => matchUrlPattern(p, t.url)));
        } else if (Array.isArray(q.url)) {
          const pats = q.url as string[];
          out = out.filter((t) => pats.some((p) => matchUrlPattern(p, t.url)));
        }
        return maybeCallback(out.map((t) => ({ ...t })), cb);
      },
      get: (tabId: number, cb?: Cb<MockTab | undefined>) => maybeCallback(tabsState.list.find((t) => t.id === tabId), cb),
      create: (props: Record<string, unknown>, cb?: Cb<MockTab>) => {
        tabsState.created.push({ ...props });
        const tab: MockTab = { id: nextTabId++, windowId: windowsState.lastFocusedId, url: String(props.url ?? ''), active: props.active !== false };
        tabsState.list.push(tab);
        return maybeCallback({ ...tab }, cb);
      },
      sendMessage: (tabId: number, msg: unknown, _opts?: unknown, cb?: Cb<unknown>) => {
        tabsState.sent.push({ tabId, msg: clone(msg) });
        return maybeCallback(undefined, typeof _opts === 'function' ? (_opts as Cb<unknown>) : cb);
      },
      onActivated: tabsState.onActivated,
      onUpdated: tabsState.onUpdated,
      onRemoved: tabsState.onRemoved,
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      WINDOW_ID_NONE: -1,
      getLastFocused: (_q?: unknown, cb?: Cb<unknown>) => maybeCallback({ id: windowsState.lastFocusedId, focused: true }, typeof _q === 'function' ? (_q as Cb<unknown>) : cb),
      getCurrent: (_q?: unknown, cb?: Cb<unknown>) => maybeCallback({ id: windowsState.lastFocusedId, focused: true }, typeof _q === 'function' ? (_q as Cb<unknown>) : cb),
      onFocusChanged: windowsState.onFocusChanged,
    },
    scripting: {
      executeScript: (injection: { target: { tabId: number; allFrames?: boolean }; files?: string[] }) => {
        scriptingState.executed.push(clone(injection) as unknown as Record<string, unknown>);
        if (scriptingState.failFor.has(injection.target.tabId)) return Promise.reject(new Error('Cannot access contents of the page'));
        return Promise.resolve([{ frameId: 0, result: undefined }]);
      },
    },
    sidePanel: {
      open: (o: Record<string, unknown>) => {
        sidePanelState.opened.push({ ...o });
        return Promise.resolve();
      },
      setPanelBehavior: (b: Record<string, unknown>) => {
        sidePanelState.behavior = { ...b };
        return Promise.resolve();
      },
      setOptions: (o: Record<string, unknown>) => {
        sidePanelState.options.push({ ...o });
        return Promise.resolve();
      },
      getOptions: () => Promise.resolve({ enabled: true }),
    },
    commands: { onCommand: commandsState.onCommand, getAll: () => Promise.resolve([]) },
    action: {
      setBadgeText: (d: Record<string, unknown>) => {
        actionState.badges.push({ ...d });
        return Promise.resolve();
      },
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: (d: Record<string, unknown>) => {
        actionState.titles.push({ ...d });
        return Promise.resolve();
      },
      setIcon: () => Promise.resolve(),
    },
  };

  const mock: ChromeMock = {
    chrome: chromeObj,
    storage: { local, session, onChanged: rootChanged },
    runtime: runtimeState,
    alarms: alarmsState,
    tabs: tabsState,
    windows: windowsState,
    scripting: scriptingState,
    sidePanel: sidePanelState,
    commands: commandsState,
    action: actionState,
    connect(name, sender) {
      const pair = createPortPair(name, sender);
      runtimeState.onConnect.dispatch(pair.worker);
      return pair;
    },
    sendMessage(msg, sender) {
      return dispatchMessage(runtimeState.onMessage, msg, sender ?? { id: extensionId, url: `chrome-extension://${extensionId}/popup/popup.html` });
    },
    sendExternalMessage(msg, sender) {
      return dispatchMessage(runtimeState.onMessageExternal, msg, sender);
    },
    fireAlarm(name) {
      alarmsState.onAlarm.dispatch({ name });
    },
    async flush(rounds = 4) {
      for (let i = 0; i < rounds; i++) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    },
    uninstall() {
      const g = globalThis as { chrome?: unknown };
      if (g.chrome === chromeObj) delete g.chrome;
    },
  };
  return mock;
}

function matchUrlPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`).test(url);
}

/** Creates a mock and installs it as `globalThis.chrome`. */
export function installChromeMock(opts: ChromeMockOptions = {}): ChromeMock {
  const mock = createChromeMock(opts);
  (globalThis as { chrome?: unknown }).chrome = mock.chrome;
  return mock;
}
