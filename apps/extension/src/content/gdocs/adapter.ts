/**
 * GoogleDocsAdapter: the FieldAdapter (kind 'gdocs') for the annotated-canvas bridge (ARCHITECTURE §3.4 table row 4,
 * §3.8 layer 2). Runs in the isolated world and talks to the MAIN-world bridge (main-bridge.ts) through the
 * CustomEvent RPC of protocol.ts.
 *
 * - Text: the last 'jammarly:gdocs-text' snapshot (normalized: no U+0003 sentinel, no trailing newline); the first
 *   snapshot is also requested over the RPC so a late-attached adapter does not wait for a keystroke.
 * - Geometry: `getRangeRects` must be synchronous (FieldAdapter contract) while the RPC is not, so it reads the SVG
 *   annotation layer directly (the DOM is shared between worlds) with the same pure geometry code the bridge's
 *   `getGeometry` method uses, caching the run→offset index per text version and layout epoch.
 *   `getRangeRectsAsync` is the RPC path.
 * - Edits: `applyEdit` translates normalized offsets to raw ones, sends the raw text it read as a compare-and-swap
 *   guard (the bridge refuses with 'stale' when Docs' text moved) and reports rung 'gdocs'. `applyEdits` is the
 *   shared right-to-left driver.
 * - Selection: Docs reports it only through the API, so `getSelection()` returns the last known value and refreshes
 *   it in the background; `setSelection` is fire-and-forget. Docs handles IME internally: `isComposing()` is false.
 *
 * Registration: `adapters/index.ts` is owned elsewhere, so the content-script entry calls
 * `registerGdocsAdapter(adapterFactories)` on a Docs document page once `waitForGdocsActivation()` reports
 * `active` (and `config.gdocsInline === 'auto'`); otherwise layer 1 (side panel) applies.
 */
import type { BatchEditOutcome, Edit, EditOutcome, FieldKind, TextRange } from '@jammarly/shared/types';
import type { FieldAdapter, SiteProfile } from '../field-adapter';
import { applyEditsRightToLeft, editMatchesText } from '../adapters/common';
import { mergeLineRects } from '../dom-text';
import { buildLayoutIndex, canvasMeasure, rectsForRange, type CollectOptions, type MappedRun, type MeasureFn } from './geometry';
import {
  ACTIVATION_TIMEOUT_MS,
  EventRpcClient,
  STATUS_EVENT,
  TEXT_EVENT,
  decodeSnapshot,
  decodeStatus,
  errorMessage,
  type GdocsRpc,
  type GdocsStatus,
  type GdocsTextSnapshot,
} from './protocol';
import { gdocsDocumentId, normalizeDocsText, normalizeNbsp, type DocsOffsetMap } from './text';

export const GDOCS_HOST = 'docs.google.com';
export const GDOCS_EDITOR_SELECTOR = '.kix-appview-editor';
export const GDOCS_SINK_FRAME_SELECTOR = 'iframe.docs-texteventtarget-iframe';
export const GDOCS_LABEL = 'Document';

/** `https://docs.google.com/document/…` (the manifest match of the MAIN-world scripts). */
export function isGdocsDocumentPage(loc: Pick<Location, 'hostname' | 'pathname'> = location): boolean {
  return loc.hostname === GDOCS_HOST && /^\/document\//.test(loc.pathname);
}

/** The editor container the adapter attaches to (scroll container, floating-button box). */
export function findGdocsEditorElement(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`#docs-editor ${GDOCS_EDITOR_SELECTOR}`) ?? doc.querySelector<HTMLElement>(GDOCS_EDITOR_SELECTOR) ?? doc.querySelector<HTMLElement>('#docs-editor');
}

let sharedClient: { target: EventTarget; client: EventRpcClient } | null = null;

/** One RPC client per event target (the document) shared by every adapter and status query. */
export function defaultGdocsRpc(target: EventTarget = document): GdocsRpc {
  if (!sharedClient || sharedClient.target !== target) sharedClient = { target, client: new EventRpcClient(target) };
  return sharedClient.client;
}

