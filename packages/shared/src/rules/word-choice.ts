/**
 * Word-level grammar patterns Grammarly flags in everyday email, each anchored on a closed word list on both sides so
 * it stays high-precision:
 *
 *  - `confusable_word`: its/it's, your/you're, their/there/they're, then/than, lose/loose, affect/effect, less/fewer,
 *    amount/number, everyday, awhile, advise/advice, whose/who's, to/too, past/passed, lead/led, breath/breathe,
 *    maybe/may be, use to/suppose to, "Were going" at a sentence start, and phrasal verbs written as one word
 *    ("I'll setup a call").
 *  - `verb_form`: modal + "of"/"have" + simple past ("could of came", "should have went"), did/does/modal + past or
 *    third-person form ("didn't went", "can goes"), "look forward to" + base verb.
 *  - `subject_verb_agreement`: "we was", "he don't", "they doesn't", "they has", "there is many".
 *  - `pronoun_case`: preposition + "X and I" ("between you and I"), "Me and John went", "contact John or myself".
 *  - `noun_number`: "if you have any question", "several option".
 *
 * Every check reads the words after its anchor, so while typing a check whose decision reaches into the word in
 * progress is skipped (lookaheadUnfinished).
 */
import type { RuleContext } from './context';
import { isUpper } from './context';
import { dict } from './dict';
import type { Token } from './tokens';
import { DIGITS_RE, GAP_HYPHEN, GAP_SPACE, LOWER_WORD_RE, LY_RE, apostropheOf, casePreserve, isAllCaps, lookaheadUnfinished, looksLikeCode, nextSpaced, prevSpaced, tokensOf, withApostrophe } from './tokens';

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter((w) => w.length > 0));

/** Characters that end a clause right after a word (the word is the last one before punctuation or a line end). */
const CLAUSE_END_RE = /[.!?,;:)\]}"”’…\n\r]/;

function clauseEndAfter(ctx: RuleContext, end: number): boolean {
  let k = end;
  const w = ctx.work;
  while (k < w.length && (w.charCodeAt(k) === 32 || w.charCodeAt(k) === 0xa0)) k++;
  if (k >= w.length) return !ctx.opts.typing;
  return CLAUSE_END_RE.test(w.charAt(k));
}

const OBJECT_WORDS = set('the a an my your our their his her its this that these those it them me us him some any');

// its / it's ---------------------------------------------------------------------------------------------------------
const ITS_ALWAYS = set(
  'a an the not been going gonna getting really just still also always never probably definitely actually already about like my your our their his her me him us them you what who how when where why because too here there now ok okay on in at up all',
);
const ITS_PRED = set(
  'fine true great good nice cool important possible impossible hard easy difficult likely unlikely necessary crazy weird funny late early done over raining ready free open closed broken working due finished perfect amazing awesome clear obvious unclear urgent critical interesting strange odd normal fair right wrong correct expensive cheap cold hot sunny worth frustrating annoying confusing exciting disappointing surprising boring happening worrying',
);
const PRED_FOLLOWERS = set('to that for if when because but and now so though anyway it the a checking trying noting considering asking');
const IT_IS_FOLLOW = set(
  `a an the not been being going gonna really very so too just still also always never only probably definitely actually
   already all about like my your our their his her me him us them you what who how when where why because here there now
   ok okay time fine true great good nice important possible hard easy done over worth i we they he she it this that`,
);
const PREPOSITIONS_BEFORE_ITS = set('of on in at for from with by into onto about under over through within across toward towards throughout upon behind beyond');

// your / you're ------------------------------------------------------------------------------------------------------
const YOUR_ALWAYS = set('a an the not going gonna getting kidding joking always never probably definitely still absolutely totally');
/** "your doing well" -> "you're": only before words that cannot start the object of a possessive gerund. */
const YOUR_DOING_NEXT = set('well great good ok okay fine alright amazing awesome a an the this that it everything something nothing anything really very better');
const YOURE_PREPS = set('for to with of about on in at from by into');
const YOUR_PRED = set(
  'right wrong correct sure aware able welcome invited free late done ready amazing awesome great brilliant kind lucky crazy interested available busy happy satisfied familiar eligible comfortable unable unsure responsible allowed supposed expected',
);
const YOUR_PRED_FOLLOWERS = set('to that about with for tomorrow today tonight now later this next on at then anytime in of');
/** Nouns that only "your" can precede: "ship you're order" -> "your order". */
const YOUR_NOUNS = set(
  'order email message account team help feedback time question request input support response reply call ideas comments thoughts name password address phone invoice payment report document file application profile company business manager boss family birthday car house schedule availability consideration patience understanding cooperation attention interest orders emails messages questions',
);
const INTENSIFIERS = set('so very really too super extremely quite');

// their / there / they're --------------------------------------------------------------------------------------------
const THEIR_THERE = set("is are was were isn't aren't wasn't weren't");
const THEIR_THEYRE = set('going gonna not a an the always never');
const THEIR_NOUN_VERBS = set("is are was were has have will isn't aren't wasn't weren't doesn't don't won't");
const THEIR_PREV = set('but and because so with for about of to on in at from by like love use check see that since although though while');
const NOT_A_NOUN_AFTER_THERE = set(
  `also still now always often never ever already just only even simply usually certainly anything anyone something someone
   nothing nobody everything everyone one more less much many enough none really probably definitely clearly obviously
   actually again too here soon sometimes perhaps maybe indeed thus therefore however meanwhile eventually finally suddenly
   apparently overall otherwise else you they she him her them his its our your their this that these those what who which
   are was were will has have had`,
);

// then / than --------------------------------------------------------------------------------------------------------
const COMPARATIVES = set(
  'more less better worse fewer bigger larger smaller greater higher lower faster slower easier harder older younger cheaper longer shorter earlier sooner stronger weaker rather different',
);
const THAN_OBJECTS = set(
  `a an the i you he she we they it me him her us them that this those these ever before expected usual last any anyone
   anything anybody most some my your our their his its one two three four five six seven eight nine ten twenty hundred
   thousand half twice normal planned anticipated originally previously average yesterday today required necessary needed
   what we're you're they're i'm it's that's enough`,
);
const THAN_TO_THEN_PREV = set('and since until till by back from');

