/**
 * Rule `comma`: missing commas Grammarly flags in email, each recognised from closed word lists:
 *
 *  - after a greeting and the name at the start of a line ("Hi John" -> "Hi John,"), including "Hi team", "Dear Dr. Lee";
 *  - after a sentence-initial transition word or phrase ("However the" -> "However, the", "For example we");
 *  - after a sentence-initial yes/no/ok/well/sure before a pronoun ("Yes I can" -> "Yes, I can");
 *  - before a name addressed directly at the end of a sentence ("Thanks John!" -> "Thanks, John!"); "Thanks for" stays;
 *  - after an opening email condition ("If you have any questions please let me know");
 *  - before "but"/"and" joining two complete clauses ("I called but nobody answered"), as a judgment call;
 *  - after "e.g." and "i.e." in US English.
 */
import type { RuleContext } from './context';
import { isUpper } from './context';
import type { Token, TokenStream } from './tokens';
import { GAP_HYPHEN, GAP_OTHER, GAP_SPACE, LY_RE, isAllCaps, lookaheadUnfinished, nextSpaced, tokensOf } from './tokens';

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter((w) => w.length > 0));

const GREETINGS = set('hi hello hey dear greetings morning');
const GREETING_GROUPS = set("team all everyone everybody folks guys there both y'all friends");
const TITLES = set('mr mrs ms dr prof');
const GREETING_CONTINUE = set(
  "i i'm i've i'd i'll we we're we've hope just thanks thank how quick following sorry great good please can could would as so it this welcome nice glad happy congrats congratulations wanted checking here attached per regarding let my our your hope",
);

const INTRO_WORDS = set(
  'however unfortunately fortunately additionally furthermore moreover meanwhile nevertheless nonetheless consequently therefore otherwise alternatively similarly likewise lastly firstly secondly thirdly personally honestly frankly basically ultimately interestingly surprisingly luckily sadly ideally incidentally admittedly regardless overall accordingly actually anyway anyhow thankfully specifically notably instead',
);
const INTRO_PHRASES: string[][] = [
  'for example', 'for instance', 'in addition', 'in fact', 'of course', 'as a result', 'in conclusion', 'in other words',
  'on the other hand', 'by the way', 'in short', 'in summary', 'having said that', 'that being said', 'to be honest',
  'first of all', 'in the meantime', 'as always', 'all in all', 'in any case', 'in that case', 'if so', 'if not',
  'if possible', 'if needed', 'if necessary', 'as discussed', 'as mentioned', 'as requested', 'as promised', 'in the end',
  'on a side note', 'in general', 'as you know', 'as you can see', 'just to clarify', 'to clarify', 'to summarize',
].map((p) => p.split(' '));
/** What may follow an introductory word: the start of a clause (determiners, pronouns, a name). */
const CLAUSE_OPENERS = set(
  "the this that these those it there we they he she i you our my your their his her its a an all some most both each every no nobody none everyone everything nothing someone something it's there's that's we're we've we'll i'm i've i'll i'd you're they're he's she's",
);
const INTRO_CONJUNCTIONS = set('if when since once while although because');
const YES_NO = set('yes no ok okay well sure alright yeah');
const YES_NO_NEXT = set("i i'm i'll i've i'd we we're we'll you you're they it it's that that's this there's");
const THANKS_GROUPS = set('everyone all team guys folks everybody both');

const IF_STARTERS = set('if when whenever once');
const IF_NOUNS = set(
  'questions question concerns anything issues problems time chance thoughts feedback comments availability minute moment second suggestions help ideas updates trouble possible needed necessary so interested available free ready convenient',
);
const IF_CONTINUE = set(
  "please let feel just don't do reach ping give send call email i i'll we we'll you you'll i'd we'd kindly contact shoot reply drop text message would could can",
);

