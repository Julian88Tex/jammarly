/**
 * Field registry (ARCHITECTURE §3.1, §3.4, §3.8): document `focusin` (capture) → findEditable → classify → site
 * profile → adapter → one FieldSession per element; `pointerdown` inside an already-focused editable attaches too;
 * removed elements are detached after a grace period. Owns the port (hello, re-sends on reconnect), the overlay and
 * the config broadcast. Instance marker `<html data-jammarly-instance="<id>:<version>">`: a newer instance dispatches
 * `jammarly:takeover` and the orphan disposes everything. Google Docs: the `jammarly:gdocs-status` CustomEvent from
 * the MAIN-world bridge either attaches the gdocs adapter (when one is registered and the bridge is active) or shows
 * the "not supported inline" state on a sentinel overlay.
 */
import type { ContentToWorker, EffectiveConfig, FieldKind, RuntimeRequest, WorkerToContent } from '@jammarly/shared/types';
import type { Classification, ClassifyOptions } from '../detect';
import type { FieldAdapter, SiteProfile } from '../field-adapter';
import type { CreateOverlay, FieldOverlay, Overlay, OverlayEvents } from '../ui/overlay-api';
import { PortClient } from './port-client';
import { FieldSession, overlayOptionsFor } from './session';
import { extensionVersion, randomToken, realTimers, safeRuntime, type RuntimeLike, type Timers } from './util';

export const INSTANCE_ATTR = 'data-jammarly-instance';
export const TAKEOVER_EVENT = 'jammarly:takeover';
export const GDOCS_STATUS_EVENT = 'jammarly:gdocs-status';
export const DETACH_SWEEP_MS = 2000;
export const DETACH_GRACE_MS = 1500;
export const GDOCS_ACTIVATION_WAIT_MS = 3000;
export const GDOCS_EDITOR_SELECTOR = '.kix-appview-editor, #docs-editor-container, #docs-editor';
export const OPT_OUT_REASON = 'Disabled by this site (opted out)';
export const GDOCS_UNSUPPORTED_REASON = "Google Docs isn't supported inline. Use the side panel to check your text.";

export type AdapterFactory = (el: HTMLElement, profile: SiteProfile) => FieldAdapter;

export interface ControllerDeps {
  findEditable(target: EventTarget | null): HTMLElement | null;
  classify(el: HTMLElement, opts: ClassifyOptions): Classification;
  fieldLabel(el: HTMLElement, profile?: Pick<SiteProfile, 'bodySelectors'> | null): string;
  resolveProfile(host: string, el: HTMLElement): SiteProfile;
  createAdapter(el: HTMLElement, profile: SiteProfile): FieldAdapter;
  createOverlay: CreateOverlay;
  /** Google Docs adapter factory (`adapterFactories.gdocs`), looked up when the bridge reports it is active. */
  gdocsAdapter?: () => AdapterFactory | undefined;
  runtime?: () => RuntimeLike | undefined;
  sendRuntime?: (msg: RuntimeRequest) => void;
  doc?: Document;
  win?: Window | null;
  timers?: Timers;
  /** Instance marker; defaults to `${chrome.runtime.id}:${version}`. */
  instance?: string;
  backoffMs?: readonly number[];
}

export function instanceId(runtimeId: string, version: string): string {
  return `${runtimeId}:${version}`;
}

export function isGoogleDocsDocument(loc: Pick<Location, 'hostname' | 'pathname'>): boolean {
  return loc.hostname === 'docs.google.com' && loc.pathname.startsWith('/document');
}