// lose / loose -------------------------------------------------------------------------------------------------------
const LOSE_PREV = set("to will would could should might may can cannot not never gonna don't didn't won't doesn't i we you they");
const LOSE_OBJECTS = set(
  'weight money track sight interest time touch focus hope faith patience control it my your his her our their the this that everything anything any all more them him me you us sleep data customers clients power access momentum steam heart contact ground',
);

// affect / effect ----------------------------------------------------------------------------------------------------
const EFFECT_PREV = set('a an the any no positive negative big huge major minor significant adverse side ripple little great real direct overall lasting');
const AFFECT_PREV = set("will would could can may might should must to not doesn't don't didn't won't also directly negatively positively greatly seriously");
const AFFECT_OBJECTS = set('me you him her us them my your our their his how whether anyone everyone people');

// simple past forms ----------------------------------------------------------------------------------------------------
const PAST_TO_PARTICIPLE = dict<string>({
  came: 'come', went: 'gone', did: 'done', ate: 'eaten', took: 'taken', gave: 'given', wrote: 'written', spoke: 'spoken',
  broke: 'broken', chose: 'chosen', drove: 'driven', knew: 'known', began: 'begun', drank: 'drunk', ran: 'run', swam: 'swum',
  flew: 'flown', grew: 'grown', threw: 'thrown', rode: 'ridden', rose: 'risen', forgot: 'forgotten', fell: 'fallen',
  hid: 'hidden', shook: 'shaken', stole: 'stolen', woke: 'woken', wore: 'worn', tore: 'torn', sang: 'sung', rang: 'rung',
  sank: 'sunk', became: 'become', drew: 'drawn', mistook: 'mistaken', overtook: 'overtaken', undertook: 'undertaken',
  withdrew: 'withdrawn', forgave: 'forgiven', froze: 'frozen', blew: 'blown',
});
const PAST_TO_BASE = dict<string>({
  went: 'go', came: 'come', saw: 'see', knew: 'know', took: 'take', gave: 'give', got: 'get', made: 'make', said: 'say',
  told: 'tell', thought: 'think', left: 'leave', felt: 'feel', brought: 'bring', bought: 'buy', wrote: 'write', ran: 'run',
  ate: 'eat', sent: 'send', heard: 'hear', kept: 'keep', began: 'begin', forgot: 'forget', understood: 'understand',
  received: 'receive', wanted: 'want', needed: 'need', liked: 'like', worked: 'work', called: 'call', asked: 'ask',
  started: 'start', finished: 'finish', looked: 'look', helped: 'help', changed: 'change', decided: 'decide',
  agreed: 'agree', replied: 'reply', responded: 'respond', mentioned: 'mention', attended: 'attend', completed: 'complete',
  checked: 'check', noticed: 'notice', realized: 'realize', expected: 'expect', arrived: 'arrive', happened: 'happen',
  showed: 'show', tried: 'try', seemed: 'seem', spoke: 'speak', met: 'meet', paid: 'pay', sold: 'sell', won: 'win',
  lost: 'lose', chose: 'choose', broke: 'break', did: 'do', had: 'have', explained: 'explain', shared: 'share',
  confirmed: 'confirm', approved: 'approve', reviewed: 'review', signed: 'sign', updated: 'update', fixed: 'fix',
});
const THIRD_TO_BASE = dict<string>({
  goes: 'go', does: 'do', has: 'have', makes: 'make', sends: 'send', gets: 'get', takes: 'take', needs: 'need', wants: 'want',
  works: 'work', comes: 'come', says: 'say', knows: 'know', sees: 'see', gives: 'give', looks: 'look', helps: 'help',
  starts: 'start', tries: 'try', uses: 'use', calls: 'call', asks: 'ask', seems: 'seem', thinks: 'think', likes: 'like',
  means: 'mean', matters: 'matter', happens: 'happen', applies: 'apply', agrees: 'agree', includes: 'include',
  requires: 'require', allows: 'allow', supports: 'support', provides: 'provide', affects: 'affect', exists: 'exist',
  runs: 'run', becomes: 'become', feels: 'feel', keeps: 'keep', leaves: 'leave', pays: 'pay', reads: 'read',
  understands: 'understand', wins: 'win', writes: 'write', finishes: 'finish', fixes: 'fix', depends: 'depend',
});
const MODALS = set('can could will would should must might may shall');
const NOUN_DETERMINERS = set('the a an his her their my your our its free good ill own political last this that');
const LOOK_FORWARD = dict<string>({
  hear: 'hearing', see: 'seeing', meet: 'meeting', work: 'working', speak: 'speaking', talk: 'talking', connect: 'connecting',
  receive: 'receiving', chat: 'chatting', get: 'getting', catch: 'catching', discuss: 'discussing', join: 'joining',
  welcome: 'welcoming', visit: 'visiting', read: 'reading', start: 'starting', help: 'helping', review: 'reviewing',
  continue: 'continuing', learn: 'learning', attend: 'attending', partner: 'partnering', have: 'having', collaborate: 'collaborating',
  hearing: 'hearing', reconnect: 'reconnecting', celebrate: 'celebrating', share: 'sharing', build: 'building', be: 'being',
  speaking: 'speaking', grow: 'growing', support: 'supporting', explore: 'exploring', move: 'moving', make: 'making',
});

// plural count nouns (less/fewer, amount/number) --------------------------------------------------------------------
const COUNT_PLURALS = set(
  `people items things mistakes errors issues problems options words emails calls meetings questions choices cars books
   students employees users customers members tasks steps bugs files pages changes features cases jobs deaths injuries
   accidents complaints requests tickets visitors clicks calories products orders applications candidates participants
   messages documents reports projects resources hours days weeks months years minutes times`,
);

// subject-verb agreement ---------------------------------------------------------------------------------------------
const PLURAL_QUANTIFIERS = set('many several two three four five six seven eight nine ten eleven twelve numerous multiple various few');
const THERE_IS_ADVERBS = set('still also only just now currently always already');

// pronoun case -------------------------------------------------------------------------------------------------------
const CASE_PREPS = set('between for with to from about among against without toward towards behind beside of at by');
const AFTER_OBJECT_I = set('to for on in at about with today tomorrow yesterday both alone too as only again here there now then later soon');
const SUBJECT_FOR_OBJECT = dict<string>({ him: 'he', her: 'she', them: 'they' });
const VERBS_AFTER_ME_AND = set('are were was will went have had can could should would did do met talked discussed agreed decided need want plan love like think worked spoke spent got');

