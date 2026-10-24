/**
 * Pure text utilities shared by every Jammarly surface (service worker, content script, side
 * panel, options). No DOM, no `chrome.*`, no runtime dependencies: this file must run unchanged in
 * an MV3 service worker and under jsdom.
 *
 * Every offset in this module is a UTF-16 code-unit offset into the plain text, matching
 * `TextRange` in ./types. Emoji and other astral characters therefore occupy two offsets.
 */

import type { Edit, Paragraph, Suggestion, SuggestionCategory, TextRange, WritingScore } from './types';

// ---------------------------------------------------------------------------
// Added types (local to this module; ./types is left untouched)
// ---------------------------------------------------------------------------

/** Disambiguation hints for {@link locateSpan}. */
export interface LocateHint {
  /** Only consider matches starting at or after this offset (default 0). */
  searchFrom?: number;
  /** Only consider matches ending at or before this offset (default text.length). */
  searchTo?: number;
  /** Text expected immediately before the match (compared trimmed + normalized). */
  prefix?: string;
  /** Text expected immediately after the match (compared trimmed + normalized). */
  suffix?: string;
  /** 0-based index among all candidates in the search window, used when prefix/suffix do not settle it. */
  occurrence?: number;
}

/** The single changed region between two versions of a text, see {@link diffShift}. */
export interface DiffRegion {
  /** Offset where old and new text first differ (length of the common prefix). */
  start: number;
  /** End (exclusive) of the changed region in the old text. */
  oldEnd: number;
  /** End (exclusive) of the changed region in the new text. */
  newEnd: number;
}

export interface ApplyEditsResult {
  text: string;
  /** Edits that were applied, in ascending start order. */
  applied: Edit[];
  /** Edits that were skipped (overlap, mismatch, or out of range), in ascending start order. */
  skipped: Edit[];
  /** Maps an offset in the old text to the corresponding offset in the new text. */
  mapOffset: (oldOffset: number) => number;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const FNV_PRIME = 0x01000193;
/** Standard 32-bit FNV offset basis. */
const FNV_BASIS_A = 0x811c9dc5;
/** Upper 32 bits of the 64-bit FNV offset basis, used as an independent seed for the second lane. */
const FNV_BASIS_B = 0xcbf29ce4;

function hex8(x: number): string {
  return (x >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fast, deterministic, non-cryptographic hash of a string.
 *
 * Algorithm: FNV-1a over the UTF-16 code units, run in two independent 32-bit lanes. Lane A
 * starts from the standard basis and consumes each code unit low byte first; lane B starts from a
 * different basis and consumes high byte first. The result is the two lanes concatenated as 16
 * lowercase hex characters (fixed width). Two lanes with different seeds and byte order make an
 * accidental collision in one lane very unlikely to repeat in the other, which is plenty for
 * cache and dedupe keys. Never use this for anything security-related.
 */
export function hashText(s: string): string {
  let a = FNV_BASIS_A;
  let b = FNV_BASIS_B;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const lo = c & 0xff;
    const hi = c >>> 8;
    a = Math.imul(a ^ lo, FNV_PRIME);
    a = Math.imul(a ^ hi, FNV_PRIME);
    b = Math.imul(b ^ hi, FNV_PRIME);
    b = Math.imul(b ^ lo, FNV_PRIME);
  }
  return hex8(a) + hex8(b);
}

/**
 * Cache key for a checked paragraph: `<hashText(paragraphText)>:<hashText(goalsKey)>`.
 *
 * The two halves are kept separate (rather than hashing the concatenation) so a cache can be
 * scanned by paragraph hash alone, e.g. to invalidate every goals variant of one paragraph.
 * `goalsKey` is whatever stable serialization of WritingGoals (plus model id, prompt version, ...)
 * the engine chooses; it only has to be deterministic.
 */
export function paragraphCacheKey(paragraphText: string, goalsKey: string): string {
  return `${hashText(paragraphText)}:${hashText(goalsKey)}`;
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

function isLineBreakCode(code: number): boolean {
  return code === 10 /* \n */ || code === 13 /* \r */;
}

/**
 * Splits text into paragraphs.
 *
 * A paragraph is a maximal run of characters that are not line breaks; a paragraph boundary is
 * one or more line breaks (`\n`, `\r\n`, or a lone `\r`). In web text fields Enter produces a new
 * block, so every line is treated as its own paragraph; blank lines simply widen the boundary.
 * Whitespace-only lines are kept as paragraphs (they are not "newline-only"); engines are expected
 * to skip paragraphs whose text trims to empty. Unicode line/paragraph separators (U+2028/U+2029)
 * are not treated as boundaries because field adapters serialize blocks with `\n`.
 *
 * `start` is the offset of the paragraph's first character in `text` and `text` excludes the
 * trailing line break, so `text.slice(p.start, p.start + p.text.length) === p.text` always holds.
 * `hash` is `hashText(p.text)`; combine it with a goals key via {@link paragraphCacheKey}.
 * Empty input returns `[]`.
 */
export function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (isLineBreakCode(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !isLineBreakCode(text.charCodeAt(j))) j++;
    const slice = text.slice(i, j);
    out.push({ index: out.length, start: i, text: slice, hash: hashText(slice) });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '\u2026' /* … */, '\u3002' /* 。 */, '\uff01' /* ！ */, '\uff1f' /* ？ */]);
/** Closing quotes/brackets that belong to the sentence they follow. */
const SENTENCE_CLOSERS = new Set(['"', "'", '\u201d', '\u2019', ')', ']', '}', '\u00bb']);
/** Opening quotes/brackets that signal a new sentence after a terminator. */
const SENTENCE_OPENERS = new Set(['"', "'", '\u201c', '\u2018', '(', '[', '\u00ab']);

/** Abbreviations that never end a sentence when followed by a period (lower-cased, without the period). */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
  'approx', 'dept', 'est', 'gen', 'gov', 'sen', 'rep', 'col', 'capt', 'lt', 'sgt', 'ave', 'blvd', 'rd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'al', 'cf', 'ca', 'misc', 'resp', 'tel', 'ext',
]);
/** Abbreviations that only count when the next token is a number ("No. 5", "Fig. 2", "p. 12"). */
const NUMERIC_ABBREVIATIONS = new Set(['no', 'nos', 'vol', 'vols', 'pp', 'p', 'ch', 'fig', 'figs', 'sec', 'art', 'para', 'ver', 'ed']);

