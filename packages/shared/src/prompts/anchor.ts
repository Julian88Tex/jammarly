/**
 * Anchoring: turns the model's verbatim-anchored EngineSuggestions into Suggestions with absolute offsets,
 * implementing the client-side verification of 02 §4.1 (and the tiering of types.ts / 02 §3.7):
 *
 *  1. field validation (enums, confidence coerced into [0,1], confidence below 0.5 dropped as the contract says
 *     "below 0.5 do not emit", explanation clamped);
 *  2. placeholder guard: an `original` containing ⟦ or ⟧ is dropped;
 *  3. `locateSpan` on the REAL block text with the prefix/suffix/occurrence hints (hints containing a placeholder
 *     are ignored); exact search first, then the length-preserving normalized repair pass (`anchor: 'normalized'`);
 *     no match drops as `unanchored`, several unresolvable matches as `ambiguous`;
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
 * Rewrites and the span edits inside their range are linked through `conflictsWith`; identical
 * (block, range, replacement) duplicates are collapsed, also when the model listed the same block twice.
 * Ids are block-relative hashes, so two paragraphs with identical text would hash identically; the later one
 * gets a `~n` suffix so every id in a field is unique (PanelAction and conflictsWith address suggestions by id).
 */
import type { EngineOutput, EngineSuggestion, Paragraph, Suggestion, SuggestionCategory, SuggestionKind, SuggestionSeverity, SuggestionTier, TextRange } from '../types';
import { CATEGORIES } from '../types';
import { hashText, locateSpan, normalizeForMatch, splitSentences } from '../text';
import type { MaskedBlock } from './messages';
import { parseBlockIndex } from './messages';
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

interface Drop {
  reason: AnchorDropReason;
  detail?: string;
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

function anchorOne(s: EngineSuggestion, ctx: BlockContext): Suggestion | Drop {
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
  const prefix = typeof s.prefix === 'string' && !hasPlaceholder(s.prefix) ? s.prefix : undefined;
  const suffix = typeof s.suffix === 'string' && !hasPlaceholder(s.suffix) ? s.suffix : undefined;
  const occurrence = Number.isFinite(s.occurrence) ? Math.max(0, Math.floor(s.occurrence) - 1) : 0;
  const pos = locateSpan(blockText, s.original, { prefix, suffix, occurrence });
  if (pos === -1) {
    const present = blockText.includes(s.original) || normalizeForMatch(blockText).includes(normalizeForMatch(s.original));
    return present ? { reason: 'ambiguous' } : { reason: 'unanchored' };
  }
  let relStart = pos;
  let relEnd = pos + s.original.length;
  let original = blockText.slice(relStart, relEnd);
  const anchor: Suggestion['anchor'] = original === s.original ? 'exact' : 'normalized';

  // The model only ever saw placeholders where the text is masked, so an `original` that lands on a masked span is
  // a hallucination; dropping it here (before trimming) also stops "https://x.com" -> "https://x.com/" from
  // surviving as an insertion at the span's edge.
  if (intersects(relStart, relEnd, ctx.block.maskedRanges)) return { reason: 'protected' };

  // 4. No-op filter and affix trimming.
  let kind: SuggestionKind = s.kind;
  let replacement = s.replacement;
  const isRewrite = kind === 'rewrite';
  const isFlag = kind === 'flag';
  if (isFlag) {
    replacement = original;
  } else {
    if (anchor === 'normalized') replacement = alignReplacement(s.original, original, replacement);
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

  return {
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
}

/**
 * Anchors every suggestion of an EngineOutput against the masked blocks it was produced for. `paragraphs` are the
 * blocks of the field at the request version (for `start` and `hash`), `text` the full field text. Suggestions
 * for unknown blocks, or for blocks whose text no longer matches, are dropped as `unknown_block`.
 */
export function anchorSuggestions(output: EngineOutput, blocks: readonly MaskedBlock[], paragraphs: readonly Paragraph[], text: string, opts: AnchorOptions): AnchorResult {
  const byId = new Map<string, MaskedBlock>();
  for (const b of blocks) byId.set(b.blockId, b);
  const byIndex = new Map<number, Paragraph>();
  for (const p of paragraphs) byIndex.set(p.index, p);
  const enabled = new Set<SuggestionCategory>(opts.categories);
  const dismissed = opts.dismissedFingerprints ?? new Set<string>();

  const suggestions: Suggestion[] = [];
  const dropped: DroppedSuggestion[] = [];
  const usedIds = new Set<string>();

  // A model that lists the same block twice gets its lists merged, so duplicates across the two entries collapse.
  const grouped = new Map<string, EngineSuggestion[]>();
  for (const br of output.blocks) {
    const list = grouped.get(br.block_id);
    if (list === undefined) grouped.set(br.block_id, [...br.suggestions]);
    else list.push(...br.suggestions);
  }

  for (const [blockId, engineSuggestions] of grouped) {
    const block = byId.get(blockId);
    const index = parseBlockIndex(blockId);
    const paragraph = index === undefined ? undefined : byIndex.get(index);
    if (block === undefined || paragraph === undefined || paragraph.text !== block.text) {
      for (const s of engineSuggestions) dropped.push({ suggestion: s, reason: 'unknown_block', blockId });
      continue;
    }
    const ctx: BlockContext = { block, paragraph, text, sentences: splitSentences(block.text), enabled, dismissed, opts };
    const kept: Suggestion[] = [];
    const seen = new Map<string, number>();
    for (const s of engineSuggestions) {
      const r = anchorOne(s, ctx);
      if ('reason' in r) {
        dropped.push({ suggestion: s, reason: r.reason, blockId, ...(r.detail === undefined ? {} : { detail: r.detail }) });
        continue;
      }
      const key = `${r.range.start}|${r.range.end}|${r.replacement}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        const existing = kept[prior];
        if (existing !== undefined && r.confidence > existing.confidence) {
          kept[prior] = r;
        }
        dropped.push({ suggestion: s, reason: 'duplicate', blockId });
        continue;
      }
      seen.set(key, kept.length);
      kept.push(r);
    }
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
