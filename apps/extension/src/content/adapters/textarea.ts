/**
 * TextareaAdapter: `<textarea>` and text-like `<input>` (ARCHITECTURE §3.4, research 03 §3.2 and §4.1).
 *
 * Reading is `value`. Geometry comes from a hidden mirror element appended to `document.body` that copies the
 * field's typography and box metrics, holds `value` plus a zero-width sentinel (so trailing spaces and newlines
 * measure), and is measured with `Range.getClientRects()` over its text node; rects are translated into the
 * field's coordinate space (field box − mirror box, minus scroll offsets), clipped to the field's client box and
 * merged per line. The mirror is re-styled lazily after resize, font load and style/attribute changes.
 *
 * Writing: focus + `setSelectionRange` + `execCommand('insertText' | 'delete')` (keeps the host's native undo)
 * → native value setter + `InputEvent('input', insertReplacementText)` (React-safe; no `change` event). Each rung is
 * verified immediately, at the next frame and at +150 ms and never re-run.
 */
import type { BatchEditOutcome, Edit, EditOutcome, FieldKind, TextRange } from '@jammarly/shared/types';
import type { FieldAdapter, SiteProfile } from '../field-adapter';
import { mergeLineRects } from '../dom-text';
import { fieldLabel } from '../detect';
import { applyEditsRightToLeft, clamp, deepActiveElement, expectedTextAfter, runLadder, type RunResult, type RungAttempt } from './common';

export type TextField = HTMLTextAreaElement | HTMLInputElement;

/** Computed properties copied onto the mirror (each listed explicitly: shorthands are not reliably readable). */
export const MIRROR_PROPERTIES: readonly string[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontStretch',
  'fontKerning',
  'fontFeatureSettings',
  'fontVariantLigatures',
  'fontSizeAdjust',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'textIndent',
  'textAlign',
  'lineHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'wordBreak',
  'overflowWrap',
  'tabSize',
  'direction',
  'unicodeBidi',
  'writingMode',
  'textRendering',
  'hyphens',
];

/** Zero-width, so offsets into the mirror text equal offsets into `value`, but it still creates a line box after a trailing "\n". */
const SENTINEL = '​';

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MirrorGeometry {
  /** Bounding box of the mirror (border box; the mirror copies the field's border widths). */
  mirrorBox: { left: number; top: number };
  /** Bounding box of the field (border box). */
  fieldBox: { left: number; top: number };
  scrollLeft: number;
  scrollTop: number;
  /** Border widths of the field; together with clientWidth/clientHeight they define the visible client box. */
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}

/**
 * Translate rects measured on the mirror into viewport rects over the field: shift by (field box − mirror box)
 * and by the field's scroll offsets, clip to the field's client box (border widths + client size) and merge per
 * line. Because the mirror copies the border widths, clientLeft/clientTop only enter the clip box. Pure.
 */
export function translateMirrorRects(rects: Iterable<RectLike>, g: MirrorGeometry): DOMRect[] {
  const dx = g.fieldBox.left - g.mirrorBox.left - g.scrollLeft;
  const dy = g.fieldBox.top - g.mirrorBox.top - g.scrollTop;
  const clipLeft = g.fieldBox.left + g.clientLeft;
  const clipTop = g.fieldBox.top + g.clientTop;
  const clipRight = clipLeft + g.clientWidth;
  const clipBottom = clipTop + g.clientHeight;
  const out: RectLike[] = [];
  for (const r of rects) {
    const left = Math.max(r.left + dx, clipLeft);
    const top = Math.max(r.top + dy, clipTop);
    const right = Math.min(r.right + dx, clipRight);
    const bottom = Math.min(r.bottom + dy, clipBottom);
    if (right <= left || bottom <= top) continue;
    out.push({ left, top, right, bottom, width: right - left, height: bottom - top });
  }
  return mergeLineRects(out);
}

/**
 * Set `value` through the prototype's native setter so frameworks that intercept the instance property (React's
 * value tracker) see the change when the following `input` event arrives.
 */
export function setNativeValue(el: TextField, value: string): void {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      desc.set.call(el, value);
      return;
    }
    proto = Object.getPrototypeOf(proto);
  }
  el.value = value;
}