const IF_MODALS = set('could would can will might may should');
const IF_PLEASE_NEXT = set("let feel reply contact call email send reach don't do ping text message advise confirm");
const CLAUSE_SUBJECTS = set("i we they he she you it there i'm i've i'll i'd we're we've we'll they're it's there's he's she's you're that's");
const CONTRACTED_SUBJECTS = set("i'm i've i'll i'd we're we've we'll they're it's there's he's she's you're that's");
const FINITE = set(
  "am is are was were will would can can't could couldn't should shouldn't have haven't has hasn't had hadn't did didn't do don't does doesn't won't wouldn't think thought need needed want wanted know knew feel felt got get also still never may might must hope believe",
);
const AND_FINITE = set('will would can could should have had am was were did do also think need want decided agreed realized found noticed hope believe');
const BUT_BLOCKERS = set("not all nothing anything everything nobody everyone anyone none no last cannot can't");
const OBJECT_PRONOUNS = set('you him her me us them');

function lineStart(ctx: RuleContext, pos: number): boolean {
  let k = pos;
  const w = ctx.work;
  while (k > 0 && (w.charAt(k - 1) === ' ' || w.charAt(k - 1) === '\t' || w.charAt(k - 1) === ' ')) k--;
  return k === 0 || w.charAt(k - 1) === '\n' || w.charAt(k - 1) === '\r';
}

/** True when nothing but spaces separates `end` from a line break or the end of the text. */
function lineEnd(ctx: RuleContext, end: number): boolean {
  let k = end;
  const w = ctx.work;
  while (k < w.length && (w.charAt(k) === ' ' || w.charAt(k) === '\t' || w.charAt(k) === ' ')) k++;
  return k >= w.length ? !ctx.opts.typing : w.charAt(k) === '\n' || w.charAt(k) === '\r';
}

function isName(t: Token | undefined): boolean {
  return t !== undefined && isUpper(t.text.charAt(0)) && !(isAllCaps(t.text) && t.text.length > 1) && t.norm !== 'i';
}

/** Number of words since the last punctuation or line break before token i (capped). */
function clauseLength(ts: TokenStream, i: number): number {
  let count = 1;
  for (let k = i; k > 0 && count < 12; k--) {
    const g = ts.gap[k];
    if (g !== GAP_SPACE && g !== GAP_HYPHEN) break;
    count++;
  }
  return count;
}

