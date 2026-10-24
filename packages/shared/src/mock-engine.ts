/**
 * The mock engine (`provider: 'mock'`): deterministic, synchronous suggestions for tests and demos. It emits the
 * same EngineOutput shape as the model, with the same anchor fields (verbatim `original`, 1–2 words of `prefix`
 * and `suffix`, 1-based `occurrence`), so the worker runs it through parseEngineOutput + anchorSuggestions
 * exactly like a real response. Suggestions are produced only for the blocks the request marks dirty, never inside
 * URLs, code, emails, handles or DOM-protected ranges (the model only sees placeholders there), ids are stable for
 * a given text, and nothing here touches the DOM or chrome.*.
 */
import type { VoiceContext, VoiceProfile } from './profile';
import type { CheckRequest, EngineBlockResult, EngineOutput, EngineSuggestion, Paragraph, SuggestionCategory, SuggestionKind, SuggestionSeverity, TextRange, TokenUsage, ToneLabel } from './types';
import { blockIdFor } from './prompts/messages';
import { stripUrlsAndCode } from './text';

export const MOCK_MODEL = 'mock' as const;

export interface MockCheckResult {
  output: EngineOutput;
  /** Rough token estimate (chars / 4 plus the cached contract); costUsd is always 0. */
  usage: TokenUsage;
  model: typeof MOCK_MODEL;
}

interface MockPattern {
  re: RegExp;
  rule: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  replacement: (match: RegExpExecArray) => string;
  explanation: string | ((match: RegExpExecArray) => string);
  confidence: number;
  meaningPreserving: boolean;
  autoApplySafe: boolean;
  alternatives?: string[];
}

/** Copies the capitalization shape of `from` onto `to` ("Tomorow" -> "Tomorrow", "TOMOROW" -> "TOMORROW"). */
function matchCase(from: string, to: string): string {
  if (from.length > 1 && from === from.toUpperCase() && /\p{L}/u.test(from)) return to.toUpperCase();
  const first = from.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) return to.charAt(0).toUpperCase() + to.slice(1);
  return to;
}

const SPELLING: Record<string, string> = {
  tomorow: 'tomorrow',
  tommorow: 'tomorrow',
  tommorrow: 'tomorrow',
  definately: 'definitely',
  recieve: 'receive',
  recieved: 'received',
  seperate: 'separate',
  seperately: 'separately',
  occured: 'occurred',
  occurence: 'occurrence',
  sentance: 'sentence',
  speling: 'spelling',
  teh: 'the',
  accomodate: 'accommodate',
  wierd: 'weird',
  untill: 'until',
  recomend: 'recommend',
};

const SPELLING_RE = new RegExp(`\\b(${Object.keys(SPELLING).join('|')})\\b`, 'gi');

const CONTRACTIONS: Record<string, string> = {
  dont: "don't",
  cant: "can't",
  wont: "won't",
  didnt: "didn't",
  doesnt: "doesn't",
  isnt: "isn't",
  wasnt: "wasn't",
  couldnt: "couldn't",
  shouldnt: "shouldn't",
  wouldnt: "wouldn't",
  havent: "haven't",
  hasnt: "hasn't",
  arent: "aren't",
  im: "I'm",
};

/**
 * Span patterns, most specific first. A later match that overlaps an earlier emitted span in the same block is
 * skipped, so "should of went" wins over "should of", and "of came" (verb_form) over "could of".
 */
