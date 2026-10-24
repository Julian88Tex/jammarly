/**
 * Anchoring: turns the model's verbatim-anchored EngineSuggestions into Suggestions with absolute offsets,
 * implementing the client-side verification of 02 §4.1 (and the tiering of types.ts / 02 §3.7):
 *
 *  1. field validation (enums, confidence coerced into [0,1], confidence below 0.5 dropped as the contract says
 *     "below 0.5 do not emit", explanation clamped);
 *  2. placeholder guard: an `original` containing ⟦ or ⟧ is dropped;
 *  3. locating `original` in the REAL block text ({@link locateOriginal}): exact search first, then the
 *     length-preserving normalized pass (quotes, dashes, NBSP), then a loose pass that also collapses whitespace
 *     runs, reads "…" as "...", ignores zero-width characters and finally ignores case (all `anchor: 'normalized'`).
 *     Candidates inside masked spans (text the model never saw) are discarded first, so `occurrence` counts the
 *     way the model counted. Several candidates are resolved by the prefix/suffix context, then `occurrence`,
 *     then (for context-free fixes such as a misspelled word) the nearest candidate. A loose match only survives
 *     when the characters the model actually changed match the real text exactly (modulo quote/dash/space glyphs),
 *     so an edit is never applied to text the model misread. No match drops as `unanchored`, several unresolvable
 *     matches as `ambiguous`, matches only inside masked text as `protected`;
 *  4. no-op filter (identical, or identical after whitespace trim / quote normalization) and trimming of the
 *     word-level common suffix then prefix shared by `original` and `replacement`, so "the the" -> "the" edits
 *     only "the ";
 *  5. sentence constraint: a span edit must lie within one sentence (rewrites and the sentence-spanning rules are
 *     exempt);
 *  6. protected overlap: an `original` that lands on a masked span (text the model never saw) is dropped before
 *     trimming, and so is a trimmed edit that still intersects one;
 *  7. category filter and dismissed-fingerprint filter;
 *  8. absolute offsets from `paragraphs[].start`, highlight = adjacent word for pure insertions, tier, stable id.
 *
 * Block ids are normalized ("B1", "b01" -> "b1"). A suggestion that does not anchor in the block it was listed
 * under (or under an unknown id) is re-tried in the other blocks of the call and kept when it anchors in exactly
 * one of them with agreeing context. Rewrites and the span edits inside their range are linked through
 * `conflictsWith`; identical (block, range, replacement) duplicates are collapsed, also when the model listed the
 * same block twice.
 * Ids are block-relative hashes, so two paragraphs with identical text would hash identically; the later one
 * gets a `~n` suffix so every id in a field is unique (PanelAction and conflictsWith address suggestions by id).
 */
import type { EngineOutput, EngineSuggestion, Paragraph, Suggestion, SuggestionCategory, SuggestionKind, SuggestionSeverity, SuggestionTier, TextRange } from '../types';
import { CATEGORIES } from '../types';
import { hashText, normalizeForMatch, splitSentences, tidyEdit } from '../text';
import type { MaskedBlock } from './messages';
import { blockIdFor, parseBlockIndex } from './messages';
import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN } from './sanitize';
import { KIND_VALUES, SEVERITY_VALUES, coerceConfidence, EXPLANATION_MAX_CHARS } from './schema';
import { categoryForRule, SENTENCE_SPANNING_RULES, titleForRule } from './vocabulary';

export type AnchorDropReason =
  | 'unknown_block'
  | 'invalid'
  | 'low_confidence'
  | 'placeholder'
  | 'unanchored'
  | 'ambiguous'
  | 'noop'
  | 'crosses_sentence'
  | 'protected'
  | 'category_disabled'
  | 'text_mismatch'
  | 'dismissed'
  | 'duplicate';

export interface DroppedSuggestion {
  suggestion: EngineSuggestion;
  reason: AnchorDropReason;
  blockId: string;
  detail?: string;
}

export interface AnchorOptions {
  model: string;
  promptVersion: string;
  /** Enabled categories; suggestions in other categories are dropped. */
  categories: readonly SuggestionCategory[];
  dismissedFingerprints?: ReadonlySet<string>;
}

export interface AnchorResult {
  suggestions: Suggestion[];
  dropped: DroppedSuggestion[];
}

export const MIN_CONFIDENCE = 0.5;
const SPAN_KINDS: ReadonlySet<string> = new Set(['replace', 'delete', 'insert']);
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const WS_RE = /\s/;