const WHITESPACE_RE = /\s/;
const UPPER_RE = /\p{Lu}/u;
const DIGIT_RE = /\p{Nd}/u;
const LETTER_RE = /\p{L}/u;
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

function isWs(ch: string): boolean {
  return WHITESPACE_RE.test(ch);
}

/**
 * True when the text that ends at `periodIdx` (exclusive) is an abbreviation, so the period at
 * `periodIdx` does not end a sentence. `nextCh` is the first non-whitespace character after the
 * terminator run (or '' at end of text).
 */
function isAbbreviationBefore(text: string, periodIdx: number, nextCh: string): boolean {
  let k = periodIdx;
  while (k > 0) {
    const ch = text.charAt(k - 1);
    if (ch === '.' || LETTER_RE.test(ch)) k--;
    else break;
  }
  const word = text.slice(k, periodIdx);
  if (word.length === 0) return false;
  // A single capital letter is an initial: "J. K. Rowling", "John F. Kennedy".
  if (word.length === 1 && UPPER_RE.test(word)) return true;
  // Dotted abbreviations where every segment is one or two letters: e.g, i.e, U.S, a.m, Ph.D.
  if (word.includes('.')) {
    const segments = word.split('.');
    if (segments.every((seg) => seg.length >= 1 && seg.length <= 2)) return true;
  }
  const lower = word.toLowerCase();
  if (ABBREVIATIONS.has(lower)) return true;
  if (NUMERIC_ABBREVIATIONS.has(lower) && nextCh !== '' && DIGIT_RE.test(nextCh)) return true;
  return false;
}

/**
 * Decides whether the terminator run starting at `termIdx` (terminators end at `termEnd`, closers
 * end at `closeEnd`) ends a sentence.
 */
function isSentenceBoundary(text: string, termIdx: number, termEnd: number, closeEnd: number): boolean {
  const n = text.length;
  if (closeEnd >= n) return true;
  // The terminator must be followed by whitespace: "3.14", "e.g.,", "U.S.A", "example.com" never split.
  if (!isWs(text.charAt(closeEnd))) return false;
  let k = closeEnd;
  while (k < n && isWs(text.charAt(k))) k++;
  // Take the whole code point so an emoji (surrogate pair) can be recognised as a sentence opener.
  const next = k < n ? String.fromCodePoint(text.codePointAt(k) ?? 0) : '';
  // Abbreviation guard, only for a lone period (not "..." or "?!").
  if (termEnd - termIdx === 1 && text.charAt(termIdx) === '.' && isAbbreviationBefore(text, termIdx, next)) {
    return false;
  }
  if (next === '') return true;
  return UPPER_RE.test(next) || DIGIT_RE.test(next) || SENTENCE_OPENERS.has(next) || PICTOGRAPHIC_RE.test(next);
}

/**
 * Splits English text into sentence ranges (trimmed of surrounding whitespace, in order,
 * non-overlapping). Good enough for readability stats and for scoping suggestions; not a parser.
 *
 * Rules:
 * - A run of terminators (`.` `!` `?` `…` and their full-width forms) ends a sentence when it is
 *   followed by whitespace and then a capital letter, a digit, an opening quote/bracket, an emoji,
 *   or the end of the text. Closing quotes/brackets right after the terminator stay in the sentence.
 * - A line break always ends a sentence, with or without punctuation.
 * - A lone period does not split after common abbreviations (Mr., Mrs., Dr., etc., vs., Inc., month
 *   names, ...), after single-letter initials (J. K. Rowling), after dotted abbreviations whose
 *   segments are 1–2 letters (e.g., i.e., U.S., a.m., Ph.D.), or after "No."/"Fig."/"p."/... when a
 *   number follows.
 * - A period glued to the next character never splits, which covers decimals (3.14), version
 *   numbers, domains and "e.g.,".
 * - An ellipsis followed by a lowercase word ("I was... thinking") does not split.
 *
 * Known limitations: a sentence that starts with a lowercase word after `.`/`!`/`?` is merged into
 * the previous one ("Really? yes."); an ellipsis followed by a capital splits; abbreviations at a
 * true sentence end ("...at 5 p.m. Then we left.") do not split; sentence-initial single capital
 * letters after a period ("Plan A. Then") are read as initials. Non-English punctuation
 * conventions (e.g. Spanish ¿¡) are not handled specially.
 */
