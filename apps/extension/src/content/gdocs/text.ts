/**
 * Pure text helpers for the Google Docs bridge. No DOM, no `chrome.*`, no imports: this file is bundled into the
 * MAIN-world bridge (subject to the page CSP, ARCHITECTURE §3.8), into the isolated-world adapter and runs in jsdom.
 *
 * Docs' annotated-text API (`_docs_annotate_getAnnotatedText(id).getText()`) returns the document body prefixed with
 * a U+0003 sentinel and suffixed with one "\n" (06 §1.3). Jammarly works on the normalized text (what the engine and
 * the overlay see) and translates offsets back to the raw string for `setSelection` and `applyEdit`.
 */

/** The control character Docs puts before the body text. */
export const DOCS_SENTINEL = '\u0003';
export const NBSP = ' ';

const NBSP_RE = / /g;

/** NBSP → space; lengths are preserved so offsets stay valid. */
export function normalizeNbsp(s: string): string {
  return s.replace(NBSP_RE, ' ');
}

/** Equal modulo NBSP ↔ space (Docs converts pasted NBSP to regular spaces). */
export function docsTextsEquivalent(a: string, b: string): boolean {
  return a === b || normalizeNbsp(a) === normalizeNbsp(b);
}

/** A raw Docs string together with its normalized view and the offset translation between the two. */
export interface DocsOffsetMap {
  /** The string `getText()` returned. */
  raw: string;
  /** `raw` without the leading sentinel and the trailing newline. */
  text: string;
  /** Code units stripped at the front (0 or 1). */
  leading: number;
  /** Code units stripped at the end (0 or 1). */
  trailing: number;
  /** Normalized offset → raw offset (clamped to the body range). */
  toRaw(offset: number): number;
  /** Raw offset → normalized offset (clamped to [0, text.length]). */
  fromRaw(rawOffset: number): number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Strip the leading U+0003 sentinel and the trailing "\n" (each at most once, each only when present) and return
 * the two offset maps. `normalizeDocsText(raw).toRaw(fromRaw(r))` round-trips every raw offset inside the body.
 */
export function normalizeDocsText(raw: string): DocsOffsetMap {
  const leading = raw.startsWith(DOCS_SENTINEL) ? 1 : 0;
  let end = raw.length;
  let trailing = 0;
  if (end > leading && raw.endsWith('\n')) {
    trailing = 1;
    end -= 1;
  }
  const text = raw.slice(leading, end);
  const len = text.length;
  return {
    raw,
    text,
    leading,
    trailing,
    toRaw: (offset: number) => clamp(Math.trunc(offset), 0, len) + leading,
    fromRaw: (rawOffset: number) => clamp(Math.trunc(rawOffset) - leading, 0, len),
  };
}

/**
 * Docs strips leading and trailing ASCII spaces from a text/plain paste but converts NBSP to a regular space
 * (FluentTyper, verified live; 06 §1.4). Edge spaces are therefore sent as NBSP.
 */
export function toPastePayload(text: string): string {
  return text.replace(/^ +/, (m) => NBSP.repeat(m.length)).replace(/ +$/, (m) => NBSP.repeat(m.length));
}

export type DocsEditStrategy = 'replace' | 'delete-right' | 'delete-left';

/** How to perform one edit on the raw Docs text with `setSelection` + one synthetic paste. */
export interface DocsEditPlan {
  /** Raw selection to set before the paste (half-open). */
  selStart: number;
  selEnd: number;
  /** text/plain payload for the paste (edge spaces as NBSP). */
  payload: string;
  /** The raw text Docs should report afterwards (compare NBSP-normalized). */
  expected: string;
  strategy: DocsEditStrategy;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A character that can be re-pasted to carry a deletion: not a paragraph break and not the sentinel. */
function isCarrierChar(ch: string): boolean {
  return ch !== '\n' && ch !== '\r' && ch !== DOCS_SENTINEL && ch !== ' ' && ch !== ' ';
}

/**
 * Plan `raw.slice(start, end)` → `replacement` as a selection plus a single paste.
 *
 * Replacements paste the text directly. Deletions cannot (Docs ignores an empty paste, 06 §1.4), so the selection is
 * widened by one neighbouring character inside the same paragraph (the one after the range, else the one before,
 * whole surrogate pairs) and that character is pasted back. Returns null for out-of-range offsets and for a deletion
 * with no usable neighbour (e.g. an entire paragraph between two breaks).
 */
export function planDocsEdit(raw: string, start: number, end: number, replacement: string): DocsEditPlan | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > raw.length) return null;
  const expected = raw.slice(0, start) + replacement + raw.slice(end);
  if (replacement.length > 0) {
    return { selStart: start, selEnd: end, payload: toPastePayload(replacement), expected, strategy: 'replace' };
  }
  // Deletion: borrow the character after the range …
  if (end < raw.length) {
    let take = 1;
    const code = raw.charCodeAt(end);
    if (isHighSurrogate(code) && end + 1 < raw.length && isLowSurrogate(raw.charCodeAt(end + 1))) take = 2;
    const right = raw.slice(end, end + take);
    if (isCarrierChar(right)) {
      return { selStart: start, selEnd: end + take, payload: toPastePayload(right), expected, strategy: 'delete-right' };
    }
  }
  // … else the one before it.
  if (start > 0) {
    let take = 1;
    const code = raw.charCodeAt(start - 1);
    if (isLowSurrogate(code) && start - 2 >= 0 && isHighSurrogate(raw.charCodeAt(start - 2))) take = 2;
    const left = raw.slice(start - take, start);
    if (isCarrierChar(left)) {
      return { selStart: start - take, selEnd: end, payload: toPastePayload(left), expected, strategy: 'delete-left' };
    }
  }
  return null;
}

/** The Docs document id from a `/document/d/<id>/…` (optionally `/document/u/<n>/d/<id>`) pathname, else "". */
export function gdocsDocumentId(pathname: string): string {
  const m = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(pathname);
  return m?.[1] ?? '';
}