/** Conservative config used until the worker's first `config` message: rules on, nothing leaves the device. */
export function defaultConfig(host: string): EffectiveConfig {
  return {
    enabled: true,
    enabledOnHost: true,
    host,
    context: 'other',
    mode: 'hybrid',
    goals: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' },
    dialect: 'en-US',
    categories: { correctness: true, clarity: true, engagement: true, delivery: true },
    debounceMs: 700,
    fastPassIdleMs: 700,
    deepPassIdleMs: 2500,
    showFloatingButton: true,
    showUnderlines: true,
    colorblindMode: false,
    shortcutSafeMode: false,
    ignoreSiteOptOut: false,
    checkOptedOutFields: false,
    mutedRules: [],
    demotedRules: [],
    dictionary: [],
    styleDecisions: {},
    storeSnippets: false,
    engineReady: false,
    consented: false,
    budgetExhausted: false,
    gdocsAnnounceId: '',
    gdocsInline: 'auto',
    userSalt: '',
  };
}

function defaultSendRuntime(msg: RuntimeRequest): void {
  try {
    const rt = safeRuntime();
    const result = rt?.sendMessage?.(msg);
    if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => undefined);
  } catch {
    // extension context gone
  }
}

/** A geometry-only adapter for containers we never read or write (Google Docs sentinel). */
export function createSentinelAdapter(el: HTMLElement, kind: FieldKind = 'gdocs'): FieldAdapter {
  return {
    kind,
    element: el,
    getLabel: () => 'Document',
    getDocHint: () => '',
    getText: () => '',
    getRangeRects: () => [],
    getProtectedRanges: () => [],
    applyEdit: async () => ({ status: 'unsupported', rung: null, text: '' }),
    applyEdits: async (edits) => ({ applied: [], skipped: edits.map((edit) => ({ edit, reason: 'unsupported' as const })), text: '', nativeUndoSteps: 0 }),
    getSelection: () => null,
    setSelection: () => undefined,
    isComposing: () => false,
    isFocused: () => false,
    focus: () => undefined,
    onChange: () => () => undefined,
    onLayout: () => () => undefined,
    onFocusChange: () => () => undefined,
    getBox: () => el.getBoundingClientRect(),
    dispose: () => undefined,
  };
}

interface Sentinel {
  fieldId: string;
  element: HTMLElement;
  adapter: FieldAdapter;
  ui: FieldOverlay;
  reason: string;
  kind: 'opt-out' | 'gdocs';
}