export function splitSentences(text: string): TextRange[] {
  const out: TextRange[] = [];
  const n = text.length;
  const push = (start: number, end: number): void => {
    while (end > start && isWs(text.charAt(end - 1))) end--;
    if (end > start) out.push({ start, end });
  };
  let i = 0;
  let start = -1;
  while (i < n) {
    const ch = text.charAt(i);
    if (start === -1) {
      if (isWs(ch)) {
        i++;
        continue;
      }
      start = i;
    }
    if (ch === '\n' || ch === '\r') {
      push(start, i);
      start = -1;
      i++;
      continue;
    }
    if (SENTENCE_TERMINATORS.has(ch)) {
      let termEnd = i + 1;
      while (termEnd < n && SENTENCE_TERMINATORS.has(text.charAt(termEnd))) termEnd++;
      let closeEnd = termEnd;
      while (closeEnd < n && SENTENCE_CLOSERS.has(text.charAt(closeEnd))) closeEnd++;
      if (isSentenceBoundary(text, i, termEnd, closeEnd)) {
        push(start, closeEnd);
        start = -1;
      }
      i = closeEnd;
      continue;
    }
    i++;
  }
  if (start !== -1) push(start, n);
  return out;
}

// ---------------------------------------------------------------------------
// Locating model output in the real text
// ---------------------------------------------------------------------------

/**
 * Length-preserving normalization used for fuzzy matching. Every code unit maps to exactly one
 * code unit, so an offset found in the normalized string is valid in the original string:
 *
 * - curly/typographic single quotes and primes (‘ ’ ‚ ‛ ′ ʼ) -> `'`
 * - curly/typographic double quotes (“ ” „ ‟ ″) -> `"`
 * - non-breaking and other Unicode spaces (U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) and tab -> ` `
 * - hyphen/dash variants (U+2010–U+2015, U+2212 minus) -> `-`
 *
 * Deliberately NOT normalized (would change the length): `…` vs `...`, ligatures, composed vs
 * decomposed accents, zero-width characters.
 */
export function normalizeForMatch(s: string): string {
  return s.replace(NORMALIZE_RE, (m) => NORMALIZE_MAP.get(m) ?? m);
}

const NORMALIZE_MAP: Map<string, string> = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201a', "'"], ['\u201b', "'"], ['\u2032', "'"], ['\u02bc', "'"],
  ['\u201c', '"'], ['\u201d', '"'], ['\u201e', '"'], ['\u201f', '"'], ['\u2033', '"'],
  ['\u00a0', ' '], ['\u1680', ' '], ['\u2000', ' '], ['\u2001', ' '], ['\u2002', ' '], ['\u2003', ' '],
  ['\u2004', ' '], ['\u2005', ' '], ['\u2006', ' '], ['\u2007', ' '], ['\u2008', ' '], ['\u2009', ' '],
  ['\u200a', ' '], ['\u202f', ' '], ['\u205f', ' '], ['\u3000', ' '], ['\t', ' '],
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'], ['\u2015', '-'], ['\u2212', '-'],
]);
const NORMALIZE_RE = /[\u2018\u2019\u201a\u201b\u2032\u02bc\u201c\u201d\u201e\u201f\u2033\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\t\u2010-\u2015\u2212]/g;

function findAllOccurrences(haystack: string, needle: string, from: number, to: number): number[] {
  const out: number[] = [];
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1 && idx + needle.length <= to) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n++;
  return n;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Floors a hint offset, falling back to `fallback` when it is missing or NaN (±Infinity clamps later). */
function hintOffset(value: number | undefined, fallback: number): number {
  return value === undefined || Number.isNaN(value) ? fallback : Math.floor(value);
}

/**
 * Finds the offset of `original` in `text`, or -1.
 *
 * 1. Candidates are every exact occurrence of `original` fully inside `[searchFrom, searchTo)`.
 * 2. If there is none, a second pass searches `normalizeForMatch(text)` for
 *    `normalizeForMatch(original)`. The normalization is length-preserving (see that function), so
 *    the offsets it yields are valid in the real text. This tolerates the model echoing curly
 *    quotes as straight ones, NBSP as space, en dashes as hyphens, and vice versa.
 * 3. A single candidate is returned as is.
 * 4. With several candidates and a `prefix`/`suffix` hint, each candidate is scored by how many
 *    characters of the trimmed, normalized hint match the (normalized, whitespace-skipped) text
 *    right before/after it; the unique best-scoring candidate wins. Ties or zero scores fall through.
 * 5. Otherwise `occurrence` (0-based, among all candidates in the window) picks one.
 * 6. Otherwise the match is ambiguous and -1 is returned. An empty `original` is never located.
 *
 * `searchFrom`/`searchTo` are floored and clamped to `[0, text.length]`; a NaN hint is treated as
 * absent (the default), never as an empty window.
 */