function inactive(error: string): GdocsStatus {
  return { state: 'inactive', active: false, announcedId: '', error };
}

/** The bridge's current status; `inactive` with an error when the bridge does not answer. */
export async function gdocsStatus(rpc: GdocsRpc = defaultGdocsRpc(), timeoutMs = 1500): Promise<GdocsStatus> {
  try {
    return await rpc.call('status', {}, timeoutMs);
  } catch (e) {
    return inactive(`bridge unavailable: ${errorMessage(e)}`);
  }
}

export interface WaitOptions {
  rpc?: GdocsRpc;
  target?: EventTarget;
  timeoutMs?: number;
}

/**
 * Resolve once the bridge reports a final state (active or inactive): by RPC when it already has one, else from the
 * next 'jammarly:gdocs-status' event. A bridge that never answers resolves `inactive` after `timeoutMs` (the
 * bridge's own 20 s activation window plus a margin by default).
 */
export function waitForGdocsActivation(opts: WaitOptions = {}): Promise<GdocsStatus> {
  const target = opts.target ?? document;
  const timeoutMs = opts.timeoutMs ?? ACTIVATION_TIMEOUT_MS + 2000;
  const rpc = opts.rpc ?? defaultGdocsRpc(target);
  return new Promise((resolve) => {
    let done = false;
    let last: GdocsStatus | null = null;
    const onStatus = (ev: Event): void => {
      const s = decodeStatus((ev as CustomEvent).detail);
      if (!s) return;
      last = s;
      if (s.state !== 'pending') finish(s);
    };
    const finish = (s: GdocsStatus): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener(STATUS_EVENT, onStatus);
      resolve(s);
    };
    const timer = setTimeout(() => {
      const s = last ?? inactive('timed out waiting for the Docs bridge');
      finish(s.state === 'pending' ? { ...s, state: 'inactive', active: false, error: 'timed out waiting for Docs to expose the annotated-text API' } : s);
    }, Math.max(1, timeoutMs));
    target.addEventListener(STATUS_EVENT, onStatus);
    rpc.call('status', {}, Math.min(1500, timeoutMs)).then(
      (s) => {
        last = s;
        if (s.state !== 'pending') finish(s);
      },
      () => {
        // bridge not installed yet (document_idle ordering): wait for its status event
      },
    );
  });
}

export interface GoogleDocsAdapterOptions {
  rpc?: GdocsRpc;
  /** Where bridge events arrive (default: the element's document). */
  target?: EventTarget;
  doc?: Document;
  win?: Window | null;
  location?: Pick<Location, 'pathname'> | null;
  /** Text measurer for partial-run rects (default: canvas measureText, proportional fallback). */
  measure?: MeasureFn;
  /** Viewport origin of an annotation `<svg>` (default: getBoundingClientRect). */
  svgOrigin?: CollectOptions['origin'];
  /** Seed snapshot; skips the initial getText round trip. */
  initial?: GdocsTextSnapshot;
}

type Snapshot = DocsOffsetMap & { version: number };

type ChangeCb = (text: string, inputType: string | null) => void;

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // listener errors must not break the adapter
  }
}

export class GoogleDocsAdapter implements FieldAdapter {
  readonly kind: FieldKind = 'gdocs';
  readonly element: HTMLElement;

  private readonly rpc: GdocsRpc;
  private readonly target: EventTarget;
  private readonly doc: Document;
  private readonly win: Window | null;
  private readonly loc: Pick<Location, 'pathname'> | null;
  private readonly scroller: HTMLElement;
  private readonly svgOrigin: CollectOptions['origin'];
  private measureFn: MeasureFn | null;

