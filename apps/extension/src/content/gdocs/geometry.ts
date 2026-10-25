/**
 * Geometry for the Google Docs annotated canvas (06 §1.2, §1.6).
 *
 * When Docs accepts the announced extension id it renders, per `.kix-canvas-tile-content` tile, an `<svg>` whose
 * `<g transform="matrix(a,0,0,d,tx,ty)">` groups hold `<rect aria-label="…" x y width height data-font-css>` text
 * runs. Runs can split a word at tile or style boundaries ("This is pa" + "ragr" + "aph"), so they are mapped to
 * text offsets by walking them in document order and matching their labels against the normalized document text.
 *
 * Everything here is pure except `collectTextRuns` (reads attributes, no layout) and `canvasMeasure` (feature-detected
 * `CanvasRenderingContext2D.measureText`). The MAIN-world bridge and the isolated-world adapter share this code; it
 * never touches HTML-string sinks.
 */
import { mergeLineRects } from '../dom-text';
import { normalizeNbsp } from './text';

/** 2-D affine matrix in SVG order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Readonly<Matrix> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** `m1 · m2`: apply `m2` first, then `m1` (how nested SVG transforms compose, outer · inner). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

const TRANSFORM_FN_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

function numbers(args: string): number[] {
  return args
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/**
 * Parse an SVG `transform` attribute (`matrix`, `translate`, `scale`; functions compose left to right as the SVG
 * spec prescribes). Unknown functions and malformed input contribute the identity.
 */
export function parseTransform(transform: string | null | undefined): Matrix {
  if (!transform) return { ...IDENTITY };
  let m: Matrix = { ...IDENTITY };
  for (const match of transform.matchAll(TRANSFORM_FN_RE)) {
    const fn = (match[1] ?? '').toLowerCase();
    const n = numbers(match[2] ?? '');
    let t: Matrix | null = null;
    if (fn === 'matrix' && n.length === 6) t = { a: n[0]!, b: n[1]!, c: n[2]!, d: n[3]!, e: n[4]!, f: n[5]! };
    else if (fn === 'translate' && n.length >= 1) t = { a: 1, b: 0, c: 0, d: 1, e: n[0]!, f: n[1] ?? 0 };
    else if (fn === 'scale' && n.length >= 1) t = { a: n[0]!, b: 0, c: 0, d: n[1] ?? n[0]!, e: 0, f: 0 };
    if (t) m = multiply(m, t);
  }
  return m;
}

/** The horizontal scale factor of a matrix (Docs' zoom lives in `a`). */
export function matrixScale(m: Matrix): number {
  return Math.hypot(m.a, m.b) || 1;
}

/** A viewport-relative box in CSS pixels. */
export interface RunBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One `rect[aria-label]` run: its text, its viewport box, the unscaled CSS font shorthand and the zoom factor. */
export interface TextRun {
  text: string;
  box: RunBox;
  /** `data-font-css` (unscaled units), "" when absent. */
  font: string;
  /** Zoom scale from the group transform (1 at 100 %). */
  scale: number;
}

/** A run with the normalized text offsets it covers. */
export interface MappedRun extends TextRun {
  start: number;
  end: number;
}