export function commaRule(ctx: RuleContext): void {
  const ts = tokensOf(ctx);
  const list = ts.list;
  const w = ctx.work;
  const insertAfter = (t: Token, key: string, explanation: string, confidence: number, autoApplySafe: boolean, lookEnd: number): void => {
    if (lookaheadUnfinished(ctx, lookEnd)) return;
    if (w.charAt(t.end) === ',') return;
    ctx.emit({ rule: 'comma', key, severity: autoApplySafe ? 'error' : 'warning', kind: 'insert', start: t.start, end: t.end, replacement: `${t.text},`, explanation, confidence, autoApplySafe });
  };

  for (let i = 0; i < list.length; i++) {
    const t = list[i] as Token;
    const n = t.norm;

    // Greeting: "Hi John" at the start of a line.
    if ((GREETINGS.has(n) || n === 'good') && isUpper(t.text.charAt(0)) && lineStart(ctx, t.start)) {
      let k = i;
      if (n === 'good') {
        const tod = nextSpaced(ts, i);
        if (tod === undefined || !/^(?:morning|afternoon|evening)$/.test(tod.norm)) continue;
        k = i + 1;
      }
      if (w.charAt((list[k] as Token).end) === ',') continue;
      const first = nextSpaced(ts, k);
      if (first === undefined) continue;
      let last = k + 1;
      if (GREETING_GROUPS.has(first.norm) && first.text === first.norm) {
        // "Hi team", "Hello everyone"
      } else if (isName(first)) {
        // Names, titles ("Dr. Lee") and connectors between names ("John and Mary", "Sir or Madam").
        let m = k + 1;
        for (;;) {
          const cur = list[m] as Token;
          const nx = list[m + 1];
          if (nx === undefined) break;
          const between = w.slice(cur.end, nx.start);
          if (TITLES.has(cur.norm) && /^\.?[  ]+$/.test(between) && isName(nx)) { m++; continue; }
          if (ts.gap[m + 1] === GAP_SPACE && isName(nx)) { m++; continue; }
          if (ts.gap[m + 1] === GAP_HYPHEN && isName(nx)) { m++; continue; }
          const after = list[m + 2];
          if (ts.gap[m + 1] === GAP_SPACE && (nx.norm === 'and' || nx.norm === 'or' || nx.norm === '&') && ts.gap[m + 2] === GAP_SPACE && isName(after)) { m += 2; continue; }
          break;
        }
        last = m;
        if (last - k > 6) continue;
      } else {
        continue;
      }
      const lt = list[last] as Token;
      const after = nextSpaced(ts, last);
      let ok = lineEnd(ctx, lt.end);
      if (!ok && after !== undefined && GREETING_CONTINUE.has(after.norm)) {
        // "Hi John and Mary" never gets a comma in the middle; the name run has ended at a clause word.
        ok = !(after.norm === 'and' || after.norm === 'or');
      }
      if (ok) insertAfter(lt, 'comma.greeting', 'Put a comma after the greeting and the name.', 0.9, true, after?.end ?? lt.end);
      i = last;
      continue;
    }

    if (!isUpper(t.text.charAt(0)) || !ctx.isSentenceStart(t.start, true)) {
      if (n === 'but' || n === 'and') compound(ctx, ts, i, insertAfter);
      continue;
    }

    // Sentence-initial transition word: "However the plan" -> "However, the plan".
    if (INTRO_WORDS.has(n) && w.charAt(t.end) !== ',') {
      const nx = nextSpaced(ts, i);
      if (nx === undefined) continue;
      const opener = CLAUSE_OPENERS.has(nx.norm) || isName(nx) || INTRO_CONJUNCTIONS.has(nx.norm);
      if (!opener) continue;
      if (n === 'however' && (nx.norm === 'you' || nx.norm === 'much' || nx.norm === 'many' || nx.norm === 'long')) continue;
      if (n === 'instead' && nx.norm === 'of') continue;
      insertAfter(t, 'comma.introductory', `Add a comma after "${t.text}" at the start of a sentence.`, 0.9, true, nx.end);
      continue;
    }
    // Sentence-initial transition phrase.
    let matched = false;
    for (const phrase of INTRO_PHRASES) {
      if (phrase[0] !== n) continue;
      let k = i;
      let ok = true;
      for (let p = 1; p < phrase.length; p++) {
        const nx = nextSpaced(ts, k);
        if (nx === undefined || nx.norm !== phrase[p]) { ok = false; break; }
        k++;
      }
      if (!ok) continue;
      const end = list[k] as Token;
      if (w.charAt(end.end) === ',') { matched = true; break; }
      const nx = nextSpaced(ts, k);
      if (nx === undefined || !(CLAUSE_OPENERS.has(nx.norm) || isName(nx))) { matched = true; break; }
      insertAfter(end, 'comma.introductory', `Add a comma after "${ctx.text.slice(t.start, end.end)}" at the start of a sentence.`, 0.9, true, nx.end);
      matched = true;
      i = k;
      break;
    }
    if (matched) continue;

    // "Yes I can", "Well I think", "Ok we'll go".
    if (YES_NO.has(n) && w.charAt(t.end) !== ',') {
      const nx = nextSpaced(ts, i);
      if (nx !== undefined && YES_NO_NEXT.has(nx.norm)) insertAfter(t, 'comma.introductory', `Add a comma after "${t.text}".`, 0.85, true, nx.end);
      continue;
    }

    // "Thanks John!" / "Thank you Sarah."
    if (n === 'thanks' || n === 'thank') {
      let k = i;
      if (n === 'thank') {
        if (nextSpaced(ts, i)?.norm !== 'you') continue;
        k = i + 1;
      }
      const name = nextSpaced(ts, k);
      if (name === undefined || w.charAt((list[k] as Token).end) === ',') continue;
      if (!(isName(name) || (THANKS_GROUPS.has(name.norm) && name.text === name.norm))) continue;
      const after = w.slice(name.end).match(/^[  ]*(.?)/)?.[1] ?? '';
      if (!(after === '' ? !ctx.opts.typing : /[.!\n\r]/.test(after))) continue;
      insertAfter(list[k] as Token, 'comma.vocative', 'Put a comma before the name of the person you address.', 0.85, true, name.end);
      continue;
    }

    // "If you have any questions please let me know." / "If you would like to cancel please reply."
    if (IF_STARTERS.has(n)) {
      for (let k = i + 1; k < Math.min(list.length - 1, i + 13); k++) {
        if (ts.gap[k] !== GAP_SPACE) break;
        const cur = list[k] as Token;
        const nx = nextSpaced(ts, k);
        if (nx === undefined) break;
        const nounThenMain = IF_NOUNS.has(cur.norm) && IF_CONTINUE.has(nx.norm) && !(cur.norm === 'so' && k !== i + 1);
        const pleaseStartsMain = nx.norm === 'please' && k > i + 2 && !IF_MODALS.has(cur.norm) && IF_PLEASE_NEXT.has(nextSpaced(ts, k + 1)?.norm ?? '');
        if (!nounThenMain && !pleaseStartsMain) continue;
        insertAfter(cur, 'comma.clause', 'Add a comma after the opening "if" clause.', 0.85, true, nx.end);
        break;
      }
    }
  }

  if (/^en-us$/i.test(ctx.opts.dialect)) {
    for (const m of w.matchAll(/(?<![\p{L}\p{N}.])([eE]\.g\.|[iI]\.e\.)(?=[  ]+[\p{L}\p{N}])/gu)) {
      const start = m.index;
      const original = m[0];
      if (lookaheadUnfinished(ctx, start + original.length + 2)) continue;
      ctx.emit({
        rule: 'comma',
        key: 'comma.abbreviation',
        severity: 'warning',
        kind: 'insert',
        start,
        end: start + original.length,
        replacement: `${original},`,
        explanation: `In US English, "${original}" is followed by a comma.`,
        confidence: 0.85,
        autoApplySafe: true,
      });
    }
  }
}

