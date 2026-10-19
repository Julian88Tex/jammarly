/**
 * Rule `confusable_word`, high-precision patterns only: modal + "of" → "have", "alot", "apart of",
 * sentence-initial "your welcome", and "then" for "than" after "more X" / "rather" / "other".
 * its/it's, their/there and affect/effect are deliberately left to the model.
 */
import type { RuleContext } from './context';
import { isLetter, isWs, matchCase } from './context';

const MODAL_OF_RE = /(?<![\p{L}\p{N}'’-])(could|should|would|must|might)([  ]+)(of)([  ]+)(\p{L}+)/giu;
const ALOT_RE = /(?<![\p{L}\p{N}'’-])alot(?![\p{L}\p{N}'’-])/giu;
const APART_OF_RE = /(?<![\p{L}\p{N}'’-])(apart)([  ]+)of(?![\p{L}\p{N}'’-])/giu;
const YOUR_WELCOME_RE = /(?<![\p{L}\p{N}'’-])(your)([  ]+)(welcome)(?![\p{L}\p{N}'’-])/giu;
const THEN_RE = /(?<![\p{L}\p{N}'’-])then(?![\p{L}\p{N}'’-])/giu;

const IRREGULAR_PARTICIPLES = new Set([
  'been', 'gone', 'done', 'seen', 'known', 'taken', 'given', 'come', 'written', 'spoken', 'eaten', 'run', 'won', 'had',
  'made', 'said', 'told', 'thought', 'brought', 'bought', 'caught', 'taught', 'left', 'lost', 'kept', 'slept', 'felt',
  'found', 'built', 'sent', 'spent', 'put', 'cut', 'hit', 'let', 'set', 'read', 'heard', 'held', 'meant', 'met', 'paid',
  'stood', 'understood', 'become', 'begun', 'broken', 'chosen', 'driven', 'fallen', 'forgotten', 'gotten', 'got',
  'hidden', 'ridden', 'risen', 'shaken', 'stolen', 'sworn', 'torn', 'worn', 'woken', 'flown', 'grown', 'thrown', 'shown',
  'drawn', 'blown', 'sung', 'drunk', 'swum', 'rung', 'sunk', 'stuck', 'struck', 'swung', 'dug', 'hung', 'lit', 'shot',
  'sat', 'led', 'fed', 'bled', 'fled', 'bred', 'sped', 'shed', 'wed', 'wept', 'bent', 'lent', 'dealt', 'dreamt', 'learnt',
  'burnt', 'spelt', 'spoilt', 'smelt', 'leapt', 'knelt', 'crept', 'swept', 'split', 'spread', 'quit', 'bet', 'cost', 'hurt',
  'burst', 'cast', 'fit', 'wet', 'rid', 'slid', 'bit', 'bitten', 'lain', 'laid', 'sewn', 'sown', 'strewn', 'shorn', 'mown',
  'proven', 'frozen', 'woven', 'beaten', 'forbidden', 'trodden', 'arisen', 'stricken', 'sunken', 'shrunk', 'shrunken',
  'thrown', 'overcome', 'undergone', 'withdrawn', 'foreseen', 'overtaken', 'mistaken', 'misunderstood', 'sold', 'won',
  'lost', 'fought', 'sought', 'wrung', 'sprung', 'stung', 'strung', 'clung', 'flung', 'slung', 'spun', 'spat', 'trod',
]);
const PARTICIPLE_SUFFIX_RE = /^\p{L}{2,}(ed|en)$/u;
const APART_PRECEDERS = new Set([
  'set', 'sets', 'setting', 'kept', 'keep', 'keeps', 'keeping', 'tear', 'tears', 'tore', 'torn', 'tearing', 'fall', 'falls',
  'fell', 'fallen', 'falling', 'come', 'comes', 'came', 'coming', 'drift', 'drifts', 'drifted', 'drifting', 'grow', 'grows',
  'grew', 'grown', 'growing', 'break', 'breaks', 'broke', 'broken', 'breaking', 'pull', 'pulls', 'pulled', 'pulling',
  'blown', 'blew', 'world', 'worlds', 'miles', 'feet', 'inches', 'years', 'far', 'wide', 'poles', 'take', 'takes', 'took',
  'taken', 'taking', 'pick', 'picks', 'picked', 'picking', 'stand', 'stands', 'stood', 'standing', 'live', 'lives', 'lived',
]);
const WELCOME_FOLLOWERS = new Set(['.', '!', ',', ';', ':', ')', '"', '”', '’', "'"]);
const COMPARATIVE_SUFFIX_RE = /(ly|ful|ous|ive|able|ible|ant|ent|ic|ish|less|al|ing|ed)$/u;
const COMPARATIVE_WORDS = new Set([
  'important', 'likely', 'often', 'common', 'popular', 'difficult', 'expensive', 'effective', 'efficient', 'powerful',
  'useful', 'reliable', 'accurate', 'detailed', 'complex', 'complicated', 'interesting', 'fun', 'money', 'time', 'people',
  'work', 'sense', 'robust', 'secure', 'stable', 'flexible', 'frequent', 'recent', 'relevant', 'precise', 'mature', 'severe',
]);
const OTHER_PRECEDERS = new Set(['each', 'the', 'one', 'another', 'and']);

export function confusableRule(ctx: RuleContext): void {
  const { work } = ctx;
  const n = work.length;

  // could/should/would/must/might of + past participle → have
  for (const m of work.matchAll(MODAL_OF_RE)) {
    const modal = m[1] ?? '';
    const gap1 = m[2] ?? '';
    const of = m[3] ?? '';
    const next = (m[5] ?? '').toLowerCase();
    if (!(IRREGULAR_PARTICIPLES.has(next) || PARTICIPLE_SUFFIX_RE.test(next))) continue;
    const start = m.index;
    const end = start + modal.length + gap1.length + of.length;
    ctx.emit({
      rule: 'confusable_word',
      key: 'confusable_word.of_have',
      severity: 'error',
      kind: 'replace',
      start,
      end,
      replacement: `${modal}${gap1}${matchCase('have', of)}`,
      explanation: `After "${modal.toLowerCase()}" the verb is "have", not "of".`,
      confidence: 0.95,
      autoApplySafe: true,
    });
  }

  // alot → a lot
  if (!ctx.protectedTerms.has('alot')) {
    for (const m of work.matchAll(ALOT_RE)) {
      const start = m.index;
      ctx.emit({
        rule: 'confusable_word',
        key: 'confusable_word.alot',
        severity: 'error',
        kind: 'replace',
        start,
        end: start + 4,
        replacement: matchCase('a lot', m[0]),
        explanation: '"A lot" is two words.',
        confidence: 0.95,
        autoApplySafe: true,
      });
    }
  }

  // apart of → a part of
  for (const m of work.matchAll(APART_OF_RE)) {
    const start = m.index;
    let p = start;
    while (p > 0 && isWs(work.charAt(p - 1))) p--;
    let ws = p;
    while (ws > 0 && isLetter(work.charAt(ws - 1))) ws--;
    if (APART_PRECEDERS.has(work.slice(ws, p).toLowerCase())) continue;
    const apart = m[1] ?? '';
    ctx.emit({
      rule: 'confusable_word',
      key: 'confusable_word.apart_of',
      severity: 'warning',
      kind: 'replace',
      start,
      end: start + apart.length,
      replacement: matchCase('a part', apart),
      explanation: '"Apart of" is not standard; "a part of" means belonging to.',
      confidence: 0.7,
      autoApplySafe: false,
    });
  }

  // your welcome → you're welcome (sentence start, followed by end/punctuation)
  for (const m of work.matchAll(YOUR_WELCOME_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!ctx.isSentenceStart(start, true)) continue;
    let q = end;
    while (q < n && (work.charAt(q) === ' ' || work.charAt(q) === ' ')) q++;
    const follower = work.charAt(q);
    // The end of the text only counts as a sentence end when "welcome" is not the word being typed:
    // "Your welcome" may still become "Your welcome gift is here".
    const unfinished = ctx.opts.typing && ctx.touchesWordInProgress(start, end);
    const atEnd = (q >= n && !unfinished) || follower === '\n' || follower === '\r';
    if (!(atEnd || WELCOME_FOLLOWERS.has(follower) || /\p{Extended_Pictographic}/u.test(String.fromCodePoint(work.codePointAt(q) ?? 0)))) continue;
    const your = m[1] ?? '';
    ctx.emit({
      rule: 'confusable_word',
      key: 'confusable_word.your_welcome',
      severity: 'error',
      kind: 'replace',
      start,
      end: start + your.length,
      replacement: matchCase("you're", your),
      explanation: '"You\'re welcome" is short for "you are welcome".',
      confidence: 0.85,
      autoApplySafe: false,
    });
  }

  // then → than: "more X then", "rather then", "other then"
  for (const m of work.matchAll(THEN_RE)) {
    const start = m.index;
    const end = start + 4;
    // Previous word.
    let p = start;
    while (p > 0 && (work.charAt(p - 1) === ' ' || work.charAt(p - 1) === ' ')) p--;
    if (p === start) continue;
    let ws = p;
    while (ws > 0 && /[\p{L}'’-]/u.test(work.charAt(ws - 1))) ws--;
    const prev = work.slice(ws, p).toLowerCase();
    if (prev.length === 0) continue;
    // Next word must be a plain word (not a comma/clause break).
    let q = end;
    while (q < n && (work.charAt(q) === ' ' || work.charAt(q) === ' ')) q++;
    if (q === end || !/[\p{L}\p{N}]/u.test(work.charAt(q))) continue;
    let ok = false;
    if (prev === 'rather') ok = true;
    else if (prev === 'other') {
      let p2 = ws;
      while (p2 > 0 && (work.charAt(p2 - 1) === ' ' || work.charAt(p2 - 1) === ' ')) p2--;
      let ws2 = p2;
      while (ws2 > 0 && isLetter(work.charAt(ws2 - 1))) ws2--;
      ok = !OTHER_PRECEDERS.has(work.slice(ws2, p2).toLowerCase());
    } else if (COMPARATIVE_WORDS.has(prev) || COMPARATIVE_SUFFIX_RE.test(prev)) {
      // "more X then": the word before X must be "more" (or "less").
      let p2 = ws;
      while (p2 > 0 && (work.charAt(p2 - 1) === ' ' || work.charAt(p2 - 1) === ' ')) p2--;
      let ws2 = p2;
      while (ws2 > 0 && isLetter(work.charAt(ws2 - 1))) ws2--;
      const prev2 = work.slice(ws2, p2).toLowerCase();
      ok = prev2 === 'more' || prev2 === 'less';
    }
    if (!ok) continue;
    ctx.emit({
      rule: 'confusable_word',
      key: 'confusable_word.then_than',
      severity: 'warning',
      kind: 'replace',
      start,
      end,
      replacement: matchCase('than', m[0]),
      explanation: 'Comparisons use "than"; "then" refers to time or sequence.',
      confidence: 0.85,
      autoApplySafe: false,
    });
  }
}