const SPAN_PATTERNS: readonly MockPattern[] = [
  {
    re: /\b(should|could|would) of went\b/gi,
    rule: 'confusable_word',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => `${m[1] ?? 'should'} have gone`,
    explanation: "'Should of' is a mishearing of 'should have', and 'have' takes 'gone'.",
    confidence: 0.97,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /(?<=\b(?:could|should|would|might|must) )of came\b/gi,
    rule: 'verb_form',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: () => 'have come',
    explanation: "After 'have', the past participle is 'come', not 'came'.",
    confidence: 0.95,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /\b(could|should|would|might|must) of\b(?! course\b)/gi,
    rule: 'confusable_word',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => `${m[1] ?? 'could'} have`,
    explanation: (m) => `'${(m[1] ?? 'could').toLowerCase()} of' is a mishearing of '${(m[1] ?? 'could').toLowerCase()} have'.`,
    confidence: 0.97,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    // Not "their going-away party".
    re: /\b(Their|their) going\b(?!-)/g,
    rule: 'confusable_word',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => `${matchCase(m[1] ?? 'their', "they're")} going`,
    explanation: "'Their' is possessive; the contraction of 'they are' is 'they're'.",
    confidence: 0.96,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /\birregardless\b/gi,
    rule: 'confusable_word',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], 'regardless'),
    explanation: "'Irregardless' is nonstandard; the word is 'regardless'.",
    confidence: 0.93,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /\bmaybe you could possibly\b/gi,
    rule: 'hedging',
    category: 'delivery',
    severity: 'suggestion',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], 'could you'),
    explanation: 'Stacked hedges make the request sound unsure; one direct ask reads as confident.',
    confidence: 0.6,
    meaningPreserving: false,
    autoApplySafe: false,
  },
  {
    re: /\bkind of touch base\b/gi,
    rule: 'wordy_phrase',
    category: 'clarity',
    severity: 'suggestion',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], 'check in'),
    explanation: "'Check in' says the same thing in two words.",
    confidence: 0.8,
    meaningPreserving: true,
    autoApplySafe: false,
  },
  {
    re: /\bin order to\b/gi,
    rule: 'wordy_phrase',
    category: 'clarity',
    severity: 'suggestion',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], 'to'),
    explanation: "'To' says the same thing in one word.",
    confidence: 0.85,
    meaningPreserving: true,
    autoApplySafe: false,
  },
  {
    re: /\bvery very\b/gi,
    rule: 'overused_word',
    category: 'engagement',
    severity: 'suggestion',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], 'very'),
    explanation: "Doubling 'very' adds no force; one is enough, or pick a stronger word.",
    confidence: 0.75,
    meaningPreserving: true,
    autoApplySafe: false,
  },
  {
    re: SPELLING_RE,
    rule: 'spelling',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], SPELLING[m[0].toLowerCase()] ?? m[0]),
    explanation: (m) => `The word is spelled '${SPELLING[m[0].toLowerCase()] ?? m[0]}'.`,
    confidence: 0.97,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    // Function words only; "that that" ("I know that that is true") and "is is" ("what it is is") are legitimate.
    re: /\b(the|a|an|to|of|in|on|and|it|this|for|with|at|be) \1\b/gi,
    rule: 'repeated_word',
    category: 'correctness',
    severity: 'error',
    kind: 'delete',
    replacement: (m) => m[1] ?? '',
    explanation: 'Repeated word.',
    confidence: 0.98,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /\b(We|we|They|they|You|you) was\b/g,
    rule: 'subject_verb_agreement',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => `${m[1] ?? 'we'} were`,
    explanation: (m) => `'${m[1] ?? 'We'}' takes 'were', not 'was'.`,
    confidence: 0.95,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /\b(dont|cant|wont|didnt|doesnt|isnt|wasnt|couldnt|shouldnt|wouldnt|havent|hasnt|arent|Im)\b/g,
    rule: 'apostrophe',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => {
      const word = m[0];
      const fixed = CONTRACTIONS[word.toLowerCase()] ?? word;
      return word === 'Im' ? "I'm" : matchCase(word, fixed);
    },
    explanation: 'Contractions take an apostrophe.',
    confidence: 0.96,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    re: /\b(its)\b(?= a good idea\b)/gi,
    rule: 'apostrophe',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: (m) => matchCase(m[0], "it's"),
    explanation: "'It's' (it is) takes an apostrophe; 'its' is possessive.",
    confidence: 0.92,
    meaningPreserving: true,
    autoApplySafe: true,
  },
  {
    // A lone "i", but not inside "i.e.", "i18n", "e-i-e-i-o" or "wi-fi".
    re: /(?<![\p{L}\p{N}'’.-])i(?![\p{L}\p{N}'’.-])/gu,
    rule: 'capitalization',
    category: 'correctness',
    severity: 'error',
    kind: 'replace',
    replacement: () => 'I',
    explanation: "The pronoun 'I' is always capitalized.",
    confidence: 0.98,
    meaningPreserving: true,
    autoApplySafe: true,
  },
];

