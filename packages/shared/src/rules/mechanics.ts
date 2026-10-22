/**
 * Small mechanical checks:
 *
 *  - `capitalization`: days, months, holidays, languages and nationalities written in lowercase ("on monday" ->
 *    "Monday"; "may", "march" and "august" are left alone), and a capitalized second word in a sign-off line
 *    ("Best Regards," -> "Best regards,").
 *  - `terminal_punctuation`: a yes/no question or request that ends with a period ("Could you send it." -> "?"), and
 *    a comma or semicolon glued to an end mark (",." -> ".").
 *  - `spacing`: a space between a number and "%" ("5 %" -> "5%") or after a currency sign ("$ 5"), and a missing
 *    space between a number and a unit of measure ("5kg" -> "5 kg").
 */
import type { RuleContext } from './context';
import { isAbbreviationBefore } from './context';
import { lookaheadUnfinished, looksLikeCode, tokensOf } from './tokens';

const PROPER = new Map<string, string>();
for (const w of `Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February April June July September October
  November December Christmas Thanksgiving Easter Halloween Hanukkah Ramadan Diwali English Spanish French German Italian
  Chinese Japanese Korean Russian Portuguese Dutch Swedish Norwegian Finnish Arabic Hindi Hebrew American British
  Canadian Australian European African Asian Mexican Brazilian Indian Irish Scottish Greek Turkish Vietnamese Thai Swiss
  America Canada England France Germany Italy Spain Mexico Europe Asia Africa Australia London Paris Tokyo Christian
  Muslim Jewish Buddhist Hindu Protestant Islam Christianity Judaism Buddhism Hinduism`.split(/\s+/)) {
  if (w.length > 0) PROPER.set(w.toLowerCase(), w);
}

