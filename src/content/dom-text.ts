/**
 * dom-text: a faithful, reversible mapping between a contenteditable element's DOM and a plain
 * text string.
 *
 * Suggestions are computed by the engine on plain text (UTF-16 code-unit offsets). To draw an
 * underline or apply a replacement we must find the live DOM nodes behind those offsets, and to
 * report the caret/selection to the engine we must go the other way. This module does both, with
 * no chrome.* APIs and no layout dependency (it can run in jsdom).
 *
 * ## Serialization rules (what the engine sees)
 *
 * We approximate Chrome's `innerText` for the DOM shapes real editors produce (Gmail, Draft.js,
 * ProseMirror, Lexical, Quill, Slack, Outlook) without consulting layout:
 *
 * - Text node data is appended verbatim. Whitespace is NOT collapsed because editors use
 *   `white-space: pre-wrap` (and when they do not, Chrome's editing engine already turns
 *   preserved spaces into NBSP, so there is nothing to collapse). NBSP (U+00A0) is replaced by a
 *   regular space in the OUTPUT so the LLM sees ordinary words, but it stays one code unit, so
 *   offsets remain 1:1 with the Text node's data. Callers that compare `text.slice(a, b)` with
 *   `Range.toString()` must therefore normalise NBSP first.
 * - Block-level elements (by tag, see {@link BLOCK_TAGS}, or by computed display
 *   block/flow-root/list-item/table/table-row/table-cell/table-caption/flex/grid when
 *   `getComputedStyle` is available and answers, or by the caller's `treatAsBlock` predicate)
 *   produce exactly ONE "\n" BETWEEN consecutive runs of content, never a leading or trailing
 *   newline, and nested blocks never double up: `<div><div>a</div></div><div>b</div>` → "a\nb".
 *   Unlike `innerText` we do not emit two newlines for `<p>`; a paragraph break is one "\n".
 *   TD/TH are blocks too (cells are separated by "\n", not "\t").
 * - `<br>` produces "\n", EXCEPT a trailing placeholder `<br>` (last renderable thing on its
 *   line inside a block that already has content on that line) produces nothing, while a `<br>`
 *   that is the only content of its line (`<div><br></div>`, the empty line every editor makes
 *   when you press Enter twice) produces an empty line: it is recorded as a zero-length `empty`
 *   segment so the caret can be placed on it, and the block boundaries around it supply the
 *   newlines. A trailing `<div><br></div>` at the end of the document is a real empty line the
 *   user created and keeps its preceding "\n"; only block-boundary newlines are suppressed at
 *   the ends of the document.
 * - Skipped entirely: SCRIPT, STYLE, TEMPLATE, NOSCRIPT, comments, elements with the `hidden`
 *   attribute, `aria-hidden="true"`, or display:none (inline style, or computed when available).
 * - `contenteditable="false"` islands (an @mention chip, a link card) have their visible text
 *   included so offsets match what the user sees, and are reported in `atomic` so callers can
 *   refuse edits that overlap them (editing inside a chip corrupts the host editor's model).
 *   Replaced/embedded elements (IMG, VIDEO, IFRAME, INPUT, …) contribute no text and are
 *   reported as ZERO-LENGTH atomic ranges: an edit whose range strictly contains that offset
 *   would silently delete the object (Slack and Gmail render emoji as `<img>`), so callers can
 *   refuse those too. Edits that merely touch a zero-length atomic range are fine.
 * - Zero-width characters (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM) are KEPT in the
 *   text so offsets stay aligned with the DOM, and their offsets are listed in `zeroWidth`.
 *   Editors insert ZWSP as caret anchors (Draft.js, Slate, Lexical, Gmail chips) and ZWJ joins
 *   emoji sequences; a suggestion that only touches these characters is noise and, if applied,
 *   can break the editor's internal state. Callers drop such suggestions.
 *
 * ## Position mapping
 *
 * `segments` is the complete, closure-free record of where every code unit came from, in
 * document order with non-decreasing offsets:
 * - `text`    [start, end) ↔ `node.data` (same length; NBSP differs).
 * - `newline` [start, start+1) ↔ a synthetic "\n". `node` is the `<br>` that produced it, or
 *   the block element whose edge produced it (the block that closed, or the block that opened
 *   when inline content precedes it).
 * - `empty`   [start, start] ↔ an empty line made of a lone `<br>` (`node`). Zero-length.
 * Text offsets adjacent to a block-boundary newline never resolve to the newline itself: they
 * resolve to the content on either side (see {@link toDomPosition} for the affinity rules).
 * Going the other way, an element point next to a block-boundary newline resolves to the side
 * of the break it is visually on: still inside the block that closed → end of that line (see
 * {@link fromDomPosition}).
 */

