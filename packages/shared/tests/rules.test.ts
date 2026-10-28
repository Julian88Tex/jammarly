import { describe, expect, it } from 'vitest';
import type { Dialect, Paragraph, Suggestion, TextRange } from '../src/types';
import { hashText, normalizeForMatch, splitParagraphs, stripUrlsAndCode } from '../src/text';
import { createContext, finalizeHits } from '../src/rules/context';
import {
  RULE_CATEGORIES,
  RULE_IDS,
  RULE_TITLES,
  articleFor,
  expectsUkSpelling,
  hitsToSuggestions,
  runRules,
  spellingVariants,
  type RuleHit,
  type RuleOptions,
} from '../src/rules';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const BASE: RuleOptions = {
  dialect: 'en-US',
  context: 'email',
  formality: 'neutral',
  protectedTerms: [],
  styleDecisions: {},
  masked: [],
  typing: false,
  mutedRules: [],
};

function opts(partial: Partial<RuleOptions> = {}): RuleOptions {
  return { ...BASE, ...partial };
}

/** Runs the engine with the masks stripUrlsAndCode would produce (what the content script does). */
function run(text: string, partial: Partial<RuleOptions> = {}): RuleHit[] {
  const masked = partial.masked ?? stripUrlsAndCode(text).masked;
  return runRules(text, opts({ ...partial, masked }));
}

function only(text: string, rule: string, partial: Partial<RuleOptions> = {}): RuleHit[] {
  return run(text, partial).filter((h) => h.rule === rule);
}

/** Every structural invariant a hit must satisfy. */
function assertHitInvariants(text: string, hits: RuleHit[], masked: TextRange[] = []): void {
  let prev = -1;
  for (const h of hits) {
    expect(h.range.start).toBeGreaterThanOrEqual(0);
    expect(h.range.end).toBeGreaterThan(h.range.start);
    expect(h.range.end).toBeLessThanOrEqual(text.length);
    expect(h.original).toBe(text.slice(h.range.start, h.range.end));
    expect(h.original.length).toBeGreaterThan(0);
    expect(h.replacement).not.toBe(h.original);
    expect(h.explanation.length).toBeLessThanOrEqual(140);
    expect(h.explanation.length).toBeGreaterThan(0);
    expect(Object.values(RULE_TITLES)).toContain(h.title);
    expect(RULE_TITLES[h.rule]).toBeDefined();
    expect(RULE_IDS).toContain(h.rule);
    expect(h.confidence).toBeGreaterThan(0);
    expect(h.confidence).toBeLessThanOrEqual(1);
    expect(h.category).toBe(RULE_CATEGORIES[h.rule] ?? 'correctness');
    expect(h.range.start).toBeGreaterThanOrEqual(prev);
    prev = h.range.start;
    for (const m of masked) {
      const overlaps = h.range.start < m.end && h.range.end > m.start;
      expect(overlaps).toBe(false);
    }
  }
}

/** Applies hits (non-overlapping, right to left) and returns the new text. */
function apply(text: string, hits: RuleHit[]): string {
  const sorted = [...hits].sort((a, b) => b.range.start - a.range.start);
  let out = text;
  let lastStart = Infinity;
  for (const h of sorted) {
    if (h.range.end > lastStart) continue;
    out = out.slice(0, h.range.start) + h.replacement + out.slice(h.range.end);
    lastStart = h.range.start;
  }
  return out;
}

function fixes(text: string, rule: string, partial: Partial<RuleOptions> = {}): string[] {
  return only(text, rule, partial).map((h) => `${h.original}→${h.replacement}`);
}

