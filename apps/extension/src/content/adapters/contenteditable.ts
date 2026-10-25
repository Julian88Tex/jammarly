/**
 * ContentEditableAdapter: generic contenteditable roots and every framework editor, parameterized by a SiteProfile
 * (ARCHITECTURE §3.4, research 04 §4–§6, 05 fact 10).
 *
 * Reading goes through dom-text's `serializeEditable` (cached until the next mutation); rects through
 * `rectsForOffsets`; protected ranges are the serialized atomic islands ∪ zero-width characters ∪ elements matching
 * the profile's `protectedSelectors`.
 *
 * Writing follows the profile ladder: 'execCommand' (Selection on the range → `execCommand('insertText'|'delete')`;
 * Draft.js roots get a selectionchange nudge and two frames first), 'beforeinput' (synthetic InputEvent
 * insertReplacementText / deleteContentBackward with `data`, a text/plain DataTransfer and patched
 * `getTargetRanges()`; when nobody claims it the DOM is spliced so DOM-reading editors still see the result),
 * 'paste' (ClipboardEvent with text/plain; never for deletions) and 'splice' (direct Range mutation + `input`).
 * Deletions use the ARCHITECTURE deletion order (beforeinput → execCommand → splice) restricted to the profile's
 * rungs. Every rung is verified immediately, at the next frame and at +150 ms (NBSP-normalized) and never re-run.
 */
import type { BatchEditOutcome, Edit, EditOutcome, TextRange } from '@jammarly/shared/types';
import type { FieldAdapter, SiteProfile } from '../field-adapter';
import { fromDomPosition, offsetsFromSelection, rangeFromOffsets, rectsForOffsets, serializeEditable, type SerializedText } from '../dom-text';
import { fieldLabel } from '../detect';
import { isDraftJsRoot } from '../sites/frameworks';
import { applyEditsRightToLeft, clamp, deepActiveElement, editMatchesText, nextFrame, runLadder, type RunResult, type RungAttempt } from './common';

type Rung = SiteProfile['ladder'][number];

const ELEMENT_NODE = 1;
const DOCUMENT_FRAGMENT_NODE = 11;

/** ARCHITECTURE §3.4: native API → beforeinput deleteContentBackward → execCommand('delete'); never an empty paste. */
const DELETION_ORDER: readonly Rung[] = ['beforeinput', 'execCommand', 'splice'];

/** The deletion ladder for a profile: the ARCHITECTURE order restricted to the rungs the profile uses, 'splice' as last resort. */
export function deletionLadder(ladder: readonly Rung[]): Rung[] {
  const out = DELETION_ORDER.filter((r) => ladder.includes(r));
  return out.length > 0 ? out : ['splice'];
}

/**
 * The text range an element occupies in a serialization, or null when it is outside the root or unserialized.
 * Uses boundary points inside the element: dom-text resolves a point still inside a block that closed to the end
 * of that block's own line, so the range never swallows the newline separating the element from the next block.
 */
export function elementRange(serialized: SerializedText, el: Element): TextRange | null {
  const start = fromDomPosition(serialized, el, 0);
  const end = fromDomPosition(serialized, el, el.childNodes.length);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Sort by start and merge strictly overlapping ranges; zero-length ranges inside another are absorbed. Pure. */
export function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TextRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
    } else if (last && r.start === last.start && r.end === last.end) {
      continue;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/** Leading/trailing spaces as NBSP so an editor that collapses whitespace keeps them. Pure. */
export function edgeSpacesToNbsp(text: string): string {
  return text.replace(/^ +| +$/g, (m) => ' '.repeat(m.length));
}

function makeDataTransfer(text: string): DataTransfer | null {
  if (typeof DataTransfer !== 'function') return null;
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    return dt;
  } catch {
    return null;
  }
}

function makeStaticRange(range: Range): StaticRange | null {
  if (typeof StaticRange !== 'function') return null;
  try {
    return new StaticRange({
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    });
  } catch {
    return null;
  }
}

export class ContentEditableAdapter implements FieldAdapter {
  readonly kind = 'contenteditable' as const;
  readonly element: HTMLElement;
  private readonly profile: SiteProfile;
  private readonly doc: Document;
  private readonly win: Window | null;
  private readonly draftJs: boolean;

  private cache: SerializedText | null = null;
  private observer: MutationObserver | null = null;
  private lastText: string;
  private pendingInputType: string | null = null;
  private flushScheduled = false;
  private composing = false;
  private dirtyWhileComposing = false;
  private disposed = false;

  private readonly changeSubs = new Set<(text: string, inputType: string | null) => void>();
  private readonly layoutSubs = new Set<() => void>();
  private readonly disposers: (() => void)[] = [];