import type { TextRange } from '@shared/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A DOM boundary point, as used by Range/Selection: `offset` is a code-unit index in a Text node, else a child index. */
export interface DomPosition {
  node: Node;
  offset: number;
}

/** A run of characters that came from a Text node. `end - start === node.data.length`. */
export interface TextSegment {
  kind: 'text';
  start: number;
  end: number;
  node: Text;
}

/** A synthetic "\n". `node` is the `<br>` or the block element that produced it. `end === start + 1`. */
export interface NewlineSegment {
  kind: 'newline';
  start: number;
  end: number;
  node: Element;
}

/** A zero-length anchor for an empty line made of a lone `<br>` (`node`). `end === start`. */
export interface EmptyLineSegment {
  kind: 'empty';
  start: number;
  end: number;
  node: Element;
}

export type Segment = TextSegment | NewlineSegment | EmptyLineSegment;

export interface SerializedText {
  /** The element that was serialized. Positions are only resolved inside it. */
  root: HTMLElement;
  /** Plain text the engine checks. NBSP already replaced by " "; zero-width characters kept. */
  text: string;
  /** Where each code unit came from, in document order. See the module doc. */
  segments: Segment[];
  /**
   * Ranges the caller must not edit across: `contenteditable="false"` islands (non-empty) and
   * replaced elements such as `<img>` (zero-length, start === end). Sorted by start.
   */
  atomic: TextRange[];
  /** Offsets of zero-width characters (U+200B, U+200C, U+200D, U+FEFF) in `text`, ascending. */
  zeroWidth: number[];
}

export interface SerializeOptions {
  /** Extra predicate for host-specific block containers (e.g. a span the host styles as a line). */
  treatAsBlock?: (el: Element) => boolean;
}

/**
 * Which side of an offset a DOM position should attach to when both are possible (the offset sits
 * between two Text nodes, or next to a synthetic newline).
 * - `forward`: the start of the content that follows the offset (good for range starts / carets).
 * - `backward`: the end of the content that precedes the offset (good for range ends).
 */
export type Affinity = 'forward' | 'backward';

// ---------------------------------------------------------------------------
// Element classification
// ---------------------------------------------------------------------------

/** Tags treated as block-level regardless of computed style. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL', 'TD', 'TH',
]);

const BLOCK_DISPLAYS: ReadonlySet<string> = new Set([
  'block', 'flow-root', 'list-item', 'table', 'table-row', 'table-cell', 'table-caption', 'flex', 'grid',
]);

const SKIP_TAGS: ReadonlySet<string> = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/** Elements that render as an object, contribute no text, and must not be deleted by a text edit. */
const REPLACED_TAGS: ReadonlySet<string> = new Set([
  'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA', 'METER', 'PROGRESS', 'PICTURE',
]);

const ZERO_WIDTH_RE = /[​‌‍﻿]/g;
const NBSP_RE = / /g;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// compareDocumentPosition bit flags (numeric so this file does not depend on the `Node` global).
const POSITION_PRECEDING = 2;
const POSITION_FOLLOWING = 4;
const POSITION_CONTAINS = 8;
const POSITION_CONTAINED_BY = 16;

