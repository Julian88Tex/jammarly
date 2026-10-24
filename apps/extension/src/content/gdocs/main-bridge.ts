/**
 * Google Docs MAIN-world bridge. Injected at document_idle on https://docs.google.com/document/* (manifest
 * `world: "MAIN"`); the bootstrap (document_start) has already announced our id in `_docs_annotate_canvas_by_ext`.
 *
 * ARCHITECTURE §3.8 layer 2: the bridge waits (up to 20 s) for Docs to expose `_docs_annotate_getAnnotatedText`,
 * calls it with the announced id and, when a model comes back, (a) polls `getText()` every 125 ms and pushes
 * 'jammarly:gdocs-text' snapshots when the text changed, (b) answers the CustomEvent RPC of protocol.ts
 * (status / getText / getSelection / setSelection / applyEdit / getGeometry) and (c) dispatches
 * 'jammarly:gdocs-status' on activation or failure. Otherwise it reports `inactive` and the isolated world falls back
 * to layer 1 (side panel).
 *
 * Edits are `setSelection(start, end)` + one synthetic text/plain `paste` into the hidden input iframe's editable,
 * verified by re-reading `getText()` after setTimeout(0) and once more a tick later (06 §1.4). Deletions borrow a
 * neighbouring character (planDocsEdit) because Docs ignores an empty paste.
 *
 * This file runs under the page CSP (Trusted Types on Google hosts, [R09 §1.18]): it never touches innerHTML /
 * outerHTML / insertAdjacentHTML / document.write, exposes no extension API to the page and wraps every Docs call
 * in try/catch, reporting failures through the RPC instead of throwing into the page.
 */
import { canvasMeasure, collectTextRuns, mapRunsToText, rectsJsonForRange, type MeasureFn, type RectJson } from './geometry';
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  STATUS_EVENT,
  TEXT_EVENT,
  TEXT_POLL_INTERVAL_MS,
  dispatchDetail,
  encodeSnapshot,
  encodeStatus,
  errorMessage,
  serveRpc,
  type GdocsApplyResult,
  type GdocsSelection,
  type GdocsStatus,
  type RpcHandlers,
  type RpcParams,
} from './protocol';
import { docsTextsEquivalent, normalizeDocsText, planDocsEdit } from './text';

/** The object `_docs_annotate_getAnnotatedText(id)` resolves to (06 §1.3). Only `getText` is required. */
export interface DocsAnnotatedModel {
  getText(): string;
  getSelection?(): unknown;
  setSelection?(start: number, end: number): unknown;
  getAnnotations?(): unknown;
}

interface DocsWindow {
  _docs_annotate_getAnnotatedText?: (id?: string) => unknown;
  _docs_annotate_canvas_by_ext?: string;
  __jammarlyAnnouncedId?: string;
  /** Install marker (frozen, data only) so a second copy of this script stays inert. */
  __jammarlyGdocsBridge?: { readonly version: number };
  /** Tests set this before importing the module to prevent the auto-install. */
  __jammarlyGdocsBridgeNoAutoInstall?: boolean;
}

export interface BridgeOptions {
  activationTimeoutMs?: number;
  activationPollMs?: number;
  textPollMs?: number;
  /** Consecutive `getText()` failures before the bridge declares itself inactive. */
  maxPollFailures?: number;
  /** Where events are exchanged (default: the window's document). */
  target?: EventTarget;
  /** Document holding the annotation layer and the input iframe (default: the window's document). */
  doc?: Document;
  measure?: MeasureFn;
}

export interface GdocsBridgeHandle {
  status(): GdocsStatus;
  /** Bridge-side text change counter. */
  version(): number;
  dispose(): void;
}