// noun number --------------------------------------------------------------------------------------------------------
const ANY_SINGULAR = dict<string>({ question: 'questions', concern: 'concerns', issue: 'issues', problem: 'problems', comment: 'comments', suggestion: 'suggestions' });
const ANY_FOLLOWERS = set('or please feel let regarding about on and');
const SINGULAR_TO_PLURAL = dict<string>({
  question: 'questions', option: 'options', issue: 'issues', problem: 'problems', thing: 'things', day: 'days',
  week: 'weeks', month: 'months', year: 'years', email: 'emails', meeting: 'meetings', file: 'files', document: 'documents',
  reason: 'reasons', idea: 'ideas', change: 'changes', step: 'steps', item: 'items', way: 'ways', member: 'members',
  customer: 'customers', user: 'users', client: 'clients', student: 'students', employee: 'employees', friend: 'friends',
  project: 'projects', task: 'tasks', update: 'updates', comment: 'comments', suggestion: 'suggestions', example: 'examples',
  mistake: 'mistakes', error: 'errors', person: 'people', child: 'children', hour: 'hours', minute: 'minutes', call: 'calls',
  request: 'requests', message: 'messages', version: 'versions', feature: 'features', page: 'pages', report: 'reports',
  account: 'accounts', product: 'products', source: 'sources', detail: 'details', time: 'times',
});
const MANY_WORDS = set('many several multiple numerous various');
const AFTER_PLURAL_OK = set(
  `and or but that which who to for in on at of from with about are were have had will would can could should we i you
   they he she it ago later now before after since so because if when while as than already again too here there today
   tomorrow yesterday`,
);

// misc -----------------------------------------------------------------------------------------------------------------
const EVERYDAY_FOLLOWERS = set(
  'at in for from to and until this of with but so or because since when while i we you they he she it after before during except now again lately last next',
);
const AWHILE_PREV = set('for in after quite');
const COMPOUND_VERBS = dict<string>({
  setup: 'set up', login: 'log in', logout: 'log out', checkout: 'check out', followup: 'follow up', backup: 'back up',
  workout: 'work out', signup: 'sign up', shutdown: 'shut down', pickup: 'pick up', cleanup: 'clean up', lookup: 'look up',
  rollout: 'roll out', handoff: 'hand off', breakdown: 'break down', sendout: 'send out', handout: 'hand out',
});
const COMPOUND_VERB_PREV = set("to will can could should would must might may please let's don't didn't won't can't cannot we i you they");
const COMPOUND_VERB_NEXT = set('the a an my your our their his her its this that these those it them me us him some everything with for on to again now today tomorrow soon later here');
const ADVISE_PREV = set('please kindly would could can to i we');
const ADVISE_NEXT = set('me us you him her them on if whether how what when');
const ADVICE_PREV = set('the your some any good great my his her our their for of legal expert helpful much sound professional');
const ADVICE_NEXT = set('on about from and');
const WHOSE_NEXT = set('going coming gonna been available free responsible ready interested joining attending leading a an the not in on up there here calling');
const WHOS_NOUNS = set('turn car idea fault responsibility job name book phone laptop bag house team account side call decision birthday');
const TOO_PREV = set("is was are were it's that's be been got get feel feels felt seems looks sounds getting it’s");
const TOO_ADJ = set('much many late early soon big small hard expensive far high low good bad young old cold hot complicated difficult risky');
const TOO_AFTER = set('for to and but so at in of right now already though anyway');
const PASSED_NOUNS = set('week month year few couple weeks months years days decade');
const PASSED_NEXT = set('away the a an my your our their his her its by through');
const LED_NEXT = set('to the us them me him her a an our my');
const MAYBE_PREV = set('it this that there he she they we you i which who these those');
const MAYBE_NEXT = set(
  'a an the too possible better best late necessary helpful useful able worth wise good easier difficult hard due related ready done available right wrong true missing delayed closed busy interested more less some',
);
const SUPPOSE_PREV = set("am is are was were be been i'm you're we're they're he's she's it's");
const USE_TO_PREV = set('i we they you he she');
const CLAUSE_LINKS = set('and but so because since when as where if though although');
const WERE_NEXT = set('going gonna looking working planning happy excited glad thrilled pleased');
const WEATHER_PREV = set('decide decided deciding know knew sure wonder wondering wondered ask asked asking see check checking determine unclear unsure clarify confirm about of regardless');
const WEATHER_NEXT = set('we you they it i he she to there this that the or anyone someone our your their my');

/** Every word the switch below has a case for (a Set lookup is cheaper than walking the cases). */
const SWITCH_WORDS = set(`advice advise affect affects amount any are awhile breath breathe did didn't does doesn't don't effect effects everyday forward had has have i is it's its less loose loosing maybe me myself of passed suppose than their then there there's they're to use was weather were who's whose you're your`);

