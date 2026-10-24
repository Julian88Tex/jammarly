/**
 * Rule `hyphen_dash`: compound modifiers before a noun take hyphens ("a follow up meeting" -> "follow-up meeting",
 * "a well known author", "a 30 minute call", "a 5 year old"), and a few compounds are always hyphenated
 * ("time consuming", "user friendly", "so called"). A compound used after the noun or as an adverb is left alone
 * ("we met face to face", "in the long term", "the author is well known").
 */
import type { RuleContext } from './context';
import type { Token, TokenStream } from './tokens';
import { DIGITS_RE, GAP_HYPHEN, lookaheadUnfinished, looksLikeCode, nextSpaced, prevSpaced, tokensOf } from './tokens';

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter((w) => w.length > 0));

/** Words that cannot be the noun a compound modifier attaches to. */
const NOT_NOUN = set(
  `a an the and or but nor so yet for of in on at to from with by about as into onto over under after before since until
   while if when than then that this these those which who whom whose what where why how i you he she it we they me him
   her us them my your his its our their is are was were be been being am have has had do does did will would can could
   should may might must shall not no yes too also very really just only even still already again now here there today
   tomorrow yesterday tonight soon later ago instead anyway though although because please thanks etc all some any every
   each more most less many much few both either neither own such same other another next last first ok okay well up down
   out off around through during without within across along against among between beyond toward towards upon via per like
   unlike plus versus vs ever never always sometimes often usually lol is isn't aren't wasn't weren't don't doesn't didn't`,
);

interface CompoundEntry {
  words: string[];
  always: boolean;
  /** Skip after "the" (ambiguous: "the first time customers visit"). */
  noThe?: boolean;
}

const ATTRIBUTIVE = [
  'long term', 'short term', 'full time', 'part time', 'high quality', 'low quality', 'high level', 'low level', 'real time',
  'full scale', 'large scale', 'small scale', 'high risk', 'low risk', 'long distance', 'open source', 'third party',
  'best case', 'worst case', 'data driven', 'cross functional', 'fast paced', 'high performing', 'world class',
  'state of the art', 'up to date', 'end to end', 'one on one', 'face to face', 'day to day', 'long lasting', 'high profile',
  'high end', 'low end', 'high speed', 'long standing', 'mid size', 'full length', 'hands on', 'in depth', 'in person',
  'on site', 'off site', 'all day', 'year end', 'sign up', 'two way', 'last ditch', 'old school', 'high tech', 'low cost',
  'high value', 'high impact', 'high priority', 'low priority', 'decision making', 'short lived',
].map((p): CompoundEntry => ({ words: p.split(' '), always: false }));
const AMBIGUOUS_AFTER_THE = ['first time', 'one time', 'last minute'].map((p): CompoundEntry => ({ words: p.split(' '), always: false, noThe: true }));
const ALWAYS = ['time consuming', 'user friendly', 'old fashioned', 'so called', 'self employed', 'open minded', 'top notch', 'follow up']
  .map((p): CompoundEntry => ({ words: p.split(' '), always: true }));

const BY_FIRST = new Map<string, CompoundEntry[]>();
for (const e of [...ATTRIBUTIVE, ...AMBIGUOUS_AFTER_THE, ...ALWAYS]) {
  const k = e.words[0] as string;
  const list = BY_FIRST.get(k) ?? [];
  list.push(e);
  list.sort((a, b) => b.words.length - a.words.length);
  BY_FIRST.set(k, list);
}

const DETERMINERS = set('a an the this that these those our my your their his her its some any every such another quick brief short friendly no each');
const WELL_PARTICIPLES = set('known written designed documented established respected educated organized organised deserved paid funded maintained defined rounded thought received crafted executed planned prepared researched structured');
const TIME_CONSUMING_BLOCKERS = set('spend spent spending waste wasted wasting more less much some no any');
const FOLLOW_UP_AFTER = set('on about with from to for regarding');
const UNITS = set('second minute hour day week month year page step person mile foot inch dollar point star game part night');
const NUMBER_WORDS = set('one two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty sixty ninety hundred');
const PREPOSITIONS = set('in at for over on by during within');

