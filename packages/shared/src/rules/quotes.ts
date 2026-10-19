/** Rule `consistency_quote_style`: straight vs curly quotes and apostrophes across the document. */
import type { RuleContext } from './context';
import { CLOSERS, PLACEHOLDER, isDigit, isLetter } from './context';

const QUOTE_RE = /["'“”‘’]/g;
const STRAIGHT = new Set(['"', "'"]);
const ELISIONS = new Set(['tis', 'twas', 'em', 'cause', 'til', 'till', 'n', 'bout', 'round', 'nuff', 'fraid']);
/** Characters after which a straight quote closes: word characters, closers and sentence punctuation. */
const CLOSING_CONTEXT = new Set([...CLOSERS, '.', ',', '!', '?', ';', '%', PLACEHOLDER]);

function toCurly(work: string, i: number): string {
  const ch = work.charAt(i);
  const prev = i > 0 ? work.charAt(i - 1) : '';
  const next = work.charAt(i + 1);
  // Anything else before the quote (whitespace, an opener, a dash, a slash, an emoji's low surrogate…) opens it.
  const opening = prev === '' || !(isLetter(prev) || isDigit(prev) || CLOSING_CONTEXT.has(prev));
  if (ch === '"') return opening ? '“' : '”';
  if (isLetter(prev) || isDigit(prev)) return '’';
  if (opening && isLetter(next)) {
    let k = i + 1;
    while (k < work.length && isLetter(work.charAt(k))) k++;
    return ELISIONS.has(work.slice(i + 1, k).toLowerCase()) ? '’' : '‘';
  }
  if (opening && isDigit(next)) return '’'; // '90s
  return '’';
}

function toStraight(ch: string): string {
  return ch === '“' || ch === '”' ? '"' : "'";
}

export function quoteStyleRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const decision = opts.styleDecisions['quotes'];
  const positions: { idx: number; straight: boolean }[] = [];
  let straightCount = 0;
  let curlyCount = 0;
  for (const m of work.matchAll(QUOTE_RE)) {
    const idx = m.index;
    const ch = m[0];
    const straight = STRAIGHT.has(ch);
    // Primes and inch/foot marks: a straight quote right after a digit (5'10", 3" screen).
    if (straight && isDigit(work.charAt(idx - 1)) && !isLetter(work.charAt(idx + 1))) continue;
    positions.push({ idx, straight });
    if (straight) straightCount++;
    else curlyCount++;
  }
  if (positions.length === 0) return;

  let flagStraight: boolean;
  let confidence: number;
  let autoApplySafe: boolean;
  if (decision === 'straight' || decision === 'curly') {
    flagStraight = decision === 'curly';
    if ((flagStraight ? straightCount : curlyCount) === 0) return;
    confidence = 0.95;
    autoApplySafe = true;
  } else {
    if (straightCount === 0 || curlyCount === 0 || straightCount === curlyCount) return;
    flagStraight = straightCount < curlyCount;
    confidence = 0.8;
    autoApplySafe = false;
  }
  const explanation = flagStraight
    ? decision === 'curly' ? 'Your style uses curly quotes.' : 'This document mostly uses curly quotes.'
    : decision === 'straight' ? 'Your style uses straight quotes.' : 'This document mostly uses straight quotes.';
  for (const p of positions) {
    if (p.straight !== flagStraight) continue;
    const ch = work.charAt(p.idx);
    ctx.emit({
      rule: 'consistency_quote_style',
      severity: 'suggestion',
      kind: 'replace',
      start: p.idx,
      end: p.idx + 1,
      replacement: flagStraight ? toCurly(work, p.idx) : toStraight(ch),
      explanation,
      confidence,
      autoApplySafe,
    });
  }
}
