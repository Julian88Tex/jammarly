/**
 * Rule `spelling`: a curated list of common misspellings of everyday words (data/misspellings.ts), each with one
 * correction. Rule `apostrophe`: contractions typed without their apostrophe ("dont", "im", "theyre"), "lets" before a
 * verb at the start of a clause, and possessive pronouns written with one ("your's", "thank's").
 *
 * Guards: protected terms, identifiers and paths (looksLikeCode), acronyms (all caps of four letters or fewer), and
 * capitalized words in mid-sentence, which are usually names ("Frome", "Colum").
 */
import type { RuleContext } from './context';
import { isUpper } from './context';
import { misspellings } from './data/misspellings';
import type { Token } from './tokens';
import { GAP_SPACE, LOWER_WORD_RE, apostropheOf, casePreserve, isAllCaps, lookaheadUnfinished, looksLikeCode, nextSpaced, tokensOf, withApostrophe } from './tokens';

/** A capitalized word in mid-sentence reads as a name; an acronym of four letters or fewer is left alone. */
function nameOrAcronym(ctx: RuleContext, t: Token): boolean {
  if (isAllCaps(t.text)) return t.text.length <= 4;
  return isUpper(t.text.charAt(0)) && !ctx.isSentenceStart(t.start, true);
}

export function spellingRule(ctx: RuleContext): void {
  const map = misspellings();
  const ts = tokensOf(ctx);
  for (const t of ts.list) {
    if (t.text.length < 3) continue;
    const fix = map.get(t.norm);
    if (fix === undefined) continue;
    if (ctx.protectedTerms.has(t.norm)) continue;
    if (nameOrAcronym(ctx, t) || looksLikeCode(ctx, t)) continue;
    const replacement = casePreserve(fix, t.text);
    ctx.emit({
      rule: 'spelling',
      severity: 'error',
      kind: 'replace',
      start: t.start,
      end: t.end,
      replacement,
      explanation: `The correct spelling is "${replacement}".`,
      confidence: 0.95,
      autoApplySafe: true,
    });
  }
}

/** [contraction, confidence, autoApplySafe]. Words that are also real words (well, were, wed, ill, its) are absent. */
const CONTRACTIONS = new Map<string, [string, number, boolean]>([
  ['dont', ["don't", 0.95, true]], ['doesnt', ["doesn't", 0.95, true]], ['didnt', ["didn't", 0.95, true]],
  ['isnt', ["isn't", 0.95, true]], ['arent', ["aren't", 0.95, true]], ['wasnt', ["wasn't", 0.95, true]],
  ['werent', ["weren't", 0.95, true]], ['havent', ["haven't", 0.95, true]], ['hasnt', ["hasn't", 0.95, true]],
  ['hadnt', ["hadn't", 0.95, true]], ['couldnt', ["couldn't", 0.95, true]], ['shouldnt', ["shouldn't", 0.95, true]],
  ['wouldnt', ["wouldn't", 0.95, true]], ['mustnt', ["mustn't", 0.95, true]], ['neednt', ["needn't", 0.95, true]],
  ['mightnt', ["mightn't", 0.95, true]], ['aint', ["ain't", 0.9, true]], ['im', ["I'm", 0.95, true]],
  ['ive', ["I've", 0.95, true]], ['youre', ["you're", 0.95, true]], ['youve', ["you've", 0.95, true]],
  ['youll', ["you'll", 0.95, true]], ['theyre', ["they're", 0.95, true]], ['theyve', ["they've", 0.95, true]],
  ['theyll', ["they'll", 0.95, true]], ['weve', ["we've", 0.95, true]], ['thats', ["that's", 0.95, true]],
  ['whats', ["what's", 0.95, true]], ['wheres', ["where's", 0.95, true]], ['whos', ["who's", 0.9, true]],
  ['heres', ["here's", 0.95, true]], ['theres', ["there's", 0.95, true]], ['hows', ["how's", 0.9, true]],
  ['shouldve', ["should've", 0.95, true]], ['couldve', ["could've", 0.95, true]], ['wouldve', ["would've", 0.95, true]],
  ['mustve', ["must've", 0.95, true]], ['mightve', ["might've", 0.95, true]], ['yall', ["y'all", 0.9, true]],
  ['hes', ["he's", 0.9, true]], ['shes', ["she's", 0.9, true]], ['itll', ["it'll", 0.9, true]],
  ['thatll', ["that'll", 0.9, true]], ['cant', ["can't", 0.85, false]], ['wont', ["won't", 0.85, false]],
]);

/** Possessive pronouns and plurals written with an apostrophe. */
const NO_APOSTROPHE = new Map<string, string>([
  ["your's", 'yours'], ["their's", 'theirs'], ["our's", 'ours'], ["thank's", 'thanks'], ["her's", 'hers'], ["yours'", 'yours'],
]);

/** "tomorrows meeting" -> "tomorrow's meeting". */
const DAY_POSSESSIVES = new Map<string, string>([['todays', "today's"], ['tomorrows', "tomorrow's"], ['yesterdays', "yesterday's"], ['tonights', "tonight's"]]);
const NOT_POSSESSED = new Set(['and', 'or', 'but', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'will', 'to', 'of', 'in', 'on', 'at', 'for', 'with']);