/** Computed `display`, or "" when getComputedStyle is unavailable or has no answer (detached nodes, jsdom quirks). */
function computedDisplay(el: Element): string {
  const view = el.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return '';
  try {
    return view.getComputedStyle(el).display ?? '';
  } catch {
    return '';
  }
}

/**
 * True when `el` starts/ends a line: a block-level tag (see {@link BLOCK_TAGS}) or, when the
 * environment can compute styles, a block-like computed display (block, flow-root, list-item,
 * table, table-row, table-cell, table-caption, flex, grid). Inline-block is not a block.
 */
export function isBlockElement(el: Element, display: string = computedDisplay(el)): boolean {
  if (BLOCK_TAGS.has(el.tagName.toUpperCase())) return true;
  return display !== '' && BLOCK_DISPLAYS.has(display);
}

function isSkipped(el: Element, display: string): boolean {
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const style = (el as HTMLElement).style;
  if (style && style.display === 'none') return true;
  return display === 'none';
}

function isAtomicElement(el: Element): boolean {
  const attr = el.getAttribute('contenteditable');
  return attr !== null && attr.toLowerCase() === 'false';
}

function isReplacedElement(el: Element): boolean {
  return REPLACED_TAGS.has(el.tagName.toUpperCase());
}

function indexInParent(node: Node): number {
  let i = 0;
  for (let n = node.previousSibling; n; n = n.previousSibling) i++;
  return i;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface BlockFrame {
  el: Element;
  /** Content emitted on the current line run of this block (reset when a nested block closes). */
  lineHasContent: boolean;
}

interface PendingBoundary {
  el: Element;
  /** Zero-length segments/atomics appended at or after these indexes were recorded while the boundary was pending and shift by one when it is emitted. */
  segIndex: number;
  atomicIndex: number;
}

class Builder {
  readonly chunks: string[] = [];
  length = 0;
  readonly segments: Segment[] = [];
  readonly atomic: TextRange[] = [];
  readonly zeroWidth: number[] = [];
  readonly frames: BlockFrame[] = [];
  pending: PendingBoundary | null = null;
  docHasContent = false;
  atomicDepth = 0;
  /** Computed display per element, read at most once per serialization (getComputedStyle is the dominant cost). */
  private readonly displays = new Map<Element, string>();

  constructor(
    readonly root: HTMLElement,
    readonly treatAsBlock: ((el: Element) => boolean) | undefined,
  ) {
    this.frames.push({ el: root, lineHasContent: false });
  }

  get frame(): BlockFrame {
    const f = this.frames[this.frames.length - 1];
    if (!f) throw new Error('dom-text: block frame stack underflow');
    return f;
  }

  display(el: Element): string {
    let d = this.displays.get(el);
    if (d === undefined) {
      d = computedDisplay(el);
      this.displays.set(el, d);
    }
    return d;
  }

  isBlock(el: Element, display: string = this.display(el)): boolean {
    return isBlockElement(el, display) || (this.treatAsBlock !== undefined && this.treatAsBlock(el));
  }

  /** Request a line break before the next content. Only the first request is kept; requests collapse. */
  requestBoundary(el: Element): void {
    if (!this.docHasContent || this.pending) return;
    this.pending = { el, segIndex: this.segments.length, atomicIndex: this.atomic.length };
  }

  /** Emit the pending block-boundary newline, placing it before any zero-length records made since. */
  flushPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const seg: NewlineSegment = { kind: 'newline', start: this.length, end: this.length + 1, node: p.el };
    for (let i = p.segIndex; i < this.segments.length; i++) {
      const s = this.segments[i]!;
      s.start += 1;
      s.end += 1;
    }
    this.segments.splice(p.segIndex, 0, seg);
    for (let i = p.atomicIndex; i < this.atomic.length; i++) {
      const a = this.atomic[i]!;
      a.start += 1;
      a.end += 1;
    }
    this.chunks.push('\n');
    this.length += 1;
  }

  markContent(): void {
    this.frame.lineHasContent = true;
    this.docHasContent = true;
  }

  walk(node: Node): void {
    if (node.nodeType === TEXT_NODE) {
      this.text(node as Text);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return; // comments, processing instructions
    const el = node as Element;
    const display = this.display(el);
    if (isSkipped(el, display)) return;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR') {
      this.br(el);
      return;
    }
    if (isReplacedElement(el)) {
      // No text, but a real object at this offset: record a zero-length atomic range.
      this.atomic.push({ start: this.length, end: this.length });
      return;
    }
    const atomicHere = this.atomicDepth === 0 && isAtomicElement(el);
    let atomicEntry: TextRange | null = null;
    if (atomicHere) {
      atomicEntry = { start: this.length, end: this.length };
      this.atomic.push(atomicEntry);
      this.atomicDepth++;
    }
    const block = this.isBlock(el, display);
    if (block) {
      this.requestBoundary(el);
      this.frames.push({ el, lineHasContent: false });
    }
    for (let child = el.firstChild; child; child = child.nextSibling) this.walk(child);
    if (block) {
      this.frames.pop();
      this.frame.lineHasContent = false;
      this.requestBoundary(el);
    }
    if (atomicEntry) {
      this.atomicDepth--;
      atomicEntry.end = this.length;
    }
  }

  text(node: Text): void {
    const data = node.data;
    if (data.length === 0) {
      // Still a valid caret position; keep it addressable as a zero-length segment.
      this.segments.push({ kind: 'text', start: this.length, end: this.length, node });
      return;
    }
    this.flushPending();
    const start = this.length;
    this.segments.push({ kind: 'text', start, end: start + data.length, node });
    this.chunks.push(data.replace(NBSP_RE, ' '));
    this.length += data.length;
    ZERO_WIDTH_RE.lastIndex = 0;
    for (let m = ZERO_WIDTH_RE.exec(data); m; m = ZERO_WIDTH_RE.exec(data)) this.zeroWidth.push(start + m.index);
    this.markContent();
  }

  br(el: Element): void {
    const trailing = !this.hasContentAfter(el);
    if (trailing && this.frame.lineHasContent) return; // placeholder <br> at the end of a line
    this.flushPending();
    if (trailing) {
      // Lone <br>: an empty line. Zero-length anchor; surrounding block boundaries give the "\n"s.
      this.segments.push({ kind: 'empty', start: this.length, end: this.length, node: el });
    } else {
      this.segments.push({ kind: 'newline', start: this.length, end: this.length + 1, node: el });
      this.chunks.push('\n');
      this.length += 1;
    }
    this.markContent();
  }

  /** Is there renderable content after `br` on the same line (before its block ends or a nested block starts)? */
  hasContentAfter(br: Element): boolean {
    let node: Node = br;
    for (;;) {
      let next: Node | null = node.nextSibling;
      while (!next) {
        const parent: Node | null = node.parentNode;
        if (!parent || parent === this.root) return false;
        if (parent.nodeType === ELEMENT_NODE && this.isBlock(parent as Element)) return false;
        node = parent;
        next = node.nextSibling;
      }
      const kind = this.classify(next);
      if (kind === 'content') return true;
      if (kind === 'block') return false;
      node = next;
    }
  }

  /** First renderable thing inside `node`: text/br/object ("content"), a block (ends the line), or nothing. */
  classify(node: Node): 'content' | 'block' | 'none' {
    if (node.nodeType === TEXT_NODE) return (node as Text).data.length > 0 ? 'content' : 'none';
    if (node.nodeType !== ELEMENT_NODE) return 'none';
    const el = node as Element;
    const display = this.display(el);
    if (isSkipped(el, display)) return 'none';
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR' || isReplacedElement(el)) return 'content';
    if (this.isBlock(el, display)) return 'block';
    for (let child = el.firstChild; child; child = child.nextSibling) {
      const r = this.classify(child);
      if (r !== 'none') return r;
    }
    return 'none';
  }
}