const REWRITE_PATTERNS: readonly MockPattern[] = [
  {
    re: /I just wanted to kind of touch base and see if maybe you could possibly send me the the report when you get a chance\./g,
    rule: 'tone_rewrite_confident',
    category: 'delivery',
    severity: 'suggestion',
    kind: 'rewrite',
    replacement: () => 'Could you send me the report when you get a chance?',
    explanation: 'The sentence hedges four times; a direct question sounds confident and is easier to answer.',
    confidence: 0.7,
    meaningPreserving: false,
    autoApplySafe: false,
    alternatives: ['Could you send me the report when you have a moment?'],
  },
];

function wordsBefore(text: string, index: number, n: number): string {
  const before = text.slice(0, index).trimEnd();
  if (before.length === 0) return '';
  const tokens = before.split(/\s+/);
  return tokens.slice(Math.max(0, tokens.length - n)).join(' ');
}

function wordsAfter(text: string, index: number, n: number): string {
  const after = text.slice(index).trimStart();
  if (after.length === 0) return '';
  return after.split(/\s+/).slice(0, n).join(' ');
}

/** 1-based index of the occurrence of `needle` that starts at `index`, counting from the block start. */
function occurrenceAt(text: string, needle: string, index: number): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1 || at > index) break;
    count++;
    if (at === index) break;
    from = at + 1;
  }
  return Math.max(1, count);
}

function overlaps(a: TextRange, taken: readonly TextRange[]): boolean {
  return taken.some((t) => a.start < t.end && t.start < a.end);
}

/**
 * The copy of a paragraph the patterns scan: URLs, code, emails, handles and the request's DOM-protected ranges
 * are blanked to same-length spaces, because the real model only ever sees `⟦…⟧` placeholders there and must
 * never flag them (02 §3.3). Offsets into the scan copy are offsets into the real text.
 */
function scanText(p: Paragraph, protectedRanges: readonly TextRange[]): string {
  let scan = stripUrlsAndCode(p.text).text;
  const end = p.start + p.text.length;
  for (const r of protectedRanges) {
    const s = Math.max(p.start, Math.min(end, Math.floor(r.start))) - p.start;
    const e = Math.max(p.start, Math.min(end, Math.floor(r.end))) - p.start;
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) scan = scan.slice(0, s) + ' '.repeat(e - s) + scan.slice(e);
  }
  return scan;
}

function runPatterns(text: string, scan: string, patterns: readonly MockPattern[], taken: TextRange[], exclusive: boolean, next: () => string): EngineSuggestion[] {
  const out: { at: number; s: EngineSuggestion }[] = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    for (const m of scan.matchAll(p.re)) {
      const index = m.index ?? 0;
      const original = m[0];
      if (original.length === 0) continue;
      // A match may not touch a blanked span (the pattern would have matched spaces in place of masked text).
      if (text.slice(index, index + original.length) !== original) continue;
      const range = { start: index, end: index + original.length };
      if (exclusive && overlaps(range, taken)) continue;
      if (exclusive) taken.push(range);
      const replacement = p.replacement(m);
      if (p.kind !== 'flag' && replacement === original) continue;
      out.push({
        at: index,
        s: {
          id: '',
          category: p.category,
          rule: p.rule,
          severity: p.severity,
          kind: p.kind,
          original,
          prefix: wordsBefore(text, index, 2),
          suffix: wordsAfter(text, index + original.length, 2),
          occurrence: occurrenceAt(text, original, index),
          replacement,
          alternatives: p.alternatives === undefined ? [] : [...p.alternatives],
          explanation: typeof p.explanation === 'function' ? p.explanation(m) : p.explanation,
          confidence: p.confidence,
          meaning_preserving: p.meaningPreserving,
          auto_apply_safe: p.autoApplySafe,
        },
      });
    }
  }
  out.sort((a, b) => a.at - b.at || (a.s.kind === 'rewrite' ? 1 : 0) - (b.s.kind === 'rewrite' ? 1 : 0));
  return out.map((o) => ({ ...o.s, id: next() }));
}