/** Verbs after which a clause-initial "lets" is "let's" ("Lets meet tomorrow"). */
const LETS_VERBS = new Set([
  'go', 'meet', 'talk', 'discuss', 'do', 'see', 'try', 'schedule', 'catch', 'plan', 'make', 'keep', 'start', 'have',
  'chat', 'sync', 'connect', 'move', 'take', 'find', 'review', 'circle', 'touch', 'hop', 'grab', 'set', 'get', 'focus',
  'aim', 'wait', 'hope', 'call', 'check', 'look', 'think', 'revisit', 'finalize', 'finalise', 'wrap', 'continue',
  'begin', 'put', 'work', 'figure', 'assume', 'say', 'be', 'not', 'celebrate', 'regroup', 'reconnect', 'pick', 'skip',
  'stick', 'use', 'agree', 'decide', 'jump', 'dive', 'book', 'grab', 'hear', 'hope', 'consider', 'ask', 'stay', 'get',
]);
const LETS_PRECEDERS = new Set(['so', 'and', 'then', 'ok', 'okay', 'now', 'alright', 'great', 'sure', 'but', 'maybe', 'perfect', 'cool', 'also', 'just', 'well', 'yes', 'please']);

export function apostropheRule(ctx: RuleContext): void {
  const ts = tokensOf(ctx);
  const list = ts.list;
  let apos: string | null = null;
  const aposOf = (): string => (apos ??= apostropheOf(ctx));
  for (let i = 0; i < list.length; i++) {
    const t = list[i] as Token;
    const n = t.norm;
    if (n.length < 2 || n.length > 10) continue;
    const c = CONTRACTIONS.get(n);
    const plain = NO_APOSTROPHE.get(n) ?? (n === "lot's" && nextSpaced(ts, i)?.norm === 'of' ? 'lots' : undefined);
    const isLets = n === 'lets';
    const day = DAY_POSSESSIVES.get(n);
    if (day !== undefined) {
      const next = nextSpaced(ts, i);
      if (next === undefined || !LOWER_WORD_RE.test(next.text) || NOT_POSSESSED.has(next.norm) || lookaheadUnfinished(ctx, next.end) || looksLikeCode(ctx, t)) continue;
      const replacement = withApostrophe(casePreserve(day, t.text), aposOf());
      ctx.emit({ rule: 'apostrophe', severity: 'error', kind: 'replace', start: t.start, end: t.end, replacement, explanation: `Use the possessive "${replacement}" before a noun.`, confidence: 0.9, autoApplySafe: true });
      continue;
    }
    if (c === undefined && plain === undefined && !isLets) continue;
    if (ctx.protectedTerms.has(n) || looksLikeCode(ctx, t)) continue;
    if (isAllCaps(t.text) && t.text.length <= 3) continue; // "IM", "IVE": acronyms
    if (isUpper(t.text.charAt(0)) && !isAllCaps(t.text) && !ctx.isSentenceStart(t.start, true) && n !== 'im' && n !== 'ive') continue;
    if (c !== undefined) {
      const [fix, confidence, autoApplySafe] = c;
      const raw = n === 'im' || n === 'ive' ? fix : casePreserve(fix, t.text);
      const replacement = withApostrophe(isAllCaps(t.text) ? raw.toUpperCase() : raw, aposOf());
      ctx.emit({
        rule: 'apostrophe',
        severity: 'error',
        kind: 'replace',
        start: t.start,
        end: t.end,
        replacement,
        explanation: `"${replacement}" is a contraction and needs an apostrophe.`,
        confidence,
        autoApplySafe,
      });
    } else if (plain !== undefined) {
      const replacement = casePreserve(plain, t.text);
      ctx.emit({
        rule: 'apostrophe',
        key: 'apostrophe.remove',
        severity: 'error',
        kind: 'replace',
        start: t.start,
        end: t.end,
        replacement,
        explanation: `"${replacement}" takes no apostrophe.`,
        confidence: 0.9,
        autoApplySafe: true,
      });
    } else {
      const next = nextSpaced(ts, i);
      if (next === undefined || !LETS_VERBS.has(next.norm) || lookaheadUnfinished(ctx, next.end)) continue;
      let clauseStart = ctx.isSentenceStart(t.start, true);
      if (!clauseStart && i > 0) {
        const prev = list[i - 1] as Token;
        const between = ctx.work.slice(prev.end, t.start);
        clauseStart = LETS_PRECEDERS.has(prev.norm) && (ts.gap[i] === GAP_SPACE || /^,[  ]+$/.test(between));
      }
      if (!clauseStart) continue;
      const replacement = withApostrophe(casePreserve("let's", t.text), aposOf());
      ctx.emit({
        rule: 'apostrophe',
        severity: 'error',
        kind: 'replace',
        start: t.start,
        end: t.end,
        replacement,
        explanation: `"Let's" is short for "let us".`,
        confidence: 0.9,
        autoApplySafe: true,
      });
    }
  }
}
