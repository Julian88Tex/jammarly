/** Rule `consistency_serial_comma`: "A, B, and C" vs "A, B and C" across the document (conservative). */
import type { RuleContext } from './context';
import { CLOSERS, isWordChar, isWs } from './context';

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
const NUMERIC_RE = /^\p{N}+$/u;
const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty',
  'forty', 'fifty', 'hundred', 'thousand', 'million', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  'eighth', 'ninth', 'tenth', 'last',
]);
function isNumberLike(word: string): boolean {
  return NUMERIC_RE.test(word) || NUMBER_WORDS.has(word.toLowerCase());
}
/**
 * Words that open an introductory phrase: "After dinner, John and Mary left", "Last week, Bob and Sue met",
 * "Yes, Bob and Sue came". Prepositions, subordinators, time and sequence words, sentence adverbs, interjections
 * and greetings. Pronouns and verbs are deliberately absent ("I like apples, oranges and pears" is a list).
 */
const INTRO_WORDS = new Set([
  'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without', 'after', 'before', 'during', 'since', 'until', 'till',
  'over', 'under', 'through', 'throughout', 'despite', 'like', 'unlike', 'per', 'of', 'as', 'to', 'into', 'via',
  'across', 'around', 'between', 'within', 'among', 'against', 'about', 'upon', 'toward', 'towards', 'inside',
  'outside', 'beyond', 'behind', 'below', 'above', 'near', 'past', 'off', 'out', 'up', 'down', 'along', 'beside',
  'besides', 'except', 'regarding', 'concerning', 'following', 'given', 'including', 'excluding', 'pending',
  'considering', 'notwithstanding', 'according', 'due', 'thanks', 'owing', 'prior', 'subsequent', 'contrary',
  'if', 'when', 'whenever', 'while', 'whilst', 'because', 'although', 'though', 'once', 'unless', 'whereas',
  'wherever', 'provided', 'providing', 'assuming', 'supposing', 'whether', 'so', 'then', 'thus', 'hence', 'now',
  'that', 'this', 'these', 'those', 'last', 'next', 'every', 'each', 'some', 'many', 'most', 'all', 'both', 'either',
  'neither', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'several', 'few',
  'tomorrow', 'yesterday', 'today', 'tonight', 'earlier', 'later', 'first', 'second', 'third', 'finally', 'lastly',
  'meanwhile', 'afterwards', 'afterward', 'soon', 'recently', 'currently', 'previously', 'originally', 'eventually',
  'initially', 'normally', 'usually', 'often', 'sometimes', 'again', 'still', 'already', 'also', 'otherwise',
  'instead', 'moreover', 'furthermore', 'however', 'therefore', 'nonetheless', 'nevertheless', 'regardless',
  'overall', 'generally', 'typically', 'ideally', 'hopefully', 'unfortunately', 'fortunately', 'luckily', 'sadly',
  'interestingly', 'importantly', 'honestly', 'frankly', 'basically', 'clearly', 'obviously', 'apparently',
  'actually', 'personally', 'specifically', 'notably', 'similarly', 'likewise', 'alternatively', 'additionally',
  'consequently', 'accordingly', 'ultimately', 'essentially', 'admittedly', 'incidentally', 'anyway', 'anyhow',
  'well', 'yes', 'no', 'sure', 'okay', 'ok', 'oh', 'ah', 'right', 'indeed', 'alright', 'absolutely', 'fine', 'great',
  'cool', 'nice', 'hi', 'hello', 'hey', 'dear', 'thank', 'cheers', 'sorry', 'fyi', 'ps', 'btw', 'look', 'see', 'note',
  'remember', 'going', 'moving', 'looking', 'speaking', 'having', 'being', 'starting', 'beginning', 'ending',
  'historically', 'traditionally', 'technically', 'theoretically', 'practically', 'realistically', 'ideally',
]);

/**
 * True when the comma at `commaIdx` is the first comma of its sentence and the words before it form a short
 * introductory phrase ("After dinner,", "In the morning,", "Yes,"): what follows is then a pair, not a list.
 * Three numbers or number words ("In 2019, 2020 and 2021", "one, two or three") are still a list.
 */
function isIntroductoryPhrase(work: string, commaIdx: number, firstItem: string, item: string, finalWord: string): boolean {
  if (isNumberLike(firstItem) && isNumberLike(item) && isNumberLike(finalWord)) return false;
  let k = commaIdx;
  while (k > 0) {
    const ch = work.charAt(k - 1);
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === ':') break;
    if (ch === ',') return false; // an earlier comma: a longer list or a clause, not an opener
    if ((ch === '.' || ch === '!' || ch === '?') && (isWs(work.charAt(k)) || CLOSERS.has(work.charAt(k)))) break;
    k--;
  }
  // Drop a closing quote or bracket left over from the previous sentence ('He said "hi." After dinner, …').
  const words = work.slice(k, commaIdx).replace(/^[^\p{L}\p{N}]+/u, '').trim().split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 4) return false;
  const first = (words[0] ?? '').replace(/[^\p{L}\p{N}'\u2019-]+$/gu, '').toLowerCase();
  return INTRO_WORDS.has(first);
}

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
    if (isIntroductoryPhrase(work, start, firstItem, item, finalWord)) continue;
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
