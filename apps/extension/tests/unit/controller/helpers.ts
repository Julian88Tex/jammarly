/**
 * Shared fakes for the controller unit tests: a chrome.runtime mock with linked fake ports, a text-backed FieldAdapter,
 * a recording Overlay/FieldOverlay pair, suggestion/config/result factories and a FieldSession harness. None of this
 * depends on the real adapters, sites or UI modules, so the controller tests run even while those change.
 */
import { vi } from 'vitest';
import type {
  BatchEditOutcome,
  CheckError,
  CheckPass,
  CheckResult,
  ContentToWorker,
  Edit,
  EditOutcome,
  EffectiveConfig,
  FieldKind,
  FieldStatus,
  RuntimeRequest,
  Suggestion,
  SuggestionCategory,
  SuggestionKind,
  SuggestionTier,
  TextRange,
  ToneAnalysis,
  WorkerToContent,
} from '@jammarly/shared/types';
import { splitParagraphs } from '@jammarly/shared/text';
import type { FieldAdapter, SiteProfile } from '../../../src/content/field-adapter';
import type { AcceptAllCounts, FieldOverlay, Overlay, OverlayEvents, OverlayOptions, UnderlineItem } from '../../../src/content/ui/overlay-api';
import { FieldSession } from '../../../src/content/controller/session';

export const FAKE_TIMER_APIS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;

// ---------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------

export function makeSuggestion(partial: Partial<Suggestion> & { id: string }): Suggestion {
  const original = partial.original ?? 'teh';
  const replacement = partial.replacement ?? 'the';
  const start = partial.range?.start ?? 0;
  const end = partial.range?.end ?? start + original.length;
  const kind: SuggestionKind = partial.kind ?? 'replace';
  const category: SuggestionCategory = partial.category ?? 'correctness';
  const tier: SuggestionTier = partial.tier ?? (kind === 'rewrite' || kind === 'flag' ? 'C' : category === 'correctness' ? 'A' : 'B');
  return {
    id: partial.id,
    category,
    rule: partial.rule ?? 'spelling',
    severity: partial.severity ?? 'error',
    kind,
    source: partial.source ?? 'llm',
    tier,
    anchor: partial.anchor ?? 'exact',
    range: { start, end },
    highlight: partial.highlight ?? { start, end },
    original,
    replacement,
    alternatives: partial.alternatives ?? [],
    title: partial.title ?? 'Correct the spelling',
    explanation: partial.explanation ?? 'This word is misspelled.',
    confidence: partial.confidence ?? 0.95,
    meaningPreserving: partial.meaningPreserving ?? true,
    autoApplySafe: partial.autoApplySafe ?? true,
    blockId: partial.blockId ?? 'b0',
    blockHash: partial.blockHash ?? 'h0',
    conflictsWith: partial.conflictsWith ?? [],
    stale: partial.stale ?? false,
    promptVersion: partial.promptVersion ?? 'v3',
    fingerprint: partial.fingerprint ?? `fp-${partial.id}`,
    learnedState: partial.learnedState ?? 'active',
    ...(partial.model ? { model: partial.model } : {}),
  };
}

/** A suggestion anchored at the first occurrence of `original` in `text`. */
export function sugAt(text: string, original: string, partial: Partial<Suggestion> & { id: string }): Suggestion {
  // Prefer a whole-word match (so a lone "i" is not found inside "Their"), then fall back to the first occurrence.
  const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = /^[\p{L}\p{N}']+$/u.test(original) ? new RegExp(`(?<![\\p{L}\\p{N}'])${escaped}(?![\\p{L}\\p{N}'])`, 'u').exec(text) : null;
  const start = word ? word.index : text.indexOf(original);
  if (start === -1) throw new Error(`"${original}" not in text`);
  const blocks = splitParagraphs(text);
  const block = blocks.find((b) => start >= b.start && start < b.start + b.text.length) ?? blocks[0];
  return makeSuggestion({
    ...partial,
    original,
    range: { start, end: start + original.length },
    highlight: partial.highlight ?? { start, end: start + original.length },
    blockId: block ? `b${block.index}` : 'b0',
    blockHash: block ? block.hash : 'h0',
  });
}

export function makeConfig(partial: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    enabled: true,
    enabledOnHost: true,
    host: 'example.com',
    context: 'email',
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
    storeSnippets: true,
    engineReady: true,
    consented: true,
    budgetExhausted: false,
    gdocsAnnounceId: '',
    gdocsInline: 'auto',
    userSalt: 'salt',
    ...partial,
  };
}