function isWordChar(ch: string): boolean {
  return ch !== '' && WORD_CHAR_RE.test(ch);
}

function isWs(ch: string): boolean {
  return ch !== '' && WS_RE.test(ch);
}

/** Dismissal-memory key: rule plus the normalized edit, independent of position and context. */
export function fingerprintFor(rule: string, original: string, replacement: string): string {
  return hashText(`${rule}|${normalizeForMatch(original)}|${normalizeForMatch(replacement)}`);
}

/**
 * Tier per types.ts: A = mechanical correctness span edit (severity error, confidence >= 0.85, meaning-preserving,
 * auto-apply-safe, exact anchor); C = rewrites, flags, anything not meaning-preserving, and span edits below
 * 0.7 confidence; B = every other span edit (confidence >= 0.7, meaning-preserving).
 */
export function tierFor(s: {
  category: SuggestionCategory;
  kind: SuggestionKind;
  severity: SuggestionSeverity;
  confidence: number;
  meaningPreserving: boolean;
  autoApplySafe: boolean;
  anchor: 'exact' | 'normalized';
}): SuggestionTier {
  if (!SPAN_KINDS.has(s.kind) || !s.meaningPreserving) return 'C';
  if (
    s.category === 'correctness' &&
    s.severity === 'error' &&
    s.confidence >= 0.85 &&
    s.autoApplySafe &&
    s.anchor === 'exact'
  ) {
    return 'A';
  }
  return s.confidence >= 0.7 ? 'B' : 'C';
}

/** True when offset `i` of `s` sits on a word boundary (start, end, or between a word and a non-word character). */
function boundary(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return true;
  return !isWordChar(s.charAt(i - 1)) || !isWordChar(s.charAt(i));
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n++;
  return n;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n++;
  return n;
}

export interface TrimmedEdit {
  /** Characters trimmed from the front of `original` (the range start moves by this much). */
  offset: number;
  original: string;
  replacement: string;
}

/**
 * Removes the common suffix, then the common prefix, that `original` and `replacement` share, but only up to a
 * word boundary on both sides so a replacement never splits a word ("were" -> "was" stays whole, while
 * "the the" -> "the" shrinks to "the " -> ""). Suffix first so a repeated word is attributed to its first copy,
 * matching 02 §4.1 ("the the report" -> range covers only "the ").
 */
export function trimCommonAffixes(original: string, replacement: string): TrimmedEdit {
  let q = commonSuffixLength(original, replacement);
  while (q > 0 && !(boundary(original, original.length - q) && boundary(replacement, replacement.length - q))) q--;
  const o1 = original.slice(0, original.length - q);
  const r1 = replacement.slice(0, replacement.length - q);
  let p = commonPrefixLength(o1, r1);
  while (p > 0 && !(boundary(o1, p) && boundary(r1, p))) p--;
  return { offset: p, original: o1.slice(p), replacement: r1.slice(p) };
}

/**
 * When the anchor was repaired (the model echoed curly quotes as straight ones, NBSP as space, a dash as a hyphen),
 * the parts of the replacement the model did not change are taken from the real text, so applying the edit never
 * silently restyles the user's typography. Normalization is length-preserving, so the model's `original` and the
 * real span have the same length and offsets line up. A straight apostrophe the model inserted is curled when the
 * real span uses curly apostrophes only.
 */