function px(v: string | undefined): number {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

function safeComputedStyle(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  try {
    return view.getComputedStyle(el);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class TextareaAdapter implements FieldAdapter {
  readonly kind: FieldKind;
  readonly element: TextField;
  private readonly profile: SiteProfile;
  private readonly doc: Document;
  private readonly win: Window | null;

  private mirror: HTMLDivElement | null = null;
  private mirrorText: Text | null = null;
  private mirrorDirty = true;

  private composing = false;
  private disposed = false;
  private readonly changeSubs = new Set<(text: string, inputType: string | null) => void>();
  private readonly layoutSubs = new Set<() => void>();
  private readonly disposers: (() => void)[] = [];

  constructor(element: TextField, profile: SiteProfile) {
    this.element = element;
    this.kind = element.tagName.toUpperCase() === 'TEXTAREA' ? 'textarea' : 'input';
    this.profile = profile;
    this.doc = element.ownerDocument;
    this.win = this.doc.defaultView;
    this.listen(element, 'compositionstart', () => {
      this.composing = true;
    });
    this.listen(element, 'compositionend', () => {
      this.composing = false;
      this.emitChange('insertCompositionText');
    });
    this.listen(element, 'input', (ev) => {
      const ie = ev as InputEvent;
      if (this.composing || ie.isComposing) return;
      this.emitChange(ie.inputType ?? null);
    });
    // The field's own scroll is not composed (invisible to the document listener inside a shadow root), so it
    // gets its own listener and the document-level capture listener skips it to avoid double notifications.
    this.listen(element, 'scroll', this.notifyLayout, { passive: true });
    this.listen(this.doc, 'scroll', this.onScrollAnywhere, { capture: true, passive: true });
    if (this.win) this.listen(this.win, 'resize', this.invalidateMirror);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.invalidateMirror());
      ro.observe(element);
      this.disposers.push(() => ro.disconnect());
    }
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => this.invalidateMirror());
      mo.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'rows', 'cols', 'wrap', 'dir'] });
      this.disposers.push(() => mo.disconnect());
    }
    const fonts = (this.doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) {
      fonts.ready
        ?.then(() => {
          if (!this.disposed) this.invalidateMirror();
        })
        .catch(() => undefined);
      if (typeof fonts.addEventListener === 'function') this.listen(fonts, 'loadingdone', this.invalidateMirror);
    }
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
    return this.element.value;
  }

  getRangeRects(range: TextRange): DOMRect[] {
    const { mirror, text } = this.ensureMirror();
    if (this.mirrorDirty) {
      this.syncMirrorStyle(mirror);
      this.mirrorDirty = false;
    }
    const value = this.element.value;
    const data = value + SENTINEL;
    if (text.data !== data) text.data = data;
    const len = value.length;
    const start = clamp(Number.isFinite(range.start) ? Math.trunc(range.start) : 0, 0, len);
    const end = clamp(Number.isFinite(range.end) ? Math.trunc(range.end) : 0, start, len);
    if (end <= start) return [];
    const r = this.doc.createRange();
    r.setStart(text, start);
    r.setEnd(text, end);
    if (typeof (r as Partial<Range>).getClientRects !== 'function') return []; // jsdom
    const el = this.element;
    return translateMirrorRects(Array.from(r.getClientRects()), {
      mirrorBox: mirror.getBoundingClientRect(),
      fieldBox: el.getBoundingClientRect(),
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      clientLeft: el.clientLeft,
      clientTop: el.clientTop,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    });
  }

  getProtectedRanges(): TextRange[] {
    return [];
  }

  getSelection(): TextRange | null {
    const s = this.element.selectionStart;
    const e = this.element.selectionEnd;
    if (s === null || e === null) return null;
    return { start: Math.min(s, e), end: Math.max(s, e) };
  }

  setSelection(range: TextRange): void {
    const len = this.element.value.length;
    const start = clamp(range.start, 0, len);
    const end = clamp(range.end, start, len);
    try {
      this.element.setSelectionRange(start, end);
    } catch {
      // input types without selection support
    }
  }

  isComposing(): boolean {
    return this.composing;
  }

  isFocused(): boolean {
    return deepActiveElement(this.doc) === this.element;
  }

  focus(): void {
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
    const el = this.element;
    if (this.composing) return { status: 'composing', rung: null, text: el.value };
    const rungs: RungAttempt[] = [
      { rung: 'execCommand', run: () => this.runExecCommand(edit) },
      { rung: 'splice', run: () => this.runSplice(edit) },
    ];
    return runLadder(edit, () => el.value, rungs);
  }

  applyEdits(edits: Edit[]): Promise<BatchEditOutcome> {
    return applyEditsRightToLeft(edits, (e) => this.applyEdit(e), () => this.element.value, () => true);
  }

  /** focus + setSelectionRange + execCommand: fires a native `input` and leaves one undo step. */
  private runExecCommand(edit: Edit): RunResult {
    const doc = this.doc as Document & { execCommand?: (id: string, ui: boolean, value: string) => boolean };
    if (typeof doc.execCommand !== 'function') return false;
    this.focus();
    if (!this.isFocused()) return false;
    try {
      this.element.setSelectionRange(edit.range.start, edit.range.end, 'forward');
    } catch {
      return false;
    }
    try {
      doc.execCommand(edit.replacement === '' ? 'delete' : 'insertText', false, edit.replacement);
    } catch {
      return false;
    }
    return 'performed';
  }

  /** Native value setter + synthetic InputEvent (insertReplacementText); never dispatches `change`. */
  private runSplice(edit: Edit): RunResult {
    const el = this.element;
    setNativeValue(el, expectedTextAfter(el.value, edit));
    const caret = edit.range.start + edit.replacement.length;
    this.setSelection({ start: caret, end: caret });
    const isDeletion = edit.replacement === '';
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: isDeletion ? 'deleteContentBackward' : 'insertReplacementText',
        data: isDeletion ? null : edit.replacement,
      }),
    );
    return 'performed';
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
    const onFocus = () => cb(true);
    const onBlur = () => cb(false);
    this.element.addEventListener('focus', onFocus);
    this.element.addEventListener('blur', onBlur);
    return () => {
      this.element.removeEventListener('focus', onFocus);
      this.element.removeEventListener('blur', onBlur);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers.splice(0)) d();
    this.changeSubs.clear();
    this.layoutSubs.clear();
    this.mirror?.remove();
    this.mirror = null;
    this.mirrorText = null;
  }

  // --- internals -------------------------------------------------------------

  private listen(target: EventTarget, type: string, handler: (ev: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  private emitChange(inputType: string | null): void {
    if (this.disposed) return;
    const text = this.element.value;
    for (const cb of [...this.changeSubs]) cb(text, inputType);
  }

  private readonly notifyLayout = (): void => {
    if (this.disposed) return;
    for (const cb of [...this.layoutSubs]) cb();
  };

  private readonly onScrollAnywhere = (ev: Event): void => {
    if (ev.target === this.element) return; // already handled by the field's own listener
    this.notifyLayout();
  };

  private readonly invalidateMirror = (): void => {
    this.mirrorDirty = true;
    this.notifyLayout();
  };

  private ensureMirror(): { mirror: HTMLDivElement; text: Text } {
    if (this.mirror && this.mirrorText && this.mirror.isConnected) return { mirror: this.mirror, text: this.mirrorText };
    const doc = this.doc;
    const mirror = doc.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    mirror.setAttribute('data-jammarly-mirror', '');
    const st = mirror.style;
    st.position = 'absolute';
    st.top = '0';
    st.left = '0';
    st.visibility = 'hidden';
    st.pointerEvents = 'none';
    st.overflow = 'hidden';
    st.height = 'auto';
    st.minHeight = '0';
    st.maxHeight = 'none';
    st.margin = '0';
    st.boxSizing = 'border-box';
    st.borderStyle = 'solid';
    st.borderColor = 'transparent';
    st.zIndex = '-1';
    const text = doc.createTextNode('');
    mirror.appendChild(text);
    (doc.body ?? doc.documentElement).appendChild(mirror);
    this.mirror = mirror;
    this.mirrorText = text;
    this.mirrorDirty = true;
    return { mirror, text };
  }

  private syncMirrorStyle(mirror: HTMLDivElement): void {
    const el = this.element;
    const cs = safeComputedStyle(el);
    if (!cs) return;
    const source = cs as unknown as Record<string, unknown>;
    const target = mirror.style as unknown as Record<string, string>;
    for (const prop of MIRROR_PROPERTIES) {
      const v = source[prop];
      if (typeof v === 'string' && v !== '') target[prop] = v;
    }
    if (this.kind === 'input') {
      mirror.style.whiteSpace = 'pre';
      mirror.style.overflowWrap = 'normal';
      mirror.style.wordBreak = 'normal';
    } else {
      mirror.style.whiteSpace = (el as HTMLTextAreaElement).wrap === 'off' ? 'pre' : 'pre-wrap';
    }
    // Content width must match exactly: clientWidth excludes the scrollbar, the copied borders are added back.
    mirror.style.width = `${el.clientWidth + px(cs.borderLeftWidth) + px(cs.borderRightWidth)}px`;
    if (this.kind === 'input') {
      // Chrome centres an input's single line inside its content box; a div puts it at the top.
      const contentHeight = el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
      const lineHeight = px(cs.lineHeight);
      if (contentHeight > 0 && contentHeight > lineHeight) mirror.style.lineHeight = `${contentHeight}px`;
    }
  }
}