/**
 * Serialize a contenteditable root to plain text plus the segment map needed to go back to the DOM.
 * See the module doc for the exact rules. Pure DOM; safe to call on every input event.
 */
export function serializeEditable(root: HTMLElement, opts: SerializeOptions = {}): SerializedText {
  const b = new Builder(root, opts.treatAsBlock);
  for (let child = root.firstChild; child; child = child.nextSibling) b.walk(child);
  // A trailing block boundary is never emitted (b.pending is simply dropped).
  return { root, text: b.chunks.join(''), segments: b.segments, atomic: b.atomic, zeroWidth: b.zeroWidth };
}

// ---------------------------------------------------------------------------
// Offsets -> DOM
// ---------------------------------------------------------------------------

/** DOM boundary point at the start of a segment, or null for block-boundary newlines (which have no node of their own). */
function segmentStartPoint(seg: Segment): DomPosition | null {
  if (seg.kind === 'text') return { node: seg.node, offset: 0 };
  if (seg.kind === 'empty' || seg.node.tagName.toUpperCase() === 'BR') {
    const parent = seg.node.parentNode;
    return parent ? { node: parent, offset: indexInParent(seg.node) } : null;
  }
  return null;
}

/** DOM boundary point at the end of a segment, or null for block-boundary newlines. */
function segmentEndPoint(seg: Segment): DomPosition | null {
  if (seg.kind === 'text') return { node: seg.node, offset: seg.node.data.length };
  if (seg.kind === 'empty' || seg.node.tagName.toUpperCase() === 'BR') {
    const parent = seg.node.parentNode;
    return parent ? { node: parent, offset: indexInParent(seg.node) + 1 } : null;
  }
  return null;
}