/** "but"/"and" between two complete clauses without a comma. */
function compound(ctx: RuleContext, ts: TokenStream, i: number, insertAfter: (t: Token, key: string, explanation: string, confidence: number, autoApplySafe: boolean, lookEnd: number) => void): void {
  const list = ts.list;
  const conj = list[i] as Token;
  if (conj.text !== conj.norm) return;
  if (ts.gap[i] !== GAP_SPACE || i === 0) return; // a comma (or anything else) already separates the clauses
  const prev = list[i - 1] as Token;
  const subj = nextSpaced(ts, i);
  if (subj === undefined || !CLAUSE_SUBJECTS.has(subj.norm)) return;
  if (BUT_BLOCKERS.has(prev.norm) || OBJECT_PRONOUNS.has(prev.norm) || isName(prev)) return;
  let verbEnd = subj.end;
  if (!CONTRACTED_SUBJECTS.has(subj.norm)) {
    const verb = nextSpaced(ts, i + 1);
    if (verb === undefined) return;
    const finite = conj.norm === 'but' ? FINITE.has(verb.norm) || /^[a-z]{3,}ed$/.test(verb.norm) : AND_FINITE.has(verb.norm);
    if (!finite) return;
    verbEnd = verb.end;
  }
  if (conj.norm === 'and') {
    if (subj.norm === 'you' || subj.norm === 'it' || subj.norm === 'there' || subj.norm === "it's" || subj.norm === "there's" || subj.norm === "that's") return;
    if (clauseLength(ts, i - 1) < 5) return;
    for (let k = i - 1; k >= 0 && k > i - 12; k--) {
      const tk = list[k] as Token;
      if (tk.norm === 'between' || tk.norm === 'both' || tk.norm === 'either' || tk.norm === 'neither') return;
      if (ts.gap[k] === GAP_OTHER) break;
    }
  } else if (clauseLength(ts, i - 1) < 3) {
    return;
  }
  if (ctx.work.slice(subj.end, verbEnd + 2).includes('?')) return;
  insertAfter(prev, 'comma.compound', `Use a comma before "${conj.norm}" when it joins two complete sentences.`, 0.8, false, verbEnd);
}