export interface RectAttributes {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transform a rect's unscaled attributes through `m` and translate by the `<svg>` element's viewport origin. The four
 * corners are transformed and bounded so a rotated or skewed matrix still yields a sane box.
 */
export function runBox(attrs: RectAttributes, m: Matrix, origin: { left: number; top: number }): RunBox {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [attrs.x, attrs.y],
    [attrs.x + attrs.width, attrs.y],
    [attrs.x, attrs.y + attrs.height],
    [attrs.x + attrs.width, attrs.y + attrs.height],
  ] as const) {
    xs.push(m.a * x + m.c * y + m.e);
    ys.push(m.b * x + m.d * y + m.f);
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left: origin.left + left, top: origin.top + top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** CSS selector for the annotation-layer runs, in document order. */
export const RUN_SELECTOR = '.kix-canvas-tile-content svg g rect[aria-label]';

export interface CollectOptions {
  /** Viewport origin of an `<svg>` element; defaults to its `getBoundingClientRect()` (zeros in jsdom). */
  origin?: (svg: Element) => { left: number; top: number };
}

function num(el: Element, name: string): number {
  const v = Number(el.getAttribute(name));
  return Number.isFinite(v) ? v : 0;
}

function defaultOrigin(svg: Element): { left: number; top: number } {
  if (typeof svg.getBoundingClientRect !== 'function') return { left: 0, top: 0 };
  const r = svg.getBoundingClientRect();
  return { left: r.left, top: r.top };
}

/** Compose the `transform` attributes from `el` (inclusive) up to, excluding, its owning `<svg>`. */
export function composedTransform(el: Element): Matrix {
  const chain: Matrix[] = [];
  let node: Element | null = el;
  while (node && node.localName !== 'svg') {
    const t = node.getAttribute('transform');
    if (t) chain.push(parseTransform(t));
    node = node.parentElement;
  }
  // chain is inner → outer; compose as outer · … · inner
  let m: Matrix = { ...IDENTITY };
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, chain[i]!);
  return m;
}

/** Read every annotation run under `root` in document order. Attribute reads only (no layout, except `origin`). */
export function collectTextRuns(root: ParentNode, opts: CollectOptions = {}): TextRun[] {
  const origin = opts.origin ?? defaultOrigin;
  const runs: TextRun[] = [];
  const rects = root.querySelectorAll(RUN_SELECTOR);
  for (const rect of Array.from(rects)) {
    const label = rect.getAttribute('aria-label');
    if (label === null) continue;
    const svg = rect.closest('svg');
    if (!svg) continue;
    const m = composedTransform(rect);
    const attrs: RectAttributes = { x: num(rect, 'x'), y: num(rect, 'y'), width: num(rect, 'width'), height: num(rect, 'height') };
    runs.push({ text: label, box: runBox(attrs, m, origin(svg)), font: rect.getAttribute('data-font-css') ?? '', scale: matrixScale(m) });
  }
  return runs;
}

/** A run this long (trimmed) may re-anchor the walk after a gap of non-whitespace text (a tile Docs did not render). */
export const RESYNC_MIN_CHARS = 4;

const WHITESPACE_ONLY = /^\s*$/;

/**
 * Assign normalized text offsets to runs by walking them in document order. Consecutive runs are separated in the
 * text by nothing (a word split across tiles), by spaces (a soft line wrap drops the trailing space) or by a
 * paragraph break; any whitespace-only gap is accepted. A non-whitespace gap (an unrendered tile, a table cell)
 * is only bridged by a run of at least RESYNC_MIN_CHARS characters. The walk anchors on the first long run and
 * maps the short runs before it backwards, so a document scrolled to the middle still resolves. Runs that cannot be
 * placed are dropped. Comparison is NBSP-insensitive.
 */
export function mapRunsToText(runs: readonly TextRun[], text: string): MappedRun[] {
  const hay = normalizeNbsp(text);
  const needles = runs.map((r) => normalizeNbsp(r.text));
  const out: (MappedRun | null)[] = runs.map(() => null);
  let anchorIndex = needles.findIndex((n) => n.trim().length >= RESYNC_MIN_CHARS);
  if (anchorIndex < 0) anchorIndex = needles.findIndex((n) => n.trim().length > 0);
  if (anchorIndex < 0) return [];

  // Forward pass from the anchor.
  let cursor = 0;
  let anchored = false;
  let firstStart = -1;
  for (let i = anchorIndex; i < runs.length; i++) {
    const needle = needles[i]!;
    if (needle.trim().length === 0) continue;
    const idx = hay.indexOf(needle, cursor);
    if (idx < 0) continue;
    const contiguous = WHITESPACE_ONLY.test(hay.slice(cursor, idx));
    if (!anchored || contiguous || needle.trim().length >= RESYNC_MIN_CHARS) {
      out[i] = { ...runs[i]!, start: idx, end: idx + needle.length };
      cursor = idx + needle.length;
      if (!anchored) firstStart = idx;
      anchored = true;
    }
  }

  // Backward pass for the short runs before the anchor: contiguous (whitespace-only gap) matches only.
  let limit = firstStart;
  for (let i = anchorIndex - 1; i >= 0 && limit > 0; i--) {
    const needle = needles[i]!;
    if (needle.trim().length === 0) continue;
    const from = limit - needle.length;
    if (from < 0) break;
    const idx = hay.lastIndexOf(needle, from);
    if (idx < 0) break;
    if (!WHITESPACE_ONLY.test(hay.slice(idx + needle.length, limit))) break;
    out[i] = { ...runs[i]!, start: idx, end: idx + needle.length };
    limit = idx;
  }

  return out.filter((r): r is MappedRun => r !== null);
}