function toneFor(req: CheckRequest): ToneLabel[] {
  const text = req.text.trim();
  if (text.length === 0) return [];
  const greeting = /^(?:hi|hello|hey|dear)\b/i.test(text);
  if (req.context === 'email' || greeting) {
    return [
      { label: 'friendly', strength: 'moderate' },
      { label: 'informal', strength: 'slight' },
    ];
  }
  return [{ label: 'direct', strength: 'moderate' }];
}

function consistencyFor(text: string): EngineOutput['document']['consistency'] {
  const us = [...text.matchAll(/\bUS\b(?!\.)/g)].length;
  const dotted = [...text.matchAll(/\bU\.S\.(?!A)/g)].length;
  if (us === 0 || dotted === 0) return [];
  const recommended = dotted >= us ? 'U.S.' : 'US';
  return [
    {
      variants: ['US', 'U.S.'],
      recommended,
      explanation: `Both "US" and "U.S." appear; pick one form and use it throughout.`,
    },
  ];
}

/**
 * Checks the dirty blocks of a request and returns deterministic suggestions for the phrases the fixtures and
 * demos use (misspellings, "could of", "the the", "We was", missing apostrophes, lone "i", wordy phrases,
 * hedging, "very very", one confident rewrite), plus document tone and a US/U.S. consistency note.
 */