function rootEnd(root: HTMLElement): DomPosition {
  return { node: root, offset: root.childNodes.length };
}

/**
 * Map a text offset to a live DOM boundary point.
 *
 * - An offset strictly inside a Text node's run maps into that Text node (both affinities).
 * - Otherwise the offset sits between two neighbours. `forward` (default) tries, in order: the
 *   start of the following Text node or empty-line anchor; the end of the preceding Text node (or
 *   the point just after a preceding `<br>`); the point just before a following `<br>`.
 *   `backward` tries the preceding neighbour first, then the following ones in the same order.
 *   Block-boundary newlines have no node of their own and are skipped, so for "a\nb" offset 1 →
 *   end of "a" and offset 2 → start of "b" under both affinities, while `<b>foo</b>bar` offset 3
 *   → (bar, 0) forward and (foo, 3) backward.
 * - `offset === text.length` maps to the end of the last Text node (or after the last `<br>`,
 *   or the last empty line's anchor, or the end of the root for an empty editor).
 * - Offsets are clamped to [0, text.length]; the result is always inside `root`.
 */
export function toDomPosition(serialized: SerializedText, offset: number, affinity: Affinity = 'forward'): DomPosition {
  const { segments, text, root } = serialized;
  // NaN -> 0; ±Infinity clamp like any other out-of-range number (Math.trunc keeps them infinite).
  const o = Number.isNaN(offset) ? 0 : Math.max(0, Math.min(Math.trunc(offset), text.length));
  if (segments.length === 0) return rootEnd(root);

  // Index of the first segment whose end >= o (segments are sorted by start, and by end too since
  // zero-length segments at offset k sit before the newline [k, k+1) that follows them).
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.end < o) lo = mid + 1;
    else hi = mid;
  }
  // Candidates in document order: every segment with start <= o <= end.
  const candidates: Segment[] = [];
  for (let i = lo; i < segments.length && segments[i]!.start <= o; i++) candidates.push(segments[i]!);
  if (candidates.length === 0) return rootEnd(root); // cannot happen for a well-formed serialization

  // Strictly inside a text run: unambiguous.
  for (const seg of candidates) {
    if (seg.kind === 'text' && seg.start < o && o < seg.end) return { node: seg.node, offset: o - seg.start };
  }

  // At most one non-empty segment ends at o (runs are disjoint); zero-length segments at o count as following.
  const preceding = candidates.find((s) => s.end === o && s.start < o);
  const following = candidates.filter((s) => s.start === o);

  // Candidate DOM points, each null when that kind of neighbour does not exist here.
  const precedingPoint = preceding ? segmentEndPoint(preceding) : null; // null for a block-boundary newline
  const followingText = following.find((s) => s.kind === 'text' || s.kind === 'empty');
  const followingTextPoint = followingText ? segmentStartPoint(followingText) : null;
  const followingBr = following.find((s) => s.kind === 'newline' && s.node.tagName.toUpperCase() === 'BR');
  const followingBrPoint = followingBr ? segmentStartPoint(followingBr) : null;

  // Text nodes are preferred over element positions on both sides; the position just before a
  // following <br> is the last resort before the root itself.
  const ordered =
    affinity === 'forward'
      ? [followingTextPoint, precedingPoint, followingBrPoint]
      : [precedingPoint, followingTextPoint, followingBrPoint];
  for (const p of ordered) if (p) return p;
  return rootEnd(root);
}