/** Width of `text` set in `font` (unscaled CSS font shorthand); only ratios within one run are used. */
export type MeasureFn = (text: string, font: string) => number;

/** Proportional fallback: every code unit the same width. Exact for monospace runs; a fair approximation otherwise. */
export const charCountMeasure: MeasureFn = (text) => text.length;

/**
 * A `measureText`-backed measurer sharing one offscreen 2-D context, or the proportional fallback when canvas is
 * unavailable (jsdom) or the context throws.
 */
export function canvasMeasure(doc: Document): MeasureFn {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    const canvas = doc.createElement('canvas');
    ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    ctx = null;
  }
  if (!ctx) return charCountMeasure;
  const c = ctx;
  return (text, font) => {
    try {
      if (font) c.font = font;
      const w = c.measureText(text).width;
      return Number.isFinite(w) && w >= 0 ? w : text.length;
    } catch {
      return text.length;
    }
  };
}

/**
 * Viewport boxes covering normalized offsets [start, end) across the mapped runs: whole runs as they are, partial
 * runs sliced horizontally by measured text width (scale cancels in the ratio). One box per run; not merged.
 */
export function boxesForRange(runs: readonly MappedRun[], start: number, end: number, measure: MeasureFn = charCountMeasure): RunBox[] {
  const boxes: RunBox[] = [];
  if (end <= start) return boxes;
  for (const run of runs) {
    const s = Math.max(start, run.start);
    const e = Math.min(end, run.end);
    if (s >= e) continue;
    if (s === run.start && e === run.end) {
      boxes.push({ ...run.box });
      continue;
    }
    const total = measure(run.text, run.font) || run.text.length || 1;
    const prefix = measure(run.text.slice(0, s - run.start), run.font);
    const span = measure(run.text.slice(s - run.start, e - run.start), run.font);
    boxes.push({
      left: run.box.left + (run.box.width * prefix) / total,
      top: run.box.top,
      width: (run.box.width * span) / total,
      height: run.box.height,
    });
  }
  return boxes;
}

/** Plain JSON rect (structured-cloneable; what the RPC carries). */
export interface RectJson {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function toRectJson(b: RunBox): RectJson {
  return { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height, width: b.width, height: b.height };
}

/** Viewport-relative rects for [start, end), merged per line (dom-text's `mergeLineRects`). */
export function rectsForRange(runs: readonly MappedRun[], start: number, end: number, measure: MeasureFn = charCountMeasure): DOMRect[] {
  return mergeLineRects(boxesForRange(runs, start, end, measure).map(toRectJson));
}

/** `rectsForRange` as plain JSON, for the RPC. */
export function rectsJsonForRange(runs: readonly MappedRun[], start: number, end: number, measure: MeasureFn = charCountMeasure): RectJson[] {
  return rectsForRange(runs, start, end, measure).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }));
}

/** Convenience: collect, map and return the layout index for `text`. */
export function buildLayoutIndex(root: ParentNode, text: string, opts: CollectOptions = {}): MappedRun[] {
  return mapRunsToText(collectTextRuns(root, opts), text);
}