export function wordChoiceRule(ctx: RuleContext): void {
  const ts = tokensOf(ctx);
  const list = ts.list;
  const n = list.length;
  let apos: string | null = null;
  const aposOf = (): string => (apos ??= apostropheOf(ctx));
  /** A subject pronoun that is part of a compound subject ("John and he are") or of "thank you" is not checked. */
  const compoundSubject = (k: number): boolean => {
    const before = prevSpaced(ts, k);
    return before !== undefined && (before.norm === 'and' || before.norm === 'or' || before.norm === 'nor' || before.norm === 'thank');
  };

  const emit = (rule: string, key: string | undefined, t0: Token, t1: Token, replacement: string, explanation: string, confidence: number, autoApplySafe: boolean, lookEnd: number): void => {
    if (lookaheadUnfinished(ctx, lookEnd)) return;
    if (ctx.protectedTerms.has(t0.norm)) return;
    ctx.emit({ rule, key, severity: autoApplySafe ? 'error' : 'warning', kind: 'replace', start: t0.start, end: t1.end, replacement, explanation, confidence, autoApplySafe });
  };
  /**
   * "have" at i is the auxiliary of the next verb: after a modal ("could have came") or after a subject pronoun that
   * opens its clause ("We have went"). Not after a relative clause: "Everything we had went to charity".
   */
  const auxiliaryHave = (k: number): boolean => {
    const pv = prevSpaced(ts, k);
    if (pv === undefined) return false;
    if (MODALS.has(pv.norm) || /^(?:i|we|you|they|he|she|it)'d$/.test(pv.norm)) return true;
    if (!/^(?:i|we|you|they|he|she|it)$/.test(pv.norm)) return false;
    const before = prevSpaced(ts, k - 1);
    return before === undefined ? ctx.isSentenceStart(pv.start, true) || ts.gap[k - 1] !== GAP_SPACE : CLAUSE_LINKS.has(before.norm);
  };
  /** Next spaced token that is not glued to a hyphen compound ("so-called"). */
  const nextWord = (i: number): Token | undefined => {
    const t = nextSpaced(ts, i);
    if (t === undefined || ts.gap[i + 2] === GAP_HYPHEN) return undefined;
    return t;
  };

  for (let i = 0; i < n; i++) {
    const t = list[i] as Token;
    const w = t.norm;
    if (w.length > 11 || !(SWITCH_WORDS.has(w) || MODALS.has(w) || MANY_WORDS.has(w) || COMPOUND_VERBS.has(w))) continue;
    switch (w) {
      case 'its': {
        const nx = nextWord(i);
        if (nx === undefined || looksLikeCode(ctx, t)) break;
        const n2 = nextSpaced(ts, i + 1);
        let ok = ITS_ALWAYS.has(nx.norm);
        if (!ok && ITS_PRED.has(nx.norm)) ok = clauseEndAfter(ctx, nx.end) || (n2 !== undefined && PRED_FOLLOWERS.has(n2.norm));
        if (!ok && nx.norm === 'time') ok = n2 !== undefined && (n2.norm === 'to' || n2.norm === 'for');
        if (ok) emit('confusable_word', 'confusable_word.its', t, t, withApostrophe(casePreserve("it's", t.text), aposOf()), '"It\'s" means "it is"; "its" shows possession.', 0.9, true, n2?.end ?? nx.end);
        break;
      }
      case "it's": {
        const nx = nextWord(i);
        if (nx === undefined) break;
        const pv = prevSpaced(ts, i);
        const own = nx.norm === 'own';
        const afterPrep = pv !== undefined && PREPOSITIONS_BEFORE_ITS.has(pv.norm) && LOWER_WORD_RE.test(nx.text) && !IT_IS_FOLLOW.has(nx.norm);
        if (own || afterPrep) emit('confusable_word', 'confusable_word.its', t, t, casePreserve('its', t.text), '"Its" shows possession; "it\'s" means "it is".', own ? 0.95 : 0.85, own, nx.end);
        break;
      }
      case 'your': {
        const nx = nextWord(i);
        if (nx === undefined) break;
        let ok = YOUR_ALWAYS.has(nx.norm) || (nx.norm === 'doing' && YOUR_DOING_NEXT.has(nextSpaced(ts, i + 1)?.norm ?? ''));
        if (!ok && YOUR_PRED.has(nx.norm)) {
          const n2 = nextSpaced(ts, i + 1);
          ok = clauseEndAfter(ctx, nx.end) || (n2 !== undefined && YOUR_PRED_FOLLOWERS.has(n2.norm));
          // "welcome" is also a noun ("I appreciate your welcome."): only "your welcome to ..." is certain here;
          // a sentence-initial "Your welcome." is owned by the your_welcome check in confusable.ts.
          if (nx.norm === 'welcome') ok = n2 !== undefined && n2.norm === 'to';
        }
        let lookEnd = nx.end;
        if (!ok && INTENSIFIERS.has(nx.norm)) {
          const n2 = nextSpaced(ts, i + 1);
          if (n2 !== undefined && LOWER_WORD_RE.test(n2.text) && ts.gap[i + 3] !== GAP_HYPHEN && clauseEndAfter(ctx, n2.end) && !n2.norm.endsWith('ly')) {
            ok = n2.norm !== 'own' && n2.norm !== 'much' && n2.norm !== 'many';
            lookEnd = n2.end;
          }
        }
        if (ok) emit('confusable_word', 'confusable_word.your', t, t, withApostrophe(casePreserve("you're", t.text), aposOf()), '"You\'re" means "you are"; "your" shows possession.', 0.9, true, lookEnd);
        break;
      }
      case "you're": {
        const nx = nextWord(i);
        if (nx === undefined) break;
        const pv = prevSpaced(ts, i);
        // "you're own", "for you're quick reply", "to you're team"
        const afterPrep = pv !== undefined && YOURE_PREPS.has(pv.norm) && LOWER_WORD_RE.test(nx.text) && !IT_IS_FOLLOW.has(nx.norm) && !/(?:ing|ed)$/.test(nx.norm);
        if (nx.norm === 'own' || afterPrep || (YOUR_NOUNS.has(nx.norm) && nx.text === nx.norm)) emit('confusable_word', 'confusable_word.your', t, t, casePreserve('your', t.text), '"Your" shows possession; "you\'re" means "you are".', nx.norm === 'own' ? 0.95 : 0.85, nx.norm === 'own', nx.end);
        break;
      }
      case 'their': {
        const nx = nextWord(i);
        if (nx === undefined) break;
        const n2 = nextSpaced(ts, i + 1);
        if (THEIR_THERE.has(nx.norm) || ((nx.norm === 'will' || nx.norm === 'has') && n2?.norm === (nx.norm === 'will' ? 'be' : 'been'))) {
          emit('confusable_word', 'confusable_word.their', t, t, casePreserve('there', t.text), '"There" points to a place or introduces a sentence; "their" shows possession.', 0.9, true, n2?.end ?? nx.end);
        } else if (THEIR_THEYRE.has(nx.norm)) {
          emit('confusable_word', 'confusable_word.their', t, t, withApostrophe(casePreserve("they're", t.text), aposOf()), '"They\'re" means "they are"; "their" shows possession.', 0.9, true, nx.end);
        }
        break;
      }
      case 'there':
      case "they're": {
        const nx = nextWord(i);
        if (nx === undefined) break;
        if (nx.norm === 'own') {
          emit('confusable_word', 'confusable_word.their', t, t, casePreserve('their', t.text), '"Their" shows possession.', 0.95, true, nx.end);
          break;
        }
        // "but there support is slow": there + noun + verb, after a word that cannot invert a "there is" question.
        const verb = nextSpaced(ts, i + 1);
        const pv = prevSpaced(ts, i);
        if (w !== 'there' || verb === undefined || !THEIR_NOUN_VERBS.has(verb.norm) || pv === undefined || !THEIR_PREV.has(pv.norm)) break;
        if (!/^\p{Ll}{3,}$/u.test(nx.text) || NOT_A_NOUN_AFTER_THERE.has(nx.norm) || LY_RE.test(nx.norm)) break;
        emit('confusable_word', 'confusable_word.their', t, t, 'their', '"Their" shows possession; "there" points to a place.', 0.85, false, verb.end);
        break;
      }
      case 'then': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || !COMPARATIVES.has(pv.norm)) break;
        if (!(THAN_OBJECTS.has(nx.norm) || /^\p{N}/u.test(nx.text) || (isUpper(nx.text.charAt(0)) && nx.norm !== 'i') || (pv.norm === 'sooner' && nx.norm === 'later'))) break;
        if (pv.norm === 'rather' || pv.norm === 'other') break; // owned by confusable.ts
        emit('confusable_word', 'confusable_word.then_than', t, t, casePreserve('than', t.text), 'Comparisons use "than"; "then" refers to time or sequence.', 0.85, false, nx.end);
        break;
      }
      case 'than': {
        const nx = nextSpaced(ts, i);
        if (nx === undefined) break;
        const pv = prevSpaced(ts, i);
        const start = ctx.isSentenceStart(t.start, true) && isUpper(t.text.charAt(0));
        if (start || (pv !== undefined && THAN_TO_THEN_PREV.has(pv.norm))) {
          emit('confusable_word', 'confusable_word.than_then', t, t, casePreserve('then', t.text), '"Then" refers to time or sequence; "than" is for comparisons.', 0.85, false, nx.end);
        }
        break;
      }
      case 'loose':
      case 'loosing': {
        const nx = nextSpaced(ts, i);
        if (nx === undefined || !LOSE_OBJECTS.has(nx.norm)) break;
        const pv = prevSpaced(ts, i);
        const ok = w === 'loosing' || (pv !== undefined && (LOSE_PREV.has(pv.norm) || pv.norm.endsWith("'ll")));
        if (ok) emit('confusable_word', undefined, t, t, casePreserve(w === 'loose' ? 'lose' : 'losing', t.text), '"Lose" means to misplace or fail to keep; "loose" means not tight.', 0.9, true, nx.end);
        break;
      }
      case 'affect':
      case 'affects': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined) break;
        const side = pv.norm === 'side' && w === 'affects';
        if ((EFFECT_PREV.has(pv.norm) && nx !== undefined && (nx.norm === 'on' || nx.norm === 'of')) || side) {
          emit('confusable_word', undefined, t, t, casePreserve(w === 'affect' ? 'effect' : 'effects', t.text), '"Effect" is the noun (a result); "affect" is the verb.', 0.9, true, nx?.end ?? t.end);
        }
        break;
      }
      case 'effect':
      case 'effects': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || !AFFECT_OBJECTS.has(nx.norm)) break;
        const verbPrev = w === 'effect' ? AFFECT_PREV.has(pv.norm) : pv.norm === 'it' || pv.norm === 'this' || pv.norm === 'that' || pv.norm === 'which';
        if (verbPrev) emit('confusable_word', undefined, t, t, casePreserve(w === 'effect' ? 'affect' : 'affects', t.text), '"Affect" is the verb (to influence); "effect" is the noun.', 0.85, false, nx.end);
        break;
      }
      case 'of': {
        // could/should/would/must/might of + simple past: "could of came" -> "could have come"
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || !/^(?:could|should|would|must|might)$/.test(pv.norm)) break;
        const part = PAST_TO_PARTICIPLE.get(nx.norm);
        if (part === undefined || part === nx.norm) break;
        emit('verb_form', undefined, t, nx, `${casePreserve('have', t.text)} ${part}`, `After "${pv.norm}" use "have ${part}", not "of ${nx.text}".`, 0.95, true, nx.end);
        break;
      }
      case 'have':
      case 'has':
      case 'had': {
        const nx = nextSpaced(ts, i);
        if (nx === undefined) break;
        const part = PAST_TO_PARTICIPLE.get(nx.norm);
        if (part !== undefined && part !== nx.norm && !looksLikeCode(ctx, nx) && auxiliaryHave(i)) {
          emit('verb_form', undefined, nx, nx, casePreserve(part, nx.text), `After "${t.norm}" use the past participle "${part}".`, 0.9, true, nx.end);
          break;
        }
        if (nx.norm === 'lead') {
          const n2 = nextSpaced(ts, i + 1);
          if (n2 !== undefined && LED_NEXT.has(n2.norm)) emit('confusable_word', undefined, nx, nx, 'led', 'The past tense of "lead" is "led".', 0.9, true, n2.end);
        } else if (nx.norm === 'past') {
          const n2 = nextSpaced(ts, i + 1);
          if ((n2 !== undefined && PASSED_NEXT.has(n2.norm)) || clauseEndAfter(ctx, nx.end)) emit('confusable_word', undefined, nx, nx, 'passed', '"Passed" is the verb; "past" is a time or a direction.', 0.85, true, n2?.end ?? nx.end);
        }
        // agreement: they/we/you/I has
        if (w === 'has') {
          const pv = prevSpaced(ts, i);
          if (pv !== undefined && (pv.norm === 'they' || pv.norm === 'we' || pv.norm === 'you' || pv.norm === 'i') && !compoundSubject(i - 1)) emit('subject_verb_agreement', undefined, t, t, 'have', `"${pv.text}" takes "have", not "has".`, 0.9, true, t.end);
        }
        break;
      }
      case "didn't":
      case "doesn't":
      case 'did':
      case 'does': {
        if (w === "doesn't") {
          const pv = prevSpaced(ts, i);
          if (pv !== undefined && (pv.norm === 'they' || pv.norm === 'we' || pv.norm === 'you' || pv.norm === 'i') && !compoundSubject(i - 1)) {
            emit('subject_verb_agreement', undefined, t, t, withApostrophe(casePreserve("don't", t.text), aposOf()), `"${pv.text}" takes "don't".`, 0.9, true, t.end);
          }
        }
        // Negatives only: "didn't went", "did not knew", "doesn't has". A bare "did" may end a clause ("what he did made sense").
        let k = i;
        if (w === 'did' || w === 'does') {
          if (nextSpaced(ts, i)?.norm !== 'not') break;
          k = i + 1;
        }
        const nx = nextSpaced(ts, k);
        if (nx === undefined || looksLikeCode(ctx, nx)) break;
        const base = w === 'did' || w === "didn't" ? PAST_TO_BASE.get(nx.norm) ?? THIRD_TO_BASE.get(nx.norm) : THIRD_TO_BASE.get(nx.norm) ?? PAST_TO_BASE.get(nx.norm);
        if (base === undefined) break;
        emit('verb_form', undefined, nx, nx, casePreserve(base, nx.text), `After "${(list[k] as Token).text}" use the base form "${base}".`, 0.9, true, nx.end);
        break;
      }
      case 'forward': {
        const pv = prevSpaced(ts, i);
        const to = nextSpaced(ts, i);
        if (pv === undefined || to === undefined || to.norm !== 'to' || !/^look(?:ing|s|ed)?$/.test(pv.norm)) break;
        const verb = nextSpaced(ts, i + 1);
        if (verb === undefined) break;
        const ing = LOOK_FORWARD.get(verb.norm);
        if (ing === undefined || ing === verb.norm) break;
        emit('verb_form', undefined, verb, verb, ing, `"Look forward to" takes an -ing form: "${ing}".`, 0.9, true, verb.end);
        break;
      }
      case 'was': {
        const pv = prevSpaced(ts, i);
        if (pv !== undefined && (pv.norm === 'we' || pv.norm === 'they' || pv.norm === 'you') && !compoundSubject(i - 1)) {
          emit('subject_verb_agreement', undefined, t, t, casePreserve('were', t.text), `"${pv.text}" takes "were", not "was".`, 0.9, true, t.end);
        }
        break;
      }
      case 'is':
      case "there's": {
        const pv = prevSpaced(ts, i);
        if (w === 'is' && pv !== undefined && (pv.norm === 'they' || pv.norm === 'we' || pv.norm === 'you' || pv.norm === 'i') && !compoundSubject(i - 1)) {
          const fix = pv.norm === 'i' ? 'am' : 'are';
          emit('subject_verb_agreement', undefined, t, t, fix, `"${pv.text}" takes "${fix}", not "is".`, 0.9, true, t.end);
          break;
        }
        // "Their is a few issues": the their/there rule fixes the first word, so the verb must agree too.
        const thereIs = w === "there's" ? ctx.isSentenceStart(t.start, true) : pv !== undefined && (pv.norm === 'there' || pv.norm === 'their') && ctx.isSentenceStart(pv.start, true);
        if (!thereIs) break;
        let q = i + 1;
        if (THERE_IS_ADVERBS.has(nextSpaced(ts, i)?.norm ?? '')) q++;
        if (ts.gap[q] === GAP_SPACE && list[q]?.norm === 'a') q++;
        const qt = ts.gap[q] === GAP_SPACE ? list[q] : undefined;
        if (qt === undefined || ts.gap[q + 1] === GAP_HYPHEN) break;
        const plural = list[q - 1]?.norm === 'a' ? qt.norm === 'few' : PLURAL_QUANTIFIERS.has(qt.norm);
        const digits = DIGITS_RE.test(qt.text) && Number(qt.text) >= 2;
        if (!plural && !digits) break;
        if (w === 'is') emit('subject_verb_agreement', undefined, t, t, 'are', `Use "are" before a plural: "there are ${qt.text}".`, 0.9, true, qt.end);
        else emit('subject_verb_agreement', undefined, t, t, `${casePreserve('there', t.text)} are`, 'Use "there are" before a plural.', 0.9, true, qt.end);
        break;
      }
      case 'are': {
        const pv = prevSpaced(ts, i);
        if (pv !== undefined && (pv.norm === 'he' || pv.norm === 'she' || pv.norm === 'i') && !compoundSubject(i - 1)) {
          const fix = pv.norm === 'i' ? 'am' : 'is';
          emit('subject_verb_agreement', undefined, t, t, fix, `"${pv.text}" takes "${fix}", not "are".`, 0.9, true, t.end);
        }
        break;
      }
      case "don't": {
        const pv = prevSpaced(ts, i);
        if (pv !== undefined && (pv.norm === 'he' || pv.norm === 'she' || pv.norm === 'it') && !compoundSubject(i - 1)) {
          emit('subject_verb_agreement', undefined, t, t, withApostrophe(casePreserve("doesn't", t.text), aposOf()), `"${pv.text}" takes "doesn't".`, 0.9, true, t.end);
        }
        break;
      }
      case 'i': {
        // preposition + X + and + I  -> me
        if (t.text !== 'I' || i < 3) break;
        const and = prevSpaced(ts, i);
        if (and === undefined || and.norm !== 'and') break;
        const x = prevSpaced(ts, i - 1);
        const prep = x === undefined ? undefined : prevSpaced(ts, i - 2);
        if (x === undefined || prep === undefined || !CASE_PREPS.has(prep.norm)) break;
        if (!(x.norm === 'you' || x.norm === 'him' || x.norm === 'her' || x.norm === 'them' || x.norm === 'us' || (isUpper(x.text.charAt(0)) && !isAllCaps(x.text)))) break;
        // "I" must end the object, not start a new clause: "to Rome and I ate pasta" is two clauses.
        const nx = nextSpaced(ts, i);
        if (nx !== undefined ? !AFTER_OBJECT_I.has(nx.norm) : !clauseEndAfter(ctx, t.end)) break;
        emit('pronoun_case', undefined, t, t, 'me', `After "${prep.norm}" use the object pronoun "me".`, 0.9, false, nx?.end ?? t.end);
        break;
      }
      case 'me': {
        // "Me and John went" -> "John and I went"
        if (t.text !== 'Me' || !ctx.isSentenceStart(t.start, true)) break;
        const and = nextSpaced(ts, i);
        const x = and === undefined ? undefined : nextSpaced(ts, i + 1);
        const verb = x === undefined ? undefined : nextSpaced(ts, i + 2);
        if (and?.norm !== 'and' || x === undefined || verb === undefined || !VERBS_AFTER_ME_AND.has(verb.norm)) break;
        const subj = SUBJECT_FOR_OBJECT.get(x.norm) ?? (isUpper(x.text.charAt(0)) && !isAllCaps(x.text) && x.norm !== 'i' ? x.text : undefined);
        if (subj === undefined) break;
        const cap = subj.charAt(0).toUpperCase() + subj.slice(1);
        emit('pronoun_case', undefined, t, x, `${cap} and I`, 'Use "I" in the subject, and put yourself last.', 0.9, false, verb.end);
        break;
      }
      case 'myself': {
        const conj = prevSpaced(ts, i);
        const x = conj === undefined ? undefined : prevSpaced(ts, i - 1);
        if (conj === undefined || x === undefined || (conj.norm !== 'or' && conj.norm !== 'and')) break;
        if (!(x.norm === 'you' || x.norm === 'him' || x.norm === 'her' || x.norm === 'them' || (isUpper(x.text.charAt(0)) && !isAllCaps(x.text) && !ctx.isSentenceStart(x.start, true)))) break;
        if (!clauseEndAfter(ctx, t.end)) break;
        emit('pronoun_case', undefined, t, t, casePreserve('me', t.text), '"Myself" needs an "I" earlier in the sentence; use "me" here.', 0.85, false, t.end);
        break;
      }
      case 'any': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || !/^(?:have|has|had)$/.test(pv.norm)) break;
        const plural = ANY_SINGULAR.get(nx.norm);
        if (plural === undefined) break;
        const n2 = nextSpaced(ts, i + 1);
        if (!(clauseEndAfter(ctx, nx.end) || (n2 !== undefined && ANY_FOLLOWERS.has(n2.norm)))) break;
        emit('noun_number', undefined, nx, nx, plural, `Use the plural after "any" here: "any ${plural}".`, 0.85, false, n2?.end ?? nx.end);
        break;
      }
      case 'less':
      case 'amount': {
        const nx = nextSpaced(ts, i);
        if (nx === undefined) break;
        const pv = prevSpaced(ts, i);
        if (w === 'less') {
          if (!COUNT_PLURALS.has(nx.norm) || (pv !== undefined && (pv.norm === 'much' || pv.norm === 'no' || pv.norm === 'or'))) break;
          if (nx.norm === 'hours' || nx.norm === 'days' || nx.norm === 'weeks' || nx.norm === 'months' || nx.norm === 'years' || nx.norm === 'minutes' || nx.norm === 'times') break;
          emit('confusable_word', 'confusable_word.fewer', t, t, casePreserve('fewer', t.text), `Use "fewer" with things you can count, like "${nx.text}".`, 0.85, false, nx.end);
        } else {
          if (nx.norm !== 'of') break;
          const noun = nextSpaced(ts, i + 1);
          if (noun === undefined || !COUNT_PLURALS.has(noun.norm) || /^(?:hours|days|weeks|months|years|minutes|times)$/.test(noun.norm)) break;
          emit('confusable_word', undefined, t, t, casePreserve('number', t.text), `Use "number" with things you can count, like "${noun.text}".`, 0.85, false, noun.end);
        }
        break;
      }
      case 'everyday': {
        const nx = nextSpaced(ts, i);
        if ((nx !== undefined && EVERYDAY_FOLLOWERS.has(nx.norm)) || (nx === undefined && clauseEndAfter(ctx, t.end))) {
          emit('confusable_word', undefined, t, t, casePreserve('every day', t.text), '"Everyday" is an adjective; as an adverb, write "every day".', 0.9, true, nx?.end ?? t.end);
        }
        break;
      }
      case 'awhile': {
        const pv = prevSpaced(ts, i);
        if (pv !== undefined && AWHILE_PREV.has(pv.norm)) emit('confusable_word', undefined, t, t, 'a while', `After "${pv.norm}" write "a while" as two words.`, 0.9, true, t.end);
        break;
      }
      case 'advice':
      case 'advise': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        const ends = nx === undefined && clauseEndAfter(ctx, t.end);
        if (w === 'advice' && pv !== undefined && ADVISE_PREV.has(pv.norm) && (ends || (nx !== undefined && ADVISE_NEXT.has(nx.norm)))) {
          emit('confusable_word', undefined, t, t, casePreserve('advise', t.text), '"Advise" is the verb; "advice" is the noun.', 0.9, true, nx?.end ?? t.end);
        } else if (w === 'advise' && pv !== undefined && ADVICE_PREV.has(pv.norm) && (ends || (nx !== undefined && ADVICE_NEXT.has(nx.norm)))) {
          emit('confusable_word', undefined, t, t, casePreserve('advice', t.text), '"Advice" is the noun; "advise" is the verb.', 0.9, true, nx?.end ?? t.end);
        }
        break;
      }
      case 'whose': {
        const nx = nextWord(i);
        if (nx !== undefined && WHOSE_NEXT.has(nx.norm)) emit('confusable_word', undefined, t, t, withApostrophe(casePreserve("who's", t.text), aposOf()), '"Who\'s" means "who is"; "whose" shows possession.', 0.9, true, nx.end);
        break;
      }
      case "who's": {
        const nx = nextWord(i);
        if (nx !== undefined && WHOS_NOUNS.has(nx.norm)) emit('confusable_word', undefined, t, t, casePreserve('whose', t.text), '"Whose" shows possession; "who\'s" means "who is".', 0.9, true, nx.end);
        break;
      }
      case 'to': {
        const pv = prevSpaced(ts, i);
        const nx = nextWord(i);
        if (pv !== undefined && nx !== undefined && TOO_PREV.has(pv.norm) && TOO_ADJ.has(nx.norm)) {
          const n2 = nextSpaced(ts, i + 1);
          const ok = clauseEndAfter(ctx, nx.end) || (n2 !== undefined && TOO_AFTER.has(n2.norm)) || ((nx.norm === 'much' || nx.norm === 'many') && n2 !== undefined);
          if (ok) emit('confusable_word', undefined, t, t, 'too', '"Too" means "excessively" or "also"; "to" is a preposition.', 0.85, true, n2?.end ?? nx.end);
        } else if (pv !== undefined && (pv.norm === 'me' || pv.norm === 'you') && nx === undefined && /^[!.]/.test(ctx.work.charAt(t.end))) {
          const before = ctx.work.slice(Math.max(0, pv.start - 2), pv.start);
          if (ctx.isSentenceStart(pv.start, true) || /,\s$/.test(before)) emit('confusable_word', undefined, t, t, 'too', '"Too" means "also" here.', 0.9, true, t.end);
        }
        break;
      }
      case 'passed': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv !== undefined && pv.norm === 'the' && nx !== undefined && PASSED_NOUNS.has(nx.norm)) emit('confusable_word', undefined, t, t, 'past', '"Past" describes a time that has gone by; "passed" is a verb.', 0.9, true, nx.end);
        break;
      }
      case 'breathe':
      case 'breath': {
        const pv = prevSpaced(ts, i);
        if (pv === undefined) break;
        if (w === 'breathe' && pv.norm === 'a') emit('confusable_word', undefined, t, t, 'breath', '"Breath" is the noun; "breathe" is the verb.', 0.9, true, t.end);
        else if (w === 'breath' && pv.norm === 'to' && list[i - 2]?.norm !== 'breath') emit('confusable_word', undefined, t, t, 'breathe', '"Breathe" is the verb; "breath" is the noun.', 0.85, true, t.end);
        break;
      }
      case 'maybe': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || !MAYBE_PREV.has(pv.norm) || !MAYBE_NEXT.has(nx.norm)) break;
        const tail = /[^.!?\n]*[.!?]?/.exec(ctx.work.slice(nx.end, nx.end + 300))?.[0] ?? '';
        if (tail.trimEnd().endsWith('?')) break; // "Are you maybe a member?" keeps its "maybe"
        emit('confusable_word', undefined, t, t, 'may be', '"May be" is a verb phrase; "maybe" means "perhaps".', 0.9, true, nx.end);
        break;
      }
      case 'suppose':
      case 'use': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || nx.norm !== 'to' || ts.gap[i + 2] === GAP_HYPHEN) break;
        const verb = nextSpaced(ts, i + 1);
        if (verb === undefined || !LOWER_WORD_RE.test(verb.text) || OBJECT_WORDS.has(verb.norm)) break;
        if (w === 'suppose' && SUPPOSE_PREV.has(pv.norm)) emit('verb_form', undefined, t, t, 'supposed', '"Supposed to" means "expected to".', 0.9, true, verb.end);
        else if (w === 'use' && USE_TO_PREV.has(pv.norm)) {
          // Only a pronoun that opens its clause: "the tools you use to build" is a relative clause ("use X to").
          const before = prevSpaced(ts, i - 1);
          const opens = ctx.isSentenceStart(pv.start, true) || (before !== undefined && CLAUSE_LINKS.has(before.norm)) || /,[ \u00a0]*$/.test(ctx.work.slice(Math.max(0, pv.start - 3), pv.start));
          if (opens) emit('verb_form', undefined, t, t, 'used', '"Used to" describes a past habit.', 0.85, false, verb.end);
        }
        break;
      }
      case 'weather': {
        const pv = prevSpaced(ts, i);
        const nx = nextSpaced(ts, i);
        if (pv === undefined || nx === undefined || !WEATHER_PREV.has(pv.norm) || !WEATHER_NEXT.has(nx.norm)) break;
        emit('confusable_word', undefined, t, t, 'whether', '"Whether" introduces alternatives; "weather" is rain or sun.', 0.9, true, nx.end);
        break;
      }
      case 'were': {
        if (t.text !== 'Were' || !ctx.isSentenceStart(t.start, true)) break;
        const nx = nextSpaced(ts, i);
        if (nx === undefined || !WERE_NEXT.has(nx.norm)) break;
        if (/\?/.test(ctx.work.slice(t.end, Math.min(ctx.work.length, t.end + 160)).split(/[.!\n]/)[0] ?? '')) break; // a question
        emit('confusable_word', undefined, t, t, withApostrophe("We're", aposOf()), '"We\'re" means "we are"; "were" is a past tense.', 0.85, false, nx.end);
        break;
      }
      default: {
        // modal + past / third person: "can goes", "will sent"
        if (MODALS.has(w) && t.text === t.norm) {
          const nx = nextSpaced(ts, i);
          if (nx === undefined) break;
          const base = PAST_TO_BASE.get(nx.norm) ?? THIRD_TO_BASE.get(nx.norm);
          if (base === undefined || nx.norm === 'had' || nx.norm === 'did') break;
          const pv = prevSpaced(ts, i);
          if (pv !== undefined && NOUN_DETERMINERS.has(pv.norm)) break;
          if (looksLikeCode(ctx, nx)) break;
          emit('verb_form', undefined, nx, nx, casePreserve(base, nx.text), `After "${w}" use the base form "${base}".`, 0.9, true, nx.end);
          break;
        }
        // many/several + singular count noun
        if (MANY_WORDS.has(w)) {
          const nx = nextWord(i);
          if (nx === undefined) break;
          const plural = SINGULAR_TO_PLURAL.get(nx.norm);
          if (plural === undefined) break;
          const n2 = nextSpaced(ts, i + 1);
          if (!(clauseEndAfter(ctx, nx.end) || (n2 !== undefined && AFTER_PLURAL_OK.has(n2.norm)))) break;
          emit('noun_number', undefined, nx, nx, casePreserve(plural, nx.text), `"${t.text}" takes a plural noun: "${plural}".`, 0.85, false, n2?.end ?? nx.end);
          break;
        }
        // phrasal verbs written as one word: "I'll setup a call"
        const split = COMPOUND_VERBS.get(w);
        if (split !== undefined) {
          const pv = prevSpaced(ts, i);
          const nx = nextSpaced(ts, i);
          const pvOk = pv !== undefined && (COMPOUND_VERB_PREV.has(pv.norm) || pv.norm.endsWith("'ll"));
          const startOk = ctx.isSentenceStart(t.start, true) && nx !== undefined && OBJECT_WORDS.has(nx.norm) && nx.norm !== 'it';
          const nxOk = (nx !== undefined && COMPOUND_VERB_NEXT.has(nx.norm)) || (nx === undefined && clauseEndAfter(ctx, t.end));
          if (!(startOk || (pvOk && nxOk)) || looksLikeCode(ctx, t)) break;
          emit('confusable_word', 'confusable_word.phrasal_verb', t, t, casePreserve(split, t.text), `As a verb, "${split}" is two words; "${w}" is the noun.`, 0.85, false, nx?.end ?? t.end);
        }
      }
    }
  }
}