/**
 * A live Range covering `text.slice(start, end)`. The start resolves with forward affinity and
 * the end with backward affinity, so a range over "foo" in `<b>foo</b>bar` stays inside `<b>`.
 * Throws RangeError when the offsets are out of order or outside the text.
 */
export function rangeFromOffsets(serialized: SerializedText, start: number, end: number): Range {
  const { text, root } = serialized;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start > end) {
    throw new RangeError(`dom-text: invalid offsets [${start}, ${end}) for text of length ${text.length}`);
  }
  const doc = root.ownerDocument;
  const range = doc.createRange();
  const s = toDomPosition(serialized, start, 'forward');
  const e = start === end ? s : toDomPosition(serialized, end, 'backward');
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

// ---------------------------------------------------------------------------
// DOM -> offsets
// ---------------------------------------------------------------------------

/**
 * Compare two DOM boundary points in tree order: negative when A is before B, 0 when equal,
 * positive when A is after B. Both points must be in the same tree.
 */
export function compareDomPositions(a: DomPosition, b: DomPosition): number {
  if (a.node === b.node) return a.offset - b.offset;
  const rel = a.node.compareDocumentPosition(b.node);
  if (rel & POSITION_CONTAINED_BY) {
    // b is inside a: find the child of a that contains b.
    let child: Node = b.node;
    while (child.parentNode !== a.node) child = child.parentNode!;
    return indexInParent(child) < a.offset ? 1 : -1;
  }
  if (rel & POSITION_CONTAINS) {
    let child: Node = a.node;
    while (child.parentNode !== b.node) child = child.parentNode!;
    return indexInParent(child) < b.offset ? -1 : 1;
  }
  if (rel & POSITION_FOLLOWING) return -1;
  if (rel & POSITION_PRECEDING) return 1;
  return 0; // disconnected; caller guards against this
}

function isInsideRoot(root: HTMLElement, node: Node): boolean {
  return node === root || root.contains(node);
}

function isBlockNewline(seg: Segment): seg is NewlineSegment {
  return seg.kind === 'newline' && seg.node.tagName.toUpperCase() !== 'BR';
}

/**
 * An element point lies strictly between the content before the block-boundary newline
 * `segments[nlIndex]` and the content after it. Decide which side of the line break it is on
 * from the edge of the block that produced the newline: the newline sits at the block's CLOSING
 * edge when the block contains the preceding content (`<div>ab<br></div>` → `(div, 1)` and
 * `(div, 2)` are still the end of "ab"), else at its OPENING edge (`hello<div>world</div>` →
 * `(root, 1)` is the end of "hello", `(div, 0)` the start of "world").
 */