export class Registry {
  private readonly deps: ControllerDeps;
  private readonly doc: Document;
  private readonly win: Window | null;
  private readonly timers: Timers;
  private readonly instance: string;
  private readonly frameToken = randomToken(6);
  private readonly sendRuntime: (msg: RuntimeRequest) => void;
  private readonly sessions = new Map<HTMLElement, FieldSession>();
  private readonly byId = new Map<string, FieldSession>();
  private readonly sentinels = new Map<HTMLElement, Sentinel>();
  private readonly disconnectedSince = new Map<HTMLElement, number>();
  private config: EffectiveConfig;
  private configReceivedFlag = false;
  private overlay: Overlay | null = null;
  private port: PortClient | null = null;
  private sweepTimer: unknown = null;
  private gdocsTimer: unknown = null;
  private gdocsDecided = false;
  private localIgnoreOptOut = false;
  private counter = 0;
  private started = false;
  private booted = false;
  private disposed = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.doc = deps.doc ?? document;
    this.win = deps.win === undefined ? (this.doc.defaultView ?? (typeof window === 'undefined' ? null : window)) : deps.win;
    this.timers = deps.timers ?? realTimers;
    const rt = (deps.runtime ?? safeRuntime)();
    this.instance = deps.instance ?? instanceId(rt?.id ?? 'dev', extensionVersion());
    this.sendRuntime = deps.sendRuntime ?? defaultSendRuntime;
    this.config = defaultConfig(this.host);
  }

  get host(): string {
    return this.doc.location?.hostname ?? '';
  }

  get origin(): string {
    return this.doc.location?.origin ?? '';
  }

  get instanceMarker(): string {
    return this.instance;
  }

  get currentConfig(): EffectiveConfig {
    return this.config;
  }

  get configReceived(): boolean {
    return this.configReceivedFlag;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get portClient(): PortClient | null {
    return this.port;
  }

  sessionFor(el: HTMLElement): FieldSession | undefined {
    return this.sessions.get(el);
  }

  sessionById(fieldId: string): FieldSession | undefined {
    return this.byId.get(fieldId);
  }

  sentinelFor(el: HTMLElement): { fieldId: string; reason: string } | undefined {
    const s = this.sentinels.get(el);
    return s ? { fieldId: s.fieldId, reason: s.reason } : undefined;
  }

  /**
   * Marks the document and starts. Returns false when the same instance is already running in this document (a
   * duplicate injection). An older instance is asked to leave (`jammarly:takeover`) and boot happens a tick later.
   */
  start(): boolean {
    if (this.started || this.disposed) return false;
    const html = this.doc.documentElement;
    if (!html) return false;
    const existing = html.getAttribute(INSTANCE_ATTR);
    if (existing === this.instance) return false;
    this.started = true;
    this.doc.addEventListener(TAKEOVER_EVENT, this.onTakeover, true);
    if (existing && existing !== this.instance) {
      html.dispatchEvent(new CustomEvent(TAKEOVER_EVENT, { detail: { instance: this.instance } }));
      this.timers.setTimeout(() => this.boot(), 0);
      return true;
    }
    this.boot();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.doc.removeEventListener(TAKEOVER_EVENT, this.onTakeover, true);
    this.doc.removeEventListener('focusin', this.onFocusIn, true);
    this.doc.removeEventListener('pointerdown', this.onPointerDown, true);
    this.doc.removeEventListener(GDOCS_STATUS_EVENT, this.onGdocsStatus, true);
    this.win?.removeEventListener('pagehide', this.onPageHide);
    if (this.sweepTimer !== null) this.timers.clearInterval(this.sweepTimer);
    if (this.gdocsTimer !== null) this.timers.clearTimeout(this.gdocsTimer);
    this.sweepTimer = null;
    this.gdocsTimer = null;
    for (const session of [...this.sessions.values()]) this.safely(() => session.dispose());
    this.sessions.clear();
    this.byId.clear();
    for (const sentinel of [...this.sentinels.values()]) this.disposeSentinel(sentinel);
    this.sentinels.clear();
    this.safely(() => this.overlay?.dispose());
    this.overlay = null;
    this.port?.dispose();
    this.port = null;
    const html = this.doc.documentElement;
    if (html && html.getAttribute(INSTANCE_ATTR) === this.instance) html.removeAttribute(INSTANCE_ATTR);
  }

  /** Attach (or reuse) a session for an editable element. Returns the session, or null when ineligible. */
  attach(el: HTMLElement): FieldSession | null {
    if (this.disposed || !this.booted || !this.overlay) return null;
    const existing = this.sessions.get(el);
    if (existing) return existing;
    if (this.sentinels.has(el)) return null;
    let profile: SiteProfile;
    try {
      profile = this.deps.resolveProfile(this.host, el);
    } catch {
      return null;
    }
    const classification = this.deps.classify(el, {
      checkOptedOutFields: this.config.checkOptedOutFields,
      ignoreSiteOptOut: profile.ignoreOptOut || this.config.ignoreSiteOptOut || this.localIgnoreOptOut,
    });
    if (!classification.ok) {
      if (classification.reason === 'opted-out') this.attachSentinel(el, OPT_OUT_REASON, 'opt-out', () => this.deps.createAdapter(el, profile));
      return null;
    }
    let adapter: FieldAdapter;
    try {
      adapter = this.deps.createAdapter(el, profile);
    } catch {
      return null;
    }
    return this.createSession(el, adapter, profile, classification.kind, this.safeLabel(el, profile));
  }

  /** Detach the session (or sentinel) for an element. */
  detach(el: HTMLElement): void {
    const session = this.sessions.get(el);
    if (session) {
      this.sessions.delete(el);
      this.byId.delete(session.fieldId);
      this.disconnectedSince.delete(el);
      this.safely(() => session.dispose());
    }
    const sentinel = this.sentinels.get(el);
    if (sentinel) {
      this.sentinels.delete(el);
      this.disposeSentinel(sentinel);
    }
  }

  /** Worker → content. Config is applied to every session; everything else is routed by fieldId. */
  handleWorkerMessage(msg: WorkerToContent): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'config':
        this.config = msg.config;
        this.configReceivedFlag = true;
        this.overlay?.setOptions({
          theme: { colorblindMode: msg.config.colorblindMode },
          showFloatingButton: msg.config.showFloatingButton,
          showUnderlines: msg.config.showUnderlines,
        });
        for (const session of [...this.sessions.values()]) session.configChanged();
        return;
      case 'check-progress':
      case 'check-result':
      case 'tone': {
        const fieldId = msg.type === 'check-result' ? msg.result.fieldId : msg.fieldId;
        this.byId.get(fieldId)?.handleMessage(msg);
        return;
      }
      case 'panel-action':
        this.byId.get(msg.action.fieldId)?.handlePanelAction(msg.action);
        return;
      default:
        return;
    }
  }

  /** Removes sessions whose element left the document (after the grace period). */
  sweep(): void {
    if (this.disposed) return;
    const now = this.timers.now();
    const check = (el: HTMLElement): boolean => {
      if (el.isConnected) {
        this.disconnectedSince.delete(el);
        return false;
      }
      const since = this.disconnectedSince.get(el);
      if (since === undefined) {
        this.disconnectedSince.set(el, now);
        return false;
      }
      return now - since >= DETACH_GRACE_MS;
    };
    for (const el of [...this.sessions.keys()]) if (check(el)) this.detach(el);
    for (const el of [...this.sentinels.keys()]) if (check(el)) this.detach(el);
  }

  /** The Google Docs bridge reported whether the annotated-text API is active for our id. */
  gdocsStatus(active: boolean): void {
    if (this.disposed || this.gdocsDecided || !this.booted) return;
    if (active) {
      this.decideGdocs(true);
      return;
    }
    if (this.gdocsTimer === null) this.gdocsTimer = this.timers.setTimeout(() => this.decideGdocs(false), GDOCS_ACTIVATION_WAIT_MS);
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private boot(): void {
    if (this.disposed || this.booted) return;
    this.booted = true;
    const html = this.doc.documentElement;
    html?.setAttribute(INSTANCE_ATTR, this.instance);
    this.overlay = this.deps.createOverlay(this.overlayEvents());
    this.overlay.setOptions({ theme: { colorblindMode: this.config.colorblindMode }, showFloatingButton: this.config.showFloatingButton, showUnderlines: this.config.showUnderlines });
    this.doc.addEventListener('focusin', this.onFocusIn, true);
    this.doc.addEventListener('pointerdown', this.onPointerDown, true);
    this.win?.addEventListener('pagehide', this.onPageHide);
    if (this.doc.location && isGoogleDocsDocument(this.doc.location)) this.doc.addEventListener(GDOCS_STATUS_EVENT, this.onGdocsStatus, true);
    this.sweepTimer = this.timers.setInterval(() => this.sweep(), DETACH_SWEEP_MS);
    this.port = new PortClient({
      runtime: this.deps.runtime,
      onMessage: (msg) => this.handleWorkerMessage(msg),
      onConnected: (reconnect) => this.onConnected(reconnect),
      onInvalidated: () => this.dispose(),
      timers: this.timers,
      win: this.win,
      ...(this.deps.backoffMs ? { backoffMs: this.deps.backoffMs } : {}),
    });
    this.port.connect();
    // A field focused before we started never fires focusin: attach it now.
    const active = this.deepActiveElement();
    if (active) {
      const el = this.deps.findEditable(active);
      if (el) this.attach(el);
    }
  }

  private onConnected(reconnect: boolean): void {
    if (this.disposed) return;
    this.send({
      type: 'hello',
      role: 'content',
      host: this.host,
      href: this.doc.location?.href ?? '',
      frameToken: this.frameToken,
      extVersion: extensionVersion(),
    });
    for (const session of this.sessions.values()) {
      this.send({ type: 'field-attached', fieldId: session.fieldId, fieldKind: session.kind, label: session.label, docKey: session.docKey });
      if (reconnect) session.resendOutstanding();
    }
  }

  private send(msg: ContentToWorker): boolean {
    return this.port ? this.port.send(msg) : false;
  }

  private createSession(el: HTMLElement, adapter: FieldAdapter, profile: SiteProfile, kind: FieldKind, label: string): FieldSession | null {
    if (!this.overlay) return null;
    const fieldId = `${this.frameToken}-${++this.counter}`;
    let session: FieldSession;
    try {
      session = new FieldSession({
        fieldId,
        element: el,
        adapter,
        profile,
        kind,
        label,
        host: this.host,
        origin: this.origin,
        overlay: this.overlay,
        getConfig: () => this.config,
        configReceived: () => this.configReceivedFlag,
        send: (msg) => this.send(msg),
        sendRuntime: (msg) => this.sendRuntime(msg),
        setOutstanding: (key, outstanding) => this.port?.setOutstanding(key, outstanding),
        timers: this.timers,
      });
    } catch {
      this.safely(() => adapter.dispose());
      return null;
    }
    this.sessions.set(el, session);
    this.byId.set(fieldId, session);
    return session;
  }

  private attachSentinel(el: HTMLElement, reason: string, kind: Sentinel['kind'], makeAdapter: () => FieldAdapter): Sentinel | null {
    if (!this.overlay || this.sentinels.has(el)) return null;
    let adapter: FieldAdapter;
    try {
      adapter = makeAdapter();
    } catch {
      adapter = createSentinelAdapter(el, kind === 'gdocs' ? 'gdocs' : 'contenteditable');
    }
    const fieldId = `${this.frameToken}-${++this.counter}`;
    const profile = this.safeProfile(el);
    const ui = this.overlay.attach(fieldId, adapter, overlayOptionsFor(this.config, profile));
    ui.setUnsupported(reason);
    ui.setStatus('unsupported', { grammar: 0, style: 0, rewrites: 0 }, 'rules');
    ui.setFieldBox(this.safely(() => adapter.getBox()) ?? new DOMRect());
    const sentinel: Sentinel = { fieldId, element: el, adapter, ui, reason, kind };
    this.sentinels.set(el, sentinel);
    return sentinel;
  }

  private disposeSentinel(sentinel: Sentinel): void {
    this.safely(() => this.overlay?.detach(sentinel.fieldId));
    this.safely(() => sentinel.adapter.dispose());
  }

  /** "Check here anyway" on an opted-out field: ignore the opt-out for this page and attach for real. */
  private checkHereAnyway(fieldId: string): void {
    for (const [el, sentinel] of this.sentinels) {
      if (sentinel.fieldId !== fieldId) continue;
      this.sentinels.delete(el);
      this.disposeSentinel(sentinel);
      if (sentinel.kind === 'opt-out') {
        this.localIgnoreOptOut = true;
        this.attach(el);
      }
      return;
    }
  }

  private decideGdocs(active: boolean): void {
    if (this.disposed || this.gdocsDecided) return;
    this.gdocsDecided = true;
    if (this.gdocsTimer !== null) this.timers.clearTimeout(this.gdocsTimer);
    this.gdocsTimer = null;
    const container = this.doc.querySelector<HTMLElement>(GDOCS_EDITOR_SELECTOR) ?? this.doc.body;
    if (!container) return;
    const factory = active && this.config.gdocsInline !== 'off' ? this.deps.gdocsAdapter?.() : undefined;
    if (factory) {
      const profile = this.safeProfile(container);
      let adapter: FieldAdapter | null = null;
      try {
        adapter = factory(container, profile);
      } catch {
        adapter = null;
      }
      if (adapter && this.createSession(container, adapter, profile, 'gdocs', 'Document')) return;
    }
    this.attachSentinel(container, GDOCS_UNSUPPORTED_REASON, 'gdocs', () => createSentinelAdapter(container, 'gdocs'));
  }

  private overlayEvents(): OverlayEvents {
    const session = (fieldId: string): FieldSession | undefined => this.byId.get(fieldId);
    return {
      onAccept: (fieldId, suggestionId, alternativeIndex) => {
        void session(fieldId)?.accept(suggestionId, alternativeIndex, 'card');
      },
      onDismiss: (fieldId, suggestionId, reason) => session(fieldId)?.dismiss(suggestionId, reason, 'card'),
      onAcceptAll: (fieldId, scope) => {
        void session(fieldId)?.acceptAll(scope, 'bulk');
      },
      onUndo: (fieldId, transactionId) => {
        void session(fieldId)?.undo(transactionId);
      },
      onAddToDictionary: (fieldId, word) => session(fieldId)?.addToDictionary(word),
      onMuteRule: (fieldId, rule, scope) => session(fieldId)?.muteRule(rule, scope),
      onReportIncorrect: (fieldId, suggestionId) => session(fieldId)?.reportIncorrect(suggestionId),
      onOpenPanel: () => this.sendRuntime({ type: 'open-side-panel' }),
      onToggleHost: (enabled) => {
        this.send({ type: 'toggle-host', enabled });
      },
      onToggleField: (fieldId, enabled) => session(fieldId)?.setFieldEnabled(enabled),
      onOpenSetup: () => this.sendRuntime({ type: 'open-options', hash: 'welcome' }),
      onCheckHereAnyway: (fieldId) => this.checkHereAnyway(fieldId),
      onRecheck: (fieldId) => session(fieldId)?.recheck(),
      onCardShown: (fieldId, suggestionId) => session(fieldId)?.cardShown(suggestionId),
      onCardHidden: (fieldId, suggestionId) => session(fieldId)?.cardHidden(suggestionId),
    };
  }

  private readonly onFocusIn = (ev: Event): void => {
    const el = this.editableFrom(ev);
    if (el) this.attach(el);
  };

  private readonly onPointerDown = (ev: Event): void => {
    const el = this.editableFrom(ev);
    if (!el || this.sessions.has(el)) return;
    const active = this.deepActiveElement();
    if (active && (active === el || el.contains(active))) this.attach(el);
  };

  private readonly onTakeover = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ instance?: string }>).detail;
    if (detail && detail.instance === this.instance) return;
    this.dispose();
  };

  private readonly onGdocsStatus = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ active?: boolean }>).detail;
    this.gdocsStatus(detail?.active === true);
  };

  private readonly onPageHide = (): void => {
    for (const session of this.sessions.values()) session.flushFeedback();
  };

  private editableFrom(ev: Event): HTMLElement | null {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const target = (path[0] ?? ev.target) as EventTarget | null;
    if (target && typeof (target as Node).getRootNode === 'function') {
      const root = (target as Node).getRootNode();
      const host = (root as ShadowRoot).host as Element | undefined;
      if (host && typeof host.tagName === 'string' && host.tagName.toLowerCase() === 'jammarly-root') return null;
    }
    try {
      return this.deps.findEditable(target);
    } catch {
      return null;
    }
  }

  private deepActiveElement(): Element | null {
    let active: Element | null = this.doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  private safeLabel(el: HTMLElement, profile: SiteProfile): string {
    try {
      return this.deps.fieldLabel(el, profile) || 'Text field';
    } catch {
      return 'Text field';
    }
  }

  private safeProfile(el: HTMLElement): SiteProfile {
    try {
      return this.deps.resolveProfile(this.host, el);
    } catch {
      return {
        id: 'generic',
        matches: () => true,
        context: 'other',
        shortcutSafe: false,
        ignoreOptOut: false,
        fastPassMultiplier: 1,
        deepPassMultiplier: 1,
        ladder: ['execCommand', 'beforeinput', 'paste', 'splice'],
        protectedSelectors: [],
        bodySelectors: [],
        docHint: () => '',
      };
    }
  }

  private safely<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }
}