/** Head nouns a compound modifier commonly attaches to (plurals and -ing nouns must come from this list). */
const HEAD_NOUNS = set(
  `plan plans goal goals job jobs role roles position positions employee employees staff work service services product
   products solution solutions data meeting meetings call calls update updates view overview summary approach strategy
   strategies project projects process processes support contract contracts vendor vendors provider providers tool tools
   app apps software code library libraries integration integrations change changes decision decisions communication
   collaboration conversation conversations discussion discussions feedback analysis report reports information numbers
   number version versions documentation result results testing team teams company companies partner partners customer
   customers user users client clients experience experiences issue issues risk risks investment investments growth success
   relationship relationships care basis schedule hours salary opportunity opportunities event events training session
   sessions interview interviews visit visits access cookies content platform platforms system systems monitoring
   processing delivery shipping notice request requests task tasks deadline deadlines price prices pricing fix fixes help
   option options effect effects impact cost costs budget budgets review reviews assessment assessments survey surveys
   question questions email emails message messages note notes item items step steps list lists form forms page pages
   site sites website websites dashboard dashboards feature features component components module modules package packages
   project vision mission thinking planning tracking hosting funding financing marketing consulting accounting reporting
   staffing scheduling buyer buyers seller sellers owner owners worker workers contractor contractors student students
   member members fee fees payment payments plan program programs course courses class classes workshop workshops demo demos
   check checks commitment commitments agreement agreements deal deals partnership partnerships investor investors manager
   managers developer developers designer designers engineer engineers lead leads hire hires candidate candidates call
   walk break trip drive flight stay rental subscription trial license warranty guarantee loan mortgage lease contract
   car vehicle house home device devices machine machines server servers network networks database databases account
   accounts project ecosystem community software framework frameworks library tool video videos photo photos image images
   camera cameras display monitor printer phone phones laptop laptops computer computers chip chips storage memory battery`,
);
const ADJECTIVE_SUFFIX_RE = /(?:able|ible|ful|ous|less|ish|ive|ic|al|ant|ent|ary)$/;
const VERBISH = set(
  'said made took gave got went came sent paid told left kept brought bought thought found held ran saw knew wrote put set let cut hit met need want make get go take give say see know think come help provide offer use require agree decide pay send keep hold run show try ask seem feel become leave call tell find mean own retain grant receive include apply',
);

function nounFollows(ts: TokenStream, last: number): Token | undefined {
  const nx = nextSpaced(ts, last);
  if (nx === undefined || nx.text !== nx.norm || !/^\p{L}+$/u.test(nx.text) || ts.gap[last + 2] === GAP_HYPHEN) return undefined;
  const w = nx.norm;
  if (HEAD_NOUNS.has(w)) return nx;
  if (NOT_NOUN.has(w) || VERBISH.has(w) || /(?:ly|ed|ing|s)$/.test(w) || ADJECTIVE_SUFFIX_RE.test(w) || w.length < 3) return undefined;
  return nx;
}