export function mockCheck(req: CheckRequest): MockCheckResult {
  const dirty = req.dirtyBlockHashes === 'all' ? null : new Set(req.dirtyBlockHashes);
  const blocks: EngineBlockResult[] = [];
  let counter = 0;
  const next = (): string => `s${++counter}`;
  let inputChars = 0;
  let suggestionCount = 0;

  // Fenced code can span several paragraphs; mask it once over the whole text so a block that is nothing but the
  // inside of a fence is blanked too (the model only ever sees a placeholder there).
  const wholeMasks = stripUrlsAndCode(req.text).masked;
  for (const p of [...req.blocks].sort((a, b) => a.index - b.index)) {
    if (dirty !== null && !dirty.has(p.hash)) continue;
    if (p.text.trim().length === 0) continue;
    inputChars += p.text.length;
    const taken: TextRange[] = [];
    const scan = scanText(p, [...req.protectedRanges, ...wholeMasks]);
    const spans = runPatterns(p.text, scan, SPAN_PATTERNS, taken, true, next);
    const rewrites = runPatterns(p.text, scan, REWRITE_PATTERNS, taken, false, next);
    const suggestions = [...spans, ...rewrites];
    suggestionCount += suggestions.length;
    blocks.push({ block_id: blockIdFor(p.index), suggestions });
  }

  const output: EngineOutput = {
    blocks,
    // Consistency is judged on the prose the model would see, not on "US" inside a URL path or a code span.
    document: { tone: toneFor(req), consistency: consistencyFor(stripUrlsAndCode(req.text).text), notes: '' },
  };
  return {
    output,
    usage: {
      inputTokens: Math.ceil(inputChars / 4) + 2400,
      outputTokens: 40 + suggestionCount * 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
    model: MOCK_MODEL,
  };
}

/** A plausible, lint-clean voice profile for dashboard demos. Deterministic. */
export function mockVoiceProfile(context: VoiceContext): VoiceProfile {
  const messages = context === 'messages';
  return {
    context,
    version: 3,
    generatedAt: '2026-01-01T00:00:00.000Z',
    generatedBy: MOCK_MODEL,
    confidence: 'medium',
    summary: messages
      ? 'Writes short, warm messages with contractions, a quick greeting and a one-line sign-off.'
      : 'Writes structured documents with medium-length sentences, headed sections and few hedges.',
    traits: messages
      ? [
          { id: 'short_sentences', label: 'Short sentences', description: 'Most sentences run under fourteen words; one idea per sentence.', dimension: 'sentences', evidenceCount: 42, confidence: 'high', locked: false },
          { id: 'contractions', label: 'Contractions', description: "Uses contractions such as I'm, we'll and don't in nearly every message.", dimension: 'register', evidenceCount: 38, confidence: 'high', locked: true },
          { id: 'warm_openers', label: 'Warm openers', description: 'Opens with a first-name greeting and a one-line pleasantry before the ask.', dimension: 'openings_closings', evidenceCount: 17, confidence: 'medium', locked: false },
          { id: 'conjunction_starts', label: 'Conjunction starts', description: "Starts sentences with 'And' or 'But' to keep a conversational rhythm.", dimension: 'stylistic_choices', evidenceCount: 11, confidence: 'medium', locked: false },
        ]
      : [
          { id: 'headed_sections', label: 'Headed sections', description: 'Breaks documents into short headed sections with a one-sentence summary first.', dimension: 'stylistic_choices', evidenceCount: 15, confidence: 'medium', locked: false },
          { id: 'medium_sentences', label: 'Medium sentences', description: 'Sentences average eighteen words with occasional long explanatory ones.', dimension: 'sentences', evidenceCount: 60, confidence: 'high', locked: false },
          { id: 'few_hedges', label: 'Few hedges', description: "States conclusions plainly and rarely uses 'perhaps' or 'it seems'.", dimension: 'tone', evidenceCount: 24, confidence: 'high', locked: true },
        ],
    styleGuide: messages
      ? 'Register: casual and friendly; contractions throughout; first names.\nSentences: short, one idea each; fragments are common and intentional.\nPunctuation: single exclamation marks for thanks; em dashes closed up.\nWords: plain verbs; "quick", "happy to", "let me know".\nOpenings and closings: "Hi <name>," then a pleasantry; signs off with "Thanks!" or "Cheers".\nWhat to leave alone: sentence-initial And/But, fragments in replies, emoji in chat.'
      : 'Register: neutral to formal; no slang; contractions only in asides.\nSentences: medium length with clear subjects; lists for more than three items.\nPunctuation: Oxford comma; curly quotes; en dashes with spaces for ranges.\nWords: concrete nouns, active verbs, defined acronyms on first use.\nOpenings and closings: a one-sentence summary first; ends with next steps.\nWhat to leave alone: long sentences in technical explanations, passive voice in method descriptions.',
    editorInstructions: messages
      ? ['Keep rewrites short and conversational; prefer a question over an instruction.', 'Keep the greeting and sign-off exactly as written.']
      : ['Prefer precise verbs over adverbs when rewording.', 'Keep headed sections and list structure intact.'],
    doNotFlagStyle: messages ? ['sentence_fragment', 'conjunction_at_start', 'contractions', 'emoji', 'exclamation_marks'] : ['long_sentences', 'passive_voice', 'serial_comma_choice'],
    keepPhrases: messages ? ['happy to', 'let me know', 'quick question'] : ['in short', 'next steps'],
    avoidPhrases: messages ? ['per my last email', 'kindly'] : ['utilize', 'leverage'],
    greetings: messages ? ['Hi {name},', 'Hey {name}!'] : [],
    signoffs: messages ? ['Thanks!', 'Cheers'] : ['Best regards'],
    acceptedPatterns: ['shortening wordy phrases', 'removing stacked hedges', 'fixing repeated words'],
    rejectedPatterns: messages ? ['formalizing greetings', 'expanding contractions', 'removing exclamation marks'] : ['splitting long technical sentences', 'converting passive method descriptions'],
    examples: {
      accepted: [
        { before: 'I just wanted to kind of touch base about the report.', after: 'Quick question about the report.' },
        { before: 'in order to finish on time', after: 'to finish on time' },
      ],
      rejected: [{ before: "Thanks so much! I'll send it tonight.", proposed: 'Thank you. I will send it tonight.', keptOrFinal: "Thanks so much! I'll send it tonight." }],
    },
    facts: messages
      ? { register: 'casual', sentence_words_avg: '11.4', sentence_words_sd: '5.2', contraction_rate: '71% of sentences', serial_comma: 'oxford', dash_style: 'em_closed', quote_style: 'straight', exclamation_per_100_sentences: '14', emoji_rate: '6% of sentences', lowercase_start_rate: '2% of sentences', dialect: 'en-US' }
      : { register: 'neutral', sentence_words_avg: '18.2', sentence_words_sd: '7.9', contraction_rate: '9% of sentences', serial_comma: 'oxford', dash_style: 'en_spaced', quote_style: 'curly', exclamation_per_100_sentences: '0', emoji_rate: '0% of sentences', lowercase_start_rate: '0% of sentences', dialect: 'en-US' },
    changelog: 'Confirmed contraction and sentence-length traits with more evidence; added conjunction starts.',
    removedByUser: [],
  };
}
