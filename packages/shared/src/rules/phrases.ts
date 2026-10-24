/**
 * Data-driven multi-word phrases, matched on the token stream with a trie (longest match wins, one pass):
 *
 *  - `wordy_phrase` (clarity): "in order to" -> "to", "due to the fact that" -> "because", "a lot of" + plural -> "many"...
 *  - `redundancy` (clarity): "past history" -> "history", "end result" -> "result", "revert back" -> "revert"...
 *  - `cliche` (engagement): "at the end of the day" -> "ultimately", "touch base" -> "connect"...
 *  - `confusable_word` (correctness): eggcorns with one right form ("for all intensive purposes", "sneak peak").
 *
 * Phrase words must be separated by spaces only (a hyphen where the entry spells one), so a phrase never runs across
 * punctuation or a line break. Style suggestions skip quoted speech and code fields; a replacement that changes the
 * sound of the next word also fixes a preceding "a"/"an" ("an end result" -> "a result").
 */
import type { SuggestionSeverity } from '../types';
import type { RuleContext } from './context';
import { isUpper } from './context';
import { RULE_CATEGORIES } from './titles';
import type { Token, TokenStream } from './tokens';
import { GAP_HYPHEN, GAP_SPACE, casePreserve, inQuotes, lookaheadUnfinished, nextSpaced, tokensOf, withArticle } from './tokens';

interface PhraseEntry {
  rule: string;
  key?: string;
  /** Lower-cased words. */
  words: string[];
  /** Gap kind before words[k] (k >= 1): GAP_SPACE or GAP_HYPHEN. */
  gaps: number[];
  /** "" deletes the phrase; "{k}" is replaced by the original text of word k (keeps "ATM", "PIN"). */
  replacement: string;
  explanation: string;
  confidence: number;
  severity: SuggestionSeverity;
  autoApplySafe: boolean;
  /** Extra condition on the words after the phrase. */
  guard?: (ctx: RuleContext, ts: TokenStream, last: number) => boolean;
}

interface TrieNode {
  next: Map<string, TrieNode>;
  entry?: PhraseEntry;
}

/** Plural count nouns after which "a lot of" / "lots of" is "many". */
const PLURALS_FOR_MANY = new Set(
  `people things ideas questions options emails meetings changes issues problems ways reasons times friends customers users
   clients students employees members details steps tasks projects features files documents pages products companies cars
   books games photos pictures places opportunities resources requests updates comments suggestions examples mistakes errors
   bugs tests calls messages years days months weeks kids children men women countries cities words numbers results factors
   challenges benefits risks tools apps sites websites articles posts videos jobs applications candidates orders visitors
   readers fans followers partners vendors teams decisions events conversations questions emails
   `.split(/\s+/).filter(Boolean),
);

function pluralFollows(ctx: RuleContext, ts: TokenStream, last: number): boolean {
  const next = nextSpaced(ts, last);
  if (next === undefined || !PLURALS_FOR_MANY.has(next.norm)) return false;
  if (lookaheadUnfinished(ctx, next.end)) return false;
  const o = ctx.opts;
  return !(o.context === 'chat' || o.context === 'social' || o.formality === 'informal');
}

/** "going forward" only as a sentence adverb: at a sentence start or right before a comma or period. */
function adverbialGoingForward(ctx: RuleContext, ts: TokenStream, last: number): boolean {
  const t = ts.list[last] as Token;
  const after = ctx.work.charAt(t.end);
  return after === ',' || after === '.' || (ts.list[last - 1] !== undefined && ctx.isSentenceStart((ts.list[last - 1] as Token).start, true) && after === ',');
}

type Row = [phrase: string, replacement: string, explanation?: string];