const SIGN_OFF_RE = /^[ \t]*(Best|Kind|Warm|Warmest|Many|With|Yours|Sincerely|All|Thank|Best)( (?:Regards|Wishes|Thanks|Truly|Sincerely|Yours|The Best|You|Love)),?[ \t]*$/gm;
/** Words that open a yes/no question or a request; the next word must be a pronoun-like subject. */
const QUESTION_OPENERS = new Set(['can', 'could', 'would', 'will', 'do', 'does', 'did', 'are', 'is', 'have', 'has', 'should', 'shall', 'may']);
const QUESTION_SUBJECT_RE = /[ \u00a0]+(?:you|we|I|they|he|she|it|there|anyone|someone|everyone|anybody|somebody)\b[^.!?\n]{0,200}?\.(?=["'”’)]*(?:\s|$))/y;
const SENTENCE_HINT_RE = /\b(?:I|I'm|I've|I'll|I'd|we|we're|we'll|you|you're|they|they're|he|she|it|it's|there's|let me|please|will|would|can|could|should)\b/i;
const LIST_MARKER_RE = /^(?:[-*•>#]|\d+[.)]|[a-z][.)] )/;
const GREETING_RE = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|thanks|thank you|best|regards|kind regards|cheers|sincerely)\b/i;
/** ",." glued together; the character before the comma is checked in code (no leading lookbehind). */
const GLUED_MARK_RE = /([,;])([.!?])(?![.!?])/g;
const GLUED_BEFORE_RE = /[\p{L}\p{N})"'”’]/u;
const PERCENT_RE = /(?<=\d)([  ]+)%/g;
const CURRENCY_RE = /([$€£¥])[  ]+(?=\d)/g;
/** Number glued to a unit; the character before the number is checked in code (a leading lookbehind runs at every offset). */
const UNIT_RE = /(\d+(?:[.,]\d+)?)(kg|km|cm|mm|ml|mg|lbs|lb|oz|mph|kph|kmh|GB|MB|TB|KB|Gb|Mb|GHz|MHz|kHz|Hz|kW|kWh|mAh)(?![\p{L}\p{N}_\-/@]|\.[\p{L}\p{N}])/gu;
const UNIT_BEFORE_RE = /[\p{L}\p{N}._\-/#@$]/u;

export function mechanicsRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const ts = tokensOf(ctx);

  // Proper nouns in lowercase. Chat written entirely in lowercase is a style, not a slip (see capitalization.ts).
  if (!(opts.context === 'chat' && !/\p{Lu}/u.test(work))) {
    const severity = opts.formality === 'informal' || opts.context === 'chat' ? 'warning' : 'error';
    for (const t of ts.list) {
      const proper = PROPER.get(t.norm);
      if (proper === undefined || t.text !== t.norm || ctx.protectedTerms.has(t.norm) || looksLikeCode(ctx, t)) continue;
      ctx.emit({
        rule: 'capitalization',
        key: 'capitalization.proper_noun',
        severity,
        kind: 'replace',
        start: t.start,
        end: t.end,
        replacement: proper,
        explanation: `"${proper}" is a proper noun, so it starts with a capital letter.`,
        confidence: 0.9,
        autoApplySafe: true,
      });
    }
  }

  // "Best Regards," -> "Best regards,"
  for (const m of work.matchAll(SIGN_OFF_RE)) {
    const second = m[2] ?? '';
    const lead = m[1] ?? '';
    const start = m.index + m[0].indexOf(lead) + lead.length + 1;
    const word = second.slice(1);
    const lowered = word.toLowerCase();
    if (word === lowered || (lead === 'Thank' && word !== 'You') || (lead !== 'Thank' && word === 'You')) continue;
    ctx.emit({
      rule: 'capitalization',
      key: 'capitalization.sign_off',
      severity: 'warning',
      kind: 'replace',
      start,
      end: start + word.length,
      replacement: lowered,
      explanation: 'Only the first word of a sign-off is capitalized.',
      confidence: 0.85,
      autoApplySafe: true,
    });
  }

  // A direct question or request that ends with a period.
  for (const t of ts.list) {
    if (!QUESTION_OPENERS.has(t.norm) || (t.norm === 'may' && t.text !== 'May') || !ctx.isSentenceStart(t.start, true)) continue;
    QUESTION_SUBJECT_RE.lastIndex = t.end;
    const m = QUESTION_SUBJECT_RE.exec(work);
    if (m === null) continue;
    const dot = t.end + m[0].length - 1;
    const sentence = work.slice(t.start, dot);
    if (/[:;"“”]/.test(sentence)) continue; // quoted speech or a list follows
    if (isAbbreviationBefore(work, dot, work.charAt(dot + 2))) continue; // "Dr." or "a.m." is not the sentence end
    if (ctx.isBlocked(t.start, dot + 1)) continue;
    ctx.emit({
      rule: 'terminal_punctuation',
      key: 'terminal_punctuation.question_mark',
      severity: 'warning',
      kind: 'replace',
      start: dot,
      end: dot + 1,
      replacement: '?',
      explanation: 'This sentence is a question, so it ends with a question mark.',
      confidence: 0.85,
      autoApplySafe: false,
    });
  }

  // A paragraph of plain email prose that ends without punctuation: "Let me know what you think" + blank line.
  if (opts.context === 'email' || opts.context === 'other') {
    let lineStart = 0;
    while (lineStart <= work.length) {
      let lineEnd = work.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = work.length;
      const nextStart = lineEnd + 1;
      let nextEnd = nextStart <= work.length ? work.indexOf('\n', nextStart) : -1;
      if (nextEnd < 0) nextEnd = work.length;
      const paragraphEnd = lineEnd >= work.length || work.slice(nextStart, nextEnd).trim().length === 0;
      if (paragraphEnd) missingPeriod(ctx, lineStart, lineEnd);
      if (lineEnd >= work.length) break;
      lineStart = nextStart;
    }
  }

  // ",." / ";!" glued together: keep the end mark.
  for (const m of work.matchAll(GLUED_MARK_RE)) {
    const start = m.index;
    if (start === 0 || !GLUED_BEFORE_RE.test(work.charAt(start - 1))) continue;
    ctx.emit({
      rule: 'terminal_punctuation',
      severity: 'warning',
      kind: 'replace',
      start,
      end: start + 2,
      replacement: m[2] ?? '.',
      explanation: `Keep only the "${m[2] ?? '.'}" here.`,
      confidence: 0.9,
      autoApplySafe: true,
    });
  }

  // "5 %" -> "5%", "$ 5" -> "$5"
  for (const m of work.includes('%') ? work.matchAll(PERCENT_RE) : []) {
    const start = m.index - 1;
    ctx.emit({ rule: 'spacing', key: 'spacing.symbol', severity: 'warning', kind: 'replace', start, end: m.index + m[0].length, replacement: `${work.charAt(start)}%`, explanation: 'No space goes between a number and "%".', confidence: 0.9, autoApplySafe: true });
  }
  for (const m of work.matchAll(CURRENCY_RE)) {
    const sym = m[1] ?? '$';
    ctx.emit({ rule: 'spacing', key: 'spacing.symbol', severity: 'warning', kind: 'replace', start: m.index, end: m.index + m[0].length + 1, replacement: `${sym}${work.charAt(m.index + m[0].length)}`, explanation: `No space goes between "${sym}" and the amount.`, confidence: 0.9, autoApplySafe: true });
  }
  // "5kg" -> "5 kg"
  if (opts.context !== 'code') {
    for (const m of work.matchAll(UNIT_RE)) {
      const num = m[1] ?? '';
      const unit = m[2] ?? '';
      const start = m.index;
      if (start > 0 && UNIT_BEFORE_RE.test(work.charAt(start - 1))) continue;
      if (lookaheadUnfinished(ctx, start + m[0].length)) continue;
      ctx.emit({
        rule: 'spacing',
        key: 'spacing.number_unit',
        severity: 'suggestion',
        kind: 'insert',
        start,
        end: start + m[0].length,
        replacement: `${num} ${unit}`,
        explanation: `Put a space between the number and the unit "${unit}".`,
        confidence: 0.8,
        autoApplySafe: false,
      });
    }
  }
}

/** The last line of a paragraph: a sentence that ends in a letter or digit gets a period. */
function missingPeriod(ctx: RuleContext, from: number, to: number): void {
  const raw = ctx.work.slice(from, to);
  const line = raw.trim();
  if (line.length < 20 || !/^\p{Lu}/u.test(line) || !/[\p{L}\p{N}]$/u.test(line)) return;
  const words = line.split(/\s+/);
  if (words.length < 7 || !SENTENCE_HINT_RE.test(line) || LIST_MARKER_RE.test(line) || GREETING_RE.test(line)) return;
  let capitalized = 0;
  for (const word of words) if (/^\p{Lu}/u.test(word)) capitalized++;
  if (capitalized * 2 > words.length) return; // a title or a heading
  const last = /[\p{L}\p{N}]+$/u.exec(line)?.[0] ?? '';
  const end = from + raw.indexOf(line) + line.length;
  const start = end - last.length;
  if (last.length === 0 || ctx.isBlocked(start, end)) return;
  ctx.emit({
    rule: 'terminal_punctuation',
    key: 'terminal_punctuation.missing_period',
    severity: 'warning',
    kind: 'insert',
    start,
    end,
    replacement: `${last}.`,
    explanation: 'End the sentence with a period.',
    confidence: 0.85,
    autoApplySafe: true,
  });
}