export function locateSpan(text: string, original: string, hint: LocateHint = {}): number {
  if (original.length === 0) return -1;
  const from = clamp(hintOffset(hint.searchFrom, 0), 0, text.length);
  const to = clamp(hintOffset(hint.searchTo, text.length), from, text.length);

  let candidates = findAllOccurrences(text, original, from, to);
  let haystack = text;
  if (candidates.length === 0) {
    const normalizedText = normalizeForMatch(text);
    const normalizedOriginal = normalizeForMatch(original);
    if (normalizedText !== text || normalizedOriginal !== original) {
      candidates = findAllOccurrences(normalizedText, normalizedOriginal, from, to);
      haystack = normalizedText;
    }
  }
  if (candidates.length === 0) return -1;
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;

  const prefix = hint.prefix !== undefined ? normalizeForMatch(hint.prefix).trim() : '';
  const suffix = hint.suffix !== undefined ? normalizeForMatch(hint.suffix).trim() : '';
  if (prefix.length > 0 || suffix.length > 0) {
    const normalizedText = haystack === text ? normalizeForMatch(text) : haystack;
    let best = -1;
    let bestScore = 0;
    let tie = false;
    for (const c of candidates) {
      let score = 0;
      if (prefix.length > 0) score += commonSuffixLength(normalizedText.slice(0, c).trimEnd(), prefix);
      if (suffix.length > 0) score += commonPrefixLength(normalizedText.slice(c + original.length).trimStart(), suffix);
      if (score > bestScore) {
        best = c;
        bestScore = score;
        tie = false;
      } else if (score === bestScore && score > 0) {
        tie = true;
      }
    }
    if (bestScore > 0 && !tie) return best;
  }

  if (hint.occurrence !== undefined && Number.isInteger(hint.occurrence) && hint.occurrence >= 0) {
    const picked = candidates[hint.occurrence];
    return picked ?? -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Diffing and rebasing
// ---------------------------------------------------------------------------

/**
 * Computes the single changed region between two texts using the longest common prefix and the
 * longest common suffix of the remainder. Returns null when the texts are identical.
 *
 * The suffix scan is bounded by `min(oldLen, newLen) - prefixLen`, so prefix and suffix never
 * overlap: inserting "a" into "aa" yields `{ start: 2, oldEnd: 2, newEnd: 3 }` rather than a
 * negative-length region. The region may split a surrogate pair when two emoji share a high
 * surrogate; that is harmless for offset arithmetic.
 */
export function diffShift(oldText: string, newText: string): DiffRegion | null {
  if (oldText === newText) return null;
  const oldLen = oldText.length;
  const newLen = newText.length;
  const minLen = Math.min(oldLen, newLen);
  let prefix = 0;
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (suffix < maxSuffix && oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)) suffix++;
  return { start: prefix, oldEnd: oldLen - suffix, newEnd: newLen - suffix };
}

/**
 * Moves suggestions computed against `oldText` onto `newText` after a single edit (one
 * {@link diffShift} region, i.e. one keystroke, paste or accepted suggestion).
 *
 * - Suggestions entirely before the changed region keep their range.
 * - Suggestions entirely after it shift by the length delta.
 * - Suggestions overlapping the changed region are dropped (their text changed under them).
 * - Every survivor is re-verified: the range must be an integer range inside `newText`
 *   (`0 <= start <= end <= newText.length`) and `newText.slice(start, end) === original`, else it
 *   is dropped. The bounds check matters for zero-width suggestions, whose empty `original` would
 *   otherwise "match" at any offset, including offsets past the end of the text.
 *
 * A suggestion touching the region boundary ("teh" + typing "x" right after it) survives as long
 * as its original text is unchanged; the next check refreshes it. Pure: returns new objects and
 * never mutates its input. Nothing but `range` is updated.
 */
/** True when `[start, end)` is a well-formed integer range inside a text of length `length`. */
function isValidRange(start: number, end: number, length: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}

export function rebaseSuggestions(suggestions: Suggestion[], oldText: string, newText: string): Suggestion[] {
  const region = diffShift(oldText, newText);
  const out: Suggestion[] = [];
  for (const s of suggestions) {
    const range = shiftRange(s.range, region);
    if (range === null) continue;
    // The hover target (highlight) must move with the edit too; if the user typed inside it, the target is stale.
    const highlight = shiftRange(s.highlight ?? s.range, region);
    if (highlight === null) continue;
    if (!isValidRange(range.start, range.end, newText.length) || newText.slice(range.start, range.end) !== s.original) continue;
    if (!isValidRange(highlight.start, highlight.end, newText.length)) continue;
    out.push({ ...s, range, highlight });
  }
  return out;
}

/** Shifts a range across a single changed region; null when the range overlaps the region. */
function shiftRange(r: TextRange, region: DiffRegion | null): TextRange | null {
  if (region === null) return { start: r.start, end: r.end };
  if (r.end <= region.start) return { start: r.start, end: r.end };
  if (r.start >= region.oldEnd) {
    const delta = region.newEnd - region.oldEnd;
    return { start: r.start + delta, end: r.end + delta };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overlap resolution
// ---------------------------------------------------------------------------

const CATEGORY_RANK: Record<SuggestionCategory, number> = { correctness: 0, clarity: 1, engagement: 2, delivery: 3 };

/**
 * Priority order for competing suggestions (negative = `a` first):
 * 1. category: correctness > clarity > engagement > delivery;
 * 2. higher confidence;
 * 3. source: within correctness the deterministic `rules` engine beats `llm`; in every other
 *    category `llm` beats `rules`;
 * 4. longer range (covers more of the problem);
 * 5. earlier start;
 * 6. equal (callers add input order as the final tiebreak for determinism).
 */
export function compareSuggestionPriority(a: Suggestion, b: Suggestion): number {
  const categoryDelta = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
  if (categoryDelta !== 0) return categoryDelta;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.source !== b.source) {
    const preferRules = a.category === 'correctness';
    const aIsRules = a.source === 'rules';
    return aIsRules === preferRules ? -1 : 1;
  }
  const lengthDelta = (b.range.end - b.range.start) - (a.range.end - a.range.start);
  if (lengthDelta !== 0) return lengthDelta;
  return a.range.start - b.range.start;
}

/** Total order on offsets that stays consistent for NaN (sorted last) and ±Infinity, unlike `a - b`. */
function compareOffsets(a: number, b: number): number {
  const x = Number.isNaN(a) ? Infinity : a;
  const y = Number.isNaN(b) ? Infinity : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Half-open overlap; identical zero-width ranges also conflict (they compete for one insertion point). */
function rangesConflict(a: TextRange, b: TextRange): boolean {
  if (a.start < b.end && b.start < a.end) return true;
  return a.start === b.start && a.end === b.end;
}

/** Marks that must never appear twice in a row where two pieces of text meet. */
const SEAM_MARKS = ',.;:';

/** True when `left`'s last character and `right`'s first are the same seam mark, or both spaces. */
export function doubledAtSeam(left: string, right: string): boolean {
  const a = left.slice(-1);
  return a !== '' && a === right.slice(0, 1) && (a === ' ' || SEAM_MARKS.includes(a));
}

/**
 * Trims an edit's replacement so it does not double a mark or space that already sits beside it in `text`: "Firstly"
 * -> "First," right before an existing comma becomes "First". The edit's own original is left alone where it already
 * doubled (an ellipsis, say). May return a no-op edit (replacement === original); callers drop those.
 */
export function tidyEdit(text: string, edit: Edit): Edit {
  const { start, end } = edit.range;
  let r = edit.replacement;
  const after = text.slice(end, end + 1);
  const before = text.slice(Math.max(0, start - 1), start);
  if (doubledAtSeam(r, after) && !doubledAtSeam(edit.original, after)) r = r.slice(0, -1);
  if (doubledAtSeam(before, r) && !doubledAtSeam(before, edit.original)) r = r.slice(1);
  return r === edit.replacement ? edit : { ...edit, range: { start, end }, replacement: r };
}

/** `a` ends exactly where `b` starts and together they would put the same mark twice ("First," then ","). */
function touchDoubled(a: Suggestion, b: Suggestion): boolean {
  return a.range.end === b.range.start && doubledAtSeam(a.replacement, b.replacement);
}

function dedupeStrings(values: string[], exclude: string): string[] {
  const seen = new Set<string>([exclude]);
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Returns a non-overlapping subset of `suggestions`, so every kept suggestion can be applied
 * independently or all at once ("Accept all").
 *
 * Steps:
 * 1. Sort by {@link compareSuggestionPriority}, then by input order.
 * 2. Collapse identical duplicates (same range AND same replacement) into the highest-priority
 *    one, merging the others' `alternatives` into it (deduplicated, never containing the
 *    replacement itself).
 * 3. Greedily keep each candidate that does not overlap an already-kept one. Two ranges overlap
 *    when `a.start < b.end && b.start < a.end`; identical zero-width ranges also count as
 *    overlapping. Touching ranges (`[0,3)` and `[3,6)`) do not overlap.
 *
 * The result is returned in reading order (by start, then end). Pure: input objects are copied.
 */
export function resolveOverlaps(suggestions: Suggestion[]): Suggestion[] {
  const indexed = suggestions.map((s, i) => ({ s, i }));
  indexed.sort((x, y) => compareSuggestionPriority(x.s, y.s) || x.i - y.i);

  const byKey = new Map<string, Suggestion>();
  const ordered: Suggestion[] = [];
  for (const { s } of indexed) {
    const key = `${s.range.start}:${s.range.end}:${s.replacement}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      const merged = dedupeStrings([...(existing.alternatives ?? []), ...(s.alternatives ?? [])], existing.replacement);
      if (merged.length > 0) existing.alternatives = merged;
      continue;
    }
    const copy: Suggestion = { ...s, range: { start: s.range.start, end: s.range.end } };
    if (s.alternatives !== undefined) copy.alternatives = dedupeStrings(s.alternatives, s.replacement);
    byKey.set(key, copy);
    ordered.push(copy);
  }

  // `kept` is maintained sorted by (start, end). Because kept ranges never conflict with each
  // other, a candidate can only conflict with its two sorted neighbours (the last kept range that
  // sorts before it and the first that sorts at or after it), so each insertion is a binary search
  // plus a splice instead of a scan over everything kept so far.
  const kept: Suggestion[] = [];
  for (const s of ordered) {
    const { start, end } = s.range;
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const k = kept[mid];
      if (k !== undefined && (k.range.start < start || (k.range.start === start && k.range.end < end))) lo = mid + 1;
      else hi = mid;
    }
    const prev = kept[lo - 1];
    const next = kept[lo];
    if (prev !== undefined && (rangesConflict(prev.range, s.range) || touchDoubled(prev, s))) continue;
    if (next !== undefined && (rangesConflict(next.range, s.range) || touchDoubled(s, next))) continue;
    kept.splice(lo, 0, s);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Applying edits
// ---------------------------------------------------------------------------

/**
 * Applies a set of edits to `text`.
 *
 * Edits are sorted by start (then end, then input order; a NaN offset sorts last so one garbage
 * edit cannot disturb the order of the others). An edit is skipped when its range is out of
 * bounds, inverted or not integral, when `text.slice(start, end) !== original`, or when it
 * overlaps an edit already accepted (so among overlapping edits the first by start wins; an edit
 * that only overlaps a *skipped* edit is still applied). Touching edits (`[0,3)` + `[3,6)`),
 * insertions at 0 and at `text.length`, and zero-width insertions next to replacements are all
 * fine. The result is rebuilt left-to-right in a single pass (equivalent to applying the accepted
 * edits right-to-left), so the cost is linear in `text.length + edits.length`.
 *
 * `mapOffset(o)` translates an offset in the old text to the new text: offsets before an edit are
 * unchanged, offsets after it shift by the edit's length delta, and offsets strictly inside a
 * replaced span (or exactly at its end) map to the end of the replacement. An offset exactly at
 * the start of an edit maps to the start of its replacement, so a caret sitting before an
 * insertion stays before the inserted text. Out-of-range inputs are clamped.
 */
export function applyEdits(text: string, edits: Edit[]): ApplyEditsResult {
  const indexed = edits.map((e, i) => ({ e, i }));
  indexed.sort((x, y) => compareOffsets(x.e.range.start, y.e.range.start) || compareOffsets(x.e.range.end, y.e.range.end) || x.i - y.i);

  const applied: Edit[] = [];
  const skipped: Edit[] = [];
  let lastEnd = 0;
  for (const { e } of indexed) {
    const { start, end } = e.range;
    if (!isValidRange(start, end, text.length) || text.slice(start, end) !== e.original || start < lastEnd) {
      skipped.push(e);
      continue;
    }
    applied.push(e);
    lastEnd = end;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const e of applied) {
    parts.push(text.slice(cursor, e.range.start), e.replacement);
    cursor = e.range.end;
  }
  parts.push(text.slice(cursor));
  const out = parts.join('');

  const mapOffset = (oldOffset: number): number => {
    const o = clamp(oldOffset, 0, text.length);
    let delta = 0;
    for (const e of applied) {
      const { start, end } = e.range;
      if (o <= start) break;
      if (o <= end) return start + delta + e.replacement.length;
      delta += e.replacement.length - (end - start);
    }
    return o + delta;
  };

  return { text: out, applied, skipped, mapOffset };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

/** Whitespace-separated tokens that contain at least one letter or digit. */
function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (token.length > 0 && HAS_WORD_CHAR_RE.test(token)) out.push(token);
  }
  return out;
}

/**
 * Counts words the way a writing assistant does: whitespace-separated tokens (any Unicode
 * whitespace, including NBSP) that contain at least one letter or digit. Hyphenated words and
 * contractions count once; URLs count as one word; bare punctuation, dashes and emoji count as
 * zero. Scripts written without spaces (CJK) are undercounted.
 */
export function countWords(text: string): number {
  return wordTokens(text).length;
}

/** Reading time in whole seconds at `wpm` words per minute (default 238, the adult silent-reading average); rounded up, 0 for no words or a non-positive/NaN `wpm`. */
export function readingTimeSeconds(text: string, wpm = 238): number {
  const words = countWords(text);
  if (words === 0 || !(wpm > 0)) return 0;
  return Math.ceil((words / wpm) * 60);
}

/**
 * Approximate syllable count for one English word using the common vowel-group heuristic:
 * strip non-letters; words of up to three letters count 1; drop a trailing silent `-e`, `-es`
 * or `-ed` (but keep `-le` as in "table"); drop a leading `y`; count runs of 1–2 vowels
 * (`aeiouy`). Minimum 1. Numbers and symbols count as one syllable. Off by one on roughly a
 * tenth of words ("beautiful" → 4), which is fine for a readability estimate.
 */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 1;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups === null ? 0 : groups.length);
}

/**
 * Flesch–Kincaid grade level: `0.39 * words/sentences + 11.8 * syllables/words - 15.59`, using
 * {@link countWords}, {@link splitSentences} (minimum one sentence) and {@link countSyllables}.
 * Clamped at 0 and rounded to one decimal; 0 for text without words. Roughly: 6 ≈ sixth grade,
 * 12 ≈ high-school senior, 16+ ≈ academic prose.
 */
export function fleschKincaidGrade(text: string): number {
  const words = wordTokens(text);
  if (words.length === 0) return 0;
  const sentences = Math.max(1, splitSentences(text).length);
  let syllables = 0;
  for (const w of words) syllables += countSyllables(w);
  const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

/** Penalty weight per suggestion, by category. */
export const SCORE_WEIGHTS: Record<SuggestionCategory, number> = { correctness: 4, clarity: 2, engagement: 1, delivery: 1 };
/** Texts shorter than this are scored as if they had this many words, so one typo in a 3-word text does not read as 0. */
export const SCORE_DENSITY_FLOOR_WORDS = 20;

/**
 * Grammarly-style 0..100 writing score.
 *
 * - Empty text (no words): `{ overall: 0, wordCount: 0, readingTimeSeconds: 0 }`.
 * - Words and no suggestions: 100.
 * - Otherwise start at 100 and subtract the summed category weights ({@link SCORE_WEIGHTS}:
 *   correctness 4, clarity 2, engagement 1, delivery 1) scaled to a 100-word window, i.e.
 *   `penalty = sum(weights) * 100 / max(wordCount, 20)`. 100 words with one typo → 96; 20 words
 *   with one typo → 80; 100 words with five typos and five clarity issues → 50. The result is
 *   rounded, floored at 0, and capped at 99 whenever at least one suggestion exists, so 100 means
 *   "clean".
 * - `readability` is {@link fleschKincaidGrade}; `readingTimeSeconds` uses the default 238 wpm.
 */
export function computeScore(text: string, suggestions: Suggestion[]): WritingScore {
  const wordCount = countWords(text);
  if (wordCount === 0) return { overall: 0, wordCount: 0, readingTimeSeconds: 0 };
  const reading = readingTimeSeconds(text);
  const readability = fleschKincaidGrade(text);
  if (suggestions.length === 0) return { overall: 100, wordCount, readingTimeSeconds: reading, readability };
  let weight = 0;
  for (const s of suggestions) weight += SCORE_WEIGHTS[s.category];
  const penalty = (weight * 100) / Math.max(wordCount, SCORE_DENSITY_FLOOR_WORDS);
  const overall = clamp(Math.round(100 - penalty), 0, 99);
  return { overall, wordCount, readingTimeSeconds: reading, readability };
}

// ---------------------------------------------------------------------------
// Code detection and masking
// ---------------------------------------------------------------------------

/** Patterns that essentially only occur in source code; each match adds to the code score. */
const CODE_KEYWORD_RES: RegExp[] = [
  /\b(?:function|const|var|let)\s+[A-Za-z_$][\w$]*/g,
  /\breturn\s*(?:;|[\w$.()[\]'"]+\s*;)/g,
  /\bdef\s+\w+\s*\(/g,
  /\bfrom\s+[\w.]+\s+import\b|\bimport\s+(?:\{[^}]*\}|[\w*]+)\s+from\s+['"]|\bimport\s+[\w.]+;|\brequire\(['"]/g,
  /\bexport\s+(?:default|const|function|class|interface|type|async)\b/g,
  /\b(?:public|private|protected|static)\s+(?:static\s+|final\s+|async\s+)*(?:void|int|string|String|bool|boolean|double|float|class|function|readonly|\w+\s*\(|\w+\s+\w+\s*[(;=])/g,
  /\bclass\s+\w+\s*(?:\{|extends|implements|:|\()/g,
  /\b(?:null|undefined|true|false|None|nil)\s*[;,)}\]]/g,
  /console\.(?:log|error|warn)\(|printf\(|println!?\(|System\.out|#include\s*[<"]|#define\s+\w|std::|print\(/g,
  /\b(?:if|for|while|switch|catch|elif)\s*\(/g,
  /\bfn\s+\w+\s*\(|\blet\s+mut\b|\bfunc\s+\w+\s*\(|\bpackage\s+\w+;?|\busing\s+namespace\b|\bnamespace\s+\w+/g,
  /<\/?[a-zA-Z][\w-]*(?:\s+[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g,
];
/** Patterns that are unambiguous code on their own (whole statements); each match counts double. */
const STRONG_CODE_RES: RegExp[] = [
  /\bSELECT\b[\s\S]{0,200}?\bFROM\b|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bWHERE\s+\w+\s*(?:=|<|>|LIKE|IN)\b/g,
];
/** Multi-character operators that rarely appear in prose. */
const CODE_OPERATOR_RE = /=>|->|::|===|!==|==|!=|&&|\|\||\w\+\+|\+=|-=|\*=|\/=|<=|>=|\/\/|\/\*|\*\/|\$\{/g;
const CODE_SYMBOL_RE = /[{}[\]();<>=|&`]/g;
const CAMEL_CASE_RE = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;
const SNAKE_CASE_RE = /^[a-z]+(?:_[a-z0-9]+)+$/;
// Anchored with a lookbehind at the start of an identifier run rather than `\b`, so a long dotted
// run ("a.a.a.a...") is scanned once instead of once per label (which was quadratic).
const ASSIGNMENT_RE = /(?<![\w$.])[A-Za-z_$][\w$.]*\s*=\s*[^=\s]/g;
const CODE_LINE_END_RE = /[;{}:)\]]\s*$/;
const CODE_LINE_START_RE = /^\s*(?:\/\/|\/\*|\*\/|\*\s|#include|#!|[}\])])/;
const INDENTED_LINE_RE = /^(?:\t| {2,})\S/;
const SENTENCE_LINE_END_RE = /[.!?]["'\u201d\u2019)]*\s*$/;
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'be', 'been',
  'it', 'that', 'this', 'for', 'with', 'as', 'by', 'from', 'we', 'you', 'i', 'he', 'she', 'they', 'my', 'your',
  'our', 'not', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'so', 'if', 'then', 'than',
  'about', 'just', 'very', 'please', 'thanks', 'hi', 'hello',
]);

function countMatches(s: string, re: RegExp): number {
  const m = s.match(re);
  return m === null ? 0 : m.length;
}

/**
 * Heuristic: does this field hold source code (or data) rather than prose? Used to skip fields
 * such as code editors, JSON inputs and terminal-like textareas.
 *
 * URLs, emails, @handles and backtick code spans are masked first (see
 * {@link stripUrlsAndCode}), so prose that merely contains links or inline code is not code.
 * Valid JSON objects/arrays are code. Otherwise a score is built from: lines ending in `; { } :
 * ) ]` or starting like comments/closers, indentation, code-only keywords (`const x`, `def f(`,
 * `#include`, HTML tags, ...; whole SQL statements count double), multi-character operators (`=>`, `===`, `&&`, ...), density
 * of `{}[]();<>=|&` among non-space characters, camelCase and snake_case identifiers, and
 * repeated assignments. English function words ("the", "and", "is", ...) and sentence-final
 * punctuation pull the score down. Code is declared at a score of 3 or more.
 *
 * Tuned for: prose, prose with links, markdown with inline code, email signatures, chat → false;
 * JSON, JS/TS, Python, CSS, HTML, SQL, one-line statements → true. Single short expressions
 * without keywords ("a = b") stay prose.
 */
export function isLikelyCode(text: string): boolean {
  const masked = stripUrlsAndCode(text).text;
  const trimmed = masked.trim();
  if (trimmed.length === 0) return false;

  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const size = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
        if (size > 0) return true;
      }
    } catch {
      // not JSON; fall through to scoring
    }
  }

  const lines = masked.split(/\r?\n|\r/).filter((l) => l.trim().length > 0);
  const lineCount = lines.length;
  let codeLines = 0;
  let indentedLines = 0;
  let sentenceLines = 0;
  for (const line of lines) {
    if (CODE_LINE_END_RE.test(line) || CODE_LINE_START_RE.test(line)) codeLines++;
    if (INDENTED_LINE_RE.test(line)) indentedLines++;
    if (SENTENCE_LINE_END_RE.test(line)) sentenceLines++;
  }

  const tokens = wordTokens(masked);
  const bareWords = tokens.map((t) => t.replace(/^[^\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+$/gu, ''));
  let camel = 0;
  let snake = 0;
  let functionWords = 0;
  for (const w of bareWords) {
    if (CAMEL_CASE_RE.test(w)) camel++;
    if (SNAKE_CASE_RE.test(w)) snake++;
    if (FUNCTION_WORDS.has(w.toLowerCase())) functionWords++;
  }

  let keywordHits = 0;
  for (const re of CODE_KEYWORD_RES) keywordHits += countMatches(masked, re);
  for (const re of STRONG_CODE_RES) keywordHits += 2 * countMatches(masked, re);
  const operators = countMatches(masked, CODE_OPERATOR_RE);
  const nonSpace = masked.replace(/\s+/g, '').length;
  const symbolDensity = nonSpace === 0 ? 0 : countMatches(masked, CODE_SYMBOL_RE) / nonSpace;
  const assignments = countMatches(masked, ASSIGNMENT_RE);

  let score = 0;
  if (lineCount >= 2 && codeLines / lineCount >= 0.5) score += 2;
  if (lineCount >= 2 && indentedLines / lineCount >= 0.3) score += 1;
  score += Math.min(4, keywordHits);
  if (operators >= 1) score += 1;
  if (operators >= 3) score += 1;
  if (symbolDensity > 0.05) score += 1;
  if (symbolDensity > 0.1) score += 1;
  if (camel >= 2 && camel / Math.max(1, bareWords.length) >= 0.15) score += 1;
  if (camel / Math.max(1, bareWords.length) >= 0.4 && camel >= 2) score += 1;
  if (snake >= 2) score += 1;
  if (assignments >= 2) score += 1;
  if (bareWords.length > 0 && functionWords / bareWords.length > 0.15) score -= 2;
  if (lineCount > 0 && sentenceLines / lineCount >= 0.5) score -= 1;
  return score >= 3;
}

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
// The lookbehinds on EMAIL_RE and BARE_DOMAIN_RE anchor each attempt at the start of a run of
// candidate characters. Without them the engine retried at every position (every letter, or every
// label after a `.`/`-`), and each retry re-scanned the rest of the run: a pasted 20KB hex blob or
// a long dotted token cost over half a second. A match starting inside a run is always dominated
// by the match from the run's start (which the engine reports first), so the results are the same.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const SCHEME_URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;
const BARE_DOMAIN_RE = /(?<![\w.-])(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|co|edu|gov|ai|app|me|us|uk|ca|de|fr|info|biz|ly|tv|xyz)\b(?:\/[^\s<>"'`]*)?/gi;
const HANDLE_RE = /(?<![\p{L}\p{N}_.])@[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?/gu;
const TRAILING_PUNCT_RE = /[.,;:!?'"]+$/;

/** Trims sentence punctuation (and an unbalanced closing paren) that a URL regex swallowed. */
function trimUrlMatch(m: string): string {
  let s = m.replace(TRAILING_PUNCT_RE, '');
  while (s.endsWith(')') && countMatches(s, /\(/g) < countMatches(s, /\)/g)) {
    s = s.slice(0, -1).replace(TRAILING_PUNCT_RE, '');
  }
  return s;
}

function maskMatches(work: string, re: RegExp, ranges: TextRange[], trim?: (m: string) => string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const m of work.matchAll(re)) {
    const raw = m[0];
    const kept = trim === undefined ? raw : trim(raw);
    if (kept.length === 0) continue;
    const start = m.index ?? 0;
    const end = start + kept.length;
    ranges.push({ start, end });
    parts.push(work.slice(cursor, start), ' '.repeat(kept.length));
    cursor = end;
  }
  if (parts.length === 0) return work;
  parts.push(work.slice(cursor));
  return parts.join('');
}

/**
 * Masks the parts of a text that must never receive suggestions: fenced and inline code
 * (between backticks, including the backticks), email addresses, URLs (`http(s)://`, `ftp://`,
 * `www.`, and bare domains with a common TLD plus optional path), and `@handles`. Each masked
 * span is replaced by the same number of spaces, so the returned text has exactly the same length
 * and every offset outside the masks is unchanged. Sentence punctuation immediately after a URL
 * ("see https://x.com.") is left in place. `masked` lists the replaced ranges in ascending order.
 */
export function stripUrlsAndCode(text: string): { text: string; masked: TextRange[] } {
  const ranges: TextRange[] = [];
  let work = text;
  work = maskMatches(work, FENCED_CODE_RE, ranges);
  work = maskMatches(work, INLINE_CODE_RE, ranges);
  work = maskMatches(work, EMAIL_RE, ranges);
  work = maskMatches(work, SCHEME_URL_RE, ranges, trimUrlMatch);
  work = maskMatches(work, BARE_DOMAIN_RE, ranges, trimUrlMatch);
  work = maskMatches(work, HANDLE_RE, ranges);
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return { text: work, masked: ranges };
}