  constructor(root: HTMLElement, profile: SiteProfile) {
    this.element = root;
    this.profile = profile;
    this.doc = root.ownerDocument;
    this.win = this.doc.defaultView;
    this.draftJs = isDraftJsRoot(root);
    this.lastText = this.getText();

    if (typeof MutationObserver === 'function') {
      this.observer = new MutationObserver(() => this.handleMutations());
      this.observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'style', 'contenteditable'],
      });
      this.disposers.push(() => {
        this.observer?.disconnect();
        this.observer = null;
      });
    }
    this.listen(root, 'input', (ev) => {
      const ie = ev as InputEvent;
      this.invalidate();
      if (this.composing || ie.isComposing) {
        this.dirtyWhileComposing = true;
        return;
      }
      this.pendingInputType = ie.inputType ?? null;
      this.scheduleFlush();
    });
    this.listen(root, 'compositionstart', () => {
      this.composing = true;
    });
    this.listen(root, 'compositionend', () => {
      this.composing = false;
      this.invalidate();
      if (this.dirtyWhileComposing || this.getText() !== this.lastText) {
        this.dirtyWhileComposing = false;
        this.pendingInputType = 'insertCompositionText';
        this.scheduleFlush();
      }
    });
    // The root's own scroll is not composed (invisible to the document listener inside a shadow root), so it
    // gets its own listener and the document-level capture listener skips it to avoid double notifications.
    this.listen(root, 'scroll', this.notifyLayout, { passive: true });
    this.listen(this.doc, 'scroll', this.onScrollAnywhere, { capture: true, passive: true });
    if (this.win) this.listen(this.win, 'resize', this.notifyLayout);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.notifyLayout());
      ro.observe(root);
      this.disposers.push(() => ro.disconnect());
    }
    const fonts = (this.doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts && typeof fonts.addEventListener === 'function') this.listen(fonts, 'loadingdone', this.notifyLayout);
  }

  // --- reading ---------------------------------------------------------------

  getLabel(): string {
    return fieldLabel(this.element, this.profile);
  }

  getDocHint(): string {
    try {
      return this.profile.docHint(this.doc.location, this.element);
    } catch {
      return '';
    }
  }

  getText(): string {
    return this.serialized().text;
  }

  getRangeRects(range: TextRange): DOMRect[] {
    const s = this.serialized();
    const len = s.text.length;
    const start = clamp(Number.isFinite(range.start) ? Math.trunc(range.start) : 0, 0, len);
    const end = clamp(Number.isFinite(range.end) ? Math.trunc(range.end) : 0, start, len);
    if (end <= start) return [];
    try {
      return rectsForOffsets(s, start, end);
    } catch {
      return [];
    }
  }

  getProtectedRanges(): TextRange[] {
    const s = this.serialized();
    const ranges: TextRange[] = s.atomic.map((a) => ({ start: a.start, end: a.end }));
    for (const offset of s.zeroWidth) ranges.push({ start: offset, end: offset + 1 });
    for (const selector of this.profile.protectedSelectors) {
      let nodes: Element[];
      try {
        nodes = Array.from(this.element.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const node of nodes) {
        const r = elementRange(s, node);
        if (r) ranges.push(r);
      }
    }
    return mergeRanges(ranges);
  }

  getSelection(): TextRange | null {
    const sel = this.selection();
    if (!sel) return null;
    try {
      return offsetsFromSelection(this.serialized(), sel);
    } catch {
      return null;
    }
  }

  setSelection(range: TextRange): void {
    const s = this.serialized();
    const len = s.text.length;
    const start = clamp(range.start, 0, len);
    const end = clamp(range.end, start, len);
    const sel = this.selection();
    if (!sel) return;
    try {
      const r = rangeFromOffsets(s, start, end);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      // detached or re-rendered DOM: nothing to select
    }
  }

  isComposing(): boolean {
    return this.composing;
  }

  isFocused(): boolean {
    const active = deepActiveElement(this.doc);
    return active !== null && (active === this.element || this.element.contains(active));
  }

  focus(): void {
    if (this.isFocused()) return;
    try {
      this.element.focus({ preventScroll: true });
    } catch {
      this.element.focus();
    }
  }

  getBox(): DOMRect {
    return this.element.getBoundingClientRect();
  }

  // --- writing ---------------------------------------------------------------

  async applyEdit(edit: Edit): Promise<EditOutcome> {
    if (this.composing) return { status: 'composing', rung: null, text: this.getText() };
    const isDeletion = edit.replacement === '';
    const ladder = isDeletion ? deletionLadder(this.profile.ladder) : this.profile.ladder;
    const rungs: RungAttempt[] = ladder.map((rung) => ({ rung, run: () => this.runRung(rung, edit, isDeletion) }));
    return runLadder(edit, () => this.getText(), rungs);
  }

  applyEdits(edits: Edit[]): Promise<BatchEditOutcome> {
    return applyEditsRightToLeft(edits, (e) => this.applyEdit(e), () => this.getText(), (start, end) => this.isPlainSpan(start, end));
  }

  /** The span holds only text (no links, bold, mentions or line breaks), so one write over it loses no markup. */
  private isPlainSpan(start: number, end: number): boolean {
    try {
      const range = rangeFromOffsets(this.serialized(), start, end);
      const nodes = range.cloneContents().childNodes;
      for (const n of Array.from(nodes)) if (n.nodeType !== Node.TEXT_NODE) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async runRung(rung: Rung, edit: Edit, isDeletion: boolean): Promise<RunResult> {
    const s = this.serialized();
    if (!editMatchesText(s.text, edit)) return false;
    let range: Range;
    try {
      range = rangeFromOffsets(s, edit.range.start, edit.range.end);
    } catch {
      return false;
    }
    switch (rung) {
      case 'execCommand':
        return this.rungExecCommand(range, edit, isDeletion);
      case 'beforeinput':
        return this.rungBeforeInput(range, edit, isDeletion);
      case 'paste':
        return isDeletion ? false : this.rungPaste(range, edit);
      case 'splice':
        return this.spliceDom(range, edit, isDeletion);
      default:
        return false;
    }
  }

  /** Focus the root, put the selection on the range (a clone, so editor-driven selection changes cannot move ours) and let the editor sync. */
  private async prepareSelection(range: Range): Promise<boolean> {
    this.focus();
    const sel = this.selection();
    if (!sel) return false;
    try {
      sel.removeAllRanges();
      sel.addRange(range.cloneRange());
    } catch {
      return false;
    }
    if (this.draftJs) {
      // Draft.js tracks selection only through its onSelect handler: nudge it and give it two frames.
      try {
        this.doc.dispatchEvent(new Event('selectionchange'));
      } catch {
        // ignore
      }
      await nextFrame();
      await nextFrame();
    } else {
      await nextFrame();
    }
    return !this.disposed;
  }

  /** The deepest element at the range start inside the root (events bubble from here to the editor's listeners). */
  private eventTarget(range: Range): Element {
    const n = range.startContainer;
    const el = n.nodeType === ELEMENT_NODE ? (n as Element) : n.parentElement;
    return el && (el === this.element || this.element.contains(el)) ? el : this.element;
  }

  private async rungExecCommand(range: Range, edit: Edit, isDeletion: boolean): Promise<RunResult> {
    const doc = this.doc as Document & { execCommand?: (id: string, ui: boolean, value: string) => boolean };
    if (typeof doc.execCommand !== 'function') return false;
    if (!(await this.prepareSelection(range))) return false;
    if (!this.isFocused()) return false;
    try {
      doc.execCommand(isDeletion ? 'delete' : 'insertText', false, edit.replacement);
    } catch {
      return false;
    }
    this.invalidate();
    return 'performed';
  }

  private async rungBeforeInput(range: Range, edit: Edit, isDeletion: boolean): Promise<RunResult> {
    if (typeof InputEvent !== 'function') return false;
    if (!(await this.prepareSelection(range))) return false;
    if (range.collapsed && edit.range.end > edit.range.start) return false; // the editor re-rendered under us
    const staticRange = makeStaticRange(range);
    const init: InputEventInit & { targetRanges?: StaticRange[] } = {
      inputType: isDeletion ? 'deleteContentBackward' : 'insertReplacementText',
      data: isDeletion ? null : edit.replacement,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const dt = isDeletion ? null : makeDataTransfer(edit.replacement);
    if (dt) init.dataTransfer = dt;
    if (staticRange) init.targetRanges = [staticRange];
    const ev = new InputEvent('beforeinput', init);
    if (staticRange) {
      try {
        Object.defineProperty(ev, 'getTargetRanges', { value: () => [staticRange], configurable: true });
      } catch {
        // frozen prototype: the editor falls back to the selection we set
      }
    }
    this.eventTarget(range).dispatchEvent(ev);
    this.invalidate();
    if (ev.defaultPrevented) return 'claimed';
    // Nobody claimed the event: write the DOM so plain contenteditables and DOM-reading editors see the result,
    // unless a listener already changed the text without preventDefault.
    if (!editMatchesText(this.getText(), edit)) return 'performed';
    return this.spliceDom(range, edit, isDeletion);
  }

  private async rungPaste(range: Range, edit: Edit): Promise<RunResult> {
    if (typeof ClipboardEvent !== 'function') return false;
    const text = this.collapsesWhitespace() ? edgeSpacesToNbsp(edit.replacement) : edit.replacement;
    const dt = makeDataTransfer(text);
    if (!dt) return false;
    if (!(await this.prepareSelection(range))) return false;
    let ev: ClipboardEvent;
    try {
      ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    } catch {
      return false;
    }
    if (!ev.clipboardData) {
      try {
        Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true });
      } catch {
        return false;
      }
    }
    this.eventTarget(range).dispatchEvent(ev);
    this.invalidate();
    // A synthetic paste has no default action: only a listener that claimed it can have written anything.
    return ev.defaultPrevented ? 'claimed' : 'performed';
  }

  /** Direct Range mutation: deleteContents, insert a Text node, normalize, caret after it, `input` event. */
  private spliceDom(range: Range, edit: Edit, isDeletion: boolean): RunResult {
    const doc = this.doc;
    try {
      range.deleteContents();
      let host: Node = range.commonAncestorContainer;
      if (!isDeletion) {
        const inserted = doc.createTextNode(edit.replacement);
        range.insertNode(inserted);
        host = inserted.parentNode ?? host;
      }
      const hostEl = host.nodeType === ELEMENT_NODE ? (host as Element) : host.parentElement;
      hostEl?.normalize();
    } catch {
      this.invalidate();
      return 'performed';
    }
    this.invalidate();
    if (this.isFocused()) {
      const caret = edit.range.start + edit.replacement.length;
      this.setSelection({ start: caret, end: caret });
    }
    this.element.dispatchEvent(
      new InputEvent('input', {
        inputType: isDeletion ? 'deleteContentBackward' : 'insertReplacementText',
        data: isDeletion ? null : edit.replacement,
        bubbles: true,
        composed: true,
      }),
    );
    return 'performed';
  }

  private collapsesWhitespace(): boolean {
    const view = this.doc.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return false;
    try {
      const ws = view.getComputedStyle(this.element).whiteSpace;
      return ws === 'normal' || ws === 'nowrap';
    } catch {
      return false;
    }
  }

  // --- subscriptions ---------------------------------------------------------

  onChange(cb: (text: string, inputType: string | null) => void): () => void {
    this.changeSubs.add(cb);
    return () => {
      this.changeSubs.delete(cb);
    };
  }

  onLayout(cb: () => void): () => void {
    this.layoutSubs.add(cb);
    return () => {
      this.layoutSubs.delete(cb);
    };
  }

  onFocusChange(cb: (focused: boolean) => void): () => void {
    const root = this.element;
    let focused = this.isFocused();
    const onIn = () => {
      if (!focused) {
        focused = true;
        cb(true);
      }
    };
    const onOut = (ev: Event) => {
      const next = (ev as FocusEvent).relatedTarget as Node | null;
      if (next && (next === root || root.contains(next))) return; // focus moved within the editor
      if (focused) {
        focused = false;
        cb(false);
      }
    };
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    return () => {
      root.removeEventListener('focusin', onIn);
      root.removeEventListener('focusout', onOut);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers.splice(0)) d();
    this.changeSubs.clear();
    this.layoutSubs.clear();
    this.cache = null;
  }

  // --- internals -------------------------------------------------------------

  private listen(target: EventTarget, type: string, handler: (ev: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  private selection(): Selection | null {
    const rootNode = this.element.getRootNode();
    if (rootNode.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const sr = rootNode as ShadowRoot & { getSelection?: () => Selection | null };
      if (typeof sr.getSelection === 'function') {
        try {
          const s = sr.getSelection();
          if (s) return s;
        } catch {
          // fall through to the document selection
        }
      }
    }
    return this.doc.getSelection();
  }

  /** The cached serialization, refreshed when mutations are pending (so reads between microtasks stay honest). */
  private serialized(): SerializedText {
    if (this.observer) {
      const records = this.observer.takeRecords();
      if (records.length > 0) this.handleMutations();
    }
    if (!this.cache) this.cache = serializeEditable(this.element);
    return this.cache;
  }

  private invalidate(): void {
    this.cache = null;
  }

  private handleMutations(): void {
    this.invalidate();
    if (this.composing) {
      this.dirtyWhileComposing = true;
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.disposed) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.disposed) return;
    const inputType = this.pendingInputType;
    this.pendingInputType = null;
    if (this.composing) {
      this.dirtyWhileComposing = true;
      return;
    }
    const text = this.getText();
    if (text !== this.lastText) {
      this.lastText = text;
      for (const cb of [...this.changeSubs]) cb(text, inputType);
    }
    this.notifyLayout();
  }

  private readonly notifyLayout = (): void => {
    if (this.disposed) return;
    for (const cb of [...this.layoutSubs]) cb();
  };

  private readonly onScrollAnywhere = (ev: Event): void => {
    if (ev.target === this.element) return; // already handled by the root's own listener
    this.notifyLayout();
  };
}