const WORDY: Row[] = [
  ['in order to', 'to'], ['in order for', 'for'], ['so as to', 'to'], ['in an effort to', 'to'],
  ['due to the fact that', 'because'], ['owing to the fact that', 'because'], ['in light of the fact that', 'because'],
  ['on account of the fact that', 'because'], ['for the reason that', 'because'], ['in view of the fact that', 'because'],
  ['in spite of the fact that', 'although'], ['despite the fact that', 'although'], ['regardless of the fact that', 'although'],
  ['at this point in time', 'now'], ['at this moment in time', 'now'], ['at the present time', 'now'], ['at the present moment', 'now'],
  ['at that point in time', 'then'], ['in the event that', 'if'], ['for the purpose of', 'for'], ['for the purposes of', 'for'],
  ['with regard to', 'regarding'], ['with regards to', 'regarding'], ['in regards to', 'regarding'], ['in regard to', 'regarding'],
  ['with reference to', 'about'], ['in reference to', 'about'], ['a large number of', 'many'], ['a great number of', 'many'],
  ['a small number of', 'a few'], ['the majority of', 'most'], ['a majority of', 'most'],
  ...['the', 'our', 'my', 'your', 'their', 'his', 'her', 'these', 'those', 'them', 'us', 'it', 'its'].flatMap((d): Row[] => [
    [`the majority of ${d}`, `most of ${d}`], [`a majority of ${d}`, `most of ${d}`],
  ]),
  ['in the near future', 'soon'],
  ['in the not too distant future', 'soon'], ['at a later date', 'later'], ['at all times', 'always'],
  ['on a daily basis', 'daily'], ['on a weekly basis', 'weekly'], ['on a monthly basis', 'monthly'], ['on a yearly basis', 'yearly'],
  ['on an annual basis', 'annually'], ['on a regular basis', 'regularly'], ['prior to', 'before'], ['subsequent to', 'after'],
  ['in close proximity to', 'near'], ['in the vicinity of', 'near'], ['has the ability to', 'can'], ['have the ability to', 'can'],
  ['had the ability to', 'could'], ['has the capacity to', 'can'], ['is able to', 'can'], ['are able to', 'can'], ['am able to', 'can'],
  ['make a decision', 'decide'], ['made a decision', 'decided'], ['making a decision', 'deciding'], ['makes a decision', 'decides'],
  ['take into consideration', 'consider'], ['took into consideration', 'considered'], ['taken into consideration', 'considered'],
  ['taking into consideration', 'considering'], ['give consideration to', 'consider'], ['in a timely manner', 'promptly'],
  ['in a timely fashion', 'promptly'], ['each and every', 'every'], ['first and foremost', 'first'], ['as a matter of fact', 'in fact'],
  ['for the most part', 'mostly'], ['with the exception of', 'except'], ['until such time as', 'until'], ['is indicative of', 'indicates'],
  ['are indicative of', 'indicate'], ['in the process of', ''], ['along the lines of', 'like'], ['in the course of', 'during'],
  ['during the course of', 'during'], ['in excess of', 'more than'], ['a sufficient amount of', 'enough'], ['in the absence of', 'without'],
  ['is in need of', 'needs'], ['are in need of', 'need'], ['has a tendency to', 'tends to'], ['have a tendency to', 'tend to'],
  ['by means of', 'by'], ['in spite of', 'despite'], ['at an early date', 'soon'], ['it is my understanding that', 'I understand that'],
  ['make an attempt to', 'try to'], ['made an attempt to', 'tried to'], ['make reference to', 'refer to'], ['made reference to', 'referred to'],
  ['provide assistance to', 'help'], ['conduct an investigation', 'investigate'], ['come to the conclusion', 'conclude'],
  ['came to the conclusion', 'concluded'], ['in the majority of cases', 'usually'], ['in most cases', 'usually'],
  ['in many cases', 'often'], ['in some cases', 'sometimes'], ['the question as to whether', 'whether'], ['as to whether', 'whether'],
  ['at your earliest convenience', 'as soon as you can'], ["please don't hesitate to", 'please'], ['please do not hesitate to', 'please'],
  ['the reason why is because', 'the reason is that'], ['the reason is because', 'the reason is that'],
];

