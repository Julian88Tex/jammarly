/** Rule `repeated_word`: "the the" on one line, case-insensitive, with an exception list. */
import type { RuleContext } from './context';
import { isUpper } from './context';

const REPEAT_RE = /(?<![\p{L}\p{N}'’-])(\p{L}[\p{L}'’]*)([  ]+)\1(?![\p{L}\p{N}'’-])/giu;

/** Legitimate doubles (lower-cased). */
const SKIP = new Set([
  'very', 'no', 'bye', 'ha', 'so', 'hush', 'night', 'win', 'tut', 'tsk', 'blah', 'yeah', 'yes', 'ok', 'okay', 'go', 'boo',
  'choo', 'ding', 'dong', 'knock', 'bang', 'la', 'na', 'da', 'ja', 'aye', 'well', 'hey', 'oh', 'ah', 'uh', 'um', 'hmm',
  'mm', 'wait', 'now', 'come', 'hear', 'there', 'please', 'again', 'many', 'more', 'far', 'long', 'much', 'really',
  'bla', 'yada', 'nom', 'tick', 'tock', 'chop', 'bam', 'pom', 'tap', 'cha', 'wee', 'yum', 'mwah', 'muah', 'ta', 'dum',
]);
/** Common words: a capitalized double of one of these at a sentence start is still a typo ("The The cat"). */
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were', 'it',
  'this', 'that', 'i', 'we', 'you', 'they', 'he', 'she', 'my', 'your', 'our', 'their', 'be', 'been', 'have', 'has', 'had',
  'do', 'did', 'not', 'so', 'if', 'as', 'by', 'from', 'what', 'when', 'where', 'why', 'how', 'will', 'can', 'there',
]);
/** Grammatical doubles that are usually right: flag softly. */
const LOW_CONFIDENCE = new Set(['had', 'that', 'is', 'do', 'does', 'did', 'has', 'have', 'can', 'will', 'in', 'it', 'be', 'to']);

export function repeatedWordRule(ctx: RuleContext): void {
  const { work } = ctx;
  for (const m of work.matchAll(REPEAT_RE)) {
    const first = m[1] ?? '';
    const lower = first.toLowerCase();
    if (lower.length < 2) continue;
    if (SKIP.has(lower) || ctx.protectedTerms.has(lower)) continue;
    const start = m.index;
    const end = start + m[0].length;
    const second = work.slice(start + first.length + (m[2] ?? '').length, end);
    // Both capitalized: a name like "Bora Bora", "Duran Duran", unless it is a common word at a sentence start.
    if (isUpper(first.charAt(0)) && isUpper(second.charAt(0)) && !(FUNCTION_WORDS.has(lower) && ctx.isSentenceStart(start, true))) continue;
    const soft = LOW_CONFIDENCE.has(lower);
    ctx.emit({
      rule: 'repeated_word',
      severity: soft ? 'warning' : 'error',
      kind: 'replace',
      start,
      end,
      replacement: first,
      explanation: soft ? `"${first} ${second}" may be a repeated word; remove one if it is.` : `"${first}" is repeated.`,
      confidence: soft ? 0.6 : 0.95,
      autoApplySafe: !soft,
    });
  }
}