export function makeProfile(partial: Partial<SiteProfile> = {}): SiteProfile {
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
    ...partial,
  };
}

export function makeResult(fieldId: string, version: number, text: string, suggestions: Suggestion[], extra: Partial<CheckResult> = {}): CheckResult {
  const pass: CheckPass = extra.pass ?? 'fast';
  return {
    fieldId,
    version,
    pass,
    suggestions,
    fromCache: false,
    blocks: splitParagraphs(text)
      .filter((b) => b.text.trim().length > 0)
      .map((b) => ({ hash: b.hash, pass, fromCache: false })),
    ...extra,
  };
}

export function makeError(code: CheckError['code'], retryable = false): CheckError {
  return { code, message: code, retryable };
}

// ---------------------------------------------------------------------------------------------
// chrome.runtime mock with fake ports
// ---------------------------------------------------------------------------------------------

export class FakePort {
  readonly posted: unknown[] = [];
  disconnected = false;
  private readonly msgListeners = new Set<(msg: unknown) => void>();
  private readonly discListeners = new Set<() => void>();
  readonly onMessage = {
    addListener: (fn: (msg: unknown) => void): void => {
      this.msgListeners.add(fn);
    },
    removeListener: (fn: (msg: unknown) => void): void => {
      this.msgListeners.delete(fn);
    },
  };
  readonly onDisconnect = {
    addListener: (fn: () => void): void => {
      this.discListeners.add(fn);
    },
    removeListener: (fn: () => void): void => {
      this.discListeners.delete(fn);
    },
  };

  postMessage(msg: unknown): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(msg);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** The worker sends a message. */
  emit(msg: WorkerToContent | Record<string, unknown>): void {
    for (const fn of [...this.msgListeners]) fn(msg);
  }

  /** The worker side went away. */
  fireDisconnect(): void {
    this.disconnected = true;
    for (const fn of [...this.discListeners]) fn();
  }

  messages<T extends ContentToWorker['type']>(type: T): Extract<ContentToWorker, { type: T }>[] {
    return this.posted.filter((m): m is Extract<ContentToWorker, { type: T }> => !!m && typeof m === 'object' && (m as { type?: string }).type === type);
  }
}

export interface FakeChrome {
  runtime: {
    id: string | undefined;
    connect: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    getManifest: () => { version: string };
  };
  ports: FakePort[];
  readonly port: FakePort;
  uninstall(): void;
}