const REDUNDANT: Row[] = [
  ['past history', 'history'], ['end result', 'result'], ['end results', 'results'], ['free gift', 'gift'], ['free gifts', 'gifts'],
  ['added bonus', 'bonus'], ['advance warning', 'warning'], ['advance planning', 'planning'], ['advance reservations', 'reservations'],
  ['basic fundamentals', 'fundamentals'], ['close proximity', 'proximity'], ['completely finished', 'finished'],
  ['completely eliminate', 'eliminate'], ['completely eliminated', 'eliminated'], ['exact same', 'same'], ['final outcome', 'outcome'],
  ['final conclusion', 'conclusion'], ['future plans', 'plans'], ['general consensus', 'consensus'], ['consensus of opinion', 'consensus'],
  ['joint collaboration', 'collaboration'], ['past experience', 'experience'], ['past experiences', 'experiences'],
  ['personal opinion', 'opinion'], ['repeat again', 'repeat'], ['revert back', 'revert'], ['reverted back', 'reverted'],
  ['return back', 'return'], ['reply back', 'reply'], ['replied back', 'replied'], ['refer back', 'refer'], ['unexpected surprise', 'surprise'],
  ['true facts', 'facts'], ['new innovation', 'innovation'], ['new innovations', 'innovations'], ['atm machine', '{0}'],
  ['pin number', '{0}'], ['absolutely essential', 'essential'], ['absolutely necessary', 'necessary'], ['actual fact', 'fact'],
  ['brief summary', 'summary'], ['collaborate together', 'collaborate'], ['combine together', 'combine'], ['merge together', 'merge'],
  ['join together', 'join'], ['connect together', 'connect'], ['cooperate together', 'cooperate'], ['mix together', 'mix'],
  ['each individual', 'each'], ['first began', 'began'], ['invited guests', 'guests'], ['mutual cooperation', 'cooperation'],
  ['new beginning', 'beginning'], ['over exaggerate', 'exaggerate'], ['postpone until later', 'postpone'], ['still remains', 'remains'],
  ['sum total', 'total'], ['unintended mistake', 'mistake'], ['very unique', 'unique'], ['totally unique', 'unique'],
  ['completely unique', 'unique'], ['period of time', 'period'], ['time period', 'period'], ['past memories', 'memories'],
  ['honest truth', 'truth'], ['armed gunman', 'gunman'], ['frozen ice', 'ice'], ['major breakthrough', 'breakthrough'],
  ['plan ahead', 'plan'], ['but however', 'but'], ['and also', 'and'], ['12 noon', 'noon'], ['12 midnight', 'midnight'],
  ['still persists', 'persists'], ['blend together', 'blend'], ['both alike', 'alike'],
];

const CLICHES: Row[] = [
  ['at the end of the day', 'ultimately'], ['when all is said and done', 'ultimately'], ['think outside the box', 'think creatively'],
  ['thinking outside the box', 'thinking creatively'], ['think out of the box', 'think creatively'], ['low hanging fruit', 'easy wins'],
  ['low-hanging fruit', 'easy wins'], ['touch base', 'connect'], ['touching base', 'connecting'], ['touched base', 'connected'],
  ['circle back', 'follow up'], ['circling back', 'following up'], ['circled back', 'followed up'], ['move the needle', 'make progress'],
  ['game changer', 'breakthrough'], ['game-changer', 'breakthrough'], ['in a nutshell', 'in short'], ['last but not least', 'finally'],
  ['the ball is in your court', "it's your decision"], ['few and far between', 'rare'], ['par for the course', 'typical'],
  ['on the same page', 'in agreement'], ['hit the ground running', 'start quickly'], ['back to square one', 'back to the start'],
  ['like the plague', 'at all costs'], ['easier said than done', 'difficult'], ['bring to the table', 'offer'],
  ['brings to the table', 'offers'], ['take it to the next level', 'improve it'], ['at this juncture', 'now'],
  ['in this day and age', 'today'], ['drop the ball', 'make a mistake'], ['dropped the ball', 'made a mistake'],
  ['keep me in the loop', 'keep me informed'], ['keep you in the loop', 'keep you informed'], ['keep us in the loop', 'keep us informed'],
  ['keep everyone in the loop', 'keep everyone informed'], ['going forward', 'from now on'],
];