function resolveAcrossBlockNewline(segments: Segment[], nlIndex: number, point: DomPosition): number {
  const nl = segments[nlIndex]!;
  const block = nl.node;
  let preceding: Segment | undefined;
  for (let j = nlIndex - 1; j >= 0 && !preceding; j--) {
    const s = segments[j]!;
    if (!isBlockNewline(s)) preceding = s;
  }
  const closing = preceding !== undefined && block.contains(preceding.node);
  const parent = block.parentNode;
  if (!parent) return nl.end;
  const index = indexInParent(block);
  const edge: DomPosition = { node: parent, offset: closing ? index + 1 : index };
  const cmp = compareDomPositions(point, edge);
  const beforeBreak = closing ? cmp < 0 : cmp <= 0;
  return beforeBreak ? nl.start : nl.end;
}

/**
 * Map a DOM boundary point back to a text offset, or null when the point is outside `root` or in
 * a Text node that was not serialized (hidden, script, …).
 *
 * - A point in a serialized Text node maps into its run (offset clamped to the node's length).
 * - An element point (`node` is an element, `offset` a child index) maps to the start of the
 *   first serialized content at or after it, so `(div, 0)` for `<div><br></div>` is the empty
 *   line and `(root, root.childNodes.length)` is `text.length`. A point just after a `<br>`
 *   maps to the offset after its newline.
 * - EXCEPT that a point separated from the following content only by a block-boundary newline
 *   stays on the line it is visually on: a point still inside the block that closed
 *   (`<div>ab<br></div>` → `(div, 1)`, `(div, 2)`) is the END of that line, `offset` of the
 *   newline; a point outside it (`(root, 1)` between two `<div>`s) is the start of the next line.
 *   Symmetrically for a block that opens after inline text (`hello<div>world</div>`: `(root, 1)`
 *   → 5, `(div, 0)` → 6).
 */
export function fromDomPosition(serialized: SerializedText, node: Node, offset: number): number | null {
  const { root, segments, text } = serialized;
  if (!isInsideRoot(root, node)) return null;
  const index = positionIndex(serialized);

  if (node.nodeType === TEXT_NODE) {
    const seg = index.byText.get(node);
    return seg ? seg.start + Math.max(0, Math.min(offset, seg.end - seg.start)) : null;
  }

  const point: DomPosition = { node, offset };
  const { positioned } = index;
  const startPoint = (i: number): DomPosition => segmentStartPoint(segments[positioned[i]!]!) ?? rootEnd(root);
  // Start points of positioned segments are in document order: binary search for the first one at or after `point`.
  let lo = 0;
  let hi = positioned.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareDomPositions(point, startPoint(mid)) > 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    // The point is after the previous positioned segment's start: at its end, or inside it (a <br>).
    const prev = segments[positioned[lo - 1]!]!;
    const cmpEnd = compareDomPositions(point, segmentEndPoint(prev) ?? rootEnd(root));
    if (cmpEnd === 0) return prev.end;
    if (cmpEnd < 0) return prev.start; // inside the <br> element itself, e.g. (br, 0)
  }
  if (lo === positioned.length) return text.length;
  const i = positioned[lo]!;
  const next = segments[i]!;
  if (compareDomPositions(point, startPoint(lo)) === 0) return next.start;
  // Strictly between the previous content and `next`. Only a block-boundary newline can sit there
  // without a DOM point of its own; pick the side of the break the point is on.
  const before = i > 0 ? segments[i - 1]! : undefined;
  return before && isBlockNewline(before) ? resolveAcrossBlockNewline(segments, i - 1, point) : next.start;
}

/** Lookup structures for {@link fromDomPosition}, built on first use and held weakly so SerializedText stays plain data. */
interface PositionIndex {
  byText: Map<Node, TextSegment>;
  /** Indexes into `segments` of the segments that have DOM points of their own (all but block-boundary newlines), in document order. */
  positioned: number[];
}