export function alignReplacement(modelOriginal: string, realOriginal: string, replacement: string): string {
  if (modelOriginal.length !== realOriginal.length) return replacement;
  const p = commonPrefixLength(modelOriginal, replacement);
  let q = commonSuffixLength(modelOriginal, replacement);
  const maxQ = Math.min(modelOriginal.length, replacement.length) - p;
  if (q > maxQ) q = maxQ;
  let middle = replacement.slice(p, replacement.length - q);
  if (realOriginal.includes('’') && !realOriginal.includes("'")) middle = middle.replace(/'/g, '’');
  return realOriginal.slice(0, p) + middle + realOriginal.slice(realOriginal.length - q);
}

/** Expands from an insertion point to the neighbouring word (preferring the word before) so the UI has a hover target. */
export function adjacentWord(text: string, pos: number, lo = 0, hi = text.length): TextRange {
  const expand = (at: number): TextRange => {
    let s = at;
    let e = at;
    while (s > lo && isWordChar(text.charAt(s - 1))) s--;
    while (e < hi && isWordChar(text.charAt(e))) e++;
    return { start: s, end: e };
  };
  let r = expand(pos);
  if (r.end > r.start) return r;
  let k = pos;
  while (k > lo && isWs(text.charAt(k - 1))) k--;
  if (k > lo) {
    r = expand(k);
    if (r.end > r.start) return r;
  }
  k = pos;
  while (k < hi && isWs(text.charAt(k))) k++;
  if (k < hi) {
    r = expand(k);
    if (r.end > r.start) return r;
  }
  if (pos > lo) return { start: pos - 1, end: pos };
  return { start: pos, end: Math.min(hi, pos + 1) };
}

/** Whether the (whitespace-trimmed) range lies inside one sentence of `sentences` (ranges over the same text). */
function withinOneSentence(text: string, start: number, end: number, sentences: readonly TextRange[]): boolean {
  let ts = start;
  let te = end;
  while (ts < te && isWs(text.charAt(ts))) ts++;
  while (te > ts && isWs(text.charAt(te - 1))) te--;
  if (ts >= te) return true;
  for (const s of sentences) {
    if (s.start <= ts && ts < s.end) return te <= s.end;
  }
  return false;
}

function intersects(start: number, end: number, ranges: readonly TextRange[]): boolean {
  for (const r of ranges) {
    if (start === end) {
      if (r.start < start && start < r.end) return true;
    } else if (r.start < end && start < r.end) {
      return true;
    }
  }
  return false;
}

function hasPlaceholder(s: string): boolean {
  return s.includes(PLACEHOLDER_OPEN) || s.includes(PLACEHOLDER_CLOSE);
}

export interface Drop {
  reason: AnchorDropReason;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Locating the model's `original` in the real block text
// ---------------------------------------------------------------------------

/** Zero-width characters a model never echoes (ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen). */
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/;

/** A loose (fuzzy-matchable) view of a string: one entry per loose character with the source range it came from. */
interface LooseText {
  s: string;
  start: number[];
  end: number[];
}

/**
 * Loose view: the length-preserving {@link normalizeForMatch} glyph folding, plus whitespace runs collapsed to
 * one space, "…" read as "...", zero-width characters dropped and (with `fold`) per-character lower case.
 */
function loosen(text: string, fold: boolean): LooseText {
  const norm = normalizeForMatch(text);
  const out: LooseText = { s: '', start: [], end: [] };
  const chars: string[] = [];
  const push = (ch: string, a: number, b: number): void => {
    chars.push(ch);
    out.start.push(a);
    out.end.push(b);
  };
  let i = 0;
  while (i < norm.length) {
    const ch = norm.charAt(i);
    if (ZERO_WIDTH_RE.test(ch)) {
      i++;
      continue;
    }
    if (isWs(ch)) {
      let j = i + 1;
      while (j < norm.length && (isWs(norm.charAt(j)) || ZERO_WIDTH_RE.test(norm.charAt(j)))) j++;
      push(' ', i, j);
      i = j;
      continue;
    }
    if (ch === '\u2026') {
      for (let k = 0; k < 3; k++) push('.', i, i + 1);
      i++;
      continue;
    }
    const lower = fold ? ch.toLowerCase() : ch;
    push(lower.length === 1 ? lower : ch, i, i + 1);
    i++;
  }
  out.s = chars.join('');
  return out;
}

/** Loose index k such that loose chars [0, k) come from source [0, pos); undefined when `pos` splits a source unit. */
function looseBoundary(lt: LooseText, pos: number): number | undefined {
  let k = 0;
  while (k < lt.s.length && (lt.end[k] ?? 0) <= pos) k++;
  if (k < lt.s.length && (lt.start[k] ?? 0) < pos) return undefined;
  return k;
}

/** Source offset of loose boundary j (start side skips dropped characters forward, end side backward). */
function sourceBoundary(lt: LooseText, j: number, sourceLength: number, side: 'start' | 'end'): number | undefined {
  // A boundary between two loose characters produced by one source character ("…" -> "...") has no source offset.
  if (j > 0 && j < lt.s.length && lt.start[j] === lt.start[j - 1]) return undefined;
  if (side === 'start') return j < lt.s.length ? (lt.start[j] ?? sourceLength) : sourceLength;
  return j > 0 ? (lt.end[j - 1] ?? 0) : 0;
}

export type LocateMethod = 'exact' | 'normalized' | 'loose';

export interface Located {
  start: number;
  end: number;
  method: LocateMethod;
  /** How much of the prefix/suffix hints agreed with the real text around the span. */
  contextScore: number;
  /** For loose matches: the replacement rebuilt onto the real span (unchanged parts copied from the real text). */
  replacement?: string;
}

interface Candidate {
  start: number;
  end: number;
}

function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

/** Memo of the last loosened texts (suggestions of one block are anchored back to back). */
const looseMemo: { text: string; fold: boolean; value: LooseText }[] = [];

function loosenCached(text: string, fold: boolean): LooseText {
  for (const m of looseMemo) if (m.fold === fold && m.text === text) return m.value;
  const value = loosen(text, fold);
  looseMemo.unshift({ text, fold, value });
  if (looseMemo.length > 4) looseMemo.pop();
  return value;
}

/** First loose index whose source start is >= pos. */
function lowerBound(lt: LooseText, pos: number): number {
  let lo = 0;
  let hi = lt.s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((lt.start[mid] ?? 0) < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Context agreement of a candidate: how many characters of the (loose, case-folded, trimmed) prefix hint match
 * the text right before it, plus how many of the suffix hint match the text right after it.
 */
function contextScore(lt: LooseText, c: Candidate, prefix: string, suffix: string): number {
  let score = 0;
  if (prefix.length > 0) {
    let i = lowerBound(lt, c.start) - 1;
    while (i >= 0 && lt.s.charAt(i) === ' ') i--;
    let n = 0;
    while (n < prefix.length && i - n >= 0 && lt.s.charAt(i - n) === prefix.charAt(prefix.length - 1 - n)) n++;
    score += n;
  }
  if (suffix.length > 0) {
    let j = lowerBound(lt, c.end);
    while (j < lt.s.length && lt.s.charAt(j) === ' ') j++;
    let n = 0;
    while (n < suffix.length && j + n < lt.s.length && lt.s.charAt(j + n) === suffix.charAt(n)) n++;
    score += n;
  }
  return score;
}

/** Levenshtein distance, capped: returns cap + 1 as soon as the distance exceeds `cap`. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length] ?? cap + 1;
}

/**
 * Whether an edit is right for every copy of its span, so the nearest copy may take it when the model's count is
 * off: a repeated word, a spacing fix, or a misspelled single word whose correction is a small edit of it.
 */
function isContextFree(rule: string, original: string, replacement: string): boolean {
  if (rule === 'repeated_word' || rule === 'spacing') return true;
  if (rule !== 'spelling' || !isSingleToken(original)) return false;
  const o = original.trim().toLowerCase();
  const r = replacement.trim().toLowerCase();
  return o.length >= 3 && editDistance(o, r, Math.max(2, Math.floor(o.length / 4))) <= Math.max(2, Math.floor(o.length / 4));
}

function isSingleToken(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && !/\s/.test(t);
}

/**
 * Rebuilds a loose match's edit onto the real span: the characters the model changed must read the same in the
 * real text (only quote, dash and space glyphs may differ), and everything the model left unchanged is copied
 * from the real text. Null when the model edited text it misread (case, spacing, an ellipsis) or when an edit
 * boundary falls inside a collapsed whitespace run.
 */
function rebuildLoose(modelOriginal: string, replacement: string, text: string, match: { looseStart: number; lt: LooseText; lm: LooseText }, realSpan: Candidate): string | null {
  let p = commonPrefixLength(modelOriginal, replacement);
  let q = commonSuffixLength(modelOriginal, replacement);
  const maxQ = Math.min(modelOriginal.length, replacement.length) - p;
  if (q > maxQ) q = maxQ;
  // Never cut through a whitespace run or a surrogate pair: back off to the nearest clean boundary.
  while (p > 0 && looseBoundary(match.lm, p) === undefined) p--;
  while (q > 0 && looseBoundary(match.lm, modelOriginal.length - q) === undefined) q--;
  const kp = looseBoundary(match.lm, p);
  const kq = looseBoundary(match.lm, modelOriginal.length - q);
  if (kp === undefined || kq === undefined) return null;
  const empty = p === modelOriginal.length - q;
  const rp = sourceBoundary(match.lt, match.looseStart + kp, text.length, empty ? 'end' : 'start');
  const rq = empty ? rp : sourceBoundary(match.lt, match.looseStart + kq, text.length, 'end');
  if (rp === undefined || rq === undefined || rp < realSpan.start || rq > realSpan.end || rq < rp) return null;
  const modelCore = modelOriginal.slice(p, modelOriginal.length - q);
  const realCore = text.slice(rp, rq);
  if (normalizeForMatch(realCore) !== normalizeForMatch(modelCore)) return null;
  let core = replacement.slice(p, replacement.length - q);
  const realSpanText = text.slice(realSpan.start, realSpan.end);
  if (realSpanText.includes('\u2019') && !realSpanText.includes("'")) core = core.replace(/'/g, '\u2019');
  return text.slice(realSpan.start, rp) + core + text.slice(rq, realSpan.end);
}

/**
 * Finds the model's `original` in `text` (one block), skipping candidates inside `masked` spans. Stages: exact,
 * length-preserving normalized, loose, loose case-insensitive; the first stage with an unmasked candidate wins.
 * Several candidates: a unique best prefix/suffix context score, else the 1-based `occurrence` among unmasked
 * candidates, else for context-free fixes the nearest candidate, else `ambiguous`.
 */
export function locateOriginal(s: Pick<EngineSuggestion, 'original' | 'replacement' | 'prefix' | 'suffix' | 'occurrence' | 'kind'>, rule: string, text: string, masked: readonly TextRange[] = []): Located | Drop {
  const original = s.original;
  const prefix = typeof s.prefix === 'string' && !hasPlaceholder(s.prefix) ? loosen(s.prefix, true).s.trim() : '';
  const suffix = typeof s.suffix === 'string' && !hasPlaceholder(s.suffix) ? loosen(s.suffix, true).s.trim() : '';
  const occurrence = Number.isFinite(s.occurrence) ? Math.max(0, Math.floor(s.occurrence) - 1) : 0;
  const visible = (c: Candidate): boolean => !intersects(c.start, c.end, masked);
  const folded = loosenCached(text, true);
  let sawMasked = false;
  let sawAmbiguous = false;

  const pick = (cands: Candidate[]): { c: Candidate; score: number } | 'ambiguous' => {
    const only = cands[0];
    if (cands.length === 1 && only !== undefined) return { c: only, score: contextScore(folded, only, prefix, suffix) };
    const scores = cands.map((c) => contextScore(folded, c, prefix, suffix));
    let best = -1;
    let bestScore = 0;
    let tie = false;
    scores.forEach((sc, i) => {
      if (sc > bestScore) {
        best = i;
        bestScore = sc;
        tie = false;
      } else if (sc === bestScore && sc > 0) {
        tie = true;
      }
    });
    const winner = cands[best];
    if (bestScore > 0 && !tie && winner !== undefined) return { c: winner, score: bestScore };
    const byOccurrence = cands[occurrence];
    if (byOccurrence !== undefined) return { c: byOccurrence, score: scores[occurrence] ?? 0 };
    // The model's count is off (it may have counted across blocks) and the context does not separate the copies:
    // only a fix that is right for every copy may go to the nearest one.
    const nearest = cands[cands.length - 1];
    if (nearest !== undefined && isContextFree(rule, original, s.replacement)) return { c: nearest, score: 0 };
    return 'ambiguous';
  };

  // Exact, then length-preserving normalized (same offsets in both strings).
  const normText = normalizeForMatch(text);
  const normOriginal = normalizeForMatch(original);
  const stages: [LocateMethod, string, string][] = [['exact', text, original]];
  if (normText !== text || normOriginal !== original) stages.push(['normalized', normText, normOriginal]);
  for (const [method, haystack, needle] of stages) {
    const all = allIndexes(haystack, needle).map((i) => ({ start: i, end: i + needle.length }));
    const cands = all.filter(visible);
    if (all.length > 0 && cands.length === 0) sawMasked = true;
    if (cands.length === 0) continue;
    const chosen = pick(cands);
    if (chosen === 'ambiguous') return { reason: 'ambiguous' };
    return { start: chosen.c.start, end: chosen.c.end, method, contextScore: chosen.score };
  }

  // Loose: whitespace runs, ellipses, zero-width characters; then case-insensitive.
  for (const fold of [false, true]) {
    const lt = loosenCached(text, fold);
    const lm = loosen(original, fold);
    if (lm.s.trim().length === 0) break;
    const all = allIndexes(lt.s, lm.s).map((k) => ({ looseStart: k, c: { start: lt.start[k] ?? 0, end: lt.end[k + lm.s.length - 1] ?? 0 } }));
    const cands = all.filter((m) => visible(m.c));
    if (all.length > 0 && cands.length === 0) sawMasked = true;
    if (cands.length === 0) continue;
    const chosen = pick(cands.map((m) => m.c));
    if (chosen === 'ambiguous') {
      sawAmbiguous = true;
      continue;
    }
    const match = cands.find((m) => m.c === chosen.c);
    if (match === undefined) continue;
    const span = chosen.c;
    if (s.kind === 'flag') return { start: span.start, end: span.end, method: 'loose', contextScore: chosen.score };
    if (s.kind === 'rewrite' && !fold) return { start: span.start, end: span.end, method: 'loose', contextScore: chosen.score, replacement: s.replacement };
    const rebuilt = rebuildLoose(original, s.replacement, text, { looseStart: match.looseStart, lt, lm }, span);
    if (rebuilt === null) return { reason: 'unanchored', detail: 'misread' };
    return { start: span.start, end: span.end, method: 'loose', contextScore: chosen.score, replacement: rebuilt };
  }
  if (sawAmbiguous) return { reason: 'ambiguous' };
  return sawMasked ? { reason: 'protected' } : { reason: 'unanchored' };
}


interface BlockContext {
  block: MaskedBlock;
  paragraph: Paragraph;
  text: string;
  sentences: TextRange[];
  enabled: ReadonlySet<SuggestionCategory>;
  dismissed: ReadonlySet<string>;
  opts: AnchorOptions;
}

interface Anchored {
  suggestion: Suggestion;
  contextScore: number;
}

function anchorOne(s: EngineSuggestion, ctx: BlockContext): Anchored | Drop {
  // 1. Field validation.
  if (
    typeof s.rule !== 'string' ||
    s.rule.trim().length === 0 ||
    typeof s.original !== 'string' ||
    s.original.length === 0 ||
    typeof s.replacement !== 'string' ||
    !(CATEGORIES as readonly string[]).includes(s.category) ||
    !(SEVERITY_VALUES as readonly string[]).includes(s.severity) ||
    !(KIND_VALUES as readonly string[]).includes(s.kind) ||
    typeof s.confidence !== 'number' ||
    !Number.isFinite(s.confidence)
  ) {
    return { reason: 'invalid' };
  }
  const rule = s.rule.trim().toLowerCase();
  const confidence = coerceConfidence(s.confidence);
  if (confidence < MIN_CONFIDENCE) return { reason: 'low_confidence' };

  // 2. Placeholder guard.
  if (hasPlaceholder(s.original)) return { reason: 'placeholder' };

  // 3. Locate in the real block text.
  const blockText = ctx.block.text;
  const located = locateOriginal(s, rule, blockText, ctx.block.maskedRanges);
  if ('reason' in located) return located;
  let relStart = located.start;
  let relEnd = located.end;
  let original = blockText.slice(relStart, relEnd);
  const anchor: Suggestion['anchor'] = located.method === 'exact' ? 'exact' : 'normalized';

  // The model only ever saw placeholders where the text is masked, so an `original` that lands on a masked span is
  // a hallucination; dropping it here (before trimming) also stops "https://x.com" -> "https://x.com/" from
  // surviving as an insertion at the span's edge.
  if (intersects(relStart, relEnd, ctx.block.maskedRanges)) return { reason: 'protected' };

  // 4. No-op filter and affix trimming.
  let kind: SuggestionKind = s.kind;
  let replacement = located.replacement ?? s.replacement;
  const isRewrite = kind === 'rewrite';
  const isFlag = kind === 'flag';
  if (isFlag) {
    replacement = original;
  } else {
    if (located.method === 'normalized') replacement = alignReplacement(s.original, original, replacement);
    if (original === replacement || normalizeForMatch(original).trim() === normalizeForMatch(replacement).trim()) return { reason: 'noop' };
    if (!isRewrite) {
      const t = trimCommonAffixes(original, replacement);
      relStart += t.offset;
      relEnd = relStart + t.original.length;
      original = t.original;
      replacement = t.replacement;
      if (original.length === 0 && replacement.length === 0) return { reason: 'noop' };
      kind = original.length === 0 ? 'insert' : replacement.length === 0 ? 'delete' : 'replace';
    }
    // "Firstly" -> "First," right before the comma already there would leave "First,,".
    replacement = tidyEdit(blockText, { range: { start: relStart, end: relEnd }, original, replacement }).replacement;
    if (original === replacement) return { reason: 'noop' };
    if (!isRewrite) kind = original.length === 0 ? 'insert' : replacement.length === 0 ? 'delete' : 'replace';
  }

  // 5. Sentence constraint.
  if (!isRewrite && !SENTENCE_SPANNING_RULES.includes(rule) && !withinOneSentence(blockText, relStart, relEnd, ctx.sentences)) {
    return { reason: 'crosses_sentence' };
  }

  // 6. Protected overlap of the trimmed edit (defensive; the untrimmed original was already checked above).
  if (intersects(relStart, relEnd, ctx.block.maskedRanges)) return { reason: 'protected' };

  // 7. Category filter.
  const category = categoryForRule(rule) ?? s.category;
  if (!ctx.enabled.has(category)) return { reason: 'category_disabled' };

  // 8. Absolute offsets and the final text guard.
  const start = ctx.paragraph.start + relStart;
  const end = ctx.paragraph.start + relEnd;
  if (ctx.text.slice(start, end) !== original) return { reason: 'text_mismatch' };
  const blockLo = ctx.paragraph.start;
  const blockHi = ctx.paragraph.start + blockText.length;
  const highlight = original.length === 0 ? adjacentWord(ctx.text, start, blockLo, blockHi) : { start, end };

  const fingerprint = fingerprintFor(rule, original, replacement);
  if (ctx.dismissed.has(fingerprint)) return { reason: 'dismissed' };

  const meaningPreserving = s.meaning_preserving === true;
  const autoApplySafe = s.auto_apply_safe === true;
  const alternatives = isRewrite && Array.isArray(s.alternatives) ? s.alternatives.filter((a): a is string => typeof a === 'string' && a.length > 0 && a !== replacement).slice(0, 3) : [];
  const explanation = typeof s.explanation === 'string' ? s.explanation.slice(0, EXPLANATION_MAX_CHARS) : '';
  const tier = tierFor({ category, kind, severity: s.severity, confidence, meaningPreserving, autoApplySafe, anchor });

  const suggestion: Suggestion = {
    id: hashText(`${rule}|${ctx.paragraph.hash}|${relStart}|${relEnd}|${replacement}`),
    category,
    rule,
    severity: s.severity,
    kind,
    source: 'llm',
    tier,
    anchor,
    range: { start, end },
    highlight,
    original,
    replacement,
    alternatives,
    title: titleForRule(rule),
    explanation,
    confidence,
    meaningPreserving,
    autoApplySafe,
    blockId: ctx.block.blockId,
    blockHash: ctx.paragraph.hash,
    conflictsWith: [],
    stale: false,
    model: ctx.opts.model,
    promptVersion: ctx.opts.promptVersion,
    fingerprint,
    learnedState: 'active',
  };
  return { suggestion, contextScore: located.contextScore };
}

/** Canonical block id of a model-written id ("b1", "B1", "b01", "block b1" -> "b1"); the input when unparseable. */
export function normalizeBlockId(blockId: string): string {
  const m = /^(?:block[\s_-]*)?b?(\d{1,9})$/i.exec(blockId.trim());
  if (m === null || m[1] === undefined) return blockId.trim();
  return blockIdFor(Number(m[1]));
}

/**
 * Anchors every suggestion of an EngineOutput against the masked blocks it was produced for. `paragraphs` are the
 * blocks of the field at the request version (for `start` and `hash`), `text` the full field text. A suggestion
 * that does not anchor in its stated block (or names a block this call did not send) is re-tried in the call's
 * other blocks and kept when it anchors in exactly one with agreeing context (or is a context-free fix);
 * otherwise it drops as `unanchored` / `unknown_block`. Blocks whose text no longer matches drop as `unknown_block`.
 */
export function anchorSuggestions(output: EngineOutput, blocks: readonly MaskedBlock[], paragraphs: readonly Paragraph[], text: string, opts: AnchorOptions): AnchorResult {
  const byIndex = new Map<number, Paragraph>();
  for (const p of paragraphs) byIndex.set(p.index, p);
  const enabled = new Set<SuggestionCategory>(opts.categories);
  const dismissed = opts.dismissedFingerprints ?? new Set<string>();

  // Contexts of the blocks this call sent whose text still matches the request's paragraphs, in block order.
  const contexts = new Map<string, BlockContext>();
  const stale = new Set<string>();
  for (const block of blocks) {
    const index = parseBlockIndex(block.blockId);
    const paragraph = index === undefined ? undefined : byIndex.get(index);
    if (paragraph === undefined || paragraph.text !== block.text) {
      stale.add(block.blockId);
      continue;
    }
    contexts.set(block.blockId, { block, paragraph, text, sentences: splitSentences(block.text), enabled, dismissed, opts });
  }

  const suggestions: Suggestion[] = [];
  const dropped: DroppedSuggestion[] = [];
  const usedIds = new Set<string>();

  // A model that lists the same block twice gets its lists merged, so duplicates across the two entries collapse.
  const grouped = new Map<string, EngineSuggestion[]>();
  for (const br of output.blocks) {
    const id = normalizeBlockId(br.block_id);
    const list = grouped.get(id);
    if (list === undefined) grouped.set(id, [...br.suggestions]);
    else list.push(...br.suggestions);
  }

  const keptByBlock = new Map<string, { list: Suggestion[]; seen: Map<string, number> }>();
  const keep = (blockId: string, r: Suggestion, s: EngineSuggestion): void => {
    let entry = keptByBlock.get(blockId);
    if (entry === undefined) {
      entry = { list: [], seen: new Map() };
      keptByBlock.set(blockId, entry);
    }
    const key = `${r.range.start}|${r.range.end}|${r.replacement}`;
    const prior = entry.seen.get(key);
    if (prior !== undefined) {
      const existing = entry.list[prior];
      if (existing !== undefined && r.confidence > existing.confidence) entry.list[prior] = r;
      dropped.push({ suggestion: s, reason: 'duplicate', blockId });
      return;
    }
    entry.seen.set(key, entry.list.length);
    entry.list.push(r);
  };

  /** The suggestion anchored in exactly one other block of the call, with context agreement or a context-free fix. */
  const rescue = (s: EngineSuggestion, exclude: string): { blockId: string; suggestion: Suggestion } | undefined => {
    const rule = typeof s.rule === 'string' ? s.rule.trim().toLowerCase() : '';
    const contextFree = typeof s.replacement === 'string' && isContextFree(rule, s.original, s.replacement);
    let found: { blockId: string; suggestion: Suggestion } | undefined;
    for (const [blockId, ctx] of contexts) {
      if (blockId === exclude) continue;
      const r = anchorOne(s, ctx);
      if ('reason' in r) continue;
      if (r.contextScore === 0 && !contextFree) continue;
      if (found !== undefined) return undefined; // several blocks qualify: ambiguous
      found = { blockId, suggestion: r.suggestion };
    }
    return found;
  };

  for (const [blockId, engineSuggestions] of grouped) {
    if (stale.has(blockId)) {
      for (const s of engineSuggestions) dropped.push({ suggestion: s, reason: 'unknown_block', blockId });
      continue;
    }
    const ctx = contexts.get(blockId);
    for (const s of engineSuggestions) {
      const r: Anchored | Drop = ctx === undefined ? { reason: 'unknown_block' } : anchorOne(s, ctx);
      if (!('reason' in r)) {
        keep(blockId, r.suggestion, s);
        continue;
      }
      if (r.reason === 'unanchored' || r.reason === 'unknown_block') {
        const moved = rescue(s, blockId);
        if (moved !== undefined) {
          keep(moved.blockId, moved.suggestion, s);
          continue;
        }
      }
      dropped.push({ suggestion: s, reason: r.reason, blockId, ...(r.detail === undefined ? {} : { detail: r.detail }) });
    }
  }

  // Blocks in paragraph order, so id suffixes for identical paragraphs are deterministic.
  const order = [...keptByBlock.keys()].sort((a, b) => (parseBlockIndex(a) ?? 0) - (parseBlockIndex(b) ?? 0));
  for (const blockId of order) {
    const kept = keptByBlock.get(blockId)?.list ?? [];
    // Ids are block-relative hashes: a second paragraph with identical text would repeat them, so suffix repeats
    // (deterministic in paragraph order) before the links below are made.
    for (const r of kept) {
      if (usedIds.has(r.id)) {
        let n = 2;
        while (usedIds.has(`${r.id}~${n}`)) n++;
        r.id = `${r.id}~${n}`;
      }
      usedIds.add(r.id);
    }
    // Link rewrites with the span edits inside their range.
    for (const rewrite of kept) {
      if (rewrite.kind !== 'rewrite') continue;
      for (const span of kept) {
        if (span === rewrite || !SPAN_KINDS.has(span.kind)) continue;
        if (span.range.start >= rewrite.range.start && span.range.end <= rewrite.range.end) {
          rewrite.conflictsWith.push(span.id);
          span.conflictsWith.push(rewrite.id);
        }
      }
    }
    suggestions.push(...kept);
  }

  suggestions.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id));
  return { suggestions, dropped };
}