const EGGCORNS: Row[] = [
  ['for all intensive purposes', 'for all intents and purposes'], ['case and point', 'case in point'], ['one in the same', 'one and the same'],
  ['peak my interest', 'pique my interest'], ['peaked my interest', 'piqued my interest'], ['peaks my interest', 'piques my interest'],
  ['peak your interest', 'pique your interest'], ['peaked your interest', 'piqued your interest'], ['peak their interest', 'pique their interest'],
  ['peaked their interest', 'piqued their interest'], ['sneak peak', 'sneak peek'], ['sneak peaks', 'sneak peeks'], ['deep seeded', 'deep-seated'],
  ['free reign', 'free rein'], ['tow the line', 'toe the line'], ['baited breath', 'bated breath'], ['mute point', 'moot point'],
  ['escape goat', 'scapegoat'], ['beckon call', 'beck and call'], ['make due', 'make do'], ['per say', 'per se'],
  ['statue of limitations', 'statute of limitations'], ['wet your appetite', 'whet your appetite'], ['piece of mind', 'peace of mind'],
  ['peace of cake', 'piece of cake'], ['slight of hand', 'sleight of hand'], ['by in large', 'by and large'],
  ['worse case scenario', 'worst-case scenario'], ['all of the sudden', 'all of a sudden'], ['weather or not', 'whether or not'],
  ['take a brake', 'take a break'], ['lunch brake', 'lunch break'], ['coffee brake', 'coffee break'], ['nip it in the butt', 'nip it in the bud'],
  ['hunger pains', 'hunger pangs'], ['damp squid', 'damp squib'], ['doggy dog world', 'dog-eat-dog world'],
  ['unchartered territory', 'uncharted territory'], ['unchartered waters', 'uncharted waters'], ['pass mustard', 'pass muster'],
  ['tongue and cheek', 'tongue-in-cheek'], ['bare with me', 'bear with me'], ['bare with us', 'bear with us'], ['lose cannon', 'loose cannon'],
  ['on the same token', 'by the same token'], ['past the buck', 'pass the buck'], ['first come first serve', 'first come, first served'],
  ['extract revenge', 'exact revenge'], ['shoe-in', 'shoo-in'], ['self-depreciating', 'self-deprecating'], ['expresso', 'espresso'],
];

/** Words that a verb already includes ("discuss about") or leaves out ("explain me"). */
const EXTRA_WORDS: Row[] = [
  ['discuss about', 'discuss'], ['discussed about', 'discussed'], ['discussing about', 'discussing'], ['discusses about', 'discusses'],
  ['mention about', 'mention'], ['mentioned about', 'mentioned'], ['emphasize on', 'emphasize'], ['emphasized on', 'emphasized'],
  ['cope up with', 'cope with'], ['return back to', 'return to'], ['reply back to', 'reply to'],
  ['might could', 'might', 'Use one helping verb: "might" already says it is possible.'],
];
const MISSING_WORDS: Row[] = [
  ['explain me', 'explain to me'], ['explained me', 'explained to me'], ['explaining me', 'explaining to me'],
];

function compile(rows: Row[], rule: string, key: string | undefined, base: Omit<PhraseEntry, 'rule' | 'key' | 'words' | 'gaps' | 'replacement' | 'explanation'>, explain: (from: string, to: string) => string, guards: Record<string, PhraseEntry['guard']> = {}): PhraseEntry[] {
  return rows.map(([phrase, replacement, explanation]) => {
    const parts = phrase.split(/([ -])/);
    const words: string[] = [];
    const gaps: number[] = [];
    for (const p of parts) {
      if (p === ' ') gaps.push(GAP_SPACE);
      else if (p === '-') gaps.push(GAP_HYPHEN);
      else if (p.length > 0) words.push(p);
    }
    const display = replacement.replace(/\{\d+\}/g, (m) => (words[Number(m.slice(1, -1))] ?? '').toUpperCase());
    return { ...base, rule, key, words, gaps: [0, ...gaps], replacement, explanation: explanation ?? explain(phrase, display), guard: guards[phrase] };
  });
}

let trie: TrieNode | null = null;

