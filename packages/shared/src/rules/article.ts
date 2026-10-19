/** Rule `article`: "a" before a vowel sound and "an" before a consonant sound. */
import type { RuleContext } from './context';
import { isUpper } from './context';

const ARTICLE_RE = /(?<![\p{L}\p{N}'’-])(a|an|A|An)([  ]+)([\p{L}\p{N}][\p{L}\p{N}'’-]*)/gu;
const HAS_DIGIT_RE = /\p{N}/u;
const ALL_UPPER_RE = /^\p{Lu}{1,6}$/u;
const MIXED_RE = /^.\p{L}*\p{Lu}/u;

/** Letter names that start with a vowel sound (acronyms are read letter by letter). */
const VOWEL_LETTER_NAMES = new Set(['A', 'E', 'F', 'H', 'I', 'L', 'M', 'N', 'O', 'R', 'S', 'X']);
/** Acronyms pronounced as words, or ambiguous (null = skip). */
const ACRONYM_ARTICLES = new Map<string, 'a' | 'an' | null>([
  ['NASA', 'a'], ['NATO', 'a'], ['NAFTA', 'a'], ['NASCAR', 'a'], ['NASDAQ', 'a'], ['NOAA', 'a'], ['NIMBY', 'a'],
  ['SCUBA', 'a'], ['SWAT', 'a'], ['SONAR', 'a'], ['SIM', 'a'], ['SCOTUS', 'a'], ['SAT', null], ['SQL', null], ['SAAS', 'a'],
  ['RAM', 'a'], ['ROM', 'a'], ['RADAR', 'a'], ['LAN', 'a'], ['LASER', 'a'], ['LIDAR', 'a'],
  ['FIFA', 'a'], ['FOMO', 'a'], ['FAQ', null], ['FEMA', 'a'], ['MIDI', 'a'], ['MOOC', 'a'], ['MOMA', 'a'],
  ['PNG', null], ['POTUS', 'a'], ['ASAP', null], ['AWOL', null], ['EULA', 'a'], ['UEFA', 'a'], ['UNESCO', 'a'],
  ['UNICEF', 'a'], ['UNIX', 'a'], ['OPEC', 'an'], ['OSHA', 'an'], ['IKEA', 'an'], ['ISO', 'an'], ['JPEG', 'a'], ['JPG', 'a'],
  ['GIF', 'a'], ['JSON', 'a'], ['YAML', 'a'], ['CAPTCHA', 'a'], ['PIN', 'a'], ['AIDS', 'an'], ['NGO', 'an'],
]);
/** Silent h. */
const SILENT_H = new Set([
  'hour', 'hourly', 'hourglass', 'hours', 'honest', 'honestly', 'honesty', 'honor', 'honour', 'honored', 'honoured',
  'honors', 'honours', 'honorable', 'honourable', 'honorary', 'honorific', 'honoree', 'heir', 'heirs', 'heiress',
  'heirloom', 'heirlooms',
]);
/** Pronunciation varies by speaker or dialect: never flag. */
const AMBIGUOUS = new Set([
  'herb', 'herbs', 'herbal', 'homage', 'historic', 'historical', 'historian', 'historians', 'hotel', 'hotels', 'humble',
  'hallucination', 'hypothesis', 'hereditary', 'habitual', 'horrific', 'hysterical', 'euler', 'ouija', 'oaxaca', 'unix',
]);
/** Words starting with u/eu that begin with a "you" sound. */
const YOU_WORDS = new Set([
  'use', 'used', 'user', 'users', 'useful', 'useless', 'usual', 'usually', 'usage', 'usable', 'usability', 'utensil',
  'utility', 'utilities', 'utilize', 'utilise', 'utopia', 'utopian', 'utah', 'ukraine', 'ukrainian', 'uruguay',
  'uruguayan', 'uranium', 'uranus', 'urine', 'urinary', 'ubiquitous', 'ubiquity', 'ukulele', 'ugandan', 'uvula',
  'unanimous', 'unanimously', 'usurp', 'usurper', 'usury', 'uterus', 'uterine', 'ute', 'utes', 'ural', 'urals',
  'euro', 'euros', 'europe', 'european', 'europeans', 'eucalyptus', 'euphemism', 'euphoria', 'euphoric', 'eureka',
  'eurasian', 'eustachian', 'eulogy', 'eugenics', 'euthanasia', 'ewe', 'ewes', 'u-turn',
]);
/** Nouns after which a lone "a" is a letter, grade or label, not an article ("vitamin a", "plan a"). */
const LETTER_CONTEXT = new Set([
  'vitamin', 'type', 'grade', 'plan', 'exhibit', 'section', 'appendix', 'option', 'point', 'part', 'class', 'schedule',
  'hepatitis', 'group', 'team', 'side', 'route', 'level', 'tier', 'series', 'model', 'category', 'phase', 'stage',
  'version', 'block', 'figure', 'table', 'chapter', 'item', 'letter', 'note', 'column', 'row', 'step', 'plan', 'track',
  'variant', 'scenario', 'bucket', 'cohort', 'slot', 'wing', 'hall', 'gate', 'terminal', 'pier', 'dock', 'zone', 'list',
]);