  private snapshot: Snapshot | null = null;
  private version = 0;
  private selection: TextRange | null = null;
  private selectionRefresh: Promise<TextRange | null> | null = null;
  private layout: { version: number; epoch: number; runs: MappedRun[] } | null = null;
  private epoch = 0;
  private layoutScheduled = false;
  private focused = false;
  private disposed = false;
  private readonly changeCbs = new Set<ChangeCb>();
  private readonly layoutCbs = new Set<() => void>();
  private readonly focusCbs = new Set<(focused: boolean) => void>();
  private readonly cleanups: (() => void)[] = [];
  private readonly readyPromise: Promise<void>;

  constructor(element: HTMLElement, opts: GoogleDocsAdapterOptions = {}) {
    this.element = element;
    this.doc = opts.doc ?? element.ownerDocument;
    this.win = opts.win === undefined ? this.doc.defaultView : opts.win;
    this.target = opts.target ?? this.doc;
    this.rpc = opts.rpc ?? defaultGdocsRpc(this.target);
    this.loc = opts.location === undefined ? (this.win ? this.win.location : null) : opts.location;
    this.svgOrigin = opts.svgOrigin;
    this.measureFn = opts.measure ?? null;
    this.scroller = element.matches(GDOCS_EDITOR_SELECTOR) ? element : (element.querySelector<HTMLElement>(GDOCS_EDITOR_SELECTOR) ?? element);

    if (opts.initial) this.adopt(opts.initial.raw, false);
    this.listen(this.target, TEXT_EVENT, this.onTextEvent);

    this.listen(this.scroller, 'scroll', this.onLayoutEvent, { passive: true });
    if (this.win) {
      this.listen(this.win, 'resize', this.onLayoutEvent);
      this.listen(this.win, 'scroll', this.onLayoutEvent, { passive: true, capture: true });
      this.listen(this.win, 'focus', this.onFocusEvent);
      this.listen(this.win, 'blur', this.onFocusEvent);
    }
    const MO = (this.win as unknown as { MutationObserver?: typeof MutationObserver } | null)?.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : undefined);
    if (typeof MO === 'function') {
      const mo = new MO(() => this.onLayoutEvent());
      mo.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ['x', 'y', 'width', 'height', 'aria-label', 'transform'] });
      this.cleanups.push(() => mo.disconnect());
    }
    this.listen(this.doc, 'focusin', this.onFocusEvent, true);
    this.listen(this.doc, 'focusout', this.onFocusEvent, true);
    this.focused = this.isFocused();

    this.readyPromise = opts.initial ? Promise.resolve() : this.seed();
  }

  // ---- FieldAdapter -----------------------------------------------------------------------------------------------

  getLabel(): string {
    return GDOCS_LABEL;
  }

  /** `gdoc:<document id>` from `/document/d/<id>/…`, "" elsewhere. */
  getDocHint(): string {
    const id = gdocsDocumentId(this.loc?.pathname ?? '');
    return id ? `gdoc:${id}` : '';
  }

  getText(): string {
    return this.snapshot?.text ?? '';
  }

  getRangeRects(range: TextRange): DOMRect[] {
    const snap = this.snapshot;
    if (!snap || this.disposed) return [];
    return rectsForRange(this.layoutIndex(snap), range.start, range.end, this.measure());
  }

  /** The bridge's geometry (RPC), for diagnostics and callers that can await. */
  async getRangeRectsAsync(range: TextRange): Promise<DOMRect[]> {
    const snap = this.snapshot;
    if (!snap) return [];
    const rects = await this.rpc.call('getGeometry', { start: snap.toRaw(range.start), end: snap.toRaw(range.end) });
    return mergeLineRects(rects);
  }

  /** Docs exposes no non-editable islands through the API; tables/footnotes are simply not edited (06 manual list). */
  getProtectedRanges(): TextRange[] {
    return [];
  }

  async applyEdit(edit: Edit): Promise<EditOutcome> {
    if (this.disposed) return { status: 'unsupported', rung: null, text: this.getText() };
    if (!this.snapshot) await this.readyPromise;
    const snap = this.snapshot;
    if (!snap) return { status: 'unsupported', rung: null, text: '' };
    const before = snap.text;
    if (!editMatchesText(before, edit)) return { status: 'mismatch', rung: null, text: before };
    const expected = before.slice(0, edit.range.start) + edit.replacement + before.slice(edit.range.end);

    let result;
    try {
      result = await this.rpc.call('applyEdit', {
        start: snap.toRaw(edit.range.start),
        end: snap.toRaw(edit.range.end),
        replacement: edit.replacement,
        expectedRaw: snap.raw,
      });
    } catch {
      return { status: 'unsupported', rung: 'gdocs', text: this.getText() };
    }
    if (this.disposed) return { status: 'unsupported', rung: 'gdocs', text: before };

    const after = normalizeDocsText(result.text);
    this.adopt(result.text, true);
    if (result.ok && normalizeNbsp(after.text) === normalizeNbsp(expected)) {
      return { status: 'applied', rung: 'gdocs', text: after.text };
    }
    switch (result.reason) {
      case 'stale':
      case 'mismatch':
        return { status: 'mismatch', rung: 'gdocs', text: after.text };
      case 'no-effect':
      case 'unsupported':
      case 'error':
      default:
        // ok without a matching text (should not happen) is treated as a mismatch, anything else as unsupported
        return result.ok ? { status: 'mismatch', rung: 'gdocs', text: after.text } : { status: 'unsupported', rung: 'gdocs', text: after.text };
    }
  }

  applyEdits(edits: Edit[]): Promise<BatchEditOutcome> {
    return applyEditsRightToLeft(edits, (e) => this.applyEdit(e), () => this.getText());
  }

  /** Last known selection (normalized); refreshed in the background on every call. */
  getSelection(): TextRange | null {
    void this.refreshSelection();
    return this.selection;
  }

  /** Ask the bridge for the live selection. */
  refreshSelection(): Promise<TextRange | null> {
    if (this.selectionRefresh) return this.selectionRefresh;
    const p = this.rpc
      .call('getSelection', {})
      .then((sel) => {
        const snap = this.snapshot;
        if (!sel || !snap) return this.selection;
        this.selection = { start: snap.fromRaw(sel.start), end: snap.fromRaw(sel.end) };
        return this.selection;
      })
      .catch(() => this.selection)
      .finally(() => {
        this.selectionRefresh = null;
      });
    this.selectionRefresh = p;
    return p;
  }

  setSelection(range: TextRange): void {
    const snap = this.snapshot;
    if (!snap) return;
    this.selection = { start: range.start, end: range.end };
    this.rpc.call('setSelection', { start: snap.toRaw(range.start), end: snap.toRaw(range.end) }).catch(() => undefined);
  }

  /** Docs handles IME inside its hidden iframe and only commits composed text to the model. */
  isComposing(): boolean {
    return false;
  }

  isFocused(): boolean {
    const active = this.doc.activeElement;
    if (!active) return false;
    const frame = this.sinkFrame();
    if (frame && active === frame) return true;
    return this.element.contains(active);
  }

  focus(): void {
    const editable = this.sinkEditable();
    if (editable) safe(() => editable.focus());
    else safe(() => this.element.focus());
  }

  onChange(cb: ChangeCb): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  onLayout(cb: () => void): () => void {
    this.layoutCbs.add(cb);
    return () => this.layoutCbs.delete(cb);
  }

  onFocusChange(cb: (focused: boolean) => void): () => void {
    this.focusCbs.add(cb);
    return () => this.focusCbs.delete(cb);
  }

  getBox(): DOMRect {
    return this.element.getBoundingClientRect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups.splice(0)) safe(c);
    this.changeCbs.clear();
    this.layoutCbs.clear();
    this.focusCbs.clear();
    this.layout = null;
  }

  // ---- extras ----------------------------------------------------------------------------------------------------

  /** Resolves once the first text snapshot arrived (or the initial request failed). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Monotonic local text version (increments on every adopted change). */
  get textVersion(): number {
    return this.version;
  }

  /** The raw Docs text behind the current snapshot (sentinel included), "" before the first snapshot. */
  get rawText(): string {
    return this.snapshot?.raw ?? '';
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private listen(target: EventTarget, type: string, handler: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  private readonly onTextEvent = (ev: Event): void => {
    if (this.disposed) return;
    const snap = decodeSnapshot((ev as CustomEvent).detail);
    if (snap) this.adopt(snap.raw, true);
  };

  private readonly onLayoutEvent = (): void => {
    if (this.disposed) return;
    this.epoch++;
    this.layout = null;
    if (this.layoutScheduled) return;
    this.layoutScheduled = true;
    const run = (): void => {
      this.layoutScheduled = false;
      if (this.disposed) return;
      for (const cb of this.layoutCbs) safe(cb);
    };
    const raf = this.win?.requestAnimationFrame;
    if (typeof raf === 'function') raf.call(this.win, run);
    else setTimeout(run, 0);
  };

  private readonly onFocusEvent = (): void => {
    if (this.disposed) return;
    const f = this.isFocused();
    if (f === this.focused) return;
    this.focused = f;
    for (const cb of this.focusCbs) safe(() => cb(f));
  };

  /** Adopt a raw snapshot when it differs from the current one; returns whether anything changed. */
  private adopt(raw: string, notify: boolean): boolean {
    if (this.snapshot && this.snapshot.raw === raw) return false;
    const map = normalizeDocsText(raw);
    this.version++;
    this.snapshot = { ...map, version: this.version };
    this.layout = null;
    if (notify) for (const cb of this.changeCbs) safe(() => cb(map.text, null));
    return true;
  }

  private async seed(): Promise<void> {
    try {
      const { raw } = await this.rpc.call('getText', {});
      // A text event that arrived meanwhile is at least as fresh as this reply.
      if (!this.disposed && !this.snapshot) this.adopt(raw, true);
    } catch {
      // bridge inactive or not installed yet: text arrives with the first snapshot event
    }
  }

  private layoutIndex(snap: Snapshot): MappedRun[] {
    const cached = this.layout;
    if (cached && cached.version === snap.version && cached.epoch === this.epoch) return cached.runs;
    const runs = buildLayoutIndex(this.doc, snap.text, this.svgOrigin ? { origin: this.svgOrigin } : {});
    this.layout = { version: snap.version, epoch: this.epoch, runs };
    return runs;
  }

  private measure(): MeasureFn {
    if (!this.measureFn) this.measureFn = canvasMeasure(this.doc);
    return this.measureFn;
  }

  private sinkFrame(): HTMLIFrameElement | null {
    return this.doc.querySelector<HTMLIFrameElement>(GDOCS_SINK_FRAME_SELECTOR);
  }

  private sinkEditable(): HTMLElement | null {
    const frame = this.sinkFrame();
    if (!frame) return null;
    try {
      return frame.contentDocument?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null;
    } catch {
      return null;
    }
  }
}

export type GdocsAdapterFactory = (el: HTMLElement, profile: SiteProfile) => FieldAdapter;

/**
 * Register the Docs adapter in the adapter registry (`adapterFactories` from adapters/index.ts, which is owned by
 * another module and therefore not imported here). Call from the content-script entry on a Docs document page once
 * the bridge is active.
 */
export function registerGdocsAdapter(factories: Partial<Record<FieldKind, GdocsAdapterFactory>>, opts: GoogleDocsAdapterOptions = {}): void {
  factories.gdocs = (el) => new GoogleDocsAdapter(el, opts);
}

/** Build the adapter for the page's editor container, or null when the Docs editor DOM is absent. */
export function createGdocsAdapter(doc: Document = document, opts: GoogleDocsAdapterOptions = {}): GoogleDocsAdapter | null {
  const el = findGdocsEditorElement(doc);
  return el ? new GoogleDocsAdapter(el, { doc, ...opts }) : null;
}