function buildTrie(): TrieNode {
  const style = { severity: 'suggestion' as const, autoApplySafe: false };
  const entries: PhraseEntry[] = [
    ...compile(WORDY, 'wordy_phrase', undefined, { ...style, confidence: 0.8 }, (from, to) => (to === '' ? `"${from}" adds words without adding meaning.` : `"${to}" says the same thing in fewer words.`)),
    ...compile(
      [['a lot of', 'many'], ['lots of', 'many']],
      'wordy_phrase',
      undefined,
      { ...style, confidence: 0.75 },
      () => '"Many" is more concise and more formal.',
      { 'a lot of': pluralFollows, 'lots of': pluralFollows },
    ),
    ...compile(REDUNDANT, 'redundancy', undefined, { ...style, confidence: 0.8 }, (from, to) => `"${to}" already carries the meaning of "${from}".`),
    ...compile(CLICHES, 'cliche', undefined, { ...style, confidence: 0.75 }, (from) => `"${from}" is an overused expression; plain words read fresher.`, { 'going forward': adverbialGoingForward }),
    ...compile(EGGCORNS, 'confusable_word', 'confusable_word.phrase', { severity: 'error', autoApplySafe: true, confidence: 0.95 }, (_from, to) => `The expression is "${to}".`),
    ...compile(EXTRA_WORDS, 'extra_word', undefined, { severity: 'error', autoApplySafe: true, confidence: 0.9 }, (from, to) => `"${to}" already says it; drop the extra word in "${from}".`),
    ...compile(MISSING_WORDS, 'missing_word', undefined, { severity: 'error', autoApplySafe: true, confidence: 0.9 }, (_from, to) => `"Explain" takes "to" before the person: "${to}".`),
  ];
  const root: TrieNode = { next: new Map() };
  for (const e of entries) {
    let node = root;
    e.words.forEach((word, k) => {
      const key = k === 0 ? word : `${e.gaps[k]}:${word}`;
      let child = node.next.get(key);
      if (child === undefined) {
        child = { next: new Map() };
        node.next.set(key, child);
      }
      node = child;
    });
    node.entry ??= e;
  }
  return root;
}

export function phraseRule(ctx: RuleContext): void {
  const ts = tokensOf(ctx);
  const list = ts.list;
  const root = (trie ??= buildTrie());
  const muted = new Set(ctx.opts.mutedRules);
  const codeField = ctx.opts.context === 'code';
  for (let i = 0; i < list.length; i++) {
    const first = list[i] as Token;
    let node = root.next.get(first.norm);
    if (node === undefined) continue;
    let best: PhraseEntry | undefined = node.entry;
    let bestEnd = i;
    for (let j = i + 1; j < list.length && node !== undefined; j++) {
      const gap = ts.gap[j] ?? 0;
      if (gap !== GAP_SPACE && gap !== GAP_HYPHEN) break;
      node = node.next.get(`${gap}:${(list[j] as Token).norm}`);
      if (node?.entry !== undefined) {
        best = node.entry;
        bestEnd = j;
      }
    }
    if (best === undefined || muted.has(best.rule)) continue;
    const last = list[bestEnd] as Token;
    const style = RULE_CATEGORIES[best.rule] !== undefined;
    if (style && (codeField || inQuotes(ts, first.start, last.end))) continue;
    if (ts.gap[bestEnd + 1] === GAP_HYPHEN || (i > 0 && ts.gap[i] === GAP_HYPHEN)) continue; // part of a longer compound
    if (best.guard !== undefined && !best.guard(ctx, ts, bestEnd)) continue;
    if (ctx.protectedTerms.has(ctx.text.slice(first.start, last.end).toLowerCase())) continue;
    let start = first.start;
    let end = last.end;
    let replacement = best.replacement.replace(/\{(\d+)\}/g, (_m, k: string) => list[i + Number(k)]?.text ?? '');
    const capital = isUpper(first.text.charAt(0)) && !/^\{\d+\}/.test(best.replacement);
    if (replacement === '') {
      if (ctx.isSentenceStart(start, true) || ctx.work.charAt(end) !== ' ') continue;
      end += 1; // take the following space with the deleted phrase
    } else if (capital) {
      replacement = casePreserve(replacement, first.text.charAt(0) + 'x');
    }
    if (replacement !== '' && best.rule !== 'confusable_word') {
      const widened = withArticle(ts, i, start, replacement);
      start = widened.start;
      replacement = widened.replacement;
    }
    ctx.emit({
      rule: best.rule,
      key: best.key,
      severity: best.severity,
      kind: replacement === '' ? 'delete' : 'replace',
      start,
      end,
      replacement,
      explanation: best.explanation,
      confidence: best.confidence,
      autoApplySafe: best.autoApplySafe,
    });
    i = bestEnd;
  }
}