/** Article the word takes, or null when unknown. `word` is the first hyphen/apostrophe segment. */
export function articleFor(word: string): 'a' | 'an' | null {
  if (ALL_UPPER_RE.test(word)) {
    const special = ACRONYM_ARTICLES.get(word);
    if (special !== undefined) return special;
    return VOWEL_LETTER_NAMES.has(word.charAt(0)) ? 'an' : 'a';
  }
  if (MIXED_RE.test(word)) return null; // iPhone, McDonald
  const w = word.toLowerCase();
  if (!/^\p{Ll}+$/u.test(w)) return null;
  if (w.length === 1) return null;
  if (ACRONYM_ARTICLES.has(w.toUpperCase()) && w.length <= 4) return null; // "nasa" lower-cased: unclear
  if (SILENT_H.has(w)) return 'an';
  if (AMBIGUOUS.has(w)) return null;
  const c = w.charAt(0);
  switch (c) {
    case 'u':
      if (YOU_WORDS.has(w)) return 'a';
      if (w.startsWith('uni') && w.length > 3 && !'mn'.includes(w.charAt(3))) return 'a'; // unique, united; not unimportant
      if (/^u[nmplgdrstbk]/.test(w)) return 'an'; // under, umbrella, upper, ugly, urgent, usher, utter
      return null;
    case 'e':
      if (YOU_WORDS.has(w) || w.startsWith('eu')) return 'a';
      return 'an';
    case 'o':
      if (/^one(s|ness|-|$)/.test(w) || w === 'once') return 'a';
      return 'an';
    case 'a':
    case 'i':
      return 'an';
    default:
      return 'a';
  }
}

export function articleRule(ctx: RuleContext): void {
  const { work } = ctx;
  for (const m of work.matchAll(ARTICLE_RE)) {
    const art = m[1] ?? '';
    const gap = m[2] ?? '';
    const token = m[3] ?? '';
    const start = m.index;
    const tokenStart = start + art.length + gap.length;
    const tokenEnd = tokenStart + token.length;
    if (ctx.opts.typing && ctx.touchesWordInProgress(tokenStart, tokenEnd)) continue; // the next word is unfinished
    if (HAS_DIGIT_RE.test(token)) continue;
    const lowerToken = token.toLowerCase();
    if (lowerToken === 'a' || lowerToken === 'an') continue; // repeated word territory
    if (ctx.protectedTerms.has(lowerToken)) continue;
    const segment = token.split(/['’-]/u)[0] ?? '';
    if (segment.length === 0 || ctx.protectedTerms.has(segment.toLowerCase())) continue;
    if (isUpper(art.charAt(0))) {
      // "A"/"An" mid-sentence is a letter, grade or label ("vitamin A is", "Plan A was").
      if (!ctx.isSentenceStart(start, true)) continue;
    } else if (art === 'a') {
      let pw = start;
      while (pw > 0 && (work.charAt(pw - 1) === ' ' || work.charAt(pw - 1) === ' ')) pw--;
      let ws = pw;
      while (ws > 0 && /\p{L}/u.test(work.charAt(ws - 1))) ws--;
      if (LETTER_CONTEXT.has(work.slice(ws, pw).toLowerCase())) continue;
    }
    const want = articleFor(segment);
    if (want === null) continue;
    const have = art.toLowerCase();
    if (want === have) continue;
    const acronym = ALL_UPPER_RE.test(segment);
    const replacement = isUpper(art.charAt(0)) ? want.charAt(0).toUpperCase() + want.slice(1) : want;
    const explanation = want === 'an'
      ? `"${segment}" starts with a vowel sound, so it takes "an".`
      : `"${segment}" starts with a consonant sound, so it takes "a".`;
    ctx.emit({
      rule: 'article',
      key: want === 'an' ? 'article.a_to_an' : 'article.an_to_a',
      severity: 'error',
      kind: 'replace',
      start,
      end: start + art.length,
      replacement,
      explanation,
      confidence: acronym ? 0.85 : 0.9,
      autoApplySafe: !acronym,
    });
  }
}
