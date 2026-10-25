/**
 * Style rules over the token stream (never in code fields or quoted speech, never auto-applied):
 *
 *  - `intensifier` (engagement): very/really/extremely/incredibly/super + a common adjective -> one stronger word
 *    ("very good" -> "excellent", "really important" -> "crucial"), with alternatives. Negated phrases ("not very
 *    good") are left alone, and adjectives that double as adverbs ("long", "fast") need a determiner or a linking verb
 *    before them ("a very long meeting", "it was very short").
 *  - `hedging` (delivery): "I think", "I believe", "I guess", "I feel like", "maybe", "kind of", "sort of", softening
 *    "just", sentence-initial "Hopefully" and "In my opinion", and "I was wondering if you could ..." (-> "Could you
 *    ...?"). Removing a hedge changes how sure the sentence sounds, so those hits are not meaning-preserving.
 */
import type { RuleContext } from './context';
import { isUpper } from './context';
import { dict } from './dict';
import type { Token, TokenStream } from './tokens';
import { GAP_HYPHEN, LOWER_WORD_RE, casePreserve, inQuotes, isAllCaps, lookaheadUnfinished, nextSpaced, prevSpaced, tokensOf, withArticle } from './tokens';

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter((w) => w.length > 0));

const INTENSIFIER_WORDS = set('very really extremely incredibly super');
/** Adjective -> stronger single words (the first is the suggestion, the rest are alternatives). */
const STRONGER = dict<string[]>({
  good: ['excellent', 'great', 'superb'], bad: ['terrible', 'awful', 'dreadful'], big: ['huge', 'enormous', 'massive'],
  large: ['huge', 'enormous', 'vast'], small: ['tiny', 'minuscule'], important: ['crucial', 'essential', 'vital'],
  happy: ['delighted', 'thrilled'], sad: ['miserable', 'heartbroken'], tired: ['exhausted', 'drained'],
  busy: ['swamped', 'overloaded'], interesting: ['fascinating', 'intriguing'], beautiful: ['gorgeous', 'stunning'],
  pretty: ['beautiful', 'lovely'], nice: ['lovely', 'wonderful'], difficult: ['arduous', 'daunting'],
  easy: ['effortless', 'simple'], quick: ['rapid', 'swift'], cold: ['freezing', 'frigid'], hot: ['scorching', 'sweltering'],
  hungry: ['starving', 'famished'], angry: ['furious', 'livid'], scared: ['terrified', 'petrified'], afraid: ['terrified'],
  excited: ['thrilled', 'ecstatic'], funny: ['hilarious'], smart: ['brilliant', 'ingenious'], expensive: ['exorbitant', 'costly'],
  strong: ['powerful', 'robust'], weak: ['feeble', 'frail'], loud: ['deafening', 'thunderous'], dirty: ['filthy', 'grimy'],
  clean: ['spotless', 'pristine'], wet: ['soaked', 'drenched'], ugly: ['hideous'], surprised: ['astonished', 'amazed'],
  worried: ['anxious', 'distressed'], sure: ['certain', 'positive'], helpful: ['invaluable', 'indispensable'],
  useful: ['invaluable', 'indispensable'], pleased: ['delighted', 'thrilled'], upset: ['distraught', 'devastated'],
  serious: ['grave', 'severe'], bright: ['dazzling', 'brilliant'], boring: ['tedious', 'dull'], confused: ['perplexed', 'bewildered'],
  tasty: ['delicious'], thirsty: ['parched'], short: ['brief'], long: ['lengthy'], fast: ['rapid'], scary: ['terrifying'],
  rude: ['insulting'], tiny: ['minuscule'], huge: ['enormous', 'colossal'], sick: ['ill'], fun: ['enjoyable', 'delightful'],
});
/** Adjectives that also work as adverbs or nouns: only after a determiner or a linking verb. */
const GUARDED = set('short long fast quick hot cold clean fun sick');
const ADJECTIVE_CONTEXT = set(
  "a an the is are was were be been being am seems seemed looks looked feels felt sounds sounded get got gets become became stay stayed remain remained it's that's he's she's i'm we're you're they're",
);
const NEGATORS = set("not never no isn't wasn't aren't weren't don't doesn't didn't won't hardly nothing");