export function compoundRule(ctx: RuleContext): void {
  const ts = tokensOf(ctx);
  const list = ts.list;
  const emit = (first: Token, last: Token, replacement: string, lookEnd: number, explanation: string): void => {
    if (lookaheadUnfinished(ctx, lookEnd)) return;
    ctx.emit({ rule: 'hyphen_dash', severity: 'warning', kind: 'replace', start: first.start, end: last.end, replacement, explanation, confidence: 0.85, autoApplySafe: true });
  };
  for (let i = 0; i < list.length; i++) {
    const t = list[i] as Token;
    if (ts.gap[i] === GAP_HYPHEN) continue;
    const prev = prevSpaced(ts, i);

    // Number + singular unit + noun: "a 30 minute call", "a two week trip", "a 5 year old".
    const c0 = t.text.charCodeAt(0);
    if ((c0 >= 48 && c0 <= 57 && t.text.length <= 4 && DIGITS_RE.test(t.text)) || NUMBER_WORDS.has(t.norm)) {
      const unit = nextSpaced(ts, i);
      if (unit === undefined || !UNITS.has(unit.norm) || ts.gap[i + 2] === GAP_HYPHEN) continue;
      const before = ctx.work.charAt(t.start - 1);
      if (before === '.' || before === ':' || before === ',' || before === '-' || before === '/') continue;
      const old = nextSpaced(ts, i + 1);
      if (old !== undefined && old.norm === 'old' && (unit.norm === 'year' || unit.norm === 'month' || unit.norm === 'week' || unit.norm === 'day')) {
        if (ts.gap[i + 3] === GAP_HYPHEN) continue;
        emit(t, old, `${t.text}-${unit.text}-${old.text}`, old.end + 1, 'An age used as a modifier or a noun is hyphenated.');
        i += 2;
        continue;
      }
      const noun = nounFollows(ts, i + 1);
      if (noun === undefined || (t.norm === 'one' && prev?.norm !== 'a' && prev?.norm !== 'the')) continue;
      emit(t, unit, `${t.text}-${unit.text}`, noun.end, 'A number and a unit that describe a noun are joined with a hyphen.');
      i += 1;
      continue;
    }

    // "a well known author"
    if (t.norm === 'well') {
      const part = nextSpaced(ts, i);
      if (part === undefined || !WELL_PARTICIPLES.has(part.norm) || prev === undefined || !DETERMINERS.has(prev.norm)) continue;
      const noun = nounFollows(ts, i + 1);
      if (noun === undefined) continue;
      emit(t, part, `${t.text}-${part.text}`, noun.end, `"${t.text}-${part.text}" before a noun takes a hyphen.`);
      i += 1;
      continue;
    }

    const entries = BY_FIRST.get(t.norm);
    if (entries === undefined) continue;
    for (const e of entries) {
      let k = i;
      let ok = true;
      for (let p = 1; p < e.words.length; p++) {
        const nx = nextSpaced(ts, k);
        if (nx === undefined || nx.norm !== e.words[p]) { ok = false; break; }
        k++;
      }
      if (!ok) continue;
      const last = list[k] as Token;
      if (ts.gap[k + 1] === GAP_HYPHEN || looksLikeCode(ctx, t)) break;
      const words = list.slice(i, k + 1).map((x) => x.text);
      const replacement = words.join('-');
      const display = e.words.join('-');
      if (e.words[0] === 'follow') {
        // noun "a follow up", "the follow up email"; the verb "I'll follow up with" stays two words
        if (prev === undefined || !DETERMINERS.has(prev.norm)) break;
        const nx = nextSpaced(ts, k);
        if (nx !== undefined && nounFollows(ts, k) === undefined && !FOLLOW_UP_AFTER.has(nx.norm)) break;
        emit(t, last, replacement, nx?.end ?? last.end + 1, 'As a noun or a modifier, "follow-up" takes a hyphen.');
      } else if (e.always) {
        if (e.words[0] === 'time' && prev !== undefined && TIME_CONSUMING_BLOCKERS.has(prev.norm)) break;
        emit(t, last, replacement, last.end + 1, `"${display}" is written with a hyphen.`);
      } else {
        const noun = nounFollows(ts, k);
        if (noun === undefined) break;
        if (e.noThe && prev?.norm === 'the') break;
        const prev2 = prev === undefined ? undefined : prevSpaced(ts, i - 1);
        if (prev?.norm === 'the' && prev2 !== undefined && PREPOSITIONS.has(prev2.norm)) break; // "in the long term growth" is ambiguous
        emit(t, last, replacement, noun.end, `"${display}" describes the noun after it, so it takes hyphens.`);
      }
      i = k;
      break;
    }
  }
}
