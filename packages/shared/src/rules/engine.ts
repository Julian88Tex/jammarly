/**
 * The local rules engine: instant, deterministic, high-precision checks that run in the content
 * script on every input event. Zero false positives matter more than recall, so every rule carries
 * guards and an exception list (see the individual rule files).
 */
import type { Paragraph, Suggestion, SuggestionTier, TextRange } from '../types';
import { hashText, normalizeForMatch } from '../text';
import type { RuleContext } from './context';
import { createContext, finalizeHits, isWordChar } from './context';
import type { RuleHit, RuleOptions } from './types';
import { spacingRule } from './spacing';
import { repeatedWordRule } from './repeated-word';
import { capitalizationRule } from './capitalization';
import { articleRule } from './article';
import { confusableRule } from './confusable';
import { terminalPunctuationRule } from './punctuation';
import { quoteStyleRule } from './quotes';
import { dashRule } from './dashes';
import { spellingVariantRule } from './spelling-variant';
import { serialCommaRule } from './serial-comma';
import type { RuleId } from './titles';

export { RULE_IDS, RULE_TITLES } from './titles';
export type { RuleId } from './titles';

const RULES: readonly [RuleId, (ctx: RuleContext) => void][] = [
  ['spacing', spacingRule],
  ['repeated_word', repeatedWordRule],
  ['capitalization', capitalizationRule],
  ['article', articleRule],
  ['confusable_word', confusableRule],
  ['terminal_punctuation', terminalPunctuationRule],
  ['consistency_quote_style', quoteStyleRule],
  ['consistency_hyphenation', dashRule],
  ['consistency_spelling_variant', spellingVariantRule],
  ['consistency_serial_comma', serialCommaRule],
];

/**
 * Runs every (non-muted) rule over the whole text. Offsets are absolute; nothing is merged (overlap
 * resolution happens in resolveOverlaps); hits are sorted by range.start. Every hit satisfies
 * `original === text.slice(range.start, range.end)`, never touches `opts.masked` or a paragraph that
 * reads as code, and, while `opts.typing`, never touches the word in progress.
 */
export function runRules(text: string, opts: RuleOptions): RuleHit[] {
  if (text.length === 0) return [];
  const ctx = createContext(text, opts);
  const muted = new Set(opts.mutedRules);
  for (const [id, run] of RULES) {
    if (muted.has(id)) continue;
    run(ctx);
  }
  return finalizeHits(ctx);
}

function containingBlock(blocks: Paragraph[], range: TextRange): Paragraph | undefined {
  let best: Paragraph | undefined;
  for (const b of blocks) {
    if (b.start > range.start) break;
    best = b;
    if (range.start < b.start + b.text.length) return b;
  }
  return best;
}

/** Expands a range to the enclosing word boundaries so an insertion highlights its neighbours. */
function wordHighlight(text: string, range: TextRange): TextRange {
  let start = range.start;
  let end = range.end;
  while (start > 0 && isWordChar(text.charAt(start - 1))) start--;
  while (end < text.length && isWordChar(text.charAt(end))) end++;
  return { start, end };
}

/**
 * Converts rule hits into full Suggestions. `id` is stable for a given (rule, range, replacement);
 * `fingerprint` ignores position so dismissals carry across edits.
 */
export function hitsToSuggestions(hits: RuleHit[], ctx: { blocks: Paragraph[]; promptVersion: string }): Suggestion[] {
  const blocks = [...ctx.blocks].sort((a, b) => a.start - b.start);
  const fullText = blocks.length > 0 ? reconstruct(blocks) : '';
  return hits.map((h) => {
    const block = containingBlock(blocks, h.range);
    const tier: SuggestionTier = h.autoApplySafe && h.category === 'correctness' ? 'A' : 'B';
    const highlight = h.kind === 'insert' && fullText.length >= h.range.end ? wordHighlight(fullText, h.range) : { ...h.range };
    return {
      id: hashText(`${h.rule}|${h.range.start}|${h.range.end}|${h.replacement}`),
      category: h.category,
      rule: h.rule,
      severity: h.severity,
      kind: h.kind,
      source: 'rules',
      tier,
      anchor: 'exact',
      range: { ...h.range },
      highlight,
      conflictsWith: [],
      stale: false,
      original: h.original,
      replacement: h.replacement,
      alternatives: [],
      title: h.title,
      explanation: h.explanation,
      confidence: h.confidence,
      meaningPreserving: h.meaningPreserving,
      autoApplySafe: h.autoApplySafe,
      blockId: block === undefined ? '' : String(block.index),
      blockHash: block === undefined ? hashText('') : block.hash,
      promptVersion: ctx.promptVersion,
      fingerprint: hashText(`${h.rule}|${normalizeForMatch(h.original)}|${normalizeForMatch(h.replacement)}`),
      learnedState: 'active',
    };
  });
}

/** Rebuilds a text with the paragraphs at their offsets (gaps are line breaks, rendered as "\n"). */
function reconstruct(blocks: Paragraph[]): string {
  let out = '';
  for (const b of blocks) {
    if (b.start > out.length) out += '\n'.repeat(b.start - out.length);
    out += b.text;
  }
  return out;
}
