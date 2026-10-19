/** Rule `consistency_serial_comma`: "A, B, and C" vs "A, B and C" across the document (conservative). */
import type { RuleContext } from './context';
import { isWordChar } from './context';

const W = "[\\p{L}\\p{N}][\\p{L}\\p{N}'\\u2019-]*";
const ITEM = `${W}(?: ${W}){0,2}`;
const LIST_RE = new RegExp(`, (${ITEM})(,?) (and|or) (${W})`, 'gu');
const CLAUSE_STARTERS = new Set([
  'i', 'he', 'she', 'we', 'they', 'it', 'you', 'then', 'but', 'so', 'which', 'that', 'who', 'and', 'or', 'if', 'when',
  'while', 'because', 'as', 'this', 'these', 'those', 'there', 'here', 'not', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'also',
  'however', 'after', 'before', 'with', 'without', 'for', 'from', 'in', 'on', 'at', 'by', 'to', 'of', 'about', 'over',
  'under', 'into', 'during', 'since', 'until', 'than', 'yet', 'nor', 'etc', 'more', 'most', 'even', 'just', 'only',
  'now', 'maybe', 'perhaps', 'please', 'thanks', 'vice',
  'yesterday', 'today', 'tomorrow', 'later', 'earlier', 'meanwhile', 'finally', 'first', 'next', 'last', 'afterwards',
  'again', 'still', 'already', 'soon', 'once', 'instead', 'otherwise', 'therefore', 'thus', 'hence', 'anyway', 'well',
  'hi', 'hello', 'hey', 'dear', 'cheers', 'regards', 'sincerely', 'course', 'example', 'instance', 'addition', 'fact',
  'short', 'general', 'particular', 'contrast', 'conclusion', 'summary', 'other', 'hand', 'way', 'result', 'end', 'all',
]);
const ADVERB_RE = /ly$/u;
const BACK_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*$/u;

/**
 * For a multi-word item before the conjunction, the item before it must also be `count` plain words
 * ("a red car, a blue bike and a green boat"), which rules out "Yesterday, John ate apples and pears".
 */
function previousItemMatches(work: string, commaIdx: number, count: number): boolean {
  let pos = commaIdx;
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      if (work.charAt(pos - 1) !== ' ') return false;
      pos--;
    }
    const m = BACK_WORD_RE.exec(work.slice(Math.max(0, pos - 40), pos));
    if (m === null) return false;
    const word = m[0];
    if (i === count - 1 && CLAUSE_STARTERS.has(word.toLowerCase())) return false;
    pos -= word.length;
  }
  return true;
}

interface ListHit {
  /** Start of the last word before the conjunction. */
  wordStart: number;
  /** End of the conjunction. */
  conjEnd: number;
  lastWord: string;
  conj: string;
  style: 'oxford' | 'none';
}

export function serialCommaRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const lists: ListHit[] = [];
  for (const m of work.matchAll(LIST_RE)) {
    const item = m[1] ?? '';
    const comma = m[2] ?? '';
    const conj = m[3] ?? '';
    const finalWord = m[4] ?? '';
    const start = m.index;
    if (start === 0 || !isWordChar(work.charAt(start - 1))) continue; // the first item must exist
    // The word before the first comma must itself read as a list item: "However, John and Mary left",
    // "Thank you, John and Jane" and "Unfortunately, Bob and Sue left" are an opener plus a pair.
    const firstItem = BACK_WORD_RE.exec(work.slice(Math.max(0, start - 40), start))?.[0] ?? '';
    const firstLower = firstItem.toLowerCase();
    if (firstItem.length === 0 || CLAUSE_STARTERS.has(firstLower)) continue;
    if (ADVERB_RE.test(firstLower) && ctx.isSentenceStart(start - firstItem.length, true)) continue;
    const itemWords = item.split(' ');
    const firstWord = (itemWords[0] ?? '').toLowerCase();
    if (CLAUSE_STARTERS.has(firstWord) || CLAUSE_STARTERS.has(finalWord.toLowerCase())) continue;
    if (itemWords.length > 1 && !previousItemMatches(work, start, itemWords.length)) continue;
    const lastWord = itemWords[itemWords.length - 1] ?? '';
    const wordStart = start + 2 + item.length - lastWord.length;
    const conjEnd = start + 2 + item.length + comma.length + 1 + conj.length;
    lists.push({ wordStart, conjEnd, lastWord, conj, style: comma === ',' ? 'oxford' : 'none' });
  }
  if (lists.length === 0) return;

  const decision = opts.styleDecisions['serial_comma'];
  let target: 'oxford' | 'none';
  let confidence: number;
  let autoApplySafe: boolean;
  if (decision === 'oxford' || decision === 'none') {
    target = decision;
    confidence = 0.9;
    autoApplySafe = true;
  } else {
    if (lists.length < 2) return;
    const oxford = lists.filter((l) => l.style === 'oxford').length;
    const none = lists.length - oxford;
    if (oxford === none) return;
    target = oxford > none ? 'oxford' : 'none';
    confidence = 0.75;
    autoApplySafe = false;
  }
  for (const l of lists) {
    if (l.style === target) continue;
    const insert = target === 'oxford';
    ctx.emit({
      rule: 'consistency_serial_comma',
      severity: 'suggestion',
      kind: insert ? 'insert' : 'replace',
      start: l.wordStart,
      end: l.conjEnd,
      replacement: insert ? `${l.lastWord}, ${l.conj}` : `${l.lastWord} ${l.conj}`,
      explanation: insert
        ? decision === 'oxford' ? 'Your style uses the serial comma.' : 'This document mostly uses a comma before the last item.'
        : decision === 'none' ? 'Your style omits the serial comma.' : 'This document mostly omits the comma before the last item.',
      confidence,
      autoApplySafe,
    });
  }
}