const positionIndexes = new WeakMap<SerializedText, PositionIndex>();

function positionIndex(serialized: SerializedText): PositionIndex {
  let index = positionIndexes.get(serialized);
  if (!index) {
    const byText = new Map<Node, TextSegment>();
    const positioned: number[] = [];
    serialized.segments.forEach((seg, i) => {
      if (seg.kind === 'text') byText.set(seg.node, seg);
      if (segmentStartPoint(seg) !== null) positioned.push(i);
    });
    index = { byText, positioned };
    positionIndexes.set(serialized, index);
  }
  return index;
}

/**
 * The current selection as text offsets, or null when it does not touch `root`. A selection that
 * reaches outside the root on one side is clamped to the root's edge (Ctrl+A on the page selects
 * the whole text); one entirely outside the root yields null.
 */
export function offsetsFromSelection(serialized: SerializedText, selection: Selection): TextRange | null {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const { root, text } = serialized;
  const startIn = isInsideRoot(root, range.startContainer);
  const endIn = isInsideRoot(root, range.endContainer);
  if (!startIn && !endIn) {
    // Only a range that surrounds the root entirely counts.
    if (!range.intersectsNode(root)) return null;
    if (compareDomPositions({ node: range.startContainer, offset: range.startOffset }, { node: root, offset: 0 }) > 0) return null;
    if (compareDomPositions({ node: range.endContainer, offset: range.endOffset }, rootEnd(root)) < 0) return null;
    return { start: 0, end: text.length };
  }
  const start = startIn ? fromDomPosition(serialized, range.startContainer, range.startOffset) : 0;
  const end = endIn ? fromDomPosition(serialized, range.endContainer, range.endOffset) : text.length;
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

// ---------------------------------------------------------------------------
// Rects
// ---------------------------------------------------------------------------

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function makeRect(left: number, top: number, right: number, bottom: number): DOMRect {
  const w = right - left;
  const h = bottom - top;
  if (typeof DOMRect === 'function') return new DOMRect(left, top, w, h);
  const r = { x: left, y: top, left, top, right, bottom, width: w, height: h, toJSON: () => r };
  return r as unknown as DOMRect;
}

/**
 * Drop zero-size rects and merge rects that share a line into one rect per line. Two rects are on
 * the same line when their vertical extents overlap by at least half of the smaller height
 * (a bold run or a chip with padding is taller than its neighbours but still on the same line).
 * Output is sorted top-to-bottom, then left-to-right. Pure; exported for testing.
 */
export function mergeLineRects(rects: Iterable<RectLike>): DOMRect[] {
  const input: RectLike[] = [];
  for (const r of rects) if (r.width > 0 && r.height > 0) input.push(r);
  input.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const r of input) {
    let merged = false;
    for (const line of lines) {
      const overlap = Math.min(line.bottom, r.bottom) - Math.max(line.top, r.top);
      const minHeight = Math.min(line.bottom - line.top, r.height);
      if (overlap >= minHeight / 2) {
        line.left = Math.min(line.left, r.left);
        line.top = Math.min(line.top, r.top);
        line.right = Math.max(line.right, r.right);
        line.bottom = Math.max(line.bottom, r.bottom);
        merged = true;
        break;
      }
    }
    if (!merged) lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  lines.sort((a, b) => a.top - b.top || a.left - b.left);
  return lines.map((l) => makeRect(l.left, l.top, l.right, l.bottom));
}

/**
 * Viewport-relative rects covering `text.slice(start, end)`, one per line, for drawing underlines.
 * Uses `Range.getClientRects()` (unavailable in jsdom, where this returns []).
 */
export function rectsForOffsets(serialized: SerializedText, start: number, end: number): DOMRect[] {
  const range = rangeFromOffsets(serialized, start, end);
  if (typeof (range as Partial<Range>).getClientRects !== 'function') return [];
  return mergeLineRects(Array.from(range.getClientRects()));
}