const SPLICE_OPENERS = set('i we they he she it thanks thank this that everything everyone the my our your their');
const SPLICE_SUBJECTS = set("i we they he she it i'm i've i'll i'd we're we've we'll they're they've they'll it's he's she's");
const SPLICE_ADVERBS = set('really also just still already actually truly totally definitely always never honestly');
const SUBORDINATORS = set('if when whenever because since although though while as after before unless until whether once that which who where how what why than said says asked like');
const HEDGE_TAGS = set('think guess hope believe suppose mean know');
/** Words after a subject pronoun that show it is not the start of a new clause. */
const NOT_A_VERB = set('a an the and or but nor to of in on at for with by from as so too also not just very really both all each either neither alone included and too');

/**
 * Rule `comma_splice`: two complete sentences joined by a comma ("Thanks for the update, I will review it today.").
 * Only when the first clause opens the sentence with a subject or "Thanks", holds no subordinating word, and the second
 * starts with a subject pronoun and a finite verb. A short tag ("..., I think.") is not a splice.
 */
export function commaSpliceRule(ctx: RuleContext): void {
  if (ctx.opts.context === 'code') return;
  const ts = tokensOf(ctx);
  const list = ts.list;
  const w = ctx.work;
  for (let i = 1; i < list.length; i++) {
    const subj = list[i] as Token;
    if (!SPLICE_SUBJECTS.has(subj.norm)) continue;
    const prev = list[i - 1] as Token;
    if (w.slice(prev.end, subj.start) !== ', ') continue;
    // Second clause: subject + (adverb) + finite verb, and more words after it.
    let v = i + 1;
    if (!CONTRACTED_SUBJECTS.has(subj.norm)) {
      let verb = nextSpaced(ts, i);
      if (verb !== undefined && SPLICE_ADVERBS.has(verb.norm)) {
        verb = nextSpaced(ts, i + 1);
        v++;
      }
      if (verb === undefined || !(FINITE.has(verb.norm) || (/^\p{Ll}{2,}$/u.test(verb.text) && !NOT_A_VERB.has(verb.norm) && !LY_RE.test(verb.norm)))) continue;
      if (HEDGE_TAGS.has(verb.norm) && /^[ \u00a0]*[.!?]/.test(w.slice(verb.end))) continue;
    } else {
      v = i;
    }
    if (nextSpaced(ts, v) === undefined) continue;
    // First clause: from the sentence start to the comma, no punctuation inside, no subordinating word.
    let k = i - 1;
    let ok = true;
    while (k > 0 && (ts.gap[k] === GAP_SPACE || ts.gap[k] === GAP_HYPHEN)) {
      if (SUBORDINATORS.has((list[k] as Token).norm)) { ok = false; break; }
      k--;
    }
    if (!ok || i - k < 3) continue;
    const first = list[k] as Token;
    if (!ctx.isSentenceStart(first.start, true) || !SPLICE_OPENERS.has(first.norm) || SUBORDINATORS.has(first.norm)) continue;
    const sentenceEnd = /[^.!?\n]*[.!?]?/.exec(w.slice(subj.end, subj.end + 400))?.[0] ?? '';
    if (sentenceEnd.trimEnd().endsWith('?')) continue;
    const lead = subj.text.charAt(0).toUpperCase() + subj.text.slice(1);
    if (lookaheadUnfinished(ctx, (list[v] as Token).end)) continue;
    ctx.emit({
      rule: 'comma_splice',
      severity: 'warning',
      kind: 'replace',
      start: prev.end,
      end: subj.end,
      replacement: `. ${lead}`,
      explanation: 'These are two complete sentences. Separate them with a period or a semicolon.',
      confidence: 0.75,
      autoApplySafe: false,
      alternatives: [`; ${subj.text}`],
    });
  }
}