export const SINK_FRAME_SELECTOR = 'iframe.docs-texteventtarget-iframe';
export const DEFAULT_MAX_POLL_FAILURES = 5;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function endpoint(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const key of ['index', 'offset', 'position']) {
      const n = o[key];
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Read the first selection entry of `getSelection()`; Harper accepts the endpoint pairs anchor/focus, base/extent
 * and start/end. Returns a sorted raw range or null when the shape is unknown.
 */
export function parseDocsSelection(sel: unknown): GdocsSelection | null {
  const first: unknown = Array.isArray(sel) ? sel[0] : sel;
  if (!first || typeof first !== 'object') return null;
  const o = first as Record<string, unknown>;
  for (const [a, b] of [
    ['anchor', 'focus'],
    ['base', 'extent'],
    ['start', 'end'],
  ] as const) {
    const s = endpoint(o[a]);
    const e = endpoint(o[b]);
    if (s !== null && e !== null) return { start: Math.min(s, e), end: Math.max(s, e) };
  }
  return null;
}

interface PasteSink {
  win: Window;
  editable: HTMLElement;
}

/** The hidden input iframe's editable (focus holder for every keystroke) and its window, for same-realm events. */
export function findPasteSink(doc: Document): PasteSink | null {
  const frame = doc.querySelector<HTMLIFrameElement>(SINK_FRAME_SELECTOR);
  if (!frame) return null;
  let fdoc: Document | null = null;
  let fwin: Window | null = null;
  try {
    fdoc = frame.contentDocument;
    fwin = frame.contentWindow;
  } catch {
    return null;
  }
  if (!fdoc || !fwin) return null;
  const editable = fdoc.querySelector<HTMLElement>('[contenteditable="true"]') ?? (fdoc.activeElement as HTMLElement | null) ?? fdoc.body;
  if (!editable) return null;
  return { win: fwin, editable };
}

/** Dispatch a text/plain paste built with the iframe realm's constructors. False when the realm lacks them. */
export function dispatchPaste(sink: PasteSink, payload: string): boolean {
  const realm = sink.win as unknown as {
    DataTransfer?: new () => DataTransfer;
    ClipboardEvent?: new (type: string, init: ClipboardEventInit) => ClipboardEvent;
  };
  const DT = realm.DataTransfer;
  const CE = realm.ClipboardEvent;
  if (typeof DT !== 'function' || typeof CE !== 'function') return false;
  const dt = new DT();
  dt.setData('text/plain', payload);
  const ev = new CE('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  sink.editable.dispatchEvent(ev);
  return true;
}

/** Install the bridge on `win`. Idempotent per window: a second install is inert until the first is disposed. */
export function installGdocsBridge(win: Window, opts: BridgeOptions = {}): GdocsBridgeHandle {
  const w = win as unknown as DocsWindow;
  const doc = opts.doc ?? win.document;
  const target = opts.target ?? doc;
  const announcedId = (): string => w.__jammarlyAnnouncedId ?? w._docs_annotate_canvas_by_ext ?? '';

  if (w.__jammarlyGdocsBridge) {
    const inert: GdocsStatus = { state: 'inactive', active: false, announcedId: announcedId(), error: 'bridge already installed' };
    return { status: () => inert, version: () => 0, dispose: () => undefined };
  }
  w.__jammarlyGdocsBridge = Object.freeze({ version: PROTOCOL_VERSION });

  const activationTimeoutMs = opts.activationTimeoutMs ?? ACTIVATION_TIMEOUT_MS;
  const activationPollMs = opts.activationPollMs ?? ACTIVATION_POLL_INTERVAL_MS;
  const textPollMs = opts.textPollMs ?? TEXT_POLL_INTERVAL_MS;
  const maxPollFailures = opts.maxPollFailures ?? DEFAULT_MAX_POLL_FAILURES;

  let status: GdocsStatus = { state: 'pending', active: false, announcedId: announcedId() };
  let model: DocsAnnotatedModel | null = null;
  let lastRaw: string | null = null;
  let version = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let activationTimer: ReturnType<typeof setInterval> | null = null;
  let activation: 'waiting' | 'calling' | 'done' = 'waiting';
  let failures = 0;
  let disposed = false;
  let measure: MeasureFn | null = opts.measure ?? null;

  const setStatus = (next: GdocsStatus): void => {
    status = next;
    try {
      dispatchDetail(target, STATUS_EVENT, encodeStatus(next));
    } catch {
      // the page owns the event loop; nothing more to do
    }
  };

  const stopPolling = (): void => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  };
  const stopActivation = (): void => {
    if (activationTimer !== null) clearInterval(activationTimer);
    activationTimer = null;
  };

  const fail = (error: string): void => {
    stopPolling();
    model = null;
    setStatus({ state: 'inactive', active: false, announcedId: announcedId(), error });
  };

  const requireModel = (): DocsAnnotatedModel => {
    if (!model) throw new Error(status.error ? `gdocs bridge inactive: ${status.error}` : 'gdocs bridge not active');
    return model;
  };

  const readRaw = (): string => {
    const text = requireModel().getText();
    if (typeof text !== 'string') throw new Error('getText() did not return a string');
    return text;
  };

  const publish = (raw: string): void => {
    lastRaw = raw;
    version++;
    const n = normalizeDocsText(raw);
    dispatchDetail(target, TEXT_EVENT, encodeSnapshot({ raw, text: n.text, leading: n.leading, trailing: n.trailing, version }));
  };

  const pollOnce = (): void => {
    if (!model || disposed) return;
    try {
      const raw = readRaw();
      failures = 0;
      if (raw !== lastRaw) publish(raw);
    } catch (e) {
      failures++;
      if (failures >= maxPollFailures) fail(`getText() failed: ${errorMessage(e)}`);
    }
  };

  const activate = async (): Promise<void> => {
    const fn = w._docs_annotate_getAnnotatedText;
    if (typeof fn !== 'function') return;
    activation = 'calling';
    stopActivation();
    const id = announcedId();
    try {
      const result: unknown = await fn.call(w, id);
      if (disposed) return;
      if (result && typeof (result as DocsAnnotatedModel).getText === 'function') {
        model = result as DocsAnnotatedModel;
        failures = 0;
        setStatus({ state: 'active', active: true, announcedId: id });
        pollOnce();
        stopPolling();
        pollTimer = setInterval(pollOnce, Math.max(16, textPollMs));
      } else {
        fail(id ? `Docs returned no annotated-text model for id ${id}` : 'no extension id was announced');
      }
    } catch (e) {
      fail(`_docs_annotate_getAnnotatedText threw: ${errorMessage(e)}`);
    } finally {
      activation = 'done';
    }
  };

  const deadline = Date.now() + activationTimeoutMs;
  const activationTick = (): void => {
    if (disposed || activation !== 'waiting') return;
    if (typeof w._docs_annotate_getAnnotatedText === 'function') {
      void activate();
      return;
    }
    if (Date.now() >= deadline) {
      activation = 'done';
      stopActivation();
      fail('Docs did not expose _docs_annotate_getAnnotatedText for the announced id');
    }
  };

  // ---- RPC -----------------------------------------------------------------------------------------------------

  const applyEdit = async (p: RpcParams<'applyEdit'>): Promise<GdocsApplyResult> => {
    const m = requireModel();
    const raw = readRaw();
    if (p.expectedRaw !== undefined && p.expectedRaw !== raw) return { ok: false, text: raw, reason: 'stale' };
    if (p.end > raw.length) return { ok: false, text: raw, reason: 'mismatch' };
    const plan = planDocsEdit(raw, p.start, p.end, p.replacement);
    if (!plan) return { ok: false, text: raw, reason: 'unsupported' };
    if (plan.expected === raw) return { ok: true, text: raw, strategy: 'noop' };
    if (typeof m.setSelection !== 'function') return { ok: false, text: raw, reason: 'unsupported' };
    const sink = findPasteSink(doc);
    if (!sink) return { ok: false, text: raw, reason: 'unsupported' };

    m.setSelection(plan.selStart, plan.selEnd);
    // setSelection blurs the editable while the frame stays focused (FluentTyper); refocus before pasting.
    try {
      sink.editable.focus();
    } catch {
      // focus is best effort
    }
    if (!dispatchPaste(sink, plan.payload)) return { ok: false, text: raw, reason: 'unsupported' };

    await tick();
    let after = readRaw();
    if (!docsTextsEquivalent(after, plan.expected)) {
      await tick();
      after = readRaw();
    }
    if (after !== lastRaw) publish(after);
    if (docsTextsEquivalent(after, plan.expected)) return { ok: true, text: after, strategy: plan.strategy };
    return { ok: false, text: after, reason: after === raw ? 'no-effect' : 'mismatch' };
  };

  const geometry = (p: GdocsSelection): RectJson[] => {
    const raw = lastRaw ?? readRaw();
    const map = normalizeDocsText(raw);
    const runs = mapRunsToText(collectTextRuns(doc), map.text);
    if (!measure) measure = canvasMeasure(doc);
    return rectsJsonForRange(runs, map.fromRaw(p.start), map.fromRaw(p.end), measure);
  };

  const handlers: RpcHandlers = {
    status: () => status,
    getText: () => ({ raw: readRaw() }),
    getSelection: () => {
      const m = requireModel();
      if (typeof m.getSelection !== 'function') return null;
      return parseDocsSelection(m.getSelection());
    },
    setSelection: (p) => {
      const m = requireModel();
      if (typeof m.setSelection !== 'function') throw new Error('setSelection is not available');
      m.setSelection(p.start, p.end);
      return { ok: true };
    },
    applyEdit,
    getGeometry: geometry,
  };
  const unsubscribe = serveRpc(target, handlers);

  activationTimer = setInterval(activationTick, Math.max(16, activationPollMs));
  activationTick();

  return {
    status: () => status,
    version: () => version,
    dispose: () => {
      disposed = true;
      stopPolling();
      stopActivation();
      unsubscribe();
      model = null;
      delete w.__jammarlyGdocsBridge;
    },
  };
}

if (typeof window !== 'undefined' && !(window as unknown as DocsWindow).__jammarlyGdocsBridgeNoAutoInstall) {
  installGdocsBridge(window);
}