export function intensifierRule(ctx: RuleContext): void {
  if (ctx.opts.context === 'code') return;
  const ts = tokensOf(ctx);
  const list = ts.list;
  for (let i = 0; i + 1 < list.length; i++) {
    const t = list[i] as Token;
    if (!INTENSIFIER_WORDS.has(t.norm)) continue;
    const adj = nextSpaced(ts, i);
    if (adj === undefined) continue;
    const stronger = STRONGER.get(adj.norm);
    if (stronger === undefined || ts.gap[i + 2] === GAP_HYPHEN || adj.text !== adj.norm) continue;
    if (isAllCaps(t.text) && t.text.length > 1) continue;
    const prev = prevSpaced(ts, i);
    if (prev !== undefined && (NEGATORS.has(prev.norm) || INTENSIFIER_WORDS.has(prev.norm) || prev.norm === 'the' || prev.norm.endsWith("n't"))) continue;
    const prev2 = prev === undefined ? undefined : prevSpaced(ts, i - 1);
    if (prev2 !== undefined && NEGATORS.has(prev2.norm)) continue; // "not a very good"
    if (GUARDED.has(adj.norm) && (prev === undefined || !ADJECTIVE_CONTEXT.has(prev.norm))) continue;
    if (lookaheadUnfinished(ctx, adj.end + 1)) continue;
    if (inQuotes(ts, t.start, adj.end)) continue;
    const [first, ...rest] = stronger;
    if (first === undefined) continue;
    let replacement = casePreserve(first, t.text);
    const widened = withArticle(ts, i, t.start, replacement);
    replacement = widened.replacement;
    const alternatives = rest.map((r) => withArticle(ts, i, t.start, casePreserve(r, t.text)).replacement);
    ctx.emit({
      rule: 'intensifier',
      severity: 'suggestion',
      kind: 'replace',
      start: widened.start,
      end: adj.end,
      replacement,
      explanation: `"${t.text} ${adj.text}" is weaker than one precise word like "${first}".`,
      confidence: 0.75,
      autoApplySafe: false,
      alternatives,
    });
    i++;
  }
}

/** Words that open a clause after a removed hedge ("I think [we] should"). */
const CLAUSE_STARTERS = set(
  "we you they he she it i this that these those there the our my your their his her a an everyone everybody everything nothing someone something it's we're you're they're there's that's i'm i've i'll i'd we'll we've we'd you'll he's she's",
);
const HEDGE_VERBS = set('think believe guess suppose');
const HEDGE_BLOCKERS = set('what how why where when whatever do does did if as than');
const JUST_NEXT = set('wanted want checking following wondering thought reaching writing letting saying asking curious hoping touching circling pinging');
const JUST_A_NEXT = set('quick reminder friendly heads note');
const JUST_PREV = set("i we i'm we're i'd we'd i've we've was were am");
const KIND_PREV = set("i'm it's that's he's she's we're they're you're is was are were am be been feel felt seems seemed looks looked sounds i we they he she it you still also");
const MAYBE_STARTERS = set("we you they i it this that there he she it's we're there's");
const MODALS = set('could can should would might will');

function capitalizeWord(t: Token): string {
  return t.text.charAt(0).toUpperCase() + t.text.slice(1);
}

function clauseStarter(t: Token | undefined, ctx: RuleContext): boolean {
  if (t === undefined) return false;
  if (CLAUSE_STARTERS.has(t.norm)) return true;
  return isUpper(t.text.charAt(0)) && !isAllCaps(t.text) && !ctx.isSentenceStart(t.start, true);
}