export function installFakeChrome(opts: { id?: string } = {}): FakeChrome {
  const ports: FakePort[] = [];
  const runtime = {
    id: opts.id ?? 'abcdefghijklmnopabcdefghijklmnop' as string | undefined,
    connect: vi.fn(() => {
      const p = new FakePort();
      ports.push(p);
      return p;
    }),
    sendMessage: vi.fn(() => Promise.resolve({ ok: true, type: 'ok' })),
    getManifest: () => ({ version: '0.1.0' }),
  };
  (globalThis as { chrome?: unknown }).chrome = { runtime };
  return {
    runtime,
    ports,
    get port(): FakePort {
      const p = ports[ports.length - 1];
      if (!p) throw new Error('no port connected yet');
      return p;
    },
    uninstall() {
      delete (globalThis as { chrome?: unknown }).chrome;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Text-backed FieldAdapter
// ---------------------------------------------------------------------------------------------

export class FakeAdapter implements FieldAdapter {
  readonly kind: FieldKind;
  readonly element: HTMLElement;
  text: string;
  composing = false;
  focused = true;
  disposed = false;
  protectedRanges: TextRange[] = [];
  docHint = '';
  label = 'Message body';
  selection: TextRange | null = null;
  /** Force the next applyEdit outcome. */
  failNext: EditOutcome['status'] | null = null;
  /** applyEdits skips (and aborts at) edits for which this returns true. */
  failOn: ((edit: Edit) => boolean) | null = null;
  /** applyEdits applies nothing at all. */
  failBatch = false;
  readonly applyCalls: Edit[] = [];
  readonly batchCalls: Edit[][] = [];
  private readonly changeSubs = new Set<(text: string, inputType: string | null) => void>();
  private readonly layoutSubs = new Set<() => void>();
  private readonly focusSubs = new Set<(focused: boolean) => void>();

  constructor(text = '', kind: FieldKind = 'textarea', element?: HTMLElement) {
    this.text = text;
    this.kind = kind;
    this.element = element ?? document.createElement(kind === 'contenteditable' ? 'div' : 'textarea');
    if (!this.element.isConnected) document.body.appendChild(this.element);
  }

  getLabel(): string {
    return this.label;
  }

  getDocHint(): string {
    return this.docHint;
  }

  getText(): string {
    return this.text;
  }

  getRangeRects(range: TextRange): DOMRect[] {
    return [new DOMRect(10 + range.start * 8, 20, Math.max(1, range.end - range.start) * 8, 16)];
  }

  getProtectedRanges(): TextRange[] {
    return this.protectedRanges.map((r) => ({ ...r }));
  }

  async applyEdit(edit: Edit): Promise<EditOutcome> {
    this.applyCalls.push(edit);
    if (this.composing) return { status: 'composing', rung: null, text: this.text };
    if (this.failNext) {
      const status = this.failNext;
      this.failNext = null;
      return { status, rung: null, text: this.text };
    }
    if (this.text.slice(edit.range.start, edit.range.end) !== edit.original) return { status: 'mismatch', rung: null, text: this.text };
    this.text = this.text.slice(0, edit.range.start) + edit.replacement + this.text.slice(edit.range.end);
    this.emitChange(edit.replacement.length === 0 ? 'deleteContentBackward' : 'insertReplacementText');
    return { status: 'applied', rung: 'native', text: this.text };
  }

  async applyEdits(edits: Edit[]): Promise<BatchEditOutcome> {
    this.batchCalls.push(edits);
    const applied: Edit[] = [];
    const skipped: BatchEditOutcome['skipped'] = [];
    if (this.failBatch) {
      for (const edit of edits) skipped.push({ edit, reason: 'reverted' });
      return { applied, skipped, text: this.text, nativeUndoSteps: 0 };
    }
    const ordered = [...edits].sort((a, b) => b.range.start - a.range.start);
    for (let i = 0; i < ordered.length; i++) {
      const edit = ordered[i]!;
      if ((this.failOn && this.failOn(edit)) || this.text.slice(edit.range.start, edit.range.end) !== edit.original) {
        for (const rest of ordered.slice(i)) skipped.push({ edit: rest, reason: 'mismatch' });
        break;
      }
      this.text = this.text.slice(0, edit.range.start) + edit.replacement + this.text.slice(edit.range.end);
      applied.push(edit);
      this.emitChange('insertReplacementText');
    }
    return { applied, skipped, text: this.text, nativeUndoSteps: applied.length };
  }

  getSelection(): TextRange | null {
    return this.selection;
  }

  setSelection(range: TextRange): void {
    this.selection = { ...range };
  }

  isComposing(): boolean {
    return this.composing;
  }

  isFocused(): boolean {
    return this.focused;
  }

  focus(): void {
    this.setFocused(true);
  }

  onChange(cb: (text: string, inputType: string | null) => void): () => void {
    this.changeSubs.add(cb);
    return () => this.changeSubs.delete(cb);
  }

  onLayout(cb: () => void): () => void {
    this.layoutSubs.add(cb);
    return () => this.layoutSubs.delete(cb);
  }

  onFocusChange(cb: (focused: boolean) => void): () => void {
    this.focusSubs.add(cb);
    return () => this.focusSubs.delete(cb);
  }

  getBox(): DOMRect {
    return new DOMRect(0, 0, 500, 200);
  }

  dispose(): void {
    this.disposed = true;
  }

  // --- test drivers ---

  /** The user changed the text (an `input` event with `inputType`). */
  type(newText: string, inputType: string | null = 'insertText'): void {
    this.text = newText;
    this.emitChange(inputType);
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    for (const cb of [...this.focusSubs]) cb(focused);
  }

  layout(): void {
    for (const cb of [...this.layoutSubs]) cb();
  }

  private emitChange(inputType: string | null): void {
    for (const cb of [...this.changeSubs]) cb(this.text, inputType);
  }
}

// ---------------------------------------------------------------------------------------------
// Recording overlay
// ---------------------------------------------------------------------------------------------

export class FakeFieldOverlay implements FieldOverlay {
  underlines: UnderlineItem[] = [];
  rectUpdates = 0;
  status: FieldStatus | null = null;
  counts: AcceptAllCounts | null = null;
  checkedBy: CheckPass | null = null;
  error: CheckError | undefined;
  tone: ToneAnalysis | undefined;
  toneChars = 0;
  box: DOMRect | null = null;
  typing: boolean | null = null;
  typingLog: boolean[] = [];
  cardOpen: string | null = null;
  cardAnchor: DOMRect | null = null;
  closeCardCalls = 0;
  focused: string | null = null;
  menuOpen = false;
  toasts: { message: string; options?: { undoTransactionId?: string; durationMs?: number } }[] = [];
  unsupportedReason: string | null = null;
  disposed = false;

  constructor(readonly fieldId: string) {}

  setUnderlines(items: UnderlineItem[]): void {
    this.underlines = items;
  }

  updateRects(items: UnderlineItem[]): void {
    this.underlines = items;
    this.rectUpdates++;
  }

  setStatus(status: FieldStatus, counts: AcceptAllCounts, checkedBy: CheckPass, error?: CheckError): void {
    this.status = status;
    this.counts = counts;
    this.checkedBy = checkedBy;
    this.error = error;
  }

  setTone(tone: ToneAnalysis | undefined, charCount: number): void {
    this.tone = tone;
    this.toneChars = charCount;
  }

  setFieldBox(box: DOMRect): void {
    this.box = box;
  }

  setTyping(typing: boolean): void {
    this.typing = typing;
    this.typingLog.push(typing);
  }

  openCard(suggestionId: string, anchorRect: DOMRect): void {
    this.cardOpen = suggestionId;
    this.cardAnchor = anchorRect;
  }

  closeCard(): void {
    this.cardOpen = null;
    this.closeCardCalls++;
  }

  focusSuggestion(suggestionId: string): void {
    this.focused = suggestionId;
  }

  openMenu(): void {
    this.menuOpen = true;
  }

  closeMenu(): void {
    this.menuOpen = false;
  }

  toast(message: string, options?: { undoTransactionId?: string; durationMs?: number }): void {
    this.toasts.push(options ? { message, options } : { message });
  }

  setUnsupported(reason: string): void {
    this.unsupportedReason = reason;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeOverlay implements Overlay {
  readonly fields = new Map<string, FakeFieldOverlay>();
  readonly attachOptions = new Map<string, OverlayOptions>();
  readonly detached: string[] = [];
  options: Partial<OverlayOptions> = {};
  disposed = false;

  constructor(readonly events?: OverlayEvents) {}

  attach(fieldId: string, _adapter: FieldAdapter, opts: OverlayOptions): FieldOverlay {
    this.attachOptions.set(fieldId, opts);
    let f = this.fields.get(fieldId);
    if (!f) {
      f = new FakeFieldOverlay(fieldId);
      this.fields.set(fieldId, f);
    }
    return f;
  }

  detach(fieldId: string): void {
    const f = this.fields.get(fieldId);
    if (f) f.dispose();
    this.fields.delete(fieldId);
    this.detached.push(fieldId);
  }

  setOptions(opts: Partial<OverlayOptions>): void {
    this.options = { ...this.options, ...opts };
  }

  isInteracting(): boolean {
    return false;
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.fields.values()) f.dispose();
  }

  field(fieldId: string): FakeFieldOverlay {
    const f = this.fields.get(fieldId);
    if (!f) throw new Error(`no overlay for ${fieldId}`);
    return f;
  }
}

/** A `createOverlay` that remembers the events object and the overlay it created. */
export function fakeCreateOverlay(): { create: (events: OverlayEvents) => Overlay; readonly overlay: FakeOverlay; readonly events: OverlayEvents } {
  let overlay: FakeOverlay | null = null;
  let events: OverlayEvents | null = null;
  return {
    create: (ev) => {
      events = ev;
      overlay = new FakeOverlay(ev);
      return overlay;
    },
    get overlay(): FakeOverlay {
      if (!overlay) throw new Error('overlay not created');
      return overlay;
    },
    get events(): OverlayEvents {
      if (!events) throw new Error('overlay not created');
      return events;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// FieldSession harness
// ---------------------------------------------------------------------------------------------

export interface SessionHarness {
  session: FieldSession;
  adapter: FakeAdapter;
  overlay: FakeOverlay;
  ui: FakeFieldOverlay;
  sent: ContentToWorker[];
  runtimeSent: RuntimeRequest[];
  outstanding: Map<string, boolean>;
  config: EffectiveConfig;
  setConfig(partial: Partial<EffectiveConfig>): void;
  messages<T extends ContentToWorker['type']>(type: T): Extract<ContentToWorker, { type: T }>[];
  /** Deliver a worker message. */
  emit(msg: WorkerToContent): void;
}

export function makeSession(opts: { text?: string; config?: Partial<EffectiveConfig>; configReceived?: boolean; kind?: FieldKind; profile?: Partial<SiteProfile>; element?: HTMLElement; fieldId?: string } = {}): SessionHarness {
  const kind = opts.kind ?? 'textarea';
  let config = makeConfig(opts.config);
  const received = opts.configReceived ?? true;
  const element = opts.element ?? document.createElement(kind === 'contenteditable' ? 'div' : kind === 'input' ? 'input' : 'textarea');
  if (!element.id) element.id = 'field-under-test';
  if (!element.isConnected) document.body.appendChild(element);
  const adapter = new FakeAdapter(opts.text ?? '', kind, element);
  const overlay = new FakeOverlay();
  const sent: ContentToWorker[] = [];
  const runtimeSent: RuntimeRequest[] = [];
  const outstanding = new Map<string, boolean>();
  const fieldId = opts.fieldId ?? 'f1';
  const session = new FieldSession({
    fieldId,
    element,
    adapter,
    profile: makeProfile(opts.profile),
    kind,
    label: 'Message body',
    host: 'example.com',
    origin: 'https://example.com',
    overlay,
    getConfig: () => config,
    configReceived: () => received,
    send: (msg) => {
      sent.push(msg);
      return true;
    },
    sendRuntime: (msg) => {
      runtimeSent.push(msg);
    },
    setOutstanding: (key, value) => {
      outstanding.set(key, value);
    },
  });
  return {
    session,
    adapter,
    overlay,
    ui: overlay.field(fieldId),
    sent,
    runtimeSent,
    outstanding,
    get config() {
      return config;
    },
    setConfig(partial) {
      config = { ...config, ...partial };
      session.configChanged();
    },
    messages(type) {
      return sent.filter((m): m is Extract<ContentToWorker, { type: typeof type }> => m.type === type);
    },
    emit(msg) {
      session.handleMessage(msg);
    },
  };
}

export async function flushPromises(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