/** Deterministic LCG so property-style tests are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const v = items[Math.floor(rng() * items.length)];
  if (v === undefined) throw new Error('empty pick');
  return v;
}

function elapsed(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// ---------------------------------------------------------------------------
// spacing
// ---------------------------------------------------------------------------

describe('spacing', () => {
  describe('multiple spaces', () => {
    it.each([
      ['I  went home.', ['  → ']],
      ['one   two', ['   → ']],
      ['a\u00a0 b', ['\u00a0 → ']],
      ['end.  Next', ['  → ']],
      ['end."  Next', ['  → ']],
    ])('flags %j', (text, expected) => {
      expect(fixes(text, 'spacing')).toEqual(expected);
    });

    it.each([
      '  indented line',
      'line one\n  indented line two',
      'line one\n\tx',
      'trailing  ',
      'no  \nnewline after',
      'tab\t\there',
    ])('leaves %j alone', (text) => {
      expect(only(text, 'spacing').filter((h) => h.title === RULE_TITLES['spacing.double_space'])).toEqual([]);
    });

    it('keeps two spaces after a sentence end when the user decided so, but trims three', () => {
      const sd = { double_space_after_period: 'keep' };
      expect(fixes('End.  Next one.  Third!  Fourth?  Fifth', 'spacing', { styleDecisions: sd })).toEqual([]);
      expect(fixes('End.   Next', 'spacing', { styleDecisions: sd })).toEqual(['   →  ']);
      expect(fixes('mid  word', 'spacing', { styleDecisions: sd })).toEqual(['  → ']);
    });

    it('is tier A (auto-apply safe) and applies to a clean text', () => {
      const text = 'I  went  home.';
      const hits = only(text, 'spacing');
      expect(hits.every((h) => h.autoApplySafe)).toBe(true);
      expect(apply(text, hits)).toBe('I went home.');
    });
  });

  describe('space before punctuation', () => {
    it.each([
      ['Hello , world', [' ,→,']],
      ['Really ?', [' ?→?']],
      ['Wait !', [' !→!']],
      ['first ; second', [' ;→;']],
      ['note : this', [' :→:']],
      ['The end .', [' .→.']],
      ['(done) .', [' .→.']],
      ['Wait ,what', [' ,→, ']],
    ])('flags %j', (text, expected) => {
      expect(fixes(text, 'spacing')).toEqual(expected);
    });

    it.each([
      'wait . . . what',
      'wait ... what',
      'score 3 : 2',
      'ratio 3 .5',
      'smile :) now',
      'wink ;) now',
      'emoji :smile: now',
      'call .bar()',
      'a ?? b',
      'x :: y',
      'Bonjour\u00a0!',
      'Vraiment\u00a0?',
      '- , oops',
      'Price is 10 ,000',
    ])('leaves %j alone', (text) => {
      expect(only(text, 'spacing').filter((h) => h.title === RULE_TITLES['spacing.before_punctuation'])).toEqual([]);
    });

    it('still flags an ASCII space before a comma or period in any English dialect', () => {
      for (const dialect of ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'] as Dialect[]) {
        expect(fixes('Hello , world .', 'spacing', { dialect })).toEqual([' ,→,', ' .→.']);
      }
    });
  });

  describe('missing space after punctuation', () => {
    it.each([
      ['We left home.Then we came back.', ['.T→. T']],
      ['Hello,world', [',w→, w']],
      ['Really?Yes.', ['?Y→? Y']],
      ['Stop!Now.', ['!N→! N']],
      ['Note:This is it', [':T→: T']],
      ['first;Second', [';S→; S']],
    ])('flags %j', (text, expected) => {
      expect(fixes(text, 'spacing')).toEqual(expected);
    });

    it.each([
      'pi is 3.14 today',
      'about 1,000 people',
      'at 9:30 sharp',
      'version 1.2.3 shipped',
      'open foo.ts and README.md',
      'see e.g.the thing',
      'i.e.That',
      'Dr.Smith and Mr.Jones',
      'the U.S.A today',
      'wait...What',
      'System.Out.Println',
      'HELLO.World',
      'use &nbsp;Text',
      'key:value pairs',
      'C:\\Users\\x',
      'std::String',
      'a,b,c',
      'x.Y',
      'snake_case.Thing',
      'end.NextStep',
      'visit example.com.Today',
      'mail me@x.com.Now',
      'path src/foo.Bar',
      'the Array.prototype.map',
    ])('leaves %j alone', (text) => {
      expect(only(text, 'spacing').filter((h) => h.title === RULE_TITLES['spacing.missing_after_punctuation'])).toEqual([]);
    });

    it('is kind insert with the two boundary characters as the anchor', () => {
      const [h] = only('home.Then', 'spacing');
      expect(h).toMatchObject({ kind: 'insert', original: '.T', replacement: '. T', range: { start: 4, end: 6 }, autoApplySafe: true });
    });

    it('is not auto-apply safe after a colon or semicolon', () => {
      const [h] = only('Note:This', 'spacing');
      expect(h).toMatchObject({ autoApplySafe: false, confidence: 0.8 });
    });
  });

  describe('trailing whitespace', () => {
    it('flags spaces and tabs before a line break as a suggestion', () => {
      const text = 'line one \nline two\t\nline three';
      const hits = only(text, 'spacing');
      expect(hits.map((h) => h.original)).toEqual([' ', '\t']);
      expect(hits.every((h) => h.severity === 'suggestion' && h.kind === 'delete' && h.replacement === '')).toBe(true);
      expect(apply(text, hits)).toBe('line one\nline two\nline three');
    });

    it.each([
      ['two spaces are a Markdown line break', 'line one  \nline two'],
      ['whitespace-only lines', 'line one\n   \nline two'],
      ['no newline follows', 'line one   '],
      ['chat context', 'line one \nline two'],
    ])('does not flag %s', (label, text) => {
      const o = label === 'chat context' ? { context: 'chat' as const } : {};
      expect(only(text, 'spacing', o)).toEqual([]);
    });

    it('does not flag the whitespace before a newline the user just typed', () => {
      expect(only('line one \n', 'spacing', { typing: true })).toEqual([]);
      expect(only('line one \n', 'spacing', { typing: false })).toHaveLength(1);
      expect(only('line one \nmore', 'spacing', { typing: true })).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// repeated_word
// ---------------------------------------------------------------------------

describe('repeated_word', () => {
  it.each([
    ['the the cat', ['the the→the']],
    ['The the cat', ['The the→The']],
    ['I saw the  the cat', ['the  the→the']],
    ['it is is fine', ['is is→is']],
    ['we went to to the shop', ['to to→to']],
    ["don't don't do it", ["don't don't→don't"]],
    ['a\u00a0a dog', []],
    ['The The cat', ['The The→The']],
    ['the recording, so so please resend', ['so so→so']],
  ])('%j', (text, expected) => {
    expect(fixes(text, 'repeated_word')).toEqual(expected);
  });

  it.each([
    'very very good',
    'no no no',
    'bye bye',
    'ha ha ha',
    'it was so so',
    'it was so so.',
    'Bora Bora is nice',
    'I love Duran Duran',
    'the long-term term sheet',
    'the\nthe',
    'it. It was',
    'that that is fine',
    'I I',
    'a a',
    'Walla Walla',
  ])('leaves %j alone or soft', (text) => {
    const hits = only(text, 'repeated_word');
    for (const h of hits) expect(h.confidence).toBeLessThan(0.7);
    if (!/that that/.test(text)) expect(hits).toEqual([]);
  });

  it('flags "had had", "that that" and "is is" softly (warning, 0.6, not auto-apply)', () => {
    for (const text of ['He had had enough.', 'I know that that is true.', 'What it is is unclear.']) {
      const [h] = only(text, 'repeated_word');
      expect(h).toMatchObject({ severity: 'warning', confidence: 0.6, autoApplySafe: false });
    }
  });

  it('skips protected terms', () => {
    expect(only('the tuk tuk arrived', 'repeated_word', { protectedTerms: ['tuk'] })).toEqual([]);
    expect(only('the tuk tuk arrived', 'repeated_word')).toHaveLength(1);
  });

  it('is case-insensitive and keeps the first word', () => {
    const [h] = only('I like Paris paris.', 'repeated_word');
    expect(h).toMatchObject({ original: 'Paris paris', replacement: 'Paris', kind: 'replace', autoApplySafe: true, confidence: 0.95 });
  });
});

// ---------------------------------------------------------------------------
// capitalization
// ---------------------------------------------------------------------------

describe('capitalization', () => {
  it.each([
    ['hello there.', ['hello→Hello']],
    ['Hi. this is it.', ['this→This']],
    ['Really? yes!', ['yes→Yes']],
    ['Wow! great.', ['great→Great']],
    ['He said "no." then left.', ['then→Then']],
    ['Done.\nnext line', ['next→Next']],
    ['  leading space', ['leading→Leading']],
    ["Stop. don't do it.", ['don→Don']],
    ['Was it good? yes. Was it cheap? no.', ['yes→Yes', 'no→No']],
    // Prose that merely starts with a programming keyword is still a sentence.
    ['return to sender. class dismissed. import duties apply. function over form.', ['return→Return', 'class→Class', 'import→Import', 'function→Function']],
    // "mix" is not a roman numeral; "vi" is one but not at a line start.
    ['Mix well. then stir. I love vi. then emacs.', ['then→Then', 'then→Then']],
  ])('%j', (text, expected) => {
    expect(fixes(text, 'capitalization')).toEqual(expected);
  });

  it.each([
    'Dr. smith left.',
    'See Mr. jones and Mrs. brown.',
    'e.g. this one',
    'i.e. that one',
    'The cost is approx. five dollars',
    'See fig. 2 for etc. details',
    'J. K. rowling wrote it.',
    '1. apples 2. pears',
    'Step 3. then we left',
    '- apples\n- pears',
    '* first item',
    'I was... thinking',
    'Wait... what?',
    'iPhone sales grew. eBay too. macOS shipped.',
    'Done. npm install works. git push too.',
    'Done. api keys rotate.',
    'Done. x marks the spot.',
    'Done. utf8 is fine.',
    'Done. foo.bar() runs. config.value is set.',
    'Done. http://x.com works.',
    'Done. jammarly rocks.',
    // Dialogue and asides: a quoted or bracketed "!" / "?" does not end the enclosing sentence.
    '"Stop!" she yelled.',
    '"Where are you going?" he asked.',
    'He left (finally!) and went home.',
    'She asked “why?” and left.',
    // Code statements: keyword plus a code-shaped continuation.
    'for i in range(10): print(i)',
    'if (x > 1) { return y; }',
    'const total = a + b',
    'def main(): pass',
    'import os',
    // Abbreviations: weekdays, scholarly and unit shorthand.
    'Open at 9 a.m. on Mon. and 2 p.m. on Tue. then close.',
    'See cf. bananas; viz. produce; ibid. again; nb. this',
    'Weighs 5 lbs. then more; drive 3 mi. then stop',
    // Initials and list markers: single letters and roman numerals at a line start.
    'e. e. cummings wrote poems',
    'a. first\nb. second\nc. third',
    'i. first\nii. second\niii. third\niv. fourth',
    'I. intro\nII. body\n(iii. aside)',
  ])('leaves %j alone', (text) => {
    expect(only(text, 'capitalization', { protectedTerms: ['jammarly'] }).filter((h) => h.title === RULE_TITLES['capitalization.sentence_start'])).toEqual([]);
  });

  describe('lone i', () => {
    it.each([
      ['i think so', ['i→I']],
      ['Yes, i do', ['i→I']],
      ["i'm here and i've seen it; i'll go, i'd say", ["i'm→I'm", "i've→I've", "i'll→I'll", "i'd→I'd"]],
      ['So i\u2019m fine', ['i\u2019m→I\u2019m']],
      ['What do i know', ['i→I']],
    ])('%j', (text, expected) => {
      expect(fixes(text, 'capitalization')).toEqual(expected);
    });

    it.each([
      'i.e. this',
      'for i in range(10)',
      'let i = 0',
      'x_i and x-i',
      'i = i + 1',
      'items (i) and (ii)',
      'wifi is on',
      'hi there',
      'a + i',
      'const i',
    ])('leaves %j alone', (text) => {
      expect(only(text, 'capitalization').filter((h) => h.title === RULE_TITLES['capitalization.lone_i'])).toEqual([]);
    });

    it('does not also report "i" as a sentence-start error', () => {
      expect(only('i think so.', 'capitalization')).toHaveLength(1);
    });
  });

  it('is a suggestion in informal chat and skipped entirely when a chat message is all lowercase', () => {
    const text = 'Hello. this is i speaking.';
    const chatHits = only(text, 'capitalization', { context: 'chat', formality: 'informal' });
    expect(chatHits).toHaveLength(2);
    expect(chatHits.every((h) => h.severity === 'suggestion' && !h.autoApplySafe)).toBe(true);
    expect(only('hello. this is i speaking.', 'capitalization', { context: 'chat', formality: 'neutral' })).toEqual([]);
    expect(only('hello. this is i speaking.', 'capitalization', { context: 'email', formality: 'informal' })).toHaveLength(3);
    const emailHits = only(text, 'capitalization');
    expect(emailHits.every((h) => h.severity === 'error' && h.autoApplySafe)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// article
// ---------------------------------------------------------------------------

describe('article', () => {
  it.each([
    ['a apple', ['a→an']],
    ['an banana', ['an→a']],
    ['a hour ago', ['a→an']],
    ['a honest man', ['a→an']],
    ['a heir', ['a→an']],
    ['an university', ['an→a']],
    ['an unicorn', ['an→a']],
    ['an uniform', ['an→a']],
    ['an one-time fee', ['an→a']],
    ['an European', ['an→a']],
    ['an euro', ['an→a']],
    ['a FBI agent', ['a→an']],
    ['a MRI scan', ['a→an']],
    ['a HTML page', ['a→an']],
    ['a X-ray', ['a→an']],
    ['an URL', ['an→a']],
    ['an UFO', ['an→a']],
    ['an NASA mission', ['an→a']],
    ['a unimportant detail', ['a→an']],
    ['a umbrella', ['a→an']],
    ['an user', ['an→a']],
    ['A elephant walked.', ['A→An']],
    ['Hi. An dog barked.', ['An→A']],
    ["a hour's drive", ['a→an']],
    ['an eight-hour shift', []],
    ['a eight-hour shift', ['a→an']],
    ['an F grade', []],
    ['a F grade', ['a→an']],
    ['a U-turn', []],
  ])('%j', (text, expected) => {
    expect(fixes(text, 'article')).toEqual(expected);
  });

  it.each([
    'an hour, an honest man, an heir, a university, a unicorn, a one-time fee, an FBI agent, an MRI, a European',
    'a URL and an SQL query and a SQL query',
    'an historic day and a historic day',
    'a herb and an herb',
    'a hotel and an hotel',
    'a 8-bit game and an 8-bit game',
    'vitamin A is good',
    'plan A failed',
    'type a influenza',
    'an iPhone and a iPhone',
    'a McDonald and an McDonald',
    'a FAQ and an FAQ',
    'a Jammarly user',
    'a 100 people',
    'an a',
    'an x and a x',
    'nasa is a agency'.replace('a agency', 'agency'),
    'the a-team',
    "I got a 'B' and a 'C'",
  ])('leaves %j alone', (text) => {
    expect(only(text, 'article', { protectedTerms: ['Jammarly'] })).toEqual([]);
  });

  it('exposes the phonetic decision', () => {
    expect(articleFor('hour')).toBe('an');
    expect(articleFor('university')).toBe('a');
    expect(articleFor('FBI')).toBe('an');
    expect(articleFor('URL')).toBe('a');
    expect(articleFor('SQL')).toBeNull();
    expect(articleFor('iPhone')).toBeNull();
    expect(articleFor('herb')).toBeNull();
    expect(articleFor('one')).toBe('a');
    expect(articleFor('onerous')).toBe('an');
    expect(articleFor('unique')).toBe('a');
    expect(articleFor('uninformed')).toBe('an');
    expect(articleFor('ewe')).toBe('a');
    expect(articleFor('x')).toBeNull();
  });

  it('acronym decisions are lower confidence and not auto-applied', () => {
    expect(only('a FBI agent', 'article')[0]).toMatchObject({ confidence: 0.85, autoApplySafe: false });
    expect(only('a apple', 'article')[0]).toMatchObject({ confidence: 0.9, autoApplySafe: true, severity: 'error' });
  });

  it('waits for the next word to be finished while typing', () => {
    expect(only('I saw a un', 'article', { typing: true })).toEqual([]);
    expect(only('I saw a un ', 'article', { typing: true })).toHaveLength(1);
    expect(only('I saw a un', 'article', { typing: false })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// confusable_word
// ---------------------------------------------------------------------------

describe('confusable_word', () => {
  it.each([
    ['I could of done it.', ['could of→could have']],
    ['You should of been there.', ['should of→should have']],
    ['They would of gone.', ['would of→would have']],
    ['It must of rained.', ['must of→must have']],
    ['She might of known.', ['might of→might have']],
    ['Could of helped.', ['Could of→Could have']],
    ['We would of the car.', []],
    ['I could of course help.', []],
    ['Think of the children.', []],
    ['Alot of people', ['Alot→A lot']],
    ['I like it alot.', ['alot→a lot']],
    ['It is apart of the plan.', ['apart→a part']],
    ['They grew apart of their own accord.', []],
    ['Set apart of the rest.', []],
    ['Your welcome.', ['Your→You\'re']],
    ['Thanks! your welcome', ['your→you\'re']],
    ['Your welcome gift is here.', []],
    ['I appreciate your welcome.', []],
    ['Your welcome to join.', ['Your→You\'re']],
    ['Your welcome, John.', ['Your→You\'re']],
    ['I would rather then not.', ['then→than']],
    ['More often then not.', ['then→than']],
    ['It is more important then ever.', ['then→than']],
    ['None other then you.', ['then→than']],
    ['If you want more cake then take it.', []],
    ['They looked at each other then left.', []],
    ['Rather then, we waited.', []],
    ['First this, then that.', []],
    ['Better then nothing.', []],
    ["It's hotter than ever and better then before.", ['then→than']],
  ])('%j', (text, expected) => {
    expect(fixes(text, 'confusable_word')).toEqual(expected);
  });

  it('flags its/it\'s and their/there only where the next words settle it, and leaves the ambiguous ones to the model', () => {
    const text = "Its a nice day and it's cat is there. There going to effect the affect. Their is a problem.";
    // "Its a" and "Their is" are certain; "and it's cat", "There going" and "effect the affect" are not.
    expect(fixes(text, 'confusable_word')).toEqual(["Its→It's", 'Their→There']);
  });

  it('confidence and tiering follow the contract', () => {
    expect(only('I could of done it.', 'confusable_word')[0]).toMatchObject({ confidence: 0.95, autoApplySafe: true, severity: 'error' });
    expect(only('alot', 'confusable_word')[0]).toMatchObject({ confidence: 0.95, autoApplySafe: true });
    expect(only('apart of it', 'confusable_word')[0]).toMatchObject({ confidence: 0.7, autoApplySafe: false, severity: 'warning' });
    expect(only('Your welcome.', 'confusable_word')[0]).toMatchObject({ confidence: 0.85, autoApplySafe: false });
    expect(only('rather then not', 'confusable_word')[0]).toMatchObject({ confidence: 0.85, autoApplySafe: false });
  });

  it('respects protected terms for "alot"', () => {
    expect(only('Alot is a brand.', 'confusable_word', { protectedTerms: ['alot'] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// terminal_punctuation
// ---------------------------------------------------------------------------

describe('terminal_punctuation', () => {
  it.each([
    ['Wow!!', ['!!→!']],
    ['Really??', ['??→?']],
    ['Yes,, no', [',,→,']],
    ['first;; second', [';;→;']],
    ['The end..', ['..→.']],
    ['Wow!!! Really???', ['!!!→!', '???→?']],
    ['Wait... what', []],
    ['Hmm.... ok', []],
    ['Really?!', []],
    ['What!?', []],
    ['Hmm?.. ok', []],
    ['Oh!.. no', []],
    ['Wow?!?!', []],
    ['a ?? b', []],
    ['x = !!y', []],
    ['range 1..5', []],
    ['../path and ./here', []],
    ['1,,000', []],
  ])('%j', (text, expected) => {
    expect(fixes(text, 'terminal_punctuation')).toEqual(expected);
  });

  it('is a warning in neutral email and a suggestion in chat, social or informal writing', () => {
    expect(only('Wow!!', 'terminal_punctuation')[0]).toMatchObject({ severity: 'warning', autoApplySafe: true, confidence: 0.9 });
    expect(only('Wow!!', 'terminal_punctuation', { context: 'chat' })[0]).toMatchObject({ severity: 'suggestion', autoApplySafe: false });
    expect(only('Wow!!', 'terminal_punctuation', { context: 'social' })[0]).toMatchObject({ severity: 'suggestion' });
    expect(only('Wow!!', 'terminal_punctuation', { formality: 'informal' })[0]).toMatchObject({ severity: 'suggestion' });
    expect(only('Wow!!', 'terminal_punctuation', { context: 'doc', formality: 'formal' })[0]).toMatchObject({ severity: 'warning' });
  });
});

// ---------------------------------------------------------------------------
// consistency_quote_style
// ---------------------------------------------------------------------------

describe('consistency_quote_style', () => {
  const RULE = 'consistency_quote_style';

  it('flags the minority style toward the majority when no decision was made', () => {
    const text = 'He said \u201chello\u201d and she said \u201cbye\u201d, but then "what" happened.';
    const hits = only(text, RULE);
    expect(hits.map((h) => `${h.original}→${h.replacement}`)).toEqual(['"→\u201c', '"→\u201d']);
    expect(hits.every((h) => h.severity === 'suggestion' && !h.autoApplySafe && h.confidence === 0.8 && h.kind === 'replace')).toBe(true);
    expect(apply(text, hits)).toBe('He said \u201chello\u201d and she said \u201cbye\u201d, but then \u201cwhat\u201d happened.');
  });

  it('converts curly to straight when straight is the majority', () => {
    const text = 'It\'s "fine", isn\'t it? Don\u2019t worry.';
    expect(fixes(text, RULE)).toEqual(['\u2019→\'']);
  });

  it('picks the right curly apostrophe and quote shapes', () => {
    const text = 'Rock \u2018n\u2019 roll in the \u201990s, \u201che said\u201d. Then \'tis "quoted" and it\'s \'fine\' \u2014 \u201cok\u201d \u2018yes\u2019.';
    const hits = only(text, RULE);
    const mapping = new Map(hits.map((h) => [h.range.start, h.replacement]));
    const idx = (needle: string, from = 0): number => text.indexOf(needle, from);
    expect(mapping.get(idx("'tis"))).toBe('\u2019');
    expect(mapping.get(idx('"quoted'))).toBe('\u201c');
    expect(mapping.get(idx('quoted"') + 6)).toBe('\u201d');
    expect(mapping.get(idx("it's") + 2)).toBe('\u2019');
    expect(mapping.get(idx("'fine"))).toBe('\u2018');
    expect(mapping.get(idx("fine'") + 4)).toBe('\u2019');
  });

  it('does nothing when only one style is used or the counts tie', () => {
    expect(only('He said "hi" and "bye".', RULE)).toEqual([]);
    expect(only('He said \u201chi\u201d and \u201cbye\u201d.', RULE)).toEqual([]);
    expect(only('He said "hi" and \u201cbye\u201d.', RULE)).toEqual([]);
    expect(only('No quotes here.', RULE)).toEqual([]);
  });

  it('follows styleDecisions.quotes and becomes auto-apply safe', () => {
    const text = 'He said "hi" and \u201cbye\u201d and it\'s fine.';
    const curly = only(text, RULE, { styleDecisions: { quotes: 'curly' } });
    expect(curly.map((h) => h.replacement)).toEqual(['\u201c', '\u201d', '\u2019']);
    expect(curly.every((h) => h.autoApplySafe && h.confidence === 0.95 && h.severity === 'suggestion')).toBe(true);
    const straight = only(text, RULE, { styleDecisions: { quotes: 'straight' } });
    expect(straight.map((h) => h.replacement)).toEqual(['"', '"']);
    expect(only('all "straight" here', RULE, { styleDecisions: { quotes: 'straight' } })).toEqual([]);
  });

  it('ignores primes and inch marks, code and masked ranges', () => {
    expect(only('He is 5\'10" tall and said \u201chi\u201d and \u201cbye\u201d.', RULE)).toEqual([]);
    expect(only('Say \u201chi\u201d and \u201cbye\u201d then `x = "y"` done.', RULE)).toEqual([]);
    expect(only('Say \u201chi\u201d and \u201cbye\u201d. See "a" and "b"', RULE, { masked: [{ start: 24, end: 36 }] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// consistency_hyphenation
// ---------------------------------------------------------------------------

describe('consistency_hyphenation', () => {
  const RULE = 'consistency_hyphenation';

  it('flags the minority dash style toward the majority', () => {
    const text = 'One thing\u2014another. Two things\u2014more. Three -- four.';
    const hits = only(text, RULE);
    expect(hits.map((h) => `${h.original}→${h.replacement}`)).toEqual([' -- →\u2014']);
    expect(hits[0]).toMatchObject({ severity: 'suggestion', autoApplySafe: false, confidence: 0.8 });
    expect(apply(text, hits)).toBe('One thing\u2014another. Two things\u2014more. Three\u2014four.');
  });

  it('recognises every style and honours styleDecisions.dash', () => {
    const text = 'a -- b. c\u2014d. e \u2014 f. g \u2013 h. i - j.';
    const cases: [string, string[]][] = [
      ['em_closed', [' -- ', ' \u2014 ', ' \u2013 ', ' - ']],
      ['en_spaced', [' -- ', '\u2014', ' \u2014 ', ' - ']],
      ['hyphen_spaced', [' -- ', '\u2014', ' \u2014 ', ' \u2013 ']],
    ];
    for (const [dash, originals] of cases) {
      const hits = only(text, RULE, { styleDecisions: { dash } });
      expect(hits.map((h) => h.original)).toEqual(originals);
      expect(hits.every((h) => h.autoApplySafe && h.confidence === 0.9)).toBe(true);
    }
    expect(only(text, RULE, { styleDecisions: { dash: 'en_spaced' } }).every((h) => h.replacement === ' \u2013 ')).toBe(true);
  });

  it('does nothing when styles tie, when only one is used, or for math, ranges and list bullets', () => {
    expect(only('a -- b and c \u2014 d', RULE)).toEqual([]);
    expect(only('a \u2014 b and c \u2014 d', RULE)).toEqual([]);
    expect(only('5 - 3 = 2 and 9\u20135 and 10 \u2013 20, so x\u2014y and z\u2014w', RULE)).toEqual([]);
    expect(only('- item one\n- item two\nso x\u2014y and z\u2014w', RULE)).toEqual([]);
    expect(only('well-known and up-to-date, so x\u2014y and z\u2014w', RULE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// consistency_spelling_variant
// ---------------------------------------------------------------------------

describe('consistency_spelling_variant', () => {
  const RULE = 'consistency_spelling_variant';

  it('ships a lexicon of at least 120 US/UK pairs', () => {
    const variants = spellingVariants();
    expect(variants.length).toBeGreaterThanOrEqual(120);
    const seen = new Set<string>();
    for (const v of variants) {
      expect(v.us).not.toBe(v.uk);
      expect(v.us).toBe(v.us.toLowerCase());
      expect(v.uk).toBe(v.uk.toLowerCase());
      seen.add(v.us);
      seen.add(v.uk);
    }
    for (const w of ['color', 'colour', 'organize', 'organise', 'center', 'centre', 'traveling', 'travelling', 'defense', 'defence', 'catalog', 'catalogue', 'gray', 'grey', 'analyze', 'analyse', 'favourite', 'theatre', 'realise', 'behaviour', 'colours', 'organisation']) {
      expect(seen.has(w)).toBe(true);
    }
    for (const w of ['program', 'programme', 'license', 'licence', 'practice', 'practise', 'advertise', 'surprise', 'exercise', 'promise', 'dialog', 'dialogue', 'analog', 'judgment', 'aesthetic']) {
      expect(seen.has(w)).toBe(false);
    }
  });

  it('flags UK forms under en-US and US forms under en-GB/CA/AU/IN', () => {
    expect(fixes('The colour and the organisation of the centre.', RULE)).toEqual(['colour→color', 'organisation→organization', 'centre→center']);
    for (const dialect of ['en-GB', 'en-CA', 'en-AU', 'en-IN'] as Dialect[]) {
      expect(expectsUkSpelling(dialect)).toBe(true);
      expect(fixes('The color and the organization of the center.', RULE, { dialect })).toEqual(['color→colour', 'organization→organisation', 'center→centre']);
      expect(fixes('The colour and the organisation of the centre.', RULE, { dialect })).toEqual([]);
    }
    expect(expectsUkSpelling('en-US')).toBe(false);
    expect(fixes('The color and the organization of the center.', RULE)).toEqual([]);
  });

  it('is a tier A correctness warning with confidence 0.9 and preserves case', () => {
    const [h] = only('Colour me surprised.', RULE);
    expect(h).toMatchObject({ severity: 'warning', autoApplySafe: true, confidence: 0.9, original: 'Colour', replacement: 'Color', kind: 'replace' });
    expect(fixes("the colour's depth", RULE)).toEqual(['colour→color']);
  });

  it.each([
    ['protected terms', 'I love colour.', { protectedTerms: ['Colour'] }],
    ['proper nouns mid-sentence', 'The Labour Party met at the Lincoln Centre.', {}],
    ['all caps', 'THE COLOUR IS RED', {}],
    ['program/programme and license/licence', 'The programme and the licence; a license to practise and a practice.', {}],
    ['ambiguous US forms under UK', 'Check the story and the curb, then tire the draft.', { dialect: 'en-GB' as const }],
    ['code and masks', '`colour` and https://colour.com and me@colour.com', {}],
    ['hyphenated compounds', 'a colour-blind test', {}],
  ])('skips %s', (_label, text, o) => {
    expect(only(text, RULE, o)).toEqual([]);
  });

  it('flags unambiguous UK forms of the one-directional pairs under en-US', () => {
    expect(fixes('Tyres on the kerb of the top storey; pay by cheque for the draught beer.', RULE)).toEqual([
      'Tyres→Tires',
      'kerb→curb',
      'storey→story',
      'cheque→check',
      'draught→draft',
    ]);
  });

  it('flags the minority form of a mixed family toward the majority when that matches the dialect', () => {
    const text = 'We use color here, color there, and colour over there. Colors everywhere.';
    const hits = only(text, RULE);
    expect(hits.map((h) => `${h.original}→${h.replacement}`)).toEqual(['colour→color']);
    const ukText = 'We use cheques here, cheques there and a check over there.';
    const ukHits = only(ukText, RULE, { dialect: 'en-GB' });
    expect(ukHits.map((h) => `${h.original}→${h.replacement}`)).toEqual(['check→cheque']);
    expect(ukHits[0]).toMatchObject({ severity: 'suggestion', autoApplySafe: false, confidence: 0.75 });
    // Under en-GB the UK forms are already right; the lone US form is flagged by the dialect rule, not twice.
    const mixedUk = only('The colour, the colour and the color.', RULE, { dialect: 'en-GB' });
    expect(mixedUk).toHaveLength(1);
    expect(mixedUk[0]).toMatchObject({ original: 'color', replacement: 'colour', confidence: 0.9 });
    // A majority that disagrees with the dialect never pulls the correct spellings along.
    expect(fixes('colour, colour, colour and color', RULE)).toEqual(['colour→color', 'colour→color', 'colour→color']);
  });
});

// ---------------------------------------------------------------------------
// consistency_serial_comma
// ---------------------------------------------------------------------------

describe('consistency_serial_comma', () => {
  const RULE = 'consistency_serial_comma';

  it('flags the minority style when the document has at least two lists', () => {
    const text = 'We bought apples, oranges, and pears. She likes red, white, and blue. He saw cats, dogs and birds.';
    const hits = only(text, RULE);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ original: 'dogs and', replacement: 'dogs, and', kind: 'insert', severity: 'suggestion', autoApplySafe: false, confidence: 0.75 });
    expect(apply(text, hits)).toContain('cats, dogs, and birds');

    const none = 'We bought apples, oranges and pears. She likes red, white and blue. He saw cats, dogs, and birds.';
    const noneHits = only(none, RULE);
    expect(noneHits.map((h) => `${h.original}→${h.replacement}`)).toEqual(['dogs, and→dogs and']);
    expect(noneHits[0]?.kind).toBe('replace');
  });

  it('needs two lists and a strict majority', () => {
    expect(only('We bought apples, oranges and pears.', RULE)).toEqual([]);
    expect(only('We bought apples, oranges and pears. She likes red, white, and blue.', RULE)).toEqual([]);
  });

  it('follows styleDecisions.serial_comma on every list', () => {
    const text = 'apples, oranges and pears; red, white, and blue; one, two or three';
    const oxford = only(text, RULE, { styleDecisions: { serial_comma: 'oxford' } });
    expect(oxford.map((h) => h.replacement)).toEqual(['oranges, and', 'two, or']);
    expect(oxford.every((h) => h.autoApplySafe && h.confidence === 0.9 && h.severity === 'suggestion')).toBe(true);
    const none = only(text, RULE, { styleDecisions: { serial_comma: 'none' } });
    expect(none.map((h) => h.replacement)).toEqual(['white and']);
  });

  it.each([
    'I bought apples, oranges, and then we left. She likes red, white, and blue.',
    'Yesterday, John ate apples and pears. She likes red, white, and blue.',
    'Later that day, John ate apples and pears. She likes red, white, and blue.',
    'He came, he saw and he left. She likes red, white, and blue.',
    'Well, apples and pears. She likes red, white, and blue.',
    'It costs 1,000, 2,000 and 3,000. She likes red, white, and blue.',
    'Thanks, Bob and Sue. She likes red, white, and blue.',
    'Yes, no and maybe, which I hate. She likes red, white, and blue.',
  ])('ignores non-list sentences in %j', (text) => {
    expect(only(text, RULE)).toEqual([]);
  });

  it('accepts multi-word items when they are parallel', () => {
    const text = 'We saw a red car, a blue bike and a green boat. She likes red, white, and blue. He saw cats, dogs, and birds.';
    expect(fixes(text, RULE)).toEqual(['bike and→bike, and']);
  });
});

// ---------------------------------------------------------------------------
// engine-level behaviour
// ---------------------------------------------------------------------------

describe('runRules', () => {
  it('returns [] for empty text and sorts hits by range.start', () => {
    expect(runRules('', opts())).toEqual([]);
    const text = 'the the cat.  i could of gone,but a apple fell.Then ok!!';
    const hits = run(text);
    assertHitInvariants(text, hits);
    expect(hits.map((h) => h.rule)).toEqual([
      'capitalization',
      'repeated_word',
      'spacing',
      'capitalization',
      'confusable_word',
      'spacing',
      'article',
      'spacing',
      'terminal_punctuation',
    ]);
  });

  it('skips muted rules', () => {
    const text = 'the the cat.  i could of gone,but a apple fell.Then ok!!';
    const all = run(text);
    const muted = run(text, { mutedRules: ['spacing', 'repeated_word'] });
    expect(muted.some((h) => h.rule === 'spacing' || h.rule === 'repeated_word')).toBe(false);
    expect(muted.length).toBe(all.filter((h) => h.rule !== 'spacing' && h.rule !== 'repeated_word').length);
    expect(run(text, { mutedRules: [...RULE_IDS] })).toEqual([]);
  });

  it('never touches masked ranges, and the stripUrlsAndCode masks cover URLs, emails, code and handles', () => {
    const text = 'see https://x.com/the the  page , me.me@x.com,`the the` and @bob bob the the end';
    const { masked } = stripUrlsAndCode(text);
    const hits = runRules(text, opts({ masked }));
    assertHitInvariants(text, hits, masked);
    expect(hits.map((h) => h.original)).toEqual(['see', '  ', ' ,', 'the the']);
    expect(hits[3]?.range.start).toBe(text.lastIndexOf('the the'));
  });

  it('treats explicit masked ranges as untouchable even without stripUrlsAndCode', () => {
    const text = 'the the cat and the the dog';
    expect(runRules(text, opts({ masked: [{ start: 0, end: 7 }] })).map((h) => h.original)).toEqual(['the the']);
    expect(runRules(text, opts({ masked: [{ start: 3, end: 5 }] })).filter((h) => h.rule === 'repeated_word').map((h) => h.range.start)).toEqual([16]);
    expect(runRules(text, opts({ masked: [{ start: -5, end: 1000 }] }))).toEqual([]);
  });

  it('does not read across a mask', () => {
    // The mask hides "https://x.com"; "is" must not be read as a sentence start, nor "a" + mask as an article error.
    expect(run('Done. https://x.com is great and a https://x.com link.')).toEqual([]);
    expect(run('Email me@x.com please')).toEqual([]);
  });

  it('skips paragraphs that read as code and keeps prose paragraphs around them', () => {
    const text = 'the the start\nconst x = foo(a,b);\nfunction bar() { return x;;}\nif (a == b) { return "the the"; }\nthe the end';
    const hits = run(text);
    expect(hits.map((h) => `${h.rule}@${h.range.start}`)).toEqual(['capitalization@0', 'repeated_word@0', `repeated_word@${text.lastIndexOf('the the')}`]);
  });

  describe('typing guard', () => {
    it('drops hits that touch the word in progress and restores them once the word is finished', () => {
      expect(run('I like the the', { typing: true })).toEqual([]);
      expect(run('I like the the ', { typing: true }).map((h) => h.rule)).toEqual(['repeated_word']);
      expect(run('I like the the.', { typing: true }).map((h) => h.rule)).toEqual(['repeated_word']);
      expect(run('I like the the', { typing: false }).map((h) => h.rule)).toEqual(['repeated_word']);
    });

    it('keeps hits that are not touching the last word', () => {
      expect(run('the the cat sat on the ma', { typing: true }).map((h) => h.rule).sort()).toEqual(['capitalization', 'repeated_word']);
      expect(run('hello  wor', { typing: true }).map((h) => h.original)).toEqual(['hello', '  ']);
    });

    it('suppresses an unfinished sentence-start word, lone i and a missing space anchored on the last word', () => {
      expect(run('Done. hel', { typing: true })).toEqual([]);
      expect(run('And i', { typing: true })).toEqual([]);
      expect(run('And i ', { typing: true }).map((h) => h.rule)).toEqual(['capitalization']);
      expect(run('home.Th', { typing: true })).toEqual([]);
      expect(run('home.Then ', { typing: true }).map((h) => h.rule)).toEqual(['spacing']);
    });

    it('treats text ending in punctuation or an emoji as complete', () => {
      expect(run('I like the the!', { typing: true })).toHaveLength(1);
      expect(run('I like the the \u{1F600}', { typing: true })).toHaveLength(1);
      expect(run('Wow!!', { typing: true }).map((h) => h.rule)).toEqual(['terminal_punctuation']);
    });
  });

  describe('unicode', () => {
    it('keeps exact offsets around emoji, NBSP and curly quotes', () => {
      const text = '\u{1F600} the the cat\u00a0\u00a0sat. \u201cok\u201d i said \u{1F600}\u{1F600} a apple';
      const hits = run(text);
      assertHitInvariants(text, hits);
      expect(hits.map((h) => `${h.rule}:${h.original}`)).toEqual([
        'repeated_word:the the',
        'spacing:\u00a0\u00a0',
        'capitalization:i',
        'article:a',
      ]);
    });

    it('handles curly apostrophes in words and does not split surrogate pairs', () => {
      const text = 'Don\u2019t don\u2019t do it \u{1F602}\u{1F602}';
      const hits = run(text);
      assertHitInvariants(text, hits);
      expect(hits.map((h) => h.original)).toEqual(['Don\u2019t don\u2019t']);
    });

    it('does not flag non-Latin scripts or accented words as spelling variants or capitalization errors', () => {
      const text = 'Ça va. Élan vital. Привет мир. こんにちは world';
      const hits = run(text);
      expect(hits.filter((h) => h.rule === 'consistency_spelling_variant')).toEqual([]);
      assertHitInvariants(text, hits);
    });
  });

  describe('dialect switches', () => {
    it('only the spelling-variant rule depends on the dialect', () => {
      const text = 'the the colour , and a apple.Then';
      const us = run(text, { dialect: 'en-US' });
      const gb = run(text, { dialect: 'en-GB' });
      expect(us.filter((h) => h.rule !== 'consistency_spelling_variant')).toEqual(gb.filter((h) => h.rule !== 'consistency_spelling_variant'));
      expect(us.filter((h) => h.rule === 'consistency_spelling_variant').map((h) => h.replacement)).toEqual(['color']);
      expect(gb.filter((h) => h.rule === 'consistency_spelling_variant')).toEqual([]);
    });
  });

  it('runs 5,000 words of mixed prose in under 60 ms', () => {
    const sentences = [
      'The quick brown fox jumps over the lazy dog, and the dog does not care.',
      'We organise the colour palette in the theatre every autumn.',
      'He said "it is fine" and she said \u201cit is not\u201d, which was a problem.',
      'Please review the attached report by Friday, then send it to the team.',
      'There are apples, oranges, and pears on the table -- take one.',
      'The meeting is at 9:30; the budget is 1,000 dollars and version 1.2.3 ships.',
      'Visit https://example.com/docs or email team@example.com for details.',
      'I think this is an honest mistake, but a unique one.',
    ];
    let text = '';
    let i = 0;
    while (text.split(/\s+/).length < 5000) {
      text += (i % 7 === 6 ? '\n' : ' ') + (sentences[i % sentences.length] ?? '');
      i++;
    }
    text = text.trim();
    const { masked } = stripUrlsAndCode(text);
    const o = opts({ masked });
    runRules(text, o); // warm up (lazy lexicon build, JIT)
    const times: number[] = [];
    for (let k = 0; k < 5; k++) times.push(elapsed(() => runRules(text, o)));
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(60);
    const hits = runRules(text, o);
    assertHitInvariants(text, hits, masked);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('keeps a 150-word paragraph under 2 ms', () => {
    const paragraph = ('The committee reviewed the colour scheme, the the budget and a apple pie recipe. ' +
      'It could of gone better, but your welcome to try again. ' +
      'We left home.Then we came back , and it was fine!! ').repeat(5);
    const o = opts({ masked: stripUrlsAndCode(paragraph).masked });
    runRules(paragraph, o);
    const times: number[] = [];
    for (let k = 0; k < 7; k++) times.push(elapsed(() => runRules(paragraph, o)));
    times.sort((a, b) => a - b);
    expect(times[3]).toBeLessThan(2);
  });

  it('property: every hit satisfies original === text.slice(start, end) on random concatenations of fixtures', () => {
    const fixtures = [
      'the the cat sat.',
      'i could of done it,but no.',
      'A apple a day.',
      'He said "hi" and \u201cbye\u201d.',
      'colour and color and organise.',
      'apples, oranges and pears; red, white, and blue.',
      'one -- two \u2014 three - four\u2014five.',
      'Wow!! Really?? ok...',
      '  indented\tline  ',
      'see https://example.com/a?b=c and me@x.com and @bob and `code the the`',
      'const x = 1;\nfunction f() { return x; }',
      '\u{1F600} emoji \u00a0 nbsp \u2019 curly',
      'Dr. smith met e.g. the U.S. team at 9:30.',
      'your welcome. Your welcome gift.',
      'rather then not, more often then not.',
      '',
      '\n',
      ' ',
    ];
    const separators = [' ', '  ', '\n', '\n\n', '', '. ', ', ', '\u00a0', ' \u{1F600} '];
    const rng = makeRng(20261019);
    const dialects: Dialect[] = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'];
    for (let round = 0; round < 300; round++) {
      const parts = Math.floor(rng() * 6) + 1;
      let text = '';
      for (let p = 0; p < parts; p++) text += pick(rng, fixtures) + pick(rng, separators);
      const { masked } = stripUrlsAndCode(text);
      const o = opts({
        masked,
        typing: rng() < 0.3,
        dialect: pick(rng, dialects),
        context: pick(rng, ['email', 'chat', 'doc', 'social', 'code', 'other'] as const),
        formality: pick(rng, ['informal', 'neutral', 'formal'] as const),
        styleDecisions: rng() < 0.3 ? { quotes: 'curly', dash: 'em_closed', serial_comma: 'oxford', double_space_after_period: 'keep' } : {},
        protectedTerms: rng() < 0.3 ? ['colour', 'the'] : [],
        mutedRules: rng() < 0.2 ? ['spacing'] : [],
      });
      const hits = runRules(text, o);
      assertHitInvariants(text, hits, masked);
      if (o.typing && text.length > 0 && !/[\s\p{P}\p{S}]$/u.test(text)) {
        let k = text.length;
        while (k > 0 && !/\s/.test(text.charAt(k - 1))) k--;
        for (const h of hits) expect(h.range.end).toBeLessThanOrEqual(k);
      }
      for (const h of hits) expect(o.mutedRules).not.toContain(h.rule);
      // Applying all non-overlapping hits must not throw and must change the text when there are hits.
      const applied = apply(text, hits);
      if (hits.length > 0) expect(applied).not.toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// hitsToSuggestions
// ---------------------------------------------------------------------------

describe('hitsToSuggestions', () => {
  const text = 'the the cat sat.\nWe left home.Then i could of gone.\n\nShe said "hi" and \u201cbye\u201d and \u201cok\u201d.';
  const blocks: Paragraph[] = splitParagraphs(text);
  const hits = run(text);
  const suggestions = hitsToSuggestions(hits, { blocks, promptVersion: 'rules-v1' });

  it('produces one Suggestion per hit with the rule fields copied', () => {
    expect(suggestions).toHaveLength(hits.length);
    suggestions.forEach((s, i) => {
      const h = hits[i];
      if (h === undefined) throw new Error('missing hit');
      expect(s).toMatchObject({
        category: h.category,
        rule: h.rule,
        severity: h.severity,
        kind: h.kind,
        source: 'rules',
        range: h.range,
        original: h.original,
        replacement: h.replacement,
        title: h.title,
        explanation: h.explanation,
        confidence: h.confidence,
        meaningPreserving: h.meaningPreserving,
        autoApplySafe: h.autoApplySafe,
        promptVersion: 'rules-v1',
        learnedState: 'active',
        alternatives: [],
      });
      expect(s.model).toBeUndefined();
    });
  });

  it('assigns stable ids and fingerprints', () => {
    const again = hitsToSuggestions(run(text), { blocks, promptVersion: 'rules-v1' });
    expect(again.map((s) => s.id)).toEqual(suggestions.map((s) => s.id));
    const ids = new Set(suggestions.map((s) => s.id));
    expect(ids.size).toBe(suggestions.length);
    for (const s of suggestions) {
      expect(s.id).toBe(hashText(`${s.rule}|${s.range.start}|${s.range.end}|${s.replacement}`));
      expect(s.fingerprint).toBe(hashText(`${s.rule}|${normalizeForMatch(s.original)}|${normalizeForMatch(s.replacement)}`));
    }
    // Same rule/original/replacement elsewhere shares the fingerprint, not the id.
    const other = hitsToSuggestions(run('and the the end'), { blocks: splitParagraphs('and the the end'), promptVersion: 'rules-v1' });
    const repeated = suggestions.find((s) => s.rule === 'repeated_word');
    const otherRepeated = other.find((s) => s.rule === 'repeated_word');
    expect(otherRepeated?.fingerprint).toBe(repeated?.fingerprint);
    expect(otherRepeated?.id).not.toBe(repeated?.id);
  });

  it('tiers: A for auto-apply-safe correctness, B otherwise', () => {
    for (const s of suggestions) expect(s.tier).toBe(s.autoApplySafe && s.category === 'correctness' ? 'A' : 'B');
    expect(suggestions.find((s) => s.rule === 'repeated_word')?.tier).toBe('A');
    expect(suggestions.find((s) => s.rule === 'consistency_quote_style')?.tier).toBe('B');
  });

  it('resolves blockId and blockHash from the containing paragraph', () => {
    for (const s of suggestions) {
      const block = blocks.find((b) => s.range.start >= b.start && s.range.start < b.start + b.text.length);
      if (block === undefined) throw new Error('no block');
      expect(s.blockId).toBe(String(block.index));
      expect(s.blockHash).toBe(block.hash);
      expect(block.hash).toBe(hashText(block.text));
    }
    expect(new Set(suggestions.map((s) => s.blockId))).toEqual(new Set(['0', '1', '2']));
  });

  it('highlights the adjacent words for insertions and the range otherwise', () => {
    const insert = suggestions.find((s) => s.kind === 'insert');
    if (insert === undefined) throw new Error('expected an insertion');
    expect(insert.original).toBe('.T');
    expect(text.slice(insert.highlight.start, insert.highlight.end)).toBe('home.Then');
    for (const s of suggestions) if (s.kind !== 'insert') expect(s.highlight).toEqual(s.range);
  });

  it('falls back gracefully when blocks are missing', () => {
    const s = hitsToSuggestions(run('the the'), { blocks: [], promptVersion: 'v' });
    expect(s[0]).toMatchObject({ blockId: '', blockHash: hashText('') });
    const s2: Suggestion[] = hitsToSuggestions([], { blocks, promptVersion: 'v' });
    expect(s2).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// adversarial: false-positive traps, anchoring traps, schema constraints, folding, stability, performance
// ---------------------------------------------------------------------------

describe('adversarial', () => {
  const TITLE_VALUES = new Set(Object.values(RULE_TITLES));
  const KINDS = new Set(['replace', 'delete', 'insert', 'rewrite', 'flag']);
  const SEVERITIES = new Set(['error', 'warning', 'suggestion']);
  const RULE_ID_SET = new Set<string>(RULE_IDS);

  /** A corpus that exercises every rule, every variant key and most guards at once. */
  const CORPUS: string[] = [
    'the the cat sat.  i could of gone,but a apple fell.Then ok!!',
    'He said "hi" and “bye” and “ok”. one -- two — three — four.',
    'colour, colour, colour and color. apples, oranges and pears; red, white, and blue; one, two, and three.',
    'Your welcome. rather then not. your welcome. More often then not. It is apart of the plan.',
    'line one \nline two\t\nDone.\nnext line\r\nWe left home.Then we came back , and it was fine!!',
    '\u{1F600} the the cat  sat. “ok” i said \u{1F600}\u{1F600} a apple and an university.',
    'see https://x.com/the the  page , me.me@x.com,`the the` and @bob bob the the end',
    'const x = foo(a,b);\nfunction bar() { return x;;}\nthe the prose after code',
    'Dr. smith met e.g. the U.S. team at 9:30. the colour of the centre was gray. Wow!!! Really???',
    'Alot of people would of liked it. A elephant walked. Hi. An dog barked. a FBI agent and an URL.',
  ];

  function corpusHits(partial: Partial<RuleOptions> = {}): { text: string; hits: RuleHit[]; masked: TextRange[] }[] {
    return CORPUS.map((text) => {
      const { masked } = stripUrlsAndCode(text);
      return { text, masked, hits: runRules(text, opts({ ...partial, masked })) };
    });
  }

  // -------------------------------------------------------------------------
  // performance: pathological inputs must stay linear
  // -------------------------------------------------------------------------

  describe('performance', () => {
    it('stays linear on long whitespace and punctuation runs (quadratic regex trap)', () => {
      run('warm up the the'); // lexicon + JIT
      const cases: [string, string][] = [
        ['20k spaces then a letter', ' '.repeat(20_000) + 'x'],
        ['20k spaces between words', 'word' + ' '.repeat(20_000) + 'word'],
        ['20k tabs between words', 'word' + '\t'.repeat(20_000) + 'word'],
        ['20k NBSP between words', 'word' + ' '.repeat(20_000) + 'word'],
        ['20k narrow NBSP before a letter', 'word' + ' '.repeat(20_000) + 'x'],
        ['20k dots between letters', 'a' + '.'.repeat(20_000) + 'b'],
        ['20k bangs then a letter', 'a' + '!'.repeat(20_000) + 'b'],
        ['20k question marks then a space and a letter', 'a' + '?'.repeat(20_000) + ' b'],
        ['20k commas', 'a' + ','.repeat(20_000) + 'b'],
        ['mixed terminator run then closers', 'a' + '?!.'.repeat(7_000) + '") x'],
        ['5k trailing-whitespace lines', 'x \n'.repeat(5_000)],
        ['5k list-like fragments', 'word, '.repeat(5_000)],
        ['long identical words (backreference trap)', ('a'.repeat(400) + ' ').repeat(50) + 'b'.repeat(2_000) + ' ' + 'b'.repeat(2_000)],
        ['long run of straight and curly quotes', '"'.repeat(3_000) + '“'.repeat(2_000)],
        ['long dash soup', 'a -- b '.repeat(2_000) + 'c—d '.repeat(1_000)],
        ['50k newlines', '\n'.repeat(50_000)],
        ['50k mixed whitespace', ' \n\t\u00a0'.repeat(12_500)],
        ['2,400 indented blank lines', (' '.repeat(20) + '\n').repeat(2_400)],
        ['2,400 semicolons then a whitespace run', ';'.repeat(2_400) + ' '.repeat(50_000) + 'x'],
        ['2,400 keyword-led lines', 'for x\n'.repeat(2_400) + ' '.repeat(20_000)],
      ];
      for (const [label, text] of cases) {
        const o = opts({ masked: stripUrlsAndCode(text).masked });
        const times = [elapsed(() => runRules(text, o)), elapsed(() => runRules(text, o)), elapsed(() => runRules(text, o))];
        times.sort((a, b) => a - b);
        // Each of these took 0.8-2.4 s before the run-start lookbehinds were added; keep a generous CI margin.
        expect(times[1], label).toBeLessThan(60);
        assertHitInvariants(text, runRules(text, o));
      }
    });

    it('a single 50 KB word and a 50 KB whitespace-only text are cheap and produce nothing', () => {
      const word = 'X'.repeat(50_000);
      expect(elapsed(() => expect(run(word)).toEqual([]))).toBeLessThan(60);
      // A lowercase one is a sentence-start hit whose anchor is capped at 64 code units (still a valid edit).
      const lower = 'x'.repeat(50_000);
      expect(run(lower).map((h) => [h.rule, h.range.end, h.replacement.charAt(0)])).toEqual([['capitalization', 64, 'X']]);
      const blank = ' \n\t '.repeat(12_500);
      expect(elapsed(() => expect(run(blank)).toEqual([]))).toBeLessThan(60);
    });
  });

  // -------------------------------------------------------------------------
  // false-positive traps
  // -------------------------------------------------------------------------

  describe('false-positive traps', () => {
    it.each<[string, string[]]>([
      ['He lives in Mass. and works in Conn. too.', []],
      ['She moved from Calif. to Fla. last year.', []],
      ['The Ph.D. candidates left. then we ate.', ['then→Then']],
      ['The meeting is at 3 p.m. tomorrow. we will see.', ['we→We']],
      ['At 9 a.m. sharp. Then i left.', ['i→I']],
      ['See No. 5 and no. 6 below.', []],
      ['Acme Inc. is here. acme Ltd. too.', ['acme→Acme']],
      ['On Sept. 3 we left. ok', []],
      ['Red vs. blue is the game.', []],
      ['apples, pears, etc. are fruit.', ['apples→Apples']],
      ['Hmm… what? no.', ['no→No']],
      ['J. R. R. tolkien and C. S. lewis met.', []],
      ['It costs 3.5. then we left. Step 3. then go.', []],
      ['Wait... what? no... maybe.', ['no→No']],
    ])('abbreviations and initials: %j', (text, expected) => {
      expect(fixes(text, 'capitalization')).toEqual(expected);
    });

    it.each([
      'Set fooBar.baz and the_var.x then call doIt().',
      'Set DEBUG=true,VERBOSE=false and go.',
      'Open ~/Documents/report.pdf,then save.',
      'Color #FF00FF,then #00FF00.',
      'Upgrade to v1.2.3,then v2.',
      'Match /^a+$/i then stop.',
      'Where i is the index and i < n and x_i holds.',
      'Items (i) and (ii) are done.',
      'Run npm i and then npm test.',
      'Run pnpm i -D vitest or yarn i or bun i.',
      'Use std::vector<int> and Foo::Bar here.',
      'The key:value pairs and a=b;c=d lines.',
      'Call window.foo.bar() and document.body.x now.',
      'Email a.b@c.com or visit a.b.c.example.org now.',
    ])('code-like tokens never trip spacing, capitalization or article: %j', (text) => {
      const hits = run(text).filter((h) => h.rule === 'spacing' || h.rule === 'capitalization' || h.rule === 'article');
      expect(hits.map((h) => `${h.rule}:${h.original}→${h.replacement}`)).toEqual([]);
    });

    it('a code paragraph is skipped but the prose around it, and prose that merely mentions keywords, is not', () => {
      expect(run('I will return the the book.').map((h) => h.rule)).toEqual(['repeated_word']);
      expect(run("if you want, let's fix the the thing.").map((h) => h.rule)).toEqual(['capitalization', 'repeated_word']);
      expect(run('Send {name, email} and the the id.').map((h) => h.rule)).toEqual(['repeated_word']);
      const code = 'the the intro\nfor (let i = 0; i < n; i++) { total += i; }\nreturn the the book;';
      // The middle line is code; the last line starts with a keyword and ends with ";" so it reads as code too.
      expect(run(code).map((h) => `${h.rule}@${h.range.start}`)).toEqual(['capitalization@0', 'repeated_word@0']);
    });

    it.each([
      ['doubled names', 'Bora Bora. Duran Duran. Sirhan Sirhan. Walla Walla. Pago Pago.', 'repeated_word', {}],
      ['proper nouns mid-sentence', 'We met the Labour Party at the Lincoln Centre near Pearl Harbor.', 'consistency_spelling_variant', {}],
      ['brand at a sentence start (en-GB)', 'Harbor Freight is a store. Center Street is nearby.', 'consistency_spelling_variant', { dialect: 'en-GB' as const }],
      ['party at a sentence start (en-US)', 'Labour Party members met. Centre Pompidou opened.', 'consistency_spelling_variant', {}],
      ['title-cased heading', 'Colour Me Surprised', 'consistency_spelling_variant', {}],
    ])('%s are not flagged', (_label, text, rule, o) => {
      expect(only(text, rule, o)).toEqual([]);
    });

    it('still flags a lone sentence-initial variant that is not part of a name', () => {
      expect(fixes('Colour me surprised. Centre the text.', 'consistency_spelling_variant')).toEqual(['Colour→Color', 'Centre→Center']);
    });

    it('all-lowercase chat prose stays untouched even when a URL, email or inline code contains capitals', () => {
      for (const text of [
        'hey i think https://github.com/Foo/Bar is fine. lets go',
        'hey i think `Foo` is fine. lets go',
        'mail Me@Example.com and i will reply. ok',
        'ping @BobSmith and i will follow up',
      ]) {
        expect(only(text, 'capitalization', { context: 'chat' })).toEqual([]);
      }
      // A real capital in the prose means the writer does use capitals, so the lowercase "i" is a slip.
      expect(fixes('Hey i think it is fine. lets go', 'capitalization', { context: 'chat' })).toEqual(['i→I', 'lets→Lets']);
      // Outside chat the lowercase style is still corrected.
      expect(fixes('hey i think https://github.com/Foo/Bar is fine', 'capitalization')).toEqual(['hey→Hey', 'i→I']);
    });

    it('informal writing softens sentence-initial capitalization to a warning, chat to a suggestion', () => {
      const text = 'hello there. this is i speaking.';
      expect(only(text, 'capitalization', { formality: 'informal' }).map((h) => [h.severity, h.autoApplySafe])).toEqual([
        ['warning', true], ['warning', true], ['warning', true],
      ]);
      expect(only(text, 'capitalization', { formality: 'neutral' }).every((h) => h.severity === 'error')).toBe(true);
      expect(only(text, 'capitalization', { formality: 'formal', context: 'doc' }).every((h) => h.severity === 'error')).toBe(true);
      expect(only('Hello. this is i.', 'capitalization', { formality: 'informal', context: 'chat' }).every((h) => h.severity === 'suggestion' && !h.autoApplySafe)).toBe(true);
    });

    it('sentence openers and vocatives before a comma are not the first item of a list', () => {
      const RULE = 'consistency_serial_comma';
      const oxfordBias = ' She likes red, white, and blue. He saw cats, dogs, and birds.';
      for (const opener of [
        'However, John and Mary left.',
        'Thank you, John and Jane.',
        'Thanks, Bob and Sue.',
        'Unfortunately, Bob and Sue left early.',
        'Of course, Bob and Sue came.',
        'Hi Bob, Mary and I are here.',
        'For example, cats and dogs.',
        'In short, apples and pears.',
        'Yesterday, apples and pears were cheap.',
      ]) {
        expect(only(opener + oxfordBias, RULE), opener).toEqual([]);
        expect(only(opener, RULE, { styleDecisions: { serial_comma: 'oxford' } }), opener).toEqual([]);
      }
      // A genuine list that opens a sentence is still a list.
      expect(fixes('Apples, oranges and pears are fruit.', RULE, { styleDecisions: { serial_comma: 'oxford' } })).toEqual(['oranges and→oranges, and']);
      expect(fixes('Apples, oranges and pears are fruit.' + oxfordBias, RULE)).toEqual(['oranges and→oranges, and']);
      expect(fixes('In 2019, 2020 and 2021 we grew.' + oxfordBias, RULE)).toEqual(['2020 and→2020, and']);
    });

    it('never flags trailing whitespace in chat or code fields, but does in email and docs', () => {
      const text = 'line one \nline two';
      for (const context of ['chat', 'code'] as const) expect(only(text, 'spacing', { context })).toEqual([]);
      for (const context of ['email', 'doc', 'social', 'other'] as const) expect(only(text, 'spacing', { context }).map((h) => h.title)).toEqual([RULE_TITLES['spacing.trailing_whitespace']]);
    });

    it('typing guard at the end of the text: only a letter/digit run is a word in progress', () => {
      const cases: [string, string[]][] = [
        ['I like the the', []],
        ['I like the the)', ['repeated_word']],
        ['I like the the"', ['repeated_word']],
        ['I like the the ', ['repeated_word']],
        ['I like the the…', ['repeated_word']],
        ['I like the the \u{1F600}', ['repeated_word']],
        ['I like the the \u{1F600}wor', ['repeated_word']],
        ['I like the the 42', ['repeated_word']],
        ['I like the the https://x.co', ['repeated_word']],
        ['I like the the well-', ['repeated_word']],
        ['home.Then', []],
        ['home.Then,', ['spacing']],
        ['I saw a un', []],
        ['I saw a un.', ['article']],
        ['I could of', []],
        ['I could of don', []],
        ['I could of done', ['confusable_word']], // the hit spans "could of", which is finished; "could of" is never right
        ['I could of done ', ['confusable_word']],
        ['Your welcom', []],
        ['Your welcome', []],
        ['Your welcome.', ['confusable_word']],
        ['Wow!!', ['terminal_punctuation']],
        ['hello  wor', ['capitalization', 'spacing']], // "hello" is complete, so its sentence-start hit stays
        ['hello  ', ['capitalization']], // trailing double space is the live edit point, "hello" is done
      ];
      for (const [text, expected] of cases) {
        expect(run(text, { typing: true }).map((h) => h.rule), JSON.stringify(text)).toEqual(expected);
      }
    });
  });

  // -------------------------------------------------------------------------
  // anchoring traps
  // -------------------------------------------------------------------------

  describe('anchoring traps', () => {
    it('no hit ever crosses a paragraph boundary, and blockId/blockHash come from the paragraph that holds it', () => {
      const texts = [
        ...CORPUS,
        'home.Then\r\nthe the end\r\n\r\nShe said "hi" and “bye” and “ok”.',
        'trailing \r\n\r\n  indented  \n\nlast line  ',
        '\n\nthe the\n\n',
      ];
      for (const text of texts) {
        const blocks = splitParagraphs(text);
        const hits = run(text);
        const suggestions = hitsToSuggestions(hits, { blocks, promptVersion: 'v' });
        for (const s of suggestions) {
          const block = blocks.find((b) => s.range.start >= b.start && s.range.start < b.start + b.text.length);
          if (block === undefined) throw new Error(`hit outside every paragraph: ${JSON.stringify(s.original)} in ${JSON.stringify(text)}`);
          expect(s.range.end).toBeLessThanOrEqual(block.start + block.text.length);
          expect(s.blockId).toBe(String(block.index));
          expect(s.blockHash).toBe(block.hash);
          expect(s.highlight.end).toBeLessThanOrEqual(block.start + block.text.length);
          expect(s.highlight.start).toBeGreaterThanOrEqual(block.start);
          expect(s.original).not.toMatch(/[\r\n]/);
        }
      }
    });

    it('keeps UTF-16 offsets exact with emoji, combining marks and curly quotes before the span', () => {
      const text = '\u{1F600}\u{1F600} café́ “ok” home.Then i said « the the »';
      const hits = run(text);
      assertHitInvariants(text, hits);
      expect(hits.map((h) => `${h.rule}:${h.original}→${h.replacement}`)).toEqual([
        'spacing:.T→. T',
        'capitalization:i→I',
        'repeated_word:the the→the',
      ]);
      const blocks = splitParagraphs(text);
      const [insert] = hitsToSuggestions(hits, { blocks, promptVersion: 'v' });
      expect(insert?.kind).toBe('insert');
      expect(text.slice(insert?.highlight.start, insert?.highlight.end)).toBe('home.Then');
      // The highlight never splits a surrogate pair.
      for (const s of hitsToSuggestions(hits, { blocks, promptVersion: 'v' })) {
        expect(text.charCodeAt(s.highlight.start) >>> 10).not.toBe(0x37); // not a low surrogate (0xDC00..0xDFFF)
        expect(text.charCodeAt(s.highlight.end - 1) >>> 10).not.toBe(0x36); // not a high surrogate (0xD800..0xDBFF)
      }
    });

    it('repeated phrases get distinct ids but one fingerprint, and ids never collide across a corpus', () => {
      const text = 'the the cat and the the dog and the the bird';
      const s = hitsToSuggestions(run(text), { blocks: splitParagraphs(text), promptVersion: 'v' });
      expect(s.map((x) => x.rule)).toEqual(['capitalization', 'repeated_word', 'repeated_word', 'repeated_word']);
      const repeated = s.filter((x) => x.rule === 'repeated_word');
      expect(new Set(repeated.map((x) => x.id)).size).toBe(3);
      expect(new Set(repeated.map((x) => x.fingerprint)).size).toBe(1);
      // id separators: (rule, 1, 21, r) and (rule, 12, 1, r) must not share an id.
      expect(hashText('repeated_word|1|21|the')).not.toBe(hashText('repeated_word|12|1|the'));
      const all = corpusHits().flatMap(({ text: t, hits }) => hitsToSuggestions(hits, { blocks: splitParagraphs(t), promptVersion: 'v' }).map((x) => `${hashText(t)}:${x.id}`));
      expect(new Set(all).size).toBe(all.length);
    });

    it('insertions at the very start or end of the text highlight the enclosing words without running off the text', () => {
      const atEnd = 'home.Then';
      const [e] = hitsToSuggestions(run(atEnd), { blocks: splitParagraphs(atEnd), promptVersion: 'v' });
      expect(e?.highlight).toEqual({ start: 0, end: atEnd.length });
      const list = 'apples, oranges and pears';
      const [l] = hitsToSuggestions(only(list, 'consistency_serial_comma', { styleDecisions: { serial_comma: 'oxford' } }), { blocks: splitParagraphs(list), promptVersion: 'v' });
      expect(l).toMatchObject({ kind: 'insert', original: 'oranges and' });
      expect(list.slice(l?.highlight.start, l?.highlight.end)).toBe('oranges and');
      // Blocks handed over out of order resolve the same way; stale (too short) blocks fall back to the range.
      const text = 'First block\n\nhome.Then';
      const blocks = splitParagraphs(text);
      const sorted = hitsToSuggestions(run(text), { blocks, promptVersion: 'v' });
      const reversed = hitsToSuggestions(run(text), { blocks: [...blocks].reverse(), promptVersion: 'v' });
      expect(reversed).toEqual(sorted);
      expect(sorted[0]?.blockId).toBe('1');
      const stale = hitsToSuggestions(run(text), { blocks: [blocks[0] as Paragraph], promptVersion: 'v' });
      expect(stale[0]?.highlight).toEqual(stale[0]?.range);
      expect(stale[0]?.blockId).toBe('0');
    });

    it('placeholder-adjacent spans: a hit may touch a mask edge but never overlap it, and odd masks never crash', () => {
      const text = 'the the @bob the the';
      const { masked } = stripUrlsAndCode(text); // masks "@bob"
      const at = text.indexOf('@bob');
      expect(masked).toEqual([{ start: at, end: at + 4 }]);
      const hits = runRules(text, opts({ masked }));
      expect(hits.map((h) => `${h.rule}:${h.range.start}-${h.range.end}`)).toEqual(['capitalization:0-3', 'repeated_word:0-7', `repeated_word:${at + 5}-${at + 12}`]);
      // "the the" ends one code unit before the mask and the next one starts one code unit after it.
      expect(hits[1]?.range.end).toBe(at - 1);
      expect(hits[2]?.range.start).toBe(at + 5);
      // Overlapping by a single code unit drops the hit.
      expect(runRules('the the cat', opts({ masked: [{ start: 6, end: 8 }] })).filter((h) => h.rule === 'repeated_word')).toEqual([]);
      expect(runRules('the the cat', opts({ masked: [{ start: 7, end: 8 }] })).filter((h) => h.rule === 'repeated_word')).toHaveLength(1);
      // Unsorted, overlapping, negative, fractional, NaN and infinite masks are normalized or ignored.
      const weird: TextRange[] = [
        { start: 9, end: 12 }, { start: 8, end: 10 }, { start: -3, end: 2 }, { start: 0.5, end: 1.5 },
        { start: Number.NaN, end: 3 }, { start: 3, end: Number.NaN }, { start: 20, end: 15 },
      ];
      const w = runRules('the the cat the the dog', opts({ masked: weird }));
      assertHitInvariants('the the cat the the dog', w, [{ start: 0, end: 2 }, { start: 8, end: 12 }]);
      expect(w.map((h) => h.original)).toEqual(['the the']);
      expect(runRules('the the', opts({ masked: [{ start: 0, end: Number.POSITIVE_INFINITY }] }))).toEqual([]);
      expect(runRules('the the', opts({ masked: [{ start: Number.NEGATIVE_INFINITY, end: 1 }] })).map((h) => h.original)).toEqual([]);
      // A mask that splits a surrogate pair leaves a lone surrogate in the working copy; nothing reads across it.
      const emoji = '\u{1F600} the the';
      expect(runRules(emoji, opts({ masked: [{ start: 1, end: 2 }] })).map((h) => h.original)).toEqual(['the the']);
      expect(runRules(emoji, opts({ masked: [{ start: 0, end: 1 }] })).map((h) => h.original)).toEqual(['the the']);
    });

    it('a straight quote after an emoji, a comma or an opening bracket is an opening quote when curling', () => {
      const RULE = 'consistency_quote_style';
      const o = { styleDecisions: { quotes: 'curly' } };
      expect(fixes('\u{1F600}"wow"', RULE, o)).toEqual(['"→“', '"→”']);
      expect(fixes('"Hello," she said and "bye."', RULE, o)).toEqual(['"→“', '"→”', '"→“', '"→”']);
      expect(fixes('He said: "wow"—"ok"', RULE, o)).toEqual(['"→“', '"→”', '"→“', '"→”']);
      expect(fixes('("quoted") and ["bracketed"]', RULE, o)).toEqual(['"→“', '"→”', '"→“', '"→”']);
      expect(fixes('\u{1F600}\'tis the \'90s and it\'s \'fine\'', RULE, o)).toEqual(["'→’", "'→’", "'→’", "'→‘", "'→’"]);
      expect(fixes('the end."', RULE, o)).toEqual(['"→”']);
      expect(fixes('said “no.” then "yes."', RULE, o)).toEqual(['"→“', '"→”']);
    });
  });

  // -------------------------------------------------------------------------
  // schema constraints
  // -------------------------------------------------------------------------

  describe('schema constraints', () => {
    it('every hit and every Suggestion honours the engine contract across the corpus and option space', () => {
      const variants: Partial<RuleOptions>[] = [
        {},
        { dialect: 'en-GB', context: 'chat', formality: 'informal' },
        { context: 'code', formality: 'formal', styleDecisions: { quotes: 'straight', dash: 'en_spaced', serial_comma: 'none', double_space_after_period: 'keep' } },
        { typing: true, protectedTerms: ['  Colour ', 'TUK', 'alot'] },
      ];
      let count = 0;
      for (const v of variants) {
        for (const { text, hits, masked } of corpusHits(v)) {
          assertHitInvariants(text, hits, masked);
          const blocks = splitParagraphs(text);
          const suggestions = hitsToSuggestions(hits, { blocks, promptVersion: 'rules-v1' });
          expect(suggestions).toHaveLength(hits.length);
          for (const h of hits) {
            count++;
            expect(RULE_ID_SET.has(h.rule), h.rule).toBe(true);
            expect(TITLE_VALUES.has(h.title), h.title).toBe(true);
            expect(RULE_TITLES[h.rule]).toBeDefined();
            expect(KINDS.has(h.kind)).toBe(true);
            expect(SEVERITIES.has(h.severity)).toBe(true);
            expect(h.kind === 'delete' ? h.replacement === '' : h.replacement.length > 0).toBe(true);
            expect(h.kind === 'insert' ? h.replacement.length > h.original.length && h.replacement.startsWith(h.original.charAt(0)) : true).toBe(true);
            expect(h.meaningPreserving).toBe(true);
            expect(h.explanation.trim()).toBe(h.explanation);
            expect(Number.isFinite(h.confidence)).toBe(true);
            expect(h.autoApplySafe ? h.confidence >= 0.8 : true).toBe(true);
          }
          for (const s of suggestions) {
            expect(s.tier).toBe(!s.meaningPreserving ? 'C' : s.autoApplySafe && s.category === 'correctness' ? 'A' : 'B');
            expect(s.highlight.start).toBeLessThanOrEqual(s.range.start);
            expect(s.highlight.end).toBeGreaterThanOrEqual(s.range.end);
            expect(s.highlight.start).toBeGreaterThanOrEqual(0);
            expect(s.highlight.end).toBeLessThanOrEqual(text.length);
            expect(s.kind === 'insert' || (s.highlight.start === s.range.start && s.highlight.end === s.range.end)).toBe(true);
            expect(s).toMatchObject({ source: 'rules', learnedState: 'active', alternatives: [], promptVersion: 'rules-v1' });
            expect(s.model).toBeUndefined();
            expect(s.id).toBe(hashText(`${s.rule}|${s.range.start}|${s.range.end}|${s.replacement}`));
            expect(s.fingerprint).toBe(hashText(`${s.rule}|${normalizeForMatch(s.original)}|${normalizeForMatch(s.replacement)}`));
            expect(s.explanation.length).toBeLessThanOrEqual(140);
          }
        }
      }
      expect(count).toBeGreaterThan(80);
    });

    it('explanations that would exceed 140 characters are truncated with an ellipsis, not dropped', () => {
      const long = 'a ' + 'e'.repeat(300) + ' is here';
      const [h] = only(long, 'article');
      expect(h).toMatchObject({ original: 'a', replacement: 'an' });
      expect(h?.explanation.length).toBe(140);
      expect(h?.explanation.endsWith('…')).toBe(true);
      const longVariant = 'The ' + 'colour'.repeat(1) + ' and ' + 'x'.repeat(200) + '.';
      for (const x of run(longVariant)) expect(x.explanation.length).toBeLessThanOrEqual(140);
    });

    it('consistency rules are never Tier A without an explicit style decision, and always Tier A with one', () => {
      const text = 'He said "hi" and “bye” and “ok”. one -- two — three — four. colour, colour, colour and color. apples, oranges and pears; red, white, and blue; one, two, and three. cheques, cheques and a check.';
      const consistency = (o: Partial<RuleOptions>): RuleHit[] => run(text, o).filter((h) => h.rule.startsWith('consistency_'));
      const undecided = consistency({ dialect: 'en-GB' });
      expect(new Set(undecided.map((h) => h.rule))).toEqual(new Set(['consistency_quote_style', 'consistency_hyphenation', 'consistency_spelling_variant', 'consistency_serial_comma']));
      for (const h of undecided) {
        if (h.rule === 'consistency_spelling_variant' && h.confidence === 0.9) continue; // the dialect itself is the decision
        expect(h.autoApplySafe, `${h.rule}:${h.original}`).toBe(false);
        expect(h.severity).toBe('suggestion');
        expect(h.confidence).toBeLessThan(0.85);
      }
      const decided = consistency({ styleDecisions: { quotes: 'curly', dash: 'em_closed', serial_comma: 'oxford' } });
      for (const h of decided) expect(h.autoApplySafe, `${h.rule}:${h.original}`).toBe(true);
      const tiers = hitsToSuggestions(decided, { blocks: splitParagraphs(text), promptVersion: 'v' }).map((s) => s.tier);
      expect(new Set(tiers)).toEqual(new Set(['A']));
    });

    it('wrong enum casing in the dialect does not silently switch the spelling family', () => {
      expect(expectsUkSpelling('EN-GB' as Dialect)).toBe(true);
      expect(expectsUkSpelling('en-us' as Dialect)).toBe(false);
      expect(expectsUkSpelling('EN-US' as Dialect)).toBe(false);
      expect(expectsUkSpelling('fr-FR' as Dialect)).toBe(false);
      expect(expectsUkSpelling('' as Dialect)).toBe(false);
      expect(fixes('The color of the centre.', 'consistency_spelling_variant', { dialect: 'EN-GB' as Dialect })).toEqual(['color→colour']);
      expect(fixes('The color of the centre.', 'consistency_spelling_variant', { dialect: 'En-Us' as Dialect })).toEqual(['centre→center']);
    });

    it('muting is by coarse rule id only; variant keys and unknown ids are ignored without throwing', () => {
      const text = 'the the cat.  i could of gone,but a apple fell.Then ok!!';
      expect(run(text, { mutedRules: ['spacing.double_space', 'nonsense', ''] })).toEqual(run(text));
      expect(run(text, { mutedRules: ['spacing'] }).some((h) => h.rule === 'spacing')).toBe(false);
      expect(run(text, { mutedRules: ['SPACING'] }).some((h) => h.rule === 'spacing')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // idempotent folding and byte-stability
  // -------------------------------------------------------------------------

  describe('folding and stability', () => {
    it('applying every hit and re-running converges to a clean fixed point within three passes', () => {
      const dialects: Dialect[] = ['en-US', 'en-GB'];
      for (const dialect of dialects) {
        for (const start of CORPUS) {
          let text = start;
          let passes = 0;
          for (; passes < 6; passes++) {
            const { masked } = stripUrlsAndCode(text);
            const hits = runRules(text, opts({ masked, dialect }));
            if (hits.length === 0) break;
            const next = apply(text, hits);
            expect(next).not.toBe(text);
            text = next;
          }
          expect(passes, `${dialect}: ${JSON.stringify(start)} → ${JSON.stringify(text)}`).toBeLessThanOrEqual(3);
          expect(runRules(text, opts({ masked: stripUrlsAndCode(text).masked, dialect }))).toEqual([]);
        }
      }
    });

    it('"Accept all grammar" (Tier A only) converges within three passes and never creates new judgment calls', () => {
      const key = (h: RuleHit): string => `${h.rule}|${h.original.toLowerCase()}|${h.replacement.toLowerCase()}`;
      for (const { text: start, hits: first } of corpusHits()) {
        const judgmentBefore = new Set(first.filter((h) => !h.autoApplySafe).map(key));
        let text = start;
        let passes = 0;
        let hits = first;
        for (; passes < 6; passes++) {
          const safe = hits.filter((h) => h.autoApplySafe);
          if (safe.length === 0) break;
          text = apply(text, safe);
          hits = runRules(text, opts({ masked: stripUrlsAndCode(text).masked }));
        }
        expect(passes, JSON.stringify(start)).toBeLessThanOrEqual(3);
        expect(hits.filter((h) => h.autoApplySafe)).toEqual([]);
        // Whatever correctness issue is left is a judgment call that was already there before the mechanical fixes
        // were applied (case-insensitively: capitalization may have re-cased the word a style hit sits on). Style
        // suggestions may appear once a word is spelled right ("Alot of people" -> "A lot of people" -> "many people"),
        // exactly as they would for text typed correctly in the first place.
        for (const h of hits) if (h.category === 'correctness') expect(judgmentBefore.has(key(h)), `${JSON.stringify(start)} → ${key(h)}`).toBe(true);
      }
    });

    it('output is byte-identical across renders with reordered or re-cased inputs', () => {
      const text = CORPUS.join('\n');
      const { masked } = stripUrlsAndCode(text);
      const a = runRules(text, opts({
        masked,
        protectedTerms: ['Colour', 'tuk', 'JAMMARLY'],
        mutedRules: ['consistency_hyphenation', 'terminal_punctuation'],
        styleDecisions: { quotes: 'curly', serial_comma: 'oxford' },
      }));
      const b = runRules(text, opts({
        masked: [...masked].reverse(),
        protectedTerms: ['  jammarly', 'TUK ', 'colour'],
        mutedRules: ['terminal_punctuation', 'consistency_hyphenation', 'consistency_hyphenation'],
        styleDecisions: { serial_comma: 'oxford', quotes: 'curly' },
      }));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(a.length).toBeGreaterThan(10);
      // And the Suggestion rendering is stable too, including when the hit array itself is shuffled first.
      const blocks = splitParagraphs(text);
      const s1 = hitsToSuggestions(a, { blocks, promptVersion: 'v' });
      const s2 = hitsToSuggestions([...b].reverse(), { blocks, promptVersion: 'v' }).reverse();
      expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
    });

    it('is a pure function: inputs are not mutated and repeated calls on the same options object agree', () => {
      const text = 'the the cat , and a apple.Then "ok" and “bye” and “no”.';
      const masked: TextRange[] = [{ start: 30, end: 31 }, { start: 5, end: 6 }];
      const snapshotMasked = JSON.stringify(masked);
      const o = opts({ masked, protectedTerms: ['X'], mutedRules: ['article'] });
      const snapshotOpts = JSON.stringify(o);
      const first = runRules(text, o);
      const second = runRules(text, o);
      expect(JSON.stringify(masked)).toBe(snapshotMasked);
      expect(JSON.stringify(o)).toBe(snapshotOpts);
      expect(second).toEqual(first);
      // Returned hits are fresh objects: mutating one never leaks into the next call.
      if (first[0] !== undefined) first[0].range.start = -1;
      expect(runRules(text, o)[0]?.range.start).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // round two: traps found by the adversarial pass. Every "leaves alone" case below was a real false positive
  // of the engine before the matching guard was added (research 02 §6.1: zero false positives beat recall).
  // -------------------------------------------------------------------------

  describe('round two', () => {
    const loneI = (text: string, o: Partial<RuleOptions> = {}): string[] =>
      only(text, 'capitalization', o).filter((h) => h.title === RULE_TITLES['capitalization.lone_i']).map((h) => `${h.original}→${h.replacement}`);

    it('lone "i" inside brackets, braces or sigils, in a roman-numeral list or after a label noun is a variable or a marker', () => {
      for (const text of [
        'Set array[i] to zero.',
        'Use {i} as the key.',
        'The $i variable holds it.',
        'x[i] = y[i] + 1 is the update.',
        'Items i, ii and iii are done.',
        'i: first; ii: second',
        'See part i and part ii.',
        'Phase i starts Monday.',
        'Read chapter i, then act i of the play.',
      ]) expect(loneI(text), text).toEqual([]);
      // The pronoun is still caught, including right after a comma or at a clause start.
      expect(loneI('Bob and i went home.')).toEqual(['i→I']);
      expect(loneI('When i went home, i slept.')).toEqual(['i→I', 'i→I']);
      expect(loneI('Yes, i do')).toEqual(['i→I']);
      expect(loneI("and i, too, agree that i'm right")).toEqual(['i→I', "i'm→I'm"]);
    });

    it('an article before a function word is not an a/an slip ("between a and b", "A and B are letters")', () => {
      for (const text of [
        'Choose between a and b.',
        'A and B are letters; a or b will do.',
        'Pick a or b, then a is cheaper than b.',
        'She has an in with the boss.',
        'Plan a or plan b, grade a and grade b.',
      ]) expect(only(text, 'article'), text).toEqual([]);
      expect(fixes('A apple and a orange or an banana.', 'article')).toEqual(['A→An', 'a→an', 'an→a']);
    });

    it.each<[string, string[]]>([
      ['an html page and a url and an sql query', []],
      ['a html page and an url', ['a→an', 'an→a']],
      ['an npm package over an ssh tunnel', []],
      ['an svg, a pdf and an xml file', []],
      ['an mba and an hr rep with a ceo title and an seo plan', []],
      ['a kpi, a roi and a nda', ['a→an', 'a→an']],
      ['an eu law and a eu law', ['a→an']],
      ['a usb stick and a utf-8 file', []],
      ['An usb stick.', ['An→A']],
      ['an Xbox, an xkcd comic and a xylophone', []],
      ['a Xbox and an xylophone', ['a→an', 'an→a']],
      ['an nth time and a hmm', []],
      ['a nth time', ['a→an']],
      ['a myth, a gym and a rhythm', []],
      ['an fyi and a tldr', []],
      ['a élan vital and an élan vital', []],
      ['an Uber and an Ubuntu box', []],
      ['a Ubuntu box', ['a→an']],
    ])('lower-cased acronyms are read letter by letter: %j', (text, expected) => {
      expect(fixes(text, 'article')).toEqual(expected);
    });

    it('exposes the lower-cased acronym and x-word decisions', () => {
      expect(articleFor('html')).toBe('an');
      expect(articleFor('url')).toBe('a');
      expect(articleFor('seo')).toBe('an');
      expect(articleFor('ceo')).toBe('a');
      expect(articleFor('nth')).toBe('an');
      expect(articleFor('xbox')).toBe('an');
      expect(articleFor('xylophone')).toBe('a');
      expect(articleFor('xmas')).toBeNull();
      expect(articleFor('hmm')).toBeNull();
      expect(articleFor('élan')).toBeNull();
      expect(articleFor('myth')).toBe('a');
      expect(articleFor('un')).toBe('an'); // a truncated "under", not the United Nations
    });

    it('an introductory phrase before the first comma is not the first item of a list', () => {
      const RULE = 'consistency_serial_comma';
      const oxford = { styleDecisions: { serial_comma: 'oxford' } };
      const oxfordBias = ' She likes red, white, and blue. He saw cats, dogs, and birds.';
      for (const text of [
        'After dinner, John and Mary left.',
        'In the morning, Bob and Sue ran.',
        'Last week, Alice and Bob met.',
        'By Friday, Tom and Jerry will finish.',
        'Yes, Bob and Sue came.',
        'As discussed, Bob and Sue will present.',
        'Going forward, Bob and Sue own this.',
        'That said, Bob and Sue disagree.',
        'Hi Bob, Mary and Jane are coming.',
        'At Google, Bob and Sue worked together.',
        'If possible, Bob and Sue should attend.',
        'Every Monday, Bob and Sue meet.',
        'Two weeks ago, Bob and Sue moved.',
        'One day, Bob and Sue moved.',
        'Dear Bob, Mary and Jo,',
        'He said "hi." After dinner, Bob and Sue left.',
      ]) {
        expect(only(text, RULE, oxford), text).toEqual([]);
        expect(only(text + oxfordBias, RULE), text).toEqual([]);
      }
      // Real lists keep their hit: after a verb, at a sentence start, of numbers and of number words.
      expect(fixes('I like apples, oranges and pears.', RULE, oxford)).toEqual(['oranges and→oranges, and']);
      expect(fixes('We met Bob, Sue and Tom.', RULE, oxford)).toEqual(['Sue and→Sue, and']);
      expect(fixes('Bob, Sue and Tom came.', RULE, oxford)).toEqual(['Sue and→Sue, and']);
      expect(fixes('In 2019, 2020 and 2021 we grew.', RULE, oxford)).toEqual(['2020 and→2020, and']);
      expect(fixes('One, two or three.', RULE, oxford)).toEqual(['two or→two, or']);
      expect(fixes('I bought red, white, blue and green paint.', RULE, oxford)).toEqual(['blue and→blue, and']);
      expect(fixes('red, white, and blue; in short, Bob and Sue', RULE, { styleDecisions: { serial_comma: 'none' } })).toEqual(['white, and→white and']);
    });

    it('spelling variants inside identifiers, calls, paths and deliberate contrasts are not prose', () => {
      const RULE = 'consistency_spelling_variant';
      const cases: [string, Partial<RuleOptions>][] = [
        ['Use math.floor here.', { dialect: 'en-GB' }],
        ['Use maths.floor and obj.colour here.', {}],
        ['The colour_value field and colour2 are set.', {}],
        ['Call color() and colour() here; pass --colour=auto.', { dialect: 'en-GB' }],
        ['See color/colour and center/centre forms.', { dialect: 'en-GB' }],
        ['The #colour tag, the @colour handle and $colour.', {}],
      ];
      for (const [text, o] of cases) expect(only(text, RULE, o), text).toEqual([]);
      expect(fixes("The colour's depth and the colour’s depth.", RULE)).toEqual(['colour→color', 'colour→color']);
      expect(fixes('A colour (red) and the colour.', RULE)).toEqual(['colour→color', 'colour→color']);
    });

    it('a capitalized variant at a sentence start is a name when a possessive or a linking word joins it to another capital', () => {
      const RULE = 'consistency_spelling_variant';
      for (const text of [
        "Grey's Anatomy is on tonight.",
        'Grey’s Anatomy is on tonight.',
        'Center for Policy Studies is a think tank.',
        'Theatre of Dreams is a stadium.',
        'Harbour Bridge Climb opens at nine.',
      ]) expect(only(text, RULE), text).toEqual([]);
      expect(only('Center for Policy Studies is a think tank.', RULE, { dialect: 'en-GB' })).toEqual([]);
      expect(fixes('Grey matter is grey. Theatre of the absurd is a genre. Centre the text.', RULE)).toEqual(['Grey→Gray', 'grey→gray', 'Theatre→Theater', 'Centre→Center']);
    });

    it('a doubled dot before "?" or "!" is left alone: collapsing it would leave ".?" behind', () => {
      expect(only('what..? no..! fine..', 'terminal_punctuation').map((h) => h.original)).toEqual(['..']);
      const text = 'what..? and so on..';
      const applied = apply(text, only(text, 'terminal_punctuation'));
      expect(applied).toBe('what..? and so on.');
      expect(applied).not.toMatch(/(?<![.])\.[?!]/); // never a lone "." glued to "?" or "!"
    });

    it('a straight double quote after a digit is an inch mark even before a letter; a single quote stays an apostrophe', () => {
      const RULE = 'consistency_quote_style';
      expect(only('a 3"x5" card and “ok” “fine” “yes”', RULE)).toEqual([]);
      expect(fixes("the 90's and “ok” “fine” “yes”", RULE)).toEqual(["'→’"]);
      expect(fixes('a 3"x5" card and the 90\'s', RULE, { styleDecisions: { quotes: 'curly' } })).toEqual(["'→’"]);
    });

    it('a spaced hyphen next to a number is a minus sign; an em dash next to a number is still a dash', () => {
      const RULE = 'consistency_hyphenation';
      const em = { styleDecisions: { dash: 'em_closed' } };
      expect(only('n - 1 and a - 5 and 5 - a and 2020 - the year', RULE, em)).toEqual([]);
      expect(fixes('in 2020 — the year — we grew', RULE, em)).toEqual([' — →—', ' — →—']);
      expect(fixes('a - b and c - d', RULE, em)).toEqual([' - →—', ' - →—']);
    });

    it.each<[string, string[]]>([
      ['It costs $5. then we left.', []], // "5." reads as a list marker: stay silent rather than guess
      ['Version v2. then v3 shipped.', ['then→Then']],
      ['Buy 10 lbs. of flour. then bake.', ['then→Then']],
      ['E.g. the test. I.e. the other.', []],
      ['Mon. and Tue. are fine. wed. is not.', ['wed→Wed']],
      ['“Stop!” she yelled. he ran.', ['he→He']],
      ['Really?!) then what', []],
      ['hello world. 😀 lets go', ['hello→Hello']], // an emoji between the sentences: conservative
      ['#winning. lol', []],
      ['see x.com. then go', ['see→See']], // the period after a masked URL is never read as a sentence end
      ['et al. found it. ibid. p. 5.', ['et→Et', 'ibid→Ibid']],
      ['The U.K. and the U.S.A. are allies. so is Canada.', ['so→So']],
      ['Read Ch. 3. chapter four is next.', []],
    ])('sentence starts around abbreviations, markers, masks and emoji: %j', (text, expected) => {
      expect(fixes(text, 'capitalization')).toEqual(expected);
    });

    it('chat lines that merely start with a programming keyword are prose; real statements are still skipped', () => {
      for (const text of [
        'let me know if the the file is ok',
        'let me know what you think; the the draft is attached',
        'return the the book when you can',
        'if the the meeting moves, let me know',
        'import duties apply; the the goods are held',
        'try the the new place; it is great',
        'switch the the lights off',
        'export the the data when ready',
      ]) expect(run(text, { context: 'chat' }).map((h) => h.rule), text).toEqual(['repeated_word']);
      expect(run('let x = the; let the = x;', { context: 'chat' })).toEqual([]);
      expect(run('if (the == the) { return the; }', { context: 'chat' })).toEqual([]);
    });

    it('typing guard: invisible characters, combining marks and digits at the end still count as the word in progress', () => {
      const cases: [string, string[]][] = [
        ['the the​', ['capitalization']], // a zero-width space glues to the last word: it is still being typed
        ['the the‍', ['capitalization']],
        ['the the 😀🏽', ['capitalization', 'repeated_word']], // a skin-tone modifier is a symbol: the text is complete
        ['the the é', ['capitalization', 'repeated_word']], // "é" in progress, "the the" is finished
        ['the the 4', ['capitalization', 'repeated_word']],
        ['the the 4x', ['capitalization', 'repeated_word']],
        ['the the x4', ['capitalization', 'repeated_word']],
        ['I saw a un', []],
        ['I saw a un ', ['article']],
        ['I saw a un.', ['article']],
      ];
      for (const [text, expected] of cases) expect(run(text, { typing: true }).map((h) => h.rule), JSON.stringify(text)).toEqual(expected);
    });

    it('fingerprints ignore quote shape and space kind (dismissals survive smart-quote editors); ids follow the position', () => {
      const render = (text: string): Suggestion | undefined =>
        hitsToSuggestions(run(text), { blocks: splitParagraphs(text), promptVersion: 'v' }).find((x) => x.rule === 'repeated_word');
      const straight = render("Don't don't do it");
      const curly = render('Don’t don’t do it');
      expect(straight?.fingerprint).toBe(curly?.fingerprint);
      expect(straight?.original).not.toBe(curly?.original);
      expect(straight?.id).not.toBe(curly?.id); // the replacement differs ("Don't" vs "Don’t")
      const nbsp = render('the the cat');
      const space = render('the the cat');
      expect(nbsp?.fingerprint).toBe(space?.fingerprint);
      expect(nbsp?.id).toBe(space?.id); // same rule, range and replacement
      expect(render('and the the end')?.fingerprint).toBe(space?.fingerprint);
      expect(render('and the the end')?.id).not.toBe(space?.id);
    });

    it('a paragraph that moves keeps its blockHash, block-relative offsets and fingerprints; only ids and absolute ranges change', () => {
      const para = 'We left home.Then i could of gone, and the the end.';
      const before = `Intro line.\n\n${para}`;
      const after = `Intro line.\nAnother line was inserted here.\n\n${para}`;
      const blockA = splitParagraphs(before).find((p) => p.text === para);
      const blockB = splitParagraphs(after).find((p) => p.text === para);
      if (blockA === undefined || blockB === undefined) throw new Error('fixture');
      const a = hitsToSuggestions(run(before), { blocks: splitParagraphs(before), promptVersion: 'v' }).filter((s) => s.blockId === String(blockA.index));
      const b = hitsToSuggestions(run(after), { blocks: splitParagraphs(after), promptVersion: 'v' }).filter((s) => s.blockId === String(blockB.index));
      expect(a.map((s) => s.rule)).toEqual(['spacing', 'capitalization', 'confusable_word', 'repeated_word']);
      expect(b).toHaveLength(a.length);
      expect(blockA.hash).toBe(blockB.hash);
      const shift = blockB.start - blockA.start;
      expect(shift).toBeGreaterThan(0);
      a.forEach((s, i) => {
        const t = b[i];
        expect(t?.fingerprint).toBe(s.fingerprint);
        expect(t?.blockHash).toBe(s.blockHash);
        expect(t?.range).toEqual({ start: s.range.start + shift, end: s.range.end + shift });
        expect(t?.highlight).toEqual({ start: s.highlight.start + shift, end: s.highlight.end + shift });
        expect(t?.id).not.toBe(s.id);
      });
    });

    it('insertions and deletions at a block edge never highlight into the neighbouring block', () => {
      const text = 'first line \napples, oranges and pears\nhome.Then';
      const blocks = splitParagraphs(text);
      const s = hitsToSuggestions(run(text, { styleDecisions: { serial_comma: 'oxford' } }), { blocks, promptVersion: 'v' });
      const del = s.find((x) => x.kind === 'delete');
      const serial = s.find((x) => x.rule === 'consistency_serial_comma');
      const missing = s.find((x) => x.rule === 'spacing' && x.kind === 'insert');
      expect(del).toMatchObject({ blockId: '0', range: { start: 10, end: 11 } });
      expect(del?.highlight).toEqual(del?.range);
      expect(serial).toMatchObject({ blockId: '1', kind: 'insert' });
      expect(text.slice(serial?.highlight.start, serial?.highlight.end)).toBe('oranges and');
      expect(missing?.blockId).toBe('2');
      expect(text.slice(missing?.highlight.start, missing?.highlight.end)).toBe('home.Then');
      for (const x of s) {
        const block = blocks[Number(x.blockId)];
        if (block === undefined) throw new Error('no block');
        expect(x.highlight.start).toBeGreaterThanOrEqual(block.start);
        expect(x.highlight.end).toBeLessThanOrEqual(block.start + block.text.length);
      }
    });

    it('the hit collector enforces the schema: ranges, no-ops, titles, explanation length, confidence bounds, dedupe, masks', () => {
      const text = 'the the cat';
      const ctx = createContext(text, opts({ typing: true, masked: [{ start: 8, end: 11 }] }));
      const base = { rule: 'repeated_word', severity: 'error' as const, kind: 'replace' as const, replacement: 'the', explanation: 'x', confidence: 0.9, autoApplySafe: true };
      ctx.emit({ ...base, start: 0, end: 7 }); // valid
      ctx.emit({ ...base, start: 0, end: 7 }); // duplicate
      ctx.emit({ ...base, start: 0, end: 7, replacement: 'the the' }); // no-op
      ctx.emit({ ...base, start: 0.5, end: 7 }); // fractional
      ctx.emit({ ...base, start: Number.NaN, end: 7 });
      ctx.emit({ ...base, start: -1, end: 7 });
      ctx.emit({ ...base, start: 7, end: 7 }); // empty
      ctx.emit({ ...base, start: 0, end: 12 }); // past the end
      ctx.emit({ ...base, rule: 'not_a_rule', start: 0, end: 7 }); // unknown rule: no title, dropped
      ctx.emit({ ...base, key: 'repeated_word.nonsense', start: 4, end: 7, replacement: 'THE' }); // unknown key: rule title
      ctx.emit({ ...base, start: 4, end: 7, replacement: 'tha', explanation: 'e'.repeat(500), confidence: 7 });
      ctx.emit({ ...base, start: 4, end: 7, replacement: 'thu', confidence: -3, meaningPreserving: false });
      ctx.emit({ ...base, start: 8, end: 11, replacement: 'dog' }); // masked
      ctx.emit({ ...base, start: 9, end: 10, replacement: 'x' }); // masked and the word in progress
      const hits = finalizeHits(ctx);
      expect(hits.map((h) => `${h.range.start}-${h.range.end}:${h.replacement}`)).toEqual(['0-7:the', '4-7:THE', '4-7:tha', '4-7:thu']);
      expect(hits[1]?.title).toBe(RULE_TITLES['repeated_word']);
      expect(hits[2]?.explanation).toHaveLength(140);
      expect(hits[2]?.explanation.endsWith('…')).toBe(true);
      expect(hits[2]?.confidence).toBe(1);
      expect(hits[3]?.confidence).toBe(0);
      expect(hits[3]?.meaningPreserving).toBe(false);
      expect(hits[0]?.meaningPreserving).toBe(true);
      expect(hits.every((h) => h.original === text.slice(h.range.start, h.range.end) && h.category === 'correctness')).toBe(true);
    });

    it('unknown option properties and wrong enum casing never throw; a mis-cased style decision is treated as undecided', () => {
      const text = 'hey i think its fine. lets go. He said "hi" and “bye” and “ok”. one -- two — three — four. apples, oranges and pears; red, white, and blue; one, two, and three.';
      const weird = {
        ...opts({ masked: stripUrlsAndCode(text).masked }),
        context: 'Chat',
        formality: 'INFORMAL',
        dialect: 'EN-gb',
        styleDecisions: { quotes: 'Curly', dash: 'EM_CLOSED', serial_comma: 'OXFORD', double_space_after_period: 'KEEP', bogus: 'x' },
        extra: { nested: true },
        mutedRules: ['Spacing', 42 as unknown as string],
      } as unknown as RuleOptions;
      const hits = runRules(text, weird);
      assertHitInvariants(text, hits);
      // "Chat" is not "chat": the all-lowercase exemption and the softer severity do not apply.
      const caps = hits.filter((h) => h.rule === 'capitalization');
      expect(caps.map((h) => `${h.original}→${h.replacement}`)).toContain('hey→Hey');
      expect(caps.every((h) => h.severity === 'error' && h.autoApplySafe)).toBe(true);
      // Mis-cased decisions fall back to the majority heuristics: never auto-apply, never Tier A.
      const consistency = hits.filter((h) => h.rule.startsWith('consistency_'));
      expect(new Set(consistency.map((h) => h.rule))).toEqual(new Set(['consistency_quote_style', 'consistency_hyphenation', 'consistency_serial_comma']));
      for (const h of consistency) expect(h.autoApplySafe, h.rule).toBe(false);
      expect(hitsToSuggestions(consistency, { blocks: splitParagraphs(text), promptVersion: 'v' }).every((s) => s.tier === 'B')).toBe(true);
      // The dialect comparison is case-insensitive by contract, so "EN-gb" is still British.
      expect(fixes('The color of the centre.', 'consistency_spelling_variant', { dialect: 'EN-gb' as Dialect })).toEqual(['color→colour']);
    });

    const CORPUS2 = [
      'Set array[i] to zero; items i, ii and iii are done. Bob and i went home.',
      'Choose between a and b. Add an html page, a url and an npm package. a Xbox and an Ubuntu box.',
      'After dinner, John and Mary left. I like apples, oranges and pears. One, two or three.',
      'Use math.floor and colour_value here. Grey’s Anatomy is on. Grey matter is grey.',
      'what..? fine.. a 3"x5" card and the 90\'s — “ok” “fine” “yes”; n - 1 and a — b and c -- d',
      'let me know if the the file is ok; return it when done',
      'Dr. smith met e.g. the U.S. team at 9:30. the colour of the centre was gray. Wow!!! Really???',
    ];
    const DECIDED = { serial_comma: 'oxford', dash: 'em_closed', quotes: 'curly' };

    it('round-two fixtures fold to a clean fixed point within three passes and render byte-identically regardless of input order', () => {
      for (const dialect of ['en-US', 'en-GB'] as Dialect[]) {
        for (const start of CORPUS2) {
          let text = start;
          let passes = 0;
          for (; passes < 6; passes++) {
            const hits = runRules(text, opts({ masked: stripUrlsAndCode(text).masked, dialect, styleDecisions: DECIDED }));
            if (hits.length === 0) break;
            const next = apply(text, hits);
            expect(next).not.toBe(text);
            text = next;
          }
          expect(passes, `${dialect}: ${JSON.stringify(start)} → ${JSON.stringify(text)}`).toBeLessThanOrEqual(3);
          expect(runRules(text, opts({ masked: stripUrlsAndCode(text).masked, dialect, styleDecisions: DECIDED }))).toEqual([]);
        }
      }
      const text = CORPUS2.join('\n');
      const { masked } = stripUrlsAndCode(text);
      const a = runRules(text, opts({ masked, protectedTerms: ['Xbox', 'grey'], mutedRules: ['article', 'consistency_quote_style'], styleDecisions: { serial_comma: 'oxford', dash: 'em_closed' } }));
      const b = runRules(text, opts({ masked: [...masked].reverse(), protectedTerms: [' GREY', 'xbox '], mutedRules: ['consistency_quote_style', 'article', 'article'], styleDecisions: { dash: 'em_closed', serial_comma: 'oxford' } }));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(a.length).toBeGreaterThan(8);
      expect(a.some((h) => h.rule === 'article' || h.rule === 'consistency_quote_style')).toBe(false);
      expect(a.some((h) => h.original.toLowerCase() === 'grey')).toBe(false);
    });

    it('the new guards stay linear on floods of their own triggers', () => {
      const cases: [string, string, Partial<RuleOptions>][] = [
        ['1,000 chat lines with code hints', 'let me know if the the file is ok; return it when done\n'.repeat(1_000), { context: 'chat' }],
        ['abbreviation-dense prose', 'Dr. smith met Mr. jones at 9 a.m. on Mon. e.g. in St. Louis vs. Mt. Hood etc. '.repeat(600), {}],
        ['10k sentence breaks', 'ok. '.repeat(10_000), {}],
        ['10k lone i candidates', 'i '.repeat(10_000), {}],
        ['5k article candidates', 'a apple '.repeat(5_000), {}],
        ['5k lists after openers', 'After dinner, John and Mary left. '.repeat(5_000), { styleDecisions: { serial_comma: 'oxford' } }],
        ['one 140 KB sentence with 5k list candidates', 'x apples, oranges and pears '.repeat(5_000), { styleDecisions: { serial_comma: 'oxford' } }],
        ['2.5k spelling variants in identifiers and names', "colour_value math.floor colour2 Grey's Anatomy ".repeat(2_500), { dialect: 'en-GB' }],
        ['20k minus signs', 'a - 5 '.repeat(20_000), { styleDecisions: { dash: 'em_closed' } }],
        ['20k inch marks', '3"x5" '.repeat(20_000), { styleDecisions: { quotes: 'curly' } }],
      ];
      run('warm up the the');
      for (const [label, text, o] of cases) {
        const options = opts({ ...o, masked: stripUrlsAndCode(text).masked });
        const times = [elapsed(() => runRules(text, options)), elapsed(() => runRules(text, options)), elapsed(() => runRules(text, options))].sort((x, y) => x - y);
        expect(times[1], label).toBeLessThan(80);
        assertHitInvariants(text, runRules(text, options));
      }
    });
  });
});