export function hedgingRule(ctx: RuleContext): void {
  if (ctx.opts.context === 'code') return;
  const ts = tokensOf(ctx);
  const list = ts.list;
  const emitHedge = (start: number, end: number, replacement: string, explanation: string, meaningPreserving: boolean, lookEnd: number, alternatives?: string[]): void => {
    if (lookaheadUnfinished(ctx, lookEnd)) return;
    if (inQuotes(ts, start, end)) return;
    ctx.emit({
      rule: 'hedging',
      severity: 'suggestion',
      kind: replacement === '' ? 'delete' : 'replace',
      start,
      end,
      replacement,
      explanation,
      confidence: 0.7,
      autoApplySafe: false,
      meaningPreserving,
      alternatives,
    });
  };
  /** Deletes tokens [i, j] plus the following space (mid-sentence), or folds them into the capitalized next word. */
  const removeHedge = (i: number, j: number, explanation: string, meaningPreserving: boolean, alternatives?: string[]): void => {
    const a = list[i] as Token;
    const b = list[j] as Token;
    const next = nextSpaced(ts, j);
    if (ctx.isSentenceStart(a.start, true)) {
      if (next === undefined || !/^\p{Ll}|^i$|^i'/u.test(next.norm)) return;
      emitHedge(a.start, next.end, capitalizeWord(next), explanation, meaningPreserving, next.end, alternatives?.map((alt) => `${alt} ${next.text}`));
      return;
    }
    if (ctx.work.charAt(b.end) !== ' ' || next === undefined) return;
    emitHedge(a.start, b.end + 1, '', explanation, meaningPreserving, next.end);
  };

  for (let i = 0; i < list.length; i++) {
    const t = list[i] as Token;
    switch (t.norm) {
      case 'i': {
        if (t.text !== 'I') break;
        const verb = nextSpaced(ts, i);
        if (verb === undefined) break;
        const pv = prevSpaced(ts, i);
        if (pv !== undefined && HEDGE_BLOCKERS.has(pv.norm)) break;
        let j = i + 1;
        if (verb.norm === 'feel') {
          const like = nextSpaced(ts, j);
          if (like === undefined || (like.norm !== 'like' && like.norm !== 'that')) break;
          j++;
        } else if (!HEDGE_VERBS.has(verb.norm)) {
          // "I was (just) wondering if you could ..."
          if (verb.norm === 'was' && ctx.isSentenceStart(t.start, true)) wondering(ctx, ts, i, emitHedge);
          break;
        } else if (nextSpaced(ts, j)?.norm === 'that' && clauseStarter(nextSpaced(ts, j + 1), ctx)) {
          j++;
        }
        const after = list[j] as Token;
        // Trailing ", I think." -> delete
        if (ctx.work.slice(Math.max(0, t.start - 2), t.start) === ', ' && /^[.!?]/.test(ctx.work.charAt(after.end)) && j === i + 1) {
          emitHedge(t.start - 2, after.end, '', `Removing "I ${verb.norm}" makes the sentence sound more confident.`, false, after.end + 1);
          break;
        }
        const next = nextSpaced(ts, j);
        if (!clauseStarter(next, ctx) || next?.norm === 'so') break;
        // Not in a question: "I think we should, right?" keeps its hedge.
        const sentenceTail = /[^.!?\n]*[.!?]?/.exec(ctx.work.slice(after.end, after.end + 300))?.[0] ?? '';
        if (sentenceTail.trimEnd().endsWith('?')) break;
        const phrase = ctx.text.slice(t.start, after.end);
        removeHedge(i, j, `Removing "${phrase}" makes the sentence sound more confident.`, false);
        i = j;
        break;
      }
      case 'just': {
        const next = nextSpaced(ts, i);
        if (next === undefined) break;
        const prev = prevSpaced(ts, i);
        const start = ctx.isSentenceStart(t.start, true);
        const softener = JUST_NEXT.has(next.norm) || (next.norm === 'a' && JUST_A_NEXT.has(nextSpaced(ts, i + 1)?.norm ?? ''));
        if (!softener) break;
        if (!start && (prev === undefined || !JUST_PREV.has(prev.norm))) break;
        removeHedge(i, i, '"Just" softens the message; leave it out to sound more direct.', true);
        break;
      }
      case 'maybe': {
        const next = nextSpaced(ts, i);
        if (next === undefined) break;
        const prev = prevSpaced(ts, i);
        if (ctx.isSentenceStart(t.start, true) && t.text === 'Maybe' && MAYBE_STARTERS.has(next.norm)) {
          const tail = /[^.!?\n]*[.!?]?/.exec(ctx.work.slice(next.end, next.end + 300))?.[0] ?? '';
          if (tail.trimEnd().endsWith('?')) break; // "Maybe we could meet?" is a proposal, not a hedge
          removeHedge(i, i, '"Maybe" makes the statement sound unsure.', false);
        } else if (prev !== undefined && MODALS.has(prev.norm) && LOWER_WORD_RE.test(next.text) && !CLAUSE_STARTERS.has(next.norm) && next.norm !== 'not') {
          removeHedge(i, i, '"Maybe" makes the statement sound unsure.', false);
        }
        break;
      }
      case 'kind':
      case 'sort': {
        const of = nextSpaced(ts, i);
        const prev = prevSpaced(ts, i);
        if (of?.norm !== 'of' || prev === undefined || !KIND_PREV.has(prev.norm)) break;
        const next = nextSpaced(ts, i + 1);
        if (next === undefined || !LOWER_WORD_RE.test(next.text) || next.norm === 'a' || next.norm === 'an' || next.norm === 'the') break;
        removeHedge(i, i + 1, `"${t.norm} of" weakens the statement; say it directly.`, false);
        i++;
        break;
      }
      case 'hopefully': {
        if (t.text !== 'Hopefully' || !ctx.isSentenceStart(t.start, true)) break;
        const comma = ctx.work.charAt(t.end) === ',';
        const next = comma ? (ts.gap[i + 1] === 0 && ctx.work.slice(t.end, (list[i + 1] as Token | undefined)?.start ?? t.end) === ', ' ? list[i + 1] : undefined) : nextSpaced(ts, i);
        if (next === undefined || !MAYBE_STARTERS.has(next.norm)) break;
        emitHedge(t.start, next.end, capitalizeWord(next), '"Hopefully" makes the statement sound unsure.', false, next.end, [`I hope ${next.text}`]);
        break;
      }
      case 'in': {
        // "In my opinion, we should" -> "We should"
        if (t.text !== 'In' || !ctx.isSentenceStart(t.start, true)) break;
        const my = nextSpaced(ts, i);
        const op = my === undefined ? undefined : nextSpaced(ts, i + 1);
        if (my?.norm !== 'my' || op === undefined || (op.norm !== 'opinion' && op.norm !== 'view')) break;
        const nx = list[i + 3];
        if (nx === undefined || ctx.work.slice(op.end, nx.start) !== ', ' || !MAYBE_STARTERS.has(nx.norm)) break;
        emitHedge(t.start, nx.end, capitalizeWord(nx), `"In my ${op.norm}" is implied; leave it out to sound more confident.`, false, nx.end);
        break;
      }
      default:
        break;
    }
  }
}

/** "I was (just) wondering if you could send it." -> "Could you send it?" */
function wondering(
  ctx: RuleContext,
  ts: TokenStream,
  i: number,
  emitHedge: (start: number, end: number, replacement: string, explanation: string, meaningPreserving: boolean, lookEnd: number) => void,
): void {
  const list = ts.list;
  let k = i + 1; // "was"
  if (nextSpaced(ts, k)?.norm === 'just') k++;
  const words = ['wondering', 'if', 'you'];
  for (const w of words) {
    const t = nextSpaced(ts, k);
    if (t?.norm !== w) return;
    k++;
  }
  const modal = nextSpaced(ts, k);
  if (modal === undefined || !/^(?:could|would|can|might)$/.test(modal.norm)) return;
  const rest = /^[^.!?\n]{1,160}?([.?])/.exec(ctx.work.slice(modal.end));
  if (rest === null) return;
  const body = ctx.text.slice(modal.end, modal.end + rest[0].length - 1);
  if (/[.!?]/.test(body) || !body.startsWith(' ')) return;
  const lead = modal.norm === 'might' ? 'Could' : modal.text.charAt(0).toUpperCase() + modal.text.slice(1);
  const end = modal.end + rest[0].length;
  emitHedge((list[i] as Token).start, end, `${lead} you${body}?`, 'Ask directly; it reads more confident and is easier to answer.', true, end);
}
