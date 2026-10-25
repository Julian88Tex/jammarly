import { describe, expect, it } from 'vitest';
import type { Edit, Suggestion, SuggestionCategory, SuggestionSource, TextRange } from '../src/types';
import {
  applyEdits,
  compareSuggestionPriority,
  computeScore,
  countSyllables,
  countWords,
  diffShift,
  fleschKincaidGrade,
  hashText,
  isLikelyCode,
  locateSpan,
  normalizeForMatch,
  paragraphCacheKey,
  readingTimeSeconds,
  rebaseSuggestions,
  resolveOverlaps,
  SCORE_DENSITY_FLOOR_WORDS,
  splitParagraphs,
  splitSentences,
  stripUrlsAndCode,
  tidyEdit,
} from '../src/text';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Deterministic LCG so property-style tests are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const idx = Math.floor(rng() * items.length);
  const v = items[idx];
  if (v === undefined) throw new Error('empty pick');
  return v;
}

function randomText(rng: () => number, alphabet: readonly string[], maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += pick(rng, alphabet);
  return s;
}

const UNICODE_ALPHABET = ['a', 'b', 'c', ' ', ' ', '\n', '\r', '\u00a0', '😀', '“', '”', '’', '.', '!', '?', 'é', '-', '–'] as const;

let nextId = 0;
function mk(partial: Partial<Suggestion> & { range: TextRange; original: string }): Suggestion {
  nextId++;
  return {
    id: partial.id ?? `s${nextId}`,
    category: partial.category ?? 'correctness',
    rule: partial.rule ?? 'spelling',
    severity: partial.severity ?? 'error',
    source: partial.source ?? 'rules',
    range: partial.range,
    original: partial.original,
    replacement: partial.replacement ?? `${partial.original}!`,
    alternatives: partial.alternatives ?? [],
    title: partial.title ?? 'Fix it',
    explanation: partial.explanation ?? 'Because.',
    confidence: partial.confidence ?? 1,
    kind: partial.kind ?? 'replace',
    tier: partial.tier ?? 'A',
    anchor: partial.anchor ?? 'exact',
    conflictsWith: partial.conflictsWith ?? [],
    stale: partial.stale ?? false,
    highlight: partial.highlight ?? partial.range,
    meaningPreserving: partial.meaningPreserving ?? true,
    autoApplySafe: partial.autoApplySafe ?? true,
    blockId: partial.blockId ?? 'b0',
    blockHash: partial.blockHash ?? 'h0',
    promptVersion: partial.promptVersion ?? 'test',
    fingerprint: partial.fingerprint ?? `${partial.rule ?? 'spelling'}|${partial.original}|${partial.replacement ?? ''}`,
    learnedState: partial.learnedState ?? 'active',
  };
}

function edit(start: number, end: number, original: string, replacement: string): Edit {
  return { range: { start, end }, original, replacement };
}

function sentenceStrings(text: string): string[] {
  return splitSentences(text).map((r) => text.slice(r.start, r.end));
}

// ---------------------------------------------------------------------------
// hashText / paragraphCacheKey
// ---------------------------------------------------------------------------

describe('hashText', () => {
  it.each(['', 'a', 'hello world', '😀', 'line\nbreak', '\u00a0', 'a'.repeat(5000)])('returns 16 lowercase hex chars for %j', (s) => {
    expect(hashText(s)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(hashText('The quick brown fox')).toBe(hashText('The quick brown fox'));
    expect(hashText('')).toBe(hashText(''));
  });

  it.each<[string, string]>([
    ['', 'a'],
    ['ab', 'ba'],
    ['a', 'a\u0000'],
    ['a\u0000', 'a\u0000\u0000'],
    ['😀', '😁'],
    ['a b', 'a\u00a0b'],
    ['"quote"', '“quote”'],
    ['hello', 'Hello'],
    ['abc', 'abcd'],
  ])('hashes %j and %j differently', (a, b) => {
    expect(hashText(a)).not.toBe(hashText(b));
  });

  it('has no collisions across a few thousand generated strings', () => {
    const rng = makeRng(42);
    const seen = new Map<string, string>();
    for (let i = 0; i < 5000; i++) {
      const s = `${i}:${randomText(rng, UNICODE_ALPHABET, 12)}`;
      const h = hashText(s);
      const prev = seen.get(h);
      expect(prev === undefined || prev === s).toBe(true);
      seen.set(h, s);
    }
  });

  it('paragraphCacheKey combines paragraph hash and goals hash', () => {
    const key = paragraphCacheKey('Some paragraph.', 'formal|general');
    expect(key).toMatch(/^[0-9a-f]{16}:[0-9a-f]{16}$/);
    expect(key.startsWith(hashText('Some paragraph.'))).toBe(true);
    expect(key.endsWith(hashText('formal|general'))).toBe(true);
    expect(paragraphCacheKey('Some paragraph.', 'informal|general')).not.toBe(key);
    expect(paragraphCacheKey('Other paragraph.', 'formal|general')).not.toBe(key);
    expect(paragraphCacheKey('Some paragraph.', 'formal|general')).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// splitParagraphs
// ---------------------------------------------------------------------------

describe('splitParagraphs', () => {
  it.each<[string, string, Array<{ start: number; text: string }>]>([
    ['empty', '', []],
    ['single line', 'hello', [{ start: 0, text: 'hello' }]],
    ['two lines', 'a\nb', [{ start: 0, text: 'a' }, { start: 2, text: 'b' }]],
    ['blank lines collapse', 'a\n\n\nb', [{ start: 0, text: 'a' }, { start: 4, text: 'b' }]],
    ['CRLF', 'a\r\nb', [{ start: 0, text: 'a' }, { start: 3, text: 'b' }]],
    ['CRLF blank line', 'a\r\n\r\nb', [{ start: 0, text: 'a' }, { start: 5, text: 'b' }]],
    ['lone CR', 'a\rb', [{ start: 0, text: 'a' }, { start: 2, text: 'b' }]],
    ['leading newlines', '\n\nlead', [{ start: 2, text: 'lead' }]],
    ['trailing newlines', 'trail\n\n', [{ start: 0, text: 'trail' }]],
    ['only newlines', '\n\r\n\n', []],
    ['whitespace-only line kept', 'a\n   \nb', [{ start: 0, text: 'a' }, { start: 2, text: '   ' }, { start: 6, text: 'b' }]],
    ['emoji offsets (two code units)', '😀 hi\nthere', [{ start: 0, text: '😀 hi' }, { start: 6, text: 'there' }]],
    ['NBSP is not a boundary', 'a\u00a0b\nc', [{ start: 0, text: 'a\u00a0b' }, { start: 4, text: 'c' }]],
    ['U+2028 is not a boundary', 'a\u2028b', [{ start: 0, text: 'a\u2028b' }]],
  ])('%s', (_name, text, expected) => {
    const paragraphs = splitParagraphs(text);
    expect(paragraphs.map((p) => ({ start: p.start, text: p.text }))).toEqual(expected);
    paragraphs.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.hash).toBe(hashText(p.text));
      expect(text.slice(p.start, p.start + p.text.length)).toBe(p.text);
    });
  });

  it('property: offsets are exact, indexes sequential, and everything outside paragraphs is a line break', () => {
    const rng = makeRng(7);
    for (let iter = 0; iter < 300; iter++) {
      const text = randomText(rng, UNICODE_ALPHABET, 40);
      const paragraphs = splitParagraphs(text);
      const covered = new Array<boolean>(text.length).fill(false);
      paragraphs.forEach((p, i) => {
        expect(p.index).toBe(i);
        expect(p.text.length).toBeGreaterThan(0);
        expect(p.text).not.toMatch(/[\r\n]/);
        expect(text.slice(p.start, p.start + p.text.length)).toBe(p.text);
        expect(p.hash).toBe(hashText(p.text));
        if (i > 0) {
          const prev = paragraphs[i - 1];
          expect(prev).toBeDefined();
          if (prev) expect(p.start).toBeGreaterThan(prev.start + prev.text.length);
        }
        for (let k = p.start; k < p.start + p.text.length; k++) covered[k] = true;
      });
      for (let k = 0; k < text.length; k++) {
        if (!covered[k]) expect(text.charAt(k)).toMatch(/[\r\n]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------

describe('splitSentences', () => {
  it.each<[string, string[]]>([
    ['Hello world.', ['Hello world.']],
    ['Hello world', ['Hello world']],
    ['One. Two! Three?', ['One.', 'Two!', 'Three?']],
    ['Dr. Smith arrived. He sat down.', ['Dr. Smith arrived.', 'He sat down.']],
    ['Mr. and Mrs. Smith left. Then we did.', ['Mr. and Mrs. Smith left.', 'Then we did.']],
    ['Pi is 3.14 exactly. Nice.', ['Pi is 3.14 exactly.', 'Nice.']],
    ['We need apples, e.g. Granny Smith. Also pears.', ['We need apples, e.g. Granny Smith.', 'Also pears.']],
    ['Use a fork, i.e. not a spoon. Fine.', ['Use a fork, i.e. not a spoon.', 'Fine.']],
    ['Cats etc. are great. Dogs too.', ['Cats etc. are great.', 'Dogs too.']],
    ['Cats vs. dogs is old. Yes.', ['Cats vs. dogs is old.', 'Yes.']],
    ['The U.S. economy grew. Wow.', ['The U.S. economy grew.', 'Wow.']],
    ['He has a Ph.D. in math. Cool.', ['He has a Ph.D. in math.', 'Cool.']],
    ['I was... thinking. Yes.', ['I was... thinking.', 'Yes.']],
    ['I was… thinking. Yes.', ['I was… thinking.', 'Yes.']],
    ['He said "Stop!" and left.', ['He said "Stop!" and left.']],
    ['“Hello.” She smiled.', ['“Hello.”', 'She smiled.']],
    ["He said 'go.' Then he left.", ["He said 'go.'", 'Then he left.']],
    ['(See below.) Then go.', ['(See below.)', 'Then go.']],
    ['Done. "Quoted start." End.', ['Done.', '"Quoted start."', 'End.']],
    ['It cost $5. Then 10 more.', ['It cost $5.', 'Then 10 more.']],
    ['J. K. Rowling wrote it. Yes.', ['J. K. Rowling wrote it.', 'Yes.']],
    ['No. 5 is best. Really.', ['No. 5 is best.', 'Really.']],
    ['See Fig. 3 for details. Done.', ['See Fig. 3 for details.', 'Done.']],
    ['Wait!!! What?!', ['Wait!!!', 'What?!']],
    ['Visit example.com. Then rest.', ['Visit example.com.', 'Then rest.']],
    ['Great! 😀 See you.', ['Great!', '😀 See you.']],
    ['Line one\nline two', ['Line one', 'line two']],
    ['Ends here.\r\nNext line.', ['Ends here.', 'Next line.']],
    ['  padded.   ', ['padded.']],
    ['', []],
    ['   ', []],
    ['\n\n', []],
    ['The\u00a0cat.\u00a0Then\u00a0dog.', ['The\u00a0cat.', 'Then\u00a0dog.']],
    ['Full width。Next', ['Full width。Next']],
    ['Full width。 Next', ['Full width。', 'Next']],
  ])('splits %j', (text, expected) => {
    expect(sentenceStrings(text)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['Really? yes.', ['Really? yes.']],
    ['We met at 5 p.m. Then we left.', ['We met at 5 p.m. Then we left.']],
    ['Plan A. Then plan B.', ['Plan A. Then plan B.']],
  ])('documented limitation: %j stays one sentence', (text, expected) => {
    expect(sentenceStrings(text)).toEqual(expected);
  });

  it('property: ranges are trimmed, ordered, non-overlapping and inside the text', () => {
    const rng = makeRng(99);
    const alphabet = ['a', 'B', ' ', ' ', '.', '!', '?', '\n', '"', '”', ')', '😀', '3', 'Mr', 'e.g', '\u00a0'] as const;
    for (let iter = 0; iter < 400; iter++) {
      const text = randomText(rng, alphabet, 30);
      const ranges = splitSentences(text);
      let last = 0;
      for (const r of ranges) {
        expect(r.start).toBeGreaterThanOrEqual(last);
        expect(r.end).toBeGreaterThan(r.start);
        expect(r.end).toBeLessThanOrEqual(text.length);
        expect(text.charAt(r.start)).not.toMatch(/\s/);
        expect(text.charAt(r.end - 1)).not.toMatch(/\s/);
        last = r.end;
      }
      if (text.trim().length > 0) expect(ranges.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeForMatch / locateSpan
// ---------------------------------------------------------------------------

describe('normalizeForMatch', () => {
  it.each<[string, string]>([
    ['“Hi”', '"Hi"'],
    ['don’t', "don't"],
    ['a\u00a0b', 'a b'],
    ['a\tb', 'a b'],
    ['rock–paper', 'rock-paper'],
    ['em—dash', 'em-dash'],
    ['plain', 'plain'],
    ['…', '…'],
    ['😀', '😀'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeForMatch(input)).toBe(expected);
  });

  it('property: is length-preserving and idempotent', () => {
    const rng = makeRng(3);
    for (let iter = 0; iter < 500; iter++) {
      const s = randomText(rng, UNICODE_ALPHABET, 30);
      const n = normalizeForMatch(s);
      expect(n.length).toBe(s.length);
      expect(normalizeForMatch(n)).toBe(n);
    }
  });
});

describe('locateSpan', () => {
  it.each<[string, string, string, Parameters<typeof locateSpan>[2] | undefined, number]>([
    ['single exact match', 'the cat sat', 'cat', undefined, 4],
    ['match at 0', 'cat sat', 'cat', undefined, 0],
    ['match at end', 'the cat', 'cat', undefined, 4],
    ['not found', 'the cat sat', 'dog', undefined, -1],
    ['empty original', 'the cat', '', undefined, -1],
    ['empty text', '', 'cat', undefined, -1],
    ['ambiguous without hints', 'a b a', 'a', undefined, -1],
    ['occurrence 0', 'a b a', 'a', { occurrence: 0 }, 0],
    ['occurrence 1', 'a b a', 'a', { occurrence: 1 }, 4],
    ['occurrence out of range', 'a b a', 'a', { occurrence: 2 }, -1],
    ['occurrence negative', 'a b a', 'a', { occurrence: -1 }, -1],
    ['searchFrom', 'a b a', 'a', { searchFrom: 1 }, 4],
    ['searchTo', 'a b a', 'a', { searchTo: 1 }, 0],
    ['window excludes partial match', 'a b a', 'a', { searchFrom: 1, searchTo: 4 }, -1],
    ['searchTo must contain the whole match', 'the cat', 'cat', { searchTo: 6 }, -1],
    ['out-of-range window is clamped', 'the cat', 'cat', { searchFrom: -5, searchTo: 999 }, 4],
    ['suffix disambiguates', 'the cat and the dog', 'the', { suffix: 'dog' }, 12],
    ['prefix disambiguates', 'the cat and the dog', 'the', { prefix: 'and' }, 12],
    ['suffix picks first', 'the cat and the dog', 'the', { suffix: 'cat' }, 0],
    ['prefix+suffix combine', 'x a y, x a z, w a y', 'a', { prefix: 'x', suffix: 'y' }, 2],
    ['prefix with surrounding whitespace is trimmed', 'the cat and the dog', 'the', { prefix: '  and  ' }, 12],
    ['prefix tie falls through to occurrence', 'x a y x a y', 'a', { prefix: 'x', occurrence: 1 }, 8],
    ['prefix tie without occurrence is ambiguous', 'x a y x a y', 'a', { prefix: 'x' }, -1],
    ['non-matching prefix on a single candidate is still returned', 'the cat', 'cat', { prefix: 'zzz' }, 4],
    ['overlapping occurrences', 'aaa', 'aa', { occurrence: 1 }, 1],
    ['curly text, straight original', 'He said “hello” there', '"hello"', undefined, 8],
    ['straight text, curly original', 'He said "hello" there', '“hello”', undefined, 8],
    ['curly apostrophe', 'I don’t know', "don't", undefined, 2],
    ['NBSP in text', 'a\u00a0b c', 'a b', undefined, 0],
    ['NBSP in original', 'a b c', 'a\u00a0b', undefined, 0],
    ['en dash vs hyphen', 'rock–paper', 'rock-paper', undefined, 0],
    ['exact match preferred over normalized twin', '"x" and “x”', '"x"', undefined, 0],
    ['normalized candidates still need disambiguation', '“x” and “x”', '"x"', undefined, -1],
    ['normalized candidates with occurrence', '“x” and “x”', '"x"', { occurrence: 1 }, 8],
    ['normalized prefix comparison', 'she said “hi” to the “hi” man', 'hi', { prefix: 'to the "' }, 22],
    ['emoji offsets with occurrence', '😀 cat 😀 cat', 'cat', { occurrence: 1 }, 10],
    ['emoji prefix', '😀 cat 😁 cat', 'cat', { prefix: '😁' }, 10],
    ['ellipsis is not normalized', 'wait… what', 'wait... what', undefined, -1],
  ])('%s', (_name, text, original, hint, expected) => {
    expect(locateSpan(text, original, hint)).toBe(expected);
  });

  it('normalized matches map back to real offsets whose text normalizes to the original', () => {
    const text = 'Start “fancy\u00a0quote” – end';
    const original = '"fancy quote" -';
    const idx = locateSpan(text, original);
    expect(idx).toBe(6);
    expect(normalizeForMatch(text.slice(idx, idx + original.length))).toBe(normalizeForMatch(original));
  });

  it('property: a located span always normalizes to the original', () => {
    const rng = makeRng(11);
    for (let iter = 0; iter < 300; iter++) {
      const text = randomText(rng, UNICODE_ALPHABET, 40);
      if (text.length === 0) continue;
      const a = Math.floor(rng() * text.length);
      const b = a + 1 + Math.floor(rng() * Math.min(6, text.length - a));
      const original = normalizeForMatch(text.slice(a, b));
      const idx = locateSpan(text, original, { occurrence: 0 });
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(normalizeForMatch(text.slice(idx, idx + original.length))).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// diffShift
// ---------------------------------------------------------------------------

describe('diffShift', () => {
  it.each<[string, string, string, ReturnType<typeof diffShift>]>([
    ['identical', 'abc', 'abc', null],
    ['both empty', '', '', null],
    ['insert at end', 'abc', 'abcd', { start: 3, oldEnd: 3, newEnd: 4 }],
    ['insert at start', 'abc', 'xabc', { start: 0, oldEnd: 0, newEnd: 1 }],
    ['insert in middle', 'abc', 'abXc', { start: 2, oldEnd: 2, newEnd: 3 }],
    ['delete middle', 'abXc', 'abc', { start: 2, oldEnd: 3, newEnd: 2 }],
    ['replace', 'hello world', 'hello there', { start: 6, oldEnd: 11, newEnd: 11 }],
    ['overlapping prefix/suffix: insert into aa', 'aa', 'aaa', { start: 2, oldEnd: 2, newEnd: 3 }],
    ['overlapping prefix/suffix: delete from aaa', 'aaa', 'aa', { start: 2, oldEnd: 3, newEnd: 2 }],
    ['from empty', '', 'x', { start: 0, oldEnd: 0, newEnd: 1 }],
    ['to empty', 'x', '', { start: 0, oldEnd: 1, newEnd: 0 }],
    ['total replacement', 'abc', 'xyz', { start: 0, oldEnd: 3, newEnd: 3 }],
    ['emoji insert', 'a b', 'a 😀 b', { start: 2, oldEnd: 2, newEnd: 5 }],
    ['repeated word typed', 'the cat', 'the the cat', { start: 4, oldEnd: 4, newEnd: 8 }],
  ])('%s', (_name, oldText, newText, expected) => {
    expect(diffShift(oldText, newText)).toEqual(expected);
  });

  it('property: region reproduces the edit and is never negative', () => {
    const rng = makeRng(5);
    for (let iter = 0; iter < 500; iter++) {
      const oldText = randomText(rng, UNICODE_ALPHABET, 20);
      const a = Math.floor(rng() * (oldText.length + 1));
      const b = a + Math.floor(rng() * (oldText.length - a + 1));
      const insert = randomText(rng, UNICODE_ALPHABET, 5);
      const newText = oldText.slice(0, a) + insert + oldText.slice(b);
      const d = diffShift(oldText, newText);
      if (oldText === newText) {
        expect(d).toBeNull();
        continue;
      }
      expect(d).not.toBeNull();
      if (d === null) continue;
      expect(d.start).toBeGreaterThanOrEqual(0);
      expect(d.oldEnd).toBeGreaterThanOrEqual(d.start);
      expect(d.newEnd).toBeGreaterThanOrEqual(d.start);
      expect(oldText.slice(0, d.start)).toBe(newText.slice(0, d.start));
      expect(oldText.slice(d.oldEnd)).toBe(newText.slice(d.newEnd));
      expect(newText).toBe(oldText.slice(0, d.start) + newText.slice(d.start, d.newEnd) + oldText.slice(d.oldEnd));
    }
  });
});

// ---------------------------------------------------------------------------
// rebaseSuggestions
// ---------------------------------------------------------------------------

describe('rebaseSuggestions', () => {
  const text = 'teh cat is hapy today';
  const teh = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the' });
  const hapy = mk({ range: { start: 11, end: 15 }, original: 'hapy', replacement: 'happy' });

  it('returns equal but new objects when the text is unchanged', () => {
    const out = rebaseSuggestions([teh, hapy], text, text);
    expect(out).toEqual([teh, hapy]);
    expect(out[0]).not.toBe(teh);
    expect(out[0]?.range).not.toBe(teh.range);
  });

  it('shifts suggestions after an insertion and leaves ones before it alone', () => {
    const newText = 'teh cat is very hapy today';
    const out = rebaseSuggestions([teh, hapy], text, newText);
    expect(out.map((s) => s.range)).toEqual([{ start: 0, end: 3 }, { start: 16, end: 20 }]);
    expect(newText.slice(16, 20)).toBe('hapy');
    expect(hapy.range).toEqual({ start: 11, end: 15 });
  });

  it('shifts left after a deletion before the suggestion', () => {
    const out = rebaseSuggestions([teh, hapy], text, 'teh is hapy today');
    expect(out.map((s) => s.range)).toEqual([{ start: 0, end: 3 }, { start: 7, end: 11 }]);
  });

  it('drops the suggestion the user typed inside of and keeps the rest', () => {
    const out = rebaseSuggestions([teh, hapy], text, 'teh cat is haXpy today');
    expect(out.map((s) => s.id)).toEqual([teh.id]);
  });

  it('drops a suggestion whose text was deleted', () => {
    const out = rebaseSuggestions([teh, hapy], text, 'cat is hapy today');
    expect(out.map((s) => s.id)).toEqual([hapy.id]);
    expect(out[0]?.range).toEqual({ start: 7, end: 11 });
  });

  it('drops suggestions overlapping a replacement that spans them', () => {
    const out = rebaseSuggestions([teh, hapy], text, 'the cat is happy today');
    expect(out).toEqual([]);
  });

  it('keeps a suggestion that merely touches the change boundary', () => {
    const out = rebaseSuggestions([teh], text, 'tehx cat is hapy today');
    expect(out.map((s) => s.range)).toEqual([{ start: 0, end: 3 }]);
  });

  it('drops survivors whose original no longer matches', () => {
    const stale = mk({ range: { start: 4, end: 7 }, original: 'dog' });
    expect(rebaseSuggestions([stale], text, text)).toEqual([]);
    expect(rebaseSuggestions([stale], text, `${text}!`)).toEqual([]);
  });

  it('shifts by two code units when an emoji is inserted before the suggestion', () => {
    const out = rebaseSuggestions([hapy], text, '😀teh cat is hapy today');
    expect(out[0]?.range).toEqual({ start: 13, end: 17 });
  });

  it('does not mutate its input', () => {
    const frozen = Object.freeze(mk({ range: Object.freeze({ start: 11, end: 15 }) as TextRange, original: 'hapy' }));
    const out = rebaseSuggestions([frozen], text, `x${text}`);
    expect(out[0]?.range).toEqual({ start: 12, end: 16 });
    expect(frozen.range).toEqual({ start: 11, end: 15 });
  });

  it('property: typing in the middle of one word drops only that suggestion', () => {
    const rng = makeRng(21);
    for (let iter = 0; iter < 200; iter++) {
      const wordCount = 3 + Math.floor(rng() * 6);
      const words = Array.from({ length: wordCount }, () => randomText(rng, ['a', 'b', 'c', 'é', '😀'], 4) || 'w');
      const oldText = words.join(' ');
      const suggestions: Suggestion[] = [];
      let offset = 0;
      for (const w of words) {
        suggestions.push(mk({ range: { start: offset, end: offset + w.length }, original: w }));
        offset += w.length + 1;
      }
      const victim = Math.floor(rng() * wordCount);
      const victimSuggestion = suggestions[victim];
      expect(victimSuggestion).toBeDefined();
      if (!victimSuggestion) continue;
      const insertAt = victimSuggestion.range.start + Math.floor(rng() * (victimSuggestion.range.end - victimSuggestion.range.start + 1));
      const inserted = pick(rng, ['x', 'xy', '😀', ' ']);
      const newText = oldText.slice(0, insertAt) + inserted + oldText.slice(insertAt);
      const out = rebaseSuggestions(suggestions, oldText, newText);
      const survivingIds = new Set(out.map((s) => s.id));
      for (const s of out) expect(newText.slice(s.range.start, s.range.end)).toBe(s.original);
      // Typing strictly inside the word must drop that word's suggestion; every other word survives.
      // When the inserted text equals its neighbour (e.g. an emoji typed next to the same emoji) the
      // diff cannot tell "before" from "after", so judge "inside" by where diffShift places the change.
      const region = diffShift(oldText, newText);
      expect(region).not.toBeNull();
      if (region === null) continue;
      const strictlyInside = region.start > victimSuggestion.range.start && region.start < victimSuggestion.range.end;
      if (strictlyInside) expect(survivingIds.has(victimSuggestion.id)).toBe(false);
      if (inserted.startsWith('x') && insertAt > victimSuggestion.range.start && insertAt < victimSuggestion.range.end) {
        // 'x' never occurs in the words, so the insertion point is unambiguous.
        expect(strictlyInside).toBe(true);
        expect(survivingIds.has(victimSuggestion.id)).toBe(false);
      }
      for (const s of suggestions) {
        if (s.id !== victimSuggestion.id) expect(survivingIds.has(s.id)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOverlaps / compareSuggestionPriority
// ---------------------------------------------------------------------------

describe('compareSuggestionPriority', () => {
  const base = { range: { start: 0, end: 3 }, original: 'abc' };

  it('orders categories correctness > clarity > engagement > delivery', () => {
    const cats: SuggestionCategory[] = ['delivery', 'engagement', 'clarity', 'correctness'];
    const sorted = cats.map((category) => mk({ ...base, category })).sort(compareSuggestionPriority);
    expect(sorted.map((s) => s.category)).toEqual(['correctness', 'clarity', 'engagement', 'delivery']);
  });

  it('prefers higher confidence within a category', () => {
    const low = mk({ ...base, confidence: 0.4 });
    const high = mk({ ...base, confidence: 0.9 });
    expect(compareSuggestionPriority(low, high)).toBeGreaterThan(0);
    expect(compareSuggestionPriority(high, low)).toBeLessThan(0);
  });

  it.each<[SuggestionCategory, SuggestionSource]>([
    ['correctness', 'rules'],
    ['clarity', 'llm'],
    ['engagement', 'llm'],
    ['delivery', 'llm'],
  ])('for %s prefers the %s source at equal confidence', (category, winner) => {
    const rules = mk({ ...base, category, source: 'rules', confidence: 0.8 });
    const llm = mk({ ...base, category, source: 'llm', confidence: 0.8 });
    const sorted = [rules, llm].sort(compareSuggestionPriority);
    expect(sorted[0]?.source).toBe(winner);
    expect([llm, rules].sort(compareSuggestionPriority)[0]?.source).toBe(winner);
  });

  it('prefers the longer range, then the earlier start, and is 0 for equal candidates', () => {
    const short = mk({ range: { start: 2, end: 4 }, original: 'bc' });
    const long = mk({ range: { start: 1, end: 5 }, original: 'abcd' });
    expect(compareSuggestionPriority(short, long)).toBeGreaterThan(0);
    const early = mk({ range: { start: 0, end: 2 }, original: 'ab' });
    const late = mk({ range: { start: 4, end: 6 }, original: 'ef' });
    expect(compareSuggestionPriority(late, early)).toBeGreaterThan(0);
    expect(compareSuggestionPriority(early, mk({ range: { start: 0, end: 2 }, original: 'ab' }))).toBe(0);
  });
});

describe('resolveOverlaps', () => {
  it('returns [] for no suggestions', () => {
    expect(resolveOverlaps([])).toEqual([]);
  });

  it('keeps non-overlapping suggestions and returns them in reading order', () => {
    const a = mk({ range: { start: 10, end: 12 }, original: 'ab' });
    const b = mk({ range: { start: 0, end: 3 }, original: 'abc' });
    const c = mk({ range: { start: 3, end: 5 }, original: 'de' });
    const out = resolveOverlaps([a, b, c]);
    expect(out.map((s) => s.id)).toEqual([b.id, c.id, a.id]);
  });

  it('touching ranges do not overlap', () => {
    const a = mk({ range: { start: 0, end: 3 }, original: 'abc' });
    const b = mk({ range: { start: 3, end: 6 }, original: 'def' });
    expect(resolveOverlaps([a, b])).toHaveLength(2);
  });

  it('correctness beats clarity on overlap regardless of confidence', () => {
    const clarity = mk({ category: 'clarity', confidence: 1, range: { start: 0, end: 10 }, original: 'abcdefghij' });
    const correctness = mk({ category: 'correctness', confidence: 0.6, range: { start: 2, end: 4 }, original: 'cd' });
    expect(resolveOverlaps([clarity, correctness]).map((s) => s.id)).toEqual([correctness.id]);
  });

  it('within a category the higher confidence wins', () => {
    const low = mk({ category: 'clarity', confidence: 0.5, range: { start: 0, end: 5 }, original: 'abcde' });
    const high = mk({ category: 'clarity', confidence: 0.9, range: { start: 3, end: 8 }, original: 'defgh' });
    expect(resolveOverlaps([low, high]).map((s) => s.id)).toEqual([high.id]);
  });

  it('rules beat llm for correctness but llm beats rules for style categories', () => {
    const rulesC = mk({ category: 'correctness', source: 'rules', confidence: 0.9, range: { start: 0, end: 4 }, original: 'abcd' });
    const llmC = mk({ category: 'correctness', source: 'llm', confidence: 0.9, range: { start: 2, end: 6 }, original: 'cdef' });
    expect(resolveOverlaps([llmC, rulesC]).map((s) => s.id)).toEqual([rulesC.id]);
    const rulesD = mk({ category: 'delivery', source: 'rules', confidence: 0.9, range: { start: 0, end: 4 }, original: 'abcd' });
    const llmD = mk({ category: 'delivery', source: 'llm', confidence: 0.9, range: { start: 2, end: 6 }, original: 'cdef' });
    expect(resolveOverlaps([rulesD, llmD]).map((s) => s.id)).toEqual([llmD.id]);
  });

  it('prefers the longer range, then the earlier start', () => {
    const short = mk({ range: { start: 2, end: 4 }, original: 'cd' });
    const long = mk({ range: { start: 0, end: 5 }, original: 'abcde' });
    expect(resolveOverlaps([short, long]).map((s) => s.id)).toEqual([long.id]);
    const early = mk({ range: { start: 0, end: 3 }, original: 'abc' });
    const late = mk({ range: { start: 2, end: 5 }, original: 'cde' });
    expect(resolveOverlaps([late, early]).map((s) => s.id)).toEqual([early.id]);
  });

  it('is greedy: a chain A-B-C keeps A and C when A does not overlap C', () => {
    const a = mk({ range: { start: 0, end: 4 }, original: 'abcd' });
    const b = mk({ range: { start: 3, end: 7 }, original: 'defg' });
    const c = mk({ range: { start: 6, end: 10 }, original: 'ghij' });
    expect(resolveOverlaps([b, c, a]).map((s) => s.id)).toEqual([a.id, c.id]);
  });

  it('collapses identical duplicates and merges alternatives without the replacement', () => {
    const first = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the', alternatives: ['then', 'the'], source: 'llm', confidence: 0.8 });
    const second = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the', alternatives: ['them', 'then'], source: 'rules', confidence: 1 });
    const out = resolveOverlaps([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(second.id);
    expect(out[0]?.alternatives).toEqual(['them', 'then']);
    expect(second.alternatives).toEqual(['them', 'then']);
    expect(first.alternatives).toEqual(['then', 'the']);
  });

  it('merges alternatives in priority order when the winner has none', () => {
    const winner = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the', confidence: 1 });
    const loser = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the', confidence: 0.5, alternatives: ['then'] });
    const out = resolveOverlaps([loser, winner]);
    expect(out[0]?.id).toBe(winner.id);
    expect(out[0]?.alternatives).toEqual(['then']);
    expect(winner.alternatives).toEqual([]);
  });

  it('same range with different replacements is an overlap, not a duplicate', () => {
    const a = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the', confidence: 1 });
    const b = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'tech', confidence: 0.9 });
    const out = resolveOverlaps([b, a]);
    expect(out.map((s) => s.id)).toEqual([a.id]);
  });

  it('two zero-width insertions at the same offset conflict; at different offsets they do not', () => {
    const a = mk({ range: { start: 5, end: 5 }, original: '', replacement: ',', confidence: 1 });
    const b = mk({ range: { start: 5, end: 5 }, original: '', replacement: ';', confidence: 0.5 });
    expect(resolveOverlaps([a, b]).map((s) => s.id)).toEqual([a.id]);
    const c = mk({ range: { start: 7, end: 7 }, original: '', replacement: ',' });
    expect(resolveOverlaps([a, c])).toHaveLength(2);
  });

  it('a zero-width insertion inside a replaced span conflicts with it', () => {
    const span = mk({ range: { start: 3, end: 7 }, original: 'abcd', confidence: 1 });
    const insertion = mk({ range: { start: 5, end: 5 }, original: '', replacement: ',', confidence: 1 });
    expect(resolveOverlaps([insertion, span]).map((s) => s.id)).toEqual([span.id]);
    const touching = mk({ range: { start: 7, end: 7 }, original: '', replacement: ',' });
    expect(resolveOverlaps([span, touching])).toHaveLength(2);
  });

  it('returns copies and never mutates the input', () => {
    const a = mk({ range: { start: 0, end: 3 }, original: 'abc', alternatives: ['x'] });
    const snapshot = JSON.stringify(a);
    const out = resolveOverlaps([a]);
    expect(out[0]).not.toBe(a);
    expect(out[0]?.range).not.toBe(a.range);
    expect(out[0]?.alternatives).not.toBe(a.alternatives);
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it('is deterministic for fully equal candidates (input order breaks the tie)', () => {
    const a = mk({ range: { start: 0, end: 3 }, original: 'abc', replacement: 'x' });
    const b = mk({ range: { start: 1, end: 4 }, original: 'bcd', replacement: 'y' });
    expect(resolveOverlaps([a, b])[0]?.id).toBe(a.id);
    expect(resolveOverlaps([b, a])[0]?.id).toBe(a.id);
    const c = mk({ range: { start: 0, end: 3 }, original: 'abc', replacement: 'z' });
    expect(resolveOverlaps([c, a])[0]?.id).toBe(c.id);
    expect(resolveOverlaps([a, c])[0]?.id).toBe(a.id);
  });

  it('property: output never overlaps and each dropped candidate overlaps a kept one of equal or higher priority', () => {
    const rng = makeRng(77);
    const cats: SuggestionCategory[] = ['correctness', 'clarity', 'engagement', 'delivery'];
    for (let iter = 0; iter < 150; iter++) {
      const text = 'x'.repeat(30);
      const input: Suggestion[] = [];
      const count = Math.floor(rng() * 12);
      for (let k = 0; k < count; k++) {
        const start = Math.floor(rng() * 28);
        const end = start + Math.floor(rng() * 5);
        input.push(mk({
          range: { start, end },
          original: text.slice(start, end),
          replacement: pick(rng, ['a', 'b', '']),
          category: pick(rng, cats),
          source: pick(rng, ['rules', 'llm'] as const),
          confidence: pick(rng, [0.5, 0.8, 1]),
        }));
      }
      const out = resolveOverlaps(input);
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i];
          const b = out[j];
          if (!a || !b) continue;
          const overlap = (a.range.start < b.range.end && b.range.start < a.range.end) || (a.range.start === b.range.start && a.range.end === b.range.end);
          expect(overlap).toBe(false);
        }
      }
      const keptIds = new Set(out.map((s) => s.id));
      for (const s of input) {
        if (keptIds.has(s.id)) continue;
        const blockers = out.filter((k) => (k.range.start < s.range.end && s.range.start < k.range.end) || (k.range.start === s.range.start && k.range.end === s.range.end));
        expect(blockers.length).toBeGreaterThan(0);
        expect(blockers.some((k) => compareSuggestionPriority(k, s) <= 0)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// applyEdits
// ---------------------------------------------------------------------------

describe('applyEdits', () => {
  it('returns the text unchanged with no edits and an identity mapOffset', () => {
    const r = applyEdits('hello', []);
    expect(r.text).toBe('hello');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect([0, 2, 5].map(r.mapOffset)).toEqual([0, 2, 5]);
  });

  it('handles empty text with an insertion at 0', () => {
    const r = applyEdits('', [edit(0, 0, '', 'hi')]);
    expect(r.text).toBe('hi');
    expect(r.applied).toHaveLength(1);
  });

  it.each<[string, string, Edit[], string, number, number]>([
    ['single replacement', 'hello world', [edit(0, 5, 'hello', 'hi')], 'hi world', 1, 0],
    ['deletion', 'hello world', [edit(5, 6, ' ', '')], 'helloworld', 1, 0],
    ['insertion at 0', 'world', [edit(0, 0, '', 'hello ')], 'hello world', 1, 0],
    ['insertion at text.length', 'hello', [edit(5, 5, '', '!')], 'hello!', 1, 0],
    ['edit covering whole text', 'abc', [edit(0, 3, 'abc', 'xyz')], 'xyz', 1, 0],
    ['adjacent edits', 'abcdef', [edit(0, 3, 'abc', 'X'), edit(3, 6, 'def', 'Y')], 'XY', 2, 0],
    ['unordered input', 'abcdef', [edit(3, 6, 'def', 'Y'), edit(0, 3, 'abc', 'X')], 'XY', 2, 0],
    ['overlapping: first by start wins', 'abcdef', [edit(2, 5, 'cde', 'Z'), edit(0, 3, 'abc', 'X')], 'Xdef', 1, 1],
    ['overlapping same start: shorter (first after sort) wins', 'abcdef', [edit(0, 4, 'abcd', 'L'), edit(0, 2, 'ab', 'S')], 'Scdef', 1, 1],
    ['mismatched original skipped', 'abcdef', [edit(0, 3, 'zzz', 'X')], 'abcdef', 0, 1],
    ['edit overlapping only a skipped edit is applied', 'abcdef', [edit(0, 3, 'zzz', 'X'), edit(2, 4, 'cd', 'Y')], 'abYef', 1, 1],
    ['out of range skipped', 'abc', [edit(2, 9, 'c', 'X')], 'abc', 0, 1],
    ['negative start skipped', 'abc', [edit(-1, 1, 'a', 'X')], 'abc', 0, 1],
    ['inverted range skipped', 'abc', [edit(2, 1, '', 'X')], 'abc', 0, 1],
    ['zero-width then replacement at same offset', 'abcdef', [edit(2, 5, 'cde', 'Z'), edit(2, 2, '', '+')], 'ab+Zf', 2, 0],
    ['two insertions at the same offset keep input order', 'ab', [edit(1, 1, '', 'X'), edit(1, 1, '', 'Y')], 'aXYb', 2, 0],
    ['emoji replacement', 'I am 😀 today', [edit(5, 7, '😀', '😢')], 'I am 😢 today', 1, 0],
    ['emoji split range mismatches and is skipped', 'I am 😀 today', [edit(5, 6, '😀', 'x')], 'I am 😀 today', 0, 1],
    ['NBSP original must match exactly', 'a\u00a0b', [edit(1, 2, ' ', '-')], 'a\u00a0b', 0, 1],
    ['NBSP replaced', 'a\u00a0b', [edit(1, 2, '\u00a0', ' ')], 'a b', 1, 0],
    ['curly quote edit', 'say “hi”', [edit(4, 5, '“', '"'), edit(7, 8, '”', '"')], 'say "hi"', 2, 0],
    ['CRLF preserved around edits', 'a\r\nb', [edit(0, 1, 'a', 'A'), edit(3, 4, 'b', 'B')], 'A\r\nB', 2, 0],
    ['many edits', 'the cat sat on teh mat', [edit(15, 18, 'teh', 'the'), edit(0, 3, 'the', 'The'), edit(22, 22, '', '.')], 'The cat sat on the mat.', 3, 0],
  ])('%s', (_name, text, edits, expected, appliedCount, skippedCount) => {
    const r = applyEdits(text, edits);
    expect(r.text).toBe(expected);
    expect(r.applied).toHaveLength(appliedCount);
    expect(r.skipped).toHaveLength(skippedCount);
    expect(r.applied.length + r.skipped.length).toBe(edits.length);
    for (const e of r.applied) expect(edits).toContain(e);
  });

  describe('mapOffset', () => {
    it('maps offsets before, inside, at the end of, and after a replacement', () => {
      const r = applyEdits('hello world', [edit(0, 5, 'hello', 'hi'), edit(6, 11, 'world', 'there!')]);
      expect(r.text).toBe('hi there!');
      expect([0, 1, 2, 4, 5, 6, 8, 11].map(r.mapOffset)).toEqual([0, 2, 2, 2, 2, 3, 9, 9]);
    });

    it('maps across a deletion and an insertion', () => {
      const r = applyEdits('abcdef', [edit(1, 3, 'bc', ''), edit(5, 5, '', 'XYZ')]);
      expect(r.text).toBe('adeXYZf');
      expect([0, 1, 2, 3, 4, 5, 6].map(r.mapOffset)).toEqual([0, 1, 1, 1, 2, 3, 7]);
    });

    it('keeps an offset at the start of a zero-width insertion before the inserted text', () => {
      const r = applyEdits('ab', [edit(1, 1, '', 'XX')]);
      expect(r.text).toBe('aXXb');
      expect(r.mapOffset(1)).toBe(1);
      expect(r.mapOffset(2)).toBe(4);
    });

    it('clamps out-of-range inputs', () => {
      const r = applyEdits('abc', [edit(3, 3, '', 'd')]);
      expect(r.mapOffset(-10)).toBe(0);
      expect(r.mapOffset(99)).toBe(3);
    });

    it('is monotonic', () => {
      const r = applyEdits('the quick brown fox', [edit(4, 9, 'quick', 'slow'), edit(10, 15, 'brown', 'reddish-brown'), edit(19, 19, '', '!')]);
      let last = -1;
      for (let o = 0; o <= 19; o++) {
        const m = r.mapOffset(o);
        expect(m).toBeGreaterThanOrEqual(last);
        last = m;
      }
    });
  });

  it('property: random non-overlapping edits all apply, match a left-to-right rebuild, and mapOffset locates each replacement', () => {
    const rng = makeRng(123);
    for (let iter = 0; iter < 300; iter++) {
      const text = randomText(rng, UNICODE_ALPHABET, 30);
      const edits: Edit[] = [];
      let cursor = 0;
      while (cursor <= text.length && rng() < 0.8) {
        const start = cursor + Math.floor(rng() * (text.length - cursor + 1));
        const end = start + Math.floor(rng() * (text.length - start + 1));
        edits.push(edit(start, end, text.slice(start, end), randomText(rng, UNICODE_ALPHABET, 4)));
        cursor = end + (end === start ? 1 : 0);
        if (end === start && cursor > text.length) break;
      }
      // Shuffle so input order does not matter.
      const shuffled = [...edits].sort(() => rng() - 0.5);
      const r = applyEdits(text, shuffled);
      expect(r.skipped).toEqual([]);
      expect(r.applied.map((e) => e.range.start)).toEqual([...edits].map((e) => e.range.start).sort((a, b) => a - b));
      let rebuilt = '';
      let at = 0;
      for (const e of edits) {
        rebuilt += text.slice(at, e.range.start) + e.replacement;
        at = e.range.end;
      }
      rebuilt += text.slice(at);
      expect(r.text).toBe(rebuilt);
      for (const e of edits) {
        if (e.range.end === e.range.start) continue;
        expect(r.text.slice(r.mapOffset(e.range.start), r.mapOffset(e.range.end))).toBe(e.replacement);
      }
      // Re-applying the applied edits against the original text is a no-op change set: nothing mismatches.
      const again = applyEdits(text, r.applied);
      expect(again.text).toBe(r.text);
      expect(again.skipped).toEqual([]);
    }
  });

  it('property: applying resolveOverlaps output never skips anything', () => {
    const rng = makeRng(321);
    for (let iter = 0; iter < 200; iter++) {
      const text = randomText(rng, ['a', 'b', ' ', '😀', '.'], 25);
      const suggestions: Suggestion[] = [];
      const n = Math.floor(rng() * 8);
      for (let k = 0; k < n; k++) {
        const start = Math.floor(rng() * (text.length + 1));
        const end = start + Math.floor(rng() * (text.length - start + 1));
        suggestions.push(mk({ range: { start, end }, original: text.slice(start, end), replacement: randomText(rng, ['x', 'y'], 3), category: pick(rng, ['correctness', 'clarity'] as const) }));
      }
      const resolved = resolveOverlaps(suggestions);
      const r = applyEdits(text, resolved.map((s) => ({ range: s.range, original: s.original, replacement: s.replacement })));
      expect(r.skipped).toEqual([]);
      expect(r.applied).toHaveLength(resolved.length);
    }
  });
});

// ---------------------------------------------------------------------------
// countWords / readingTimeSeconds / syllables / Flesch-Kincaid
// ---------------------------------------------------------------------------

describe('countWords', () => {
  it.each<[string, number]>([
    ['', 0],
    ['   ', 0],
    ['hello', 1],
    ['hello world', 2],
    ["don't stop-me", 2],
    ['a\u00a0b', 2],
    ['—', 0],
    ['😀', 0],
    ['hi 😀 there', 2],
    ['https://x.com is up', 3],
    ['one\ntwo\r\nthree', 3],
    ['  spaced   out  ', 2],
    ['3.14 is pi', 3],
    ['café résumé', 2],
    ['(parenthetical) remark!', 2],
    ['a, b, c', 3],
  ])('counts %j as %i', (text, expected) => {
    expect(countWords(text)).toBe(expected);
  });
});

describe('readingTimeSeconds', () => {
  it('is 0 for no words and rounds up otherwise', () => {
    expect(readingTimeSeconds('')).toBe(0);
    expect(readingTimeSeconds('one')).toBe(1);
    expect(readingTimeSeconds(Array.from({ length: 238 }, () => 'w').join(' '))).toBe(60);
    expect(readingTimeSeconds(Array.from({ length: 476 }, () => 'w').join(' '))).toBe(120);
    expect(readingTimeSeconds(Array.from({ length: 100 }, () => 'w').join(' '), 100)).toBe(60);
    expect(readingTimeSeconds('one two', 0)).toBe(0);
  });
});

describe('countSyllables', () => {
  it.each<[string, number]>([
    ['cat', 1],
    ['the', 1],
    ['a', 1],
    ['make', 1],
    ['tree', 1],
    ['table', 2],
    ['little', 2],
    ['jumped', 1],
    ['boxes', 1],
    ['communication', 5],
    ['2024', 1],
    ['---', 1],
    ['', 1],
    ['Hello,', 2],
    ['yellow', 2],
  ])('%j -> %i', (word, expected) => {
    expect(countSyllables(word)).toBe(expected);
  });

  it('approximates "beautiful" within one syllable', () => {
    expect(Math.abs(countSyllables('beautiful') - 3)).toBeLessThanOrEqual(1);
  });
});

describe('fleschKincaidGrade', () => {
  it('is 0 for empty text and for trivially simple text', () => {
    expect(fleschKincaidGrade('')).toBe(0);
    expect(fleschKincaidGrade('Go.')).toBe(0);
    expect(fleschKincaidGrade('The cat sat on the mat.')).toBe(0);
  });

  it('ranks complex prose above simple prose', () => {
    const simple = 'The cat sat on the mat. It was warm. The dog ran by.';
    const complex = 'Notwithstanding the aforementioned considerations, the committee unanimously determined that further deliberation was unnecessary.';
    expect(fleschKincaidGrade(complex)).toBeGreaterThan(fleschKincaidGrade(simple));
    expect(fleschKincaidGrade(complex)).toBeGreaterThan(12);
  });

  it('is rounded to one decimal', () => {
    const g = fleschKincaidGrade('Reading comprehension improves with deliberate, consistent practice over many months.');
    expect(Math.round(g * 10) / 10).toBe(g);
  });
});

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------

describe('computeScore', () => {
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const sug = (category: SuggestionCategory): Suggestion => mk({ category, range: { start: 0, end: 2 }, original: 'w0' });

  it('returns 0 / 0 / 0 for empty text', () => {
    expect(computeScore('', [])).toEqual({ overall: 0, wordCount: 0, readingTimeSeconds: 0 });
    expect(computeScore('   \n', [])).toEqual({ overall: 0, wordCount: 0, readingTimeSeconds: 0 });
    expect(computeScore('😀 — !', [sug('correctness')])).toEqual({ overall: 0, wordCount: 0, readingTimeSeconds: 0 });
  });

  it('returns 100 only for at least one word and no suggestions', () => {
    const s = computeScore('Hello there.', []);
    expect(s.overall).toBe(100);
    expect(s.wordCount).toBe(2);
    expect(s.readingTimeSeconds).toBe(1);
    expect(typeof s.readability).toBe('number');
  });

  it.each<[number, SuggestionCategory[], number]>([
    [100, ['correctness'], 96],
    [100, ['clarity'], 98],
    [100, ['engagement'], 99],
    [100, ['delivery'], 99],
    [100, ['correctness', 'correctness', 'correctness', 'correctness', 'correctness', 'clarity', 'clarity', 'clarity', 'clarity', 'clarity'], 70],
    [20, ['correctness'], 80],
    [50, ['correctness'], 92],
    [200, ['correctness'], 98],
  ])('%i words with %j -> %i', (n, cats, expected) => {
    expect(computeScore(words(n), cats.map(sug)).overall).toBe(expected);
  });

  it('treats very short texts as having the floor word count', () => {
    expect(SCORE_DENSITY_FLOOR_WORDS).toBe(20);
    expect(computeScore(words(5), [sug('correctness')]).overall).toBe(80);
    expect(computeScore(words(1), [sug('correctness')]).overall).toBe(80);
  });

  it('never returns 100 when any suggestion exists, and never goes below 0', () => {
    expect(computeScore(words(2000), [sug('delivery')]).overall).toBe(99);
    expect(computeScore(words(10), Array.from({ length: 50 }, () => sug('correctness'))).overall).toBe(0);
  });

  it('includes readability and reading time', () => {
    const s = computeScore(words(238), [sug('clarity')]);
    expect(s.readingTimeSeconds).toBe(60);
    expect(s.wordCount).toBe(238);
    expect(s.readability).toBe(fleschKincaidGrade(words(238)));
  });
});

// ---------------------------------------------------------------------------
// isLikelyCode
// ---------------------------------------------------------------------------

describe('isLikelyCode', () => {
  it.each<[string, string]>([
    ['empty', ''],
    ['whitespace', '  \n '],
    ['plain prose', 'The quick brown fox jumps over the lazy dog. It was a sunny day, and everyone was happy.'],
    ['URL-heavy sentence', 'Check out https://example.com/foo?bar=1&baz=2 and http://test.org/path#frag for details.'],
    ['URLs alone', 'https://example.com/a?b=c&d=e[0] https://foo.io/{x}'],
    ['markdown with inline code', 'Run `npm install` and then `npm start` to begin. The `config.json` file holds settings.'],
    ['markdown with a fenced block', 'Here is how:\n\n```js\nconst x = f();\n```\n\nThen run it and tell me what happens.'],
    ['email signature', 'John Smith\nCEO, Acme Inc.\njohn@acme.com\n+1 (555) 123-4567'],
    ['prose with semicolons', 'We went home; it was late; nobody cared.'],
    ['chat message', 'lol ok (brb)'],
    ['math in prose', 'If x = 5 and y = 10 then z = 15.'],
    ['product names', 'I love my iPhone and iPad.'],
    ['parentheticals', 'Smith (CEO) resigned (again).'],
    ['team update', 'Hey team, quick update: the deploy went out at 5pm and everything looks stable. Ping me if you see errors.'],
    ['letter', 'Dear Dr. Jones,\n\nThank you for your time yesterday. I have attached the revised proposal.\n\nBest,\nAna'],
    ['bullet notes', 'Meeting notes:\n- budget approved\n- hire two engineers\n- ship by Q3'],
    ['todo line', 'TODO: fix the login bug; also update docs'],
    ['handles and emails', 'cc @alice and @bob.smith, or mail ops@example.com'],
    ['emoji chat', '😀😀 see you at 5!! 🎉'],
    ['curly quotes', '“No way,” she said. “Not today.”'],
  ])('prose: %s -> false', (_name, text) => {
    expect(isLikelyCode(text)).toBe(false);
  });

  it.each<[string, string]>([
    ['JSON object', '{"name": "x", "items": [1,2,3]}'],
    ['JSON array', '[{"id": 1}, {"id": 2}]'],
    ['pretty JSON', '{\n  "enabled": true,\n  "debounceMs": 900\n}'],
    ['JavaScript function', 'function add(a, b) {\n  return a + b;\n}\nconst total = add(1, 2);\nconsole.log(total);'],
    ['one-line statement', 'const x = foo.bar(baz);'],
    ['for loop', 'for (let i = 0; i < 10; i++) { sum += i; }'],
    ['assignments', 'x = 5; y = 10; z = x + y;'],
    ['commented JS', '// Compute the total of the items in the cart\nconst total = items.reduce((sum, item) => sum + item.price, 0);'],
    ['React component', 'import React from "react";\nexport default function App() {\n  return <div>Hi</div>;\n}'],
    ['Python', 'def greet(name):\n    print(f"Hello, {name}")\n    return name.upper()'],
    ['Python with snake_case', 'user_name = get_user()\nfull_name = user_name.strip()\nprint(full_name)'],
    ['HTML', '<div class="card">\n  <p>Hello</p>\n</div>'],
    ['CSS', '.btn {\n  color: red;\n  padding: 4px;\n}'],
    ['SQL', 'SELECT name FROM users WHERE id = 1;'],
    ['TypeScript interface', 'export interface Props {\n  title: string;\n  onClick: () => void;\n}'],
    ['Rust', 'fn main() {\n    let mut x = 5;\n    println!("{}", x);\n}'],
    ['C', '#include <stdio.h>\nint main(void) {\n  printf("hi\\n");\n  return 0;\n}'],
  ])('code: %s -> true', (_name, text) => {
    expect(isLikelyCode(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripUrlsAndCode
// ---------------------------------------------------------------------------

describe('stripUrlsAndCode', () => {
  function check(text: string): { text: string; masked: TextRange[] } {
    const r = stripUrlsAndCode(text);
    expect(r.text.length).toBe(text.length);
    let last = 0;
    for (const m of r.masked) {
      expect(m.start).toBeGreaterThanOrEqual(last);
      expect(m.end).toBeGreaterThan(m.start);
      expect(r.text.slice(m.start, m.end)).toBe(' '.repeat(m.end - m.start));
      last = m.end;
    }
    // Everything outside the masks is untouched.
    let cursor = 0;
    for (const m of r.masked) {
      expect(r.text.slice(cursor, m.start)).toBe(text.slice(cursor, m.start));
      cursor = m.end;
    }
    expect(r.text.slice(cursor)).toBe(text.slice(cursor));
    return r;
  }

  function maskedStrings(text: string): string[] {
    return check(text).masked.map((m) => text.slice(m.start, m.end));
  }

  it('leaves plain text alone', () => {
    expect(check('')).toEqual({ text: '', masked: [] });
    expect(check('Just some words, nothing to mask.')).toEqual({ text: 'Just some words, nothing to mask.', masked: [] });
  });

  it.each<[string, string, string[]]>([
    ['https URL mid-sentence', 'see https://x.com/a?b=1 ok', ['https://x.com/a?b=1']],
    ['trailing period is not part of the URL', 'see https://x.com/a?b=1. ok', ['https://x.com/a?b=1']],
    ['trailing comma and question mark', 'try http://foo.org/bar, or https://baz.net/q?', ['http://foo.org/bar', 'https://baz.net/q']],
    ['URL in parentheses', '(see https://x.com/path) now', ['https://x.com/path']],
    ['wikipedia-style parens kept', 'https://en.wikipedia.org/wiki/Foo_(bar) ok', ['https://en.wikipedia.org/wiki/Foo_(bar)']],
    ['www URL', 'go to www.foo.org/bar, then rest', ['www.foo.org/bar']],
    ['bare domain with path', 'open example.com/path and docs.io.', ['example.com/path', 'docs.io']],
    ['ftp', 'ftp://files.example.com/x', ['ftp://files.example.com/x']],
    ['email', 'mail me@x.com now', ['me@x.com']],
    ['email with plus and subdomain', 'first.last+tag@mail.example.co.uk!', ['first.last+tag@mail.example.co.uk']],
    ['handle', 'thanks @bob!', ['@bob']],
    ['handle at start', '@alice hi', ['@alice']],
    ['dotted handle', 'ping @a.b.c today', ['@a.b.c']],
    ['not a handle inside a word', 'a@b is not an email', []],
    ['email is one mask, not a handle', 'cc ops@example.com please', ['ops@example.com']],
    ['inline code', 'use `npm i` now', ['`npm i`']],
    ['two inline spans', 'set `a` and `b`', ['`a`', '`b`']],
    ['inline code containing a URL masks once', 'see `https://x.com` ok', ['`https://x.com`']],
    ['fenced block', '```js\nlet x\n```\ntext', ['```js\nlet x\n```']],
    ['unclosed backtick is left alone', 'a ` b', []],
    ['emoji inside URL', 'https://x.com/😀 ok', ['https://x.com/😀']],
    ['URL inside quotes', 'he wrote "https://x.com" there', ['https://x.com']],
    ['URL inside curly quotes', 'he wrote “https://x.com” there', ['https://x.com”']],
    ['NBSP ends a URL', 'https://x.com/a\u00a0b', ['https://x.com/a']],
    ['abbreviations are not domains', 'e.g. this, i.e. that, etc.', []],
    ['version numbers are not domains', 'v1.2.3 shipped', []],
    ['mixed', 'Hi @sam, see https://x.io/a and `cfg.json`, mail me@x.com or visit example.com/x. Bye', ['@sam', 'https://x.io/a', '`cfg.json`', 'me@x.com', 'example.com/x']],
  ])('%s', (_name, text, expected) => {
    expect(maskedStrings(text)).toEqual(expected);
  });

  it('property: length is preserved and masks are sorted and non-overlapping on random input', () => {
    const rng = makeRng(55);
    const alphabet = ['a', ' ', '\n', '`', '@', 'x.com', 'https://', 'www.', 'foo', '.', ',', '😀', '\u00a0', '/', '?', 'me@x.io', ')'] as const;
    for (let iter = 0; iter < 400; iter++) {
      const text = randomText(rng, alphabet, 20);
      check(text);
    }
  });

  it('URLs with quote-like characters never produce masks outside the text', () => {
    const r = check('https://x.com/’ and https://y.com/"q');
    for (const m of r.masked) expect(m.end).toBeLessThanOrEqual(r.text.length);
  });
});

// ---------------------------------------------------------------------------
// adversarial
// ---------------------------------------------------------------------------

describe('adversarial', () => {
  const PERF_BUDGET_MS = 200;

  function elapsed(fn: () => unknown): number {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }

  function build(unit: string, length: number): string {
    let s = '';
    while (s.length < length) s += unit;
    return s.slice(0, length);
  }

  const PROSE_50KB = build(
    'The quick brown fox jumps over the lazy dog. Dr. Smith said "hello" to Mrs. Jones, e.g. at 5 p.m. See https://example.com/path?q=1 for details, or mail me@example.com! It was 3.14 degrees… really? Yes.\n',
    50_000,
  );
  const CODE_50KB = build('const total = items.reduce((sum, item) => sum + item.price, 0);\nif (total > 100) { console.log("big"); }\n', 50_000);

  const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
  const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

  /** The overlap rule from the module's contract, reimplemented independently for oracles. */
  const conflicts = (a: TextRange, b: TextRange): boolean => (a.start < b.end && b.start < a.end) || (a.start === b.start && a.end === b.end);

  // -------------------------------------------------------------------------
  describe('hashText / paragraphCacheKey', () => {
    it('distinguishes lone surrogates, surrogate order, and code units that share a low byte', () => {
      const hashes = ['\ud83d', '\ude00', '😀', '\ude00\ud83d', 'a', 'š' /* same low byte as a */, 'A', 'Ł' /* same low byte as A */, '\u0000', '\u0000\u0000', ''].map(hashText);
      for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{16}$/);
      expect(new Set(hashes).size).toBe(hashes.length);
    });

    it('keeps the cache key fixed-width so colons in the inputs can never alias another key', () => {
      const a = paragraphCacheKey('a:b', 'c');
      const b = paragraphCacheKey('a', 'b:c');
      expect(a).toMatch(/^[0-9a-f]{16}:[0-9a-f]{16}$/);
      expect(b).toMatch(/^[0-9a-f]{16}:[0-9a-f]{16}$/);
      expect(a).not.toBe(b);
      expect(a.length).toBe(33);
    });

    it('hashes 50KB well inside the budget', () => {
      expect(elapsed(() => hashText(PROSE_50KB))).toBeLessThan(PERF_BUDGET_MS);
    });
  });

  // -------------------------------------------------------------------------
  describe('splitParagraphs', () => {
    it('treats every mixture of CR, LF and CRLF as boundaries and nothing else', () => {
      expect(splitParagraphs('\r\n\r\n')).toEqual([]);
      expect(splitParagraphs('\r\r\r')).toEqual([]);
      expect(splitParagraphs('a\r\r\nb\n\rc').map((p) => [p.start, p.text])).toEqual([[0, 'a'], [4, 'b'], [7, 'c']]);
      expect(splitParagraphs('  \u0085').map((p) => [p.start, p.text])).toEqual([[0, '  \u0085']]);
    });

    it('keeps whitespace-only and zero-width-only lines as paragraphs with exact offsets', () => {
      expect(splitParagraphs('   ').map((p) => [p.start, p.text])).toEqual([[0, '   ']]);
      expect(splitParagraphs('\n \n').map((p) => [p.start, p.text])).toEqual([[1, ' ']]);
      expect(splitParagraphs('\t\n​\n﻿').map((p) => [p.start, p.text])).toEqual([[0, '\t'], [2, '​'], [4, '﻿']]);
    });

    it('never splits a surrogate pair and places emoji-only paragraphs at the right code-unit offsets', () => {
      const text = '😀\n😀😀\r\n\n😀';
      const paragraphs = splitParagraphs(text);
      expect(paragraphs.map((p) => [p.start, p.text])).toEqual([[0, '😀'], [3, '😀😀'], [10, '😀']]);
      for (const p of paragraphs) {
        expect(isLowSurrogate(text.charCodeAt(p.start))).toBe(false);
        expect(isHighSurrogate(text.charCodeAt(p.start + p.text.length - 1))).toBe(false);
      }
    });

    it('property: splitting A + "\\n" + B equals the split of A followed by the shifted split of B', () => {
      const rng = makeRng(2024);
      for (let iter = 0; iter < 200; iter++) {
        const a = randomText(rng, UNICODE_ALPHABET, 25);
        const b = randomText(rng, UNICODE_ALPHABET, 25);
        const joined = splitParagraphs(`${a}\n${b}`).map((p) => ({ start: p.start, text: p.text, hash: p.hash }));
        const expected = [
          ...splitParagraphs(a).map((p) => ({ start: p.start, text: p.text, hash: p.hash })),
          ...splitParagraphs(b).map((p) => ({ start: p.start + a.length + 1, text: p.text, hash: p.hash })),
        ];
        expect(joined).toEqual(expected);
      }
    });

    it('splits 50KB inside the budget and the last paragraph ends exactly at text.length', () => {
      const text = PROSE_50KB.replace(/\n$/, '') + ' tail';
      let paragraphs: ReturnType<typeof splitParagraphs> = [];
      expect(elapsed(() => { paragraphs = splitParagraphs(text); })).toBeLessThan(PERF_BUDGET_MS);
      const last = paragraphs[paragraphs.length - 1];
      expect(last).toBeDefined();
      if (last) expect(last.start + last.text.length).toBe(text.length);
    });
  });

  // -------------------------------------------------------------------------
  describe('splitSentences', () => {
    const SENTENCE_ALPHABET = ['a', 'B', ' ', ' ', '.', '!', '?', '\n', '\r\n', '\r', '"', '”', ')', '(', '“', '😀', '3', 'Mr', 'e.g', ' ', '…', ' ', '\t'] as const;

    it('property: every non-whitespace code unit lies inside exactly one sentence, and no range splits a surrogate pair', () => {
      const rng = makeRng(31337);
      for (let iter = 0; iter < 500; iter++) {
        const text = randomText(rng, SENTENCE_ALPHABET, 40);
        const ranges = splitSentences(text);
        const owner = new Array<number>(text.length).fill(-1);
        ranges.forEach((r, idx) => {
          expect(isLowSurrogate(text.charCodeAt(r.start))).toBe(false);
          expect(isHighSurrogate(text.charCodeAt(r.end - 1))).toBe(false);
          for (let k = r.start; k < r.end; k++) {
            expect(owner[k]).toBe(-1);
            owner[k] = idx;
          }
        });
        for (let k = 0; k < text.length; k++) {
          if (!/\s/.test(text.charAt(k))) expect(owner[k]).not.toBe(-1);
        }
      }
    });

    it('requires whitespace between a terminator and an emoji opener, but splits once it is there', () => {
      expect(sentenceStrings('Hi!😀 Next')).toEqual(['Hi!😀 Next']);
      expect(sentenceStrings('Hi! 😀 Next')).toEqual(['Hi!', '😀 Next']);
      expect(sentenceStrings('😀. 😀')).toEqual(['😀.', '😀']);
    });

    it('treats CR, LF and CRLF as hard sentence ends even after abbreviations', () => {
      expect(sentenceStrings('Dr.\r\nSmith\rleft. Now')).toEqual(['Dr.', 'Smith', 'left.', 'Now']);
      expect(sentenceStrings('etc.\nThen')).toEqual(['etc.', 'Then']);
      expect(sentenceStrings('e.g.\r\n\r\nx')).toEqual(['e.g.', 'x']);
    });

    it('handles whitespace-only, zero-width-only and terminator-only inputs', () => {
      expect(splitSentences('  \t\r\n ')).toEqual([]);
      expect(splitSentences('​')).toEqual([{ start: 0, end: 1 }]);
      expect(splitSentences('...')).toEqual([{ start: 0, end: 3 }]);
      expect(splitSentences('?!"')).toEqual([{ start: 0, end: 3 }]);
      expect(splitSentences(' . ')).toEqual([{ start: 1, end: 2 }]);
    });

    it('ends ranges exactly at text.length when the text ends in terminators or closers', () => {
      for (const text of ['He said "Go."', 'x.', 'Wow!!!', 'Really?)', 'Done.”', '😀!']) {
        const ranges = splitSentences(text);
        expect(ranges).toHaveLength(1);
        expect(ranges[0]).toEqual({ start: 0, end: text.length });
      }
    });

    it('documented limitation: a lowercase word after a terminator merges into the previous sentence', () => {
      expect(sentenceStrings('wow. amazing. Yes.')).toEqual(['wow. amazing.', 'Yes.']);
    });

    it('splits 50KB of prose and a 50KB run of "a. " inside the budget', () => {
      expect(elapsed(() => splitSentences(PROSE_50KB))).toBeLessThan(PERF_BUDGET_MS);
      expect(elapsed(() => splitSentences('a. '.repeat(17_000)))).toBeLessThan(PERF_BUDGET_MS);
    });
  });

  // -------------------------------------------------------------------------
  describe('normalizeForMatch / locateSpan', () => {
    it('leaves zero-width and combining characters alone and stays length-preserving on them', () => {
      const s = '​‌‍﻿́é⁠';
      expect(normalizeForMatch(s)).toBe(s);
      expect(normalizeForMatch(`“${s}”`)).toBe(`"${s}"`);
    });

    it('treats NaN window hints as absent instead of as an empty window', () => {
      expect(locateSpan('the cat', 'cat', { searchFrom: NaN })).toBe(4);
      expect(locateSpan('the cat', 'cat', { searchTo: NaN })).toBe(4);
      expect(locateSpan('the cat', 'cat', { searchFrom: NaN, searchTo: NaN })).toBe(4);
      expect(locateSpan('the cat', 'cat', { searchFrom: -Infinity, searchTo: Infinity })).toBe(4);
      expect(locateSpan('a b a', 'a', { searchFrom: NaN, occurrence: 1 })).toBe(4);
    });

    it('handles window edges at 0 and text.length exactly', () => {
      expect(locateSpan('abc', 'c', { searchFrom: 3 })).toBe(-1);
      expect(locateSpan('abc', 'c', { searchFrom: 2 })).toBe(2);
      expect(locateSpan('abc', 'a', { searchTo: 0 })).toBe(-1);
      expect(locateSpan('abc', 'a', { searchTo: 1 })).toBe(0);
      expect(locateSpan('the cat', 'cat', { searchTo: 7 })).toBe(4);
      expect(locateSpan('abc', 'b', { searchFrom: 2, searchTo: 1 })).toBe(-1);
      expect(locateSpan('abc', 'abc')).toBe(0);
      expect(locateSpan('abc', 'abcd')).toBe(-1);
      expect(locateSpan('', '')).toBe(-1);
    });

    it('rejects non-integer, infinite and NaN occurrence hints as ambiguous', () => {
      for (const occurrence of [1.5, Infinity, -Infinity, NaN, -0.5]) {
        expect(locateSpan('a b a', 'a', { occurrence })).toBe(-1);
      }
      expect(locateSpan('a b a', 'a', { occurrence: -0 })).toBe(0);
    });

    it('falls through to occurrence when prefix/suffix hints score zero or are whitespace-only', () => {
      expect(locateSpan('x a y x a y', 'a', { prefix: 'zzz', occurrence: 1 })).toBe(8);
      expect(locateSpan('x a y x a y', 'a', { suffix: 'qq', occurrence: 0 })).toBe(2);
      expect(locateSpan('x a y x a y', 'a', { prefix: '  \t', suffix: '', occurrence: 1 })).toBe(8);
      expect(locateSpan('x a y x a y', 'a', { prefix: 'zzz' })).toBe(-1);
    });

    it('does not see through zero-width characters (they are not normalized)', () => {
      expect(locateSpan('a​b', 'ab')).toBe(-1);
      expect(locateSpan('a​b', 'a​b')).toBe(0);
      expect(locateSpan('ab', 'a​b')).toBe(-1);
    });

    it('counts occurrences in code units across emoji and never returns an offset outside the window', () => {
      expect(locateSpan('😀😀😀', '😀', { occurrence: 2 })).toBe(4);
      expect(locateSpan('😀😀😀', '😀😀', { occurrence: 1 })).toBe(2);
      expect(locateSpan('😀a😀a', 'a', { prefix: '😀', suffix: '😀' })).toBe(2);
      expect(locateSpan('😀😀😀', '😀', { searchFrom: 1, occurrence: 0 })).toBe(2);
    });

    it('property: occurrence k is the k-th exact occurrence inside the window, and the result lies inside the window', () => {
      const rng = makeRng(8080);
      const alphabet = ['a', 'b', ' ', '😀', '“', '"', ' ', '-'] as const;
      for (let iter = 0; iter < 400; iter++) {
        const text = randomText(rng, alphabet, 30);
        const needle = randomText(rng, alphabet, 3);
        if (needle.length === 0) continue;
        const from = Math.floor(rng() * (text.length + 1));
        const to = from + Math.floor(rng() * (text.length - from + 1));
        const expected: number[] = [];
        let idx = text.indexOf(needle, from);
        while (idx !== -1 && idx + needle.length <= to) {
          expected.push(idx);
          idx = text.indexOf(needle, idx + 1);
        }
        for (let k = 0; k <= expected.length; k++) {
          const got = locateSpan(text, needle, { searchFrom: from, searchTo: to, occurrence: k });
          if (expected.length === 0) {
            // No exact candidates: the normalized pass may still find one, which must lie in the window.
            if (got !== -1) {
              expect(got).toBeGreaterThanOrEqual(from);
              expect(got + needle.length).toBeLessThanOrEqual(to);
              expect(normalizeForMatch(text.slice(got, got + needle.length))).toBe(normalizeForMatch(needle));
            }
          } else if (expected.length === 1) {
            expect(got).toBe(expected[0]);
          } else {
            expect(got).toBe(k < expected.length ? expected[k] : -1);
          }
        }
      }
    });

    it('locates among thousands of candidates in 50KB inside the budget', () => {
      let found = -1;
      expect(elapsed(() => { found = locateSpan(PROSE_50KB, 'the', { prefix: 'over', occurrence: 5 }); })).toBeLessThan(PERF_BUDGET_MS);
      expect(found).toBeGreaterThan(0);
      expect(PROSE_50KB.slice(found, found + 3)).toBe('the');
      expect(elapsed(() => locateSpan('a. '.repeat(17_000), 'a', { prefix: '.', suffix: 'a' }))).toBeLessThan(PERF_BUDGET_MS);
    });
  });

  // -------------------------------------------------------------------------
  describe('diffShift / rebaseSuggestions', () => {
    it('property: swapping the arguments swaps oldEnd/newEnd and keeps start', () => {
      const rng = makeRng(606);
      for (let iter = 0; iter < 300; iter++) {
        const a = randomText(rng, UNICODE_ALPHABET, 15);
        const b = randomText(rng, UNICODE_ALPHABET, 15);
        const ab = diffShift(a, b);
        const ba = diffShift(b, a);
        if (ab === null || ba === null) {
          expect(ab).toBeNull();
          expect(ba).toBeNull();
          expect(a).toBe(b);
          continue;
        }
        expect(ba).toEqual({ start: ab.start, oldEnd: ab.newEnd, newEnd: ab.oldEnd });
      }
    });

    it('bounds the region when a text is duplicated, prepended and appended at once, or has CRLF collapsed', () => {
      expect(diffShift('aa', 'aaaa')).toEqual({ start: 2, oldEnd: 2, newEnd: 4 });
      expect(diffShift('abc', 'xabcx')).toEqual({ start: 0, oldEnd: 3, newEnd: 5 });
      expect(diffShift('a\r\nb\r\nc', 'a\nb\nc')).toEqual({ start: 1, oldEnd: 5, newEnd: 3 });
      expect(diffShift('😀', '😁')).toEqual({ start: 1, oldEnd: 2, newEnd: 2 });
    });

    it('drops survivors whose range is outside the new text even when the empty original "matches"', () => {
      const s = mk({ range: { start: 50, end: 50 }, original: '', replacement: '.' });
      expect(rebaseSuggestions([s], 'abc', 'abc')).toEqual([]);
      expect(rebaseSuggestions([mk({ range: { start: -1, end: -1 }, original: '', replacement: '.' })], 'abc', 'abc')).toEqual([]);
      expect(rebaseSuggestions([mk({ range: { start: 2, end: 1 }, original: '', replacement: '.' })], 'abc', 'abc')).toEqual([]);
      expect(rebaseSuggestions([mk({ range: { start: 1.5, end: 3 }, original: 'bc', replacement: 'x' })], 'abc', 'abc')).toEqual([]);
      expect(rebaseSuggestions([mk({ range: { start: 3, end: 3 }, original: '', replacement: '.' })], 'abc', 'abc').map((s2) => s2.range)).toEqual([{ start: 3, end: 3 }]);
      // Deleting the final character legitimately moves an end-of-text insertion point to the new end.
      expect(rebaseSuggestions([mk({ range: { start: 3, end: 3 }, original: '', replacement: '.' })], 'abc', 'ab').map((s2) => s2.range)).toEqual([{ start: 2, end: 2 }]);
      // ...but a stale offset past the end of the unchanged text is never valid.
      expect(rebaseSuggestions([mk({ range: { start: 4, end: 4 }, original: '', replacement: '.' })], 'abc', 'abc')).toEqual([]);
    });

    it('keeps a zero-width suggestion at text.length across an append (before the new text) and a trailing deletion', () => {
      const period = mk({ range: { start: 5, end: 5 }, original: '', replacement: '.' });
      expect(rebaseSuggestions([period], 'hello', 'hello!').map((s) => s.range)).toEqual([{ start: 5, end: 5 }]);
      expect(rebaseSuggestions([period], 'hello', 'hell').map((s) => s.range)).toEqual([{ start: 4, end: 4 }]);
      expect(rebaseSuggestions([period], 'hello', '').map((s) => s.range)).toEqual([{ start: 0, end: 0 }]);
    });

    it('survives a CRLF -> LF conversion outside the changed region and drops what is inside it', () => {
      const oldText = 'a\r\nb\r\nc';
      const a = mk({ range: { start: 0, end: 1 }, original: 'a' });
      const b = mk({ range: { start: 3, end: 4 }, original: 'b' });
      const c = mk({ range: { start: 6, end: 7 }, original: 'c' });
      const out = rebaseSuggestions([a, b, c], oldText, 'a\nb\nc');
      expect(out.map((s) => [s.id, s.range.start, s.range.end])).toEqual([[a.id, 0, 1], [c.id, 4, 5]]);
    });

    it('keeps both neighbours when an emoji is typed next to an identical emoji', () => {
      const emoji = mk({ range: { start: 1, end: 3 }, original: '😀' });
      const b = mk({ range: { start: 3, end: 4 }, original: 'b' });
      const out = rebaseSuggestions([emoji, b], 'a😀b', 'a😀😀b');
      expect(out.map((s) => s.range)).toEqual([{ start: 1, end: 3 }, { start: 5, end: 6 }]);
    });

    it('property: every survivor is valid in the new text, ids are a subset, and nothing but range and highlight changes', () => {
      const rng = makeRng(4242);
      for (let iter = 0; iter < 300; iter++) {
        const words = Array.from({ length: 2 + Math.floor(rng() * 6) }, () => randomText(rng, ['a', 'b', '😀', 'é', '“'], 4) || 'w');
        const oldText = words.join(' ');
        const suggestions: Suggestion[] = [];
        let offset = 0;
        for (const w of words) {
          suggestions.push(mk({ range: { start: offset, end: offset + w.length }, original: w, category: pick(rng, ['correctness', 'clarity'] as const), alternatives: ['x'] }));
          if (rng() < 0.3) suggestions.push(mk({ range: { start: offset + w.length, end: offset + w.length }, original: '', replacement: ',' }));
          offset += w.length + 1;
        }
        const a = Math.floor(rng() * (oldText.length + 1));
        const b = a + Math.floor(rng() * (oldText.length - a + 1));
        const newText = oldText.slice(0, a) + randomText(rng, ['x', '😀', ' ', ''], 3) + oldText.slice(b);
        const out = rebaseSuggestions(suggestions, oldText, newText);
        const byId = new Map(suggestions.map((s) => [s.id, s]));
        for (const s of out) {
          expect(Number.isInteger(s.range.start) && Number.isInteger(s.range.end)).toBe(true);
          expect(s.range.start).toBeGreaterThanOrEqual(0);
          expect(s.range.end).toBeGreaterThanOrEqual(s.range.start);
          expect(s.range.end).toBeLessThanOrEqual(newText.length);
          expect(newText.slice(s.range.start, s.range.end)).toBe(s.original);
          const src = byId.get(s.id);
          expect(src).toBeDefined();
          if (!src) continue;
          expect({ ...s, range: null, highlight: null }).toEqual({ ...src, range: null, highlight: null });
          // The hover target moves by exactly the same delta as the edit range.
          expect(s.highlight.start - src.highlight.start).toBe(s.range.start - src.range.start);
          expect(s.highlight.end - src.highlight.end).toBe(s.range.end - src.range.end);
        }
        expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('compareSuggestionPriority / resolveOverlaps', () => {
    const cats: SuggestionCategory[] = ['correctness', 'clarity', 'engagement', 'delivery'];
    const sources: SuggestionSource[] = ['rules', 'llm'];

    function randomSuggestion(rng: () => number, text: string, allowZeroWidth: boolean): Suggestion {
      const start = Math.floor(rng() * (text.length + 1));
      const maxLen = Math.min(6, text.length - start);
      const len = allowZeroWidth && rng() < 0.25 ? 0 : Math.floor(rng() * (maxLen + 1));
      return mk({
        range: { start, end: start + len },
        original: text.slice(start, start + len),
        replacement: pick(rng, ['a', 'b', '']),
        category: pick(rng, cats),
        source: pick(rng, sources),
        confidence: pick(rng, [0.3, 0.5, 0.8, 1]),
        alternatives: rng() < 0.3 ? [pick(rng, ['a', 'b', 'c'])] : undefined,
      });
    }

    /** Independent re-implementation of the documented algorithm with the naive O(n²) overlap scan. */
    function bruteForceResolve(input: Suggestion[]): string[] {
      const indexed = input.map((s, i) => ({ s, i }));
      indexed.sort((x, y) => compareSuggestionPriority(x.s, y.s) || x.i - y.i);
      const seen = new Set<string>();
      const kept: Suggestion[] = [];
      for (const { s } of indexed) {
        const key = `${s.range.start}:${s.range.end}:${s.replacement}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (kept.some((k) => conflicts(k.range, s.range))) continue;
        kept.push(s);
      }
      kept.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
      return kept.map((s) => s.id);
    }

    it('property: compareSuggestionPriority is antisymmetric and transitive', () => {
      const rng = makeRng(99991);
      const text = 'x'.repeat(40);
      for (let iter = 0; iter < 500; iter++) {
        const a = randomSuggestion(rng, text, true);
        const b = randomSuggestion(rng, text, true);
        const c = randomSuggestion(rng, text, true);
        // Sum of signs (not toBe) so that 0 and -0 compare equal.
        expect(Math.sign(compareSuggestionPriority(a, b)) + Math.sign(compareSuggestionPriority(b, a))).toBe(0);
        expect(compareSuggestionPriority(a, a)).toBe(0);
        if (compareSuggestionPriority(a, b) <= 0 && compareSuggestionPriority(b, c) <= 0) {
          expect(compareSuggestionPriority(a, c)).toBeLessThanOrEqual(0);
        }
      }
    });

    it('property: matches the brute-force algorithm exactly on dense inputs with zero-width ranges and duplicates', () => {
      const rng = makeRng(5150);
      for (let iter = 0; iter < 60; iter++) {
        const text = 'x'.repeat(10 + Math.floor(rng() * 50));
        const count = Math.floor(rng() * 300);
        const input: Suggestion[] = [];
        for (let k = 0; k < count; k++) {
          const s = randomSuggestion(rng, text, true);
          input.push(s);
          if (rng() < 0.15) input.push(mk({ ...s, id: undefined, confidence: pick(rng, [0.3, 1]), alternatives: ['dup'] }));
        }
        const out = resolveOverlaps(input);
        expect(out.map((s) => s.id)).toEqual(bruteForceResolve(input));
        for (let i = 1; i < out.length; i++) {
          const prev = out[i - 1];
          const cur = out[i];
          if (!prev || !cur) continue;
          expect(prev.range.start < cur.range.start || (prev.range.start === cur.range.start && prev.range.end <= cur.range.end)).toBe(true);
          expect(conflicts(prev.range, cur.range)).toBe(false);
        }
        for (const s of out) {
          if (s.alternatives !== undefined) {
            expect(s.alternatives).not.toContain(s.replacement);
            expect(new Set(s.alternatives).size).toBe(s.alternatives.length);
          }
        }
      }
    });

    it('collapses identical zero-width duplicates but lets different insertions at one offset compete', () => {
      const a = mk({ range: { start: 4, end: 4 }, original: '', replacement: ',', confidence: 0.6, alternatives: [';'] });
      const b = mk({ range: { start: 4, end: 4 }, original: '', replacement: ',', confidence: 1, alternatives: [',', ':'] });
      const out = resolveOverlaps([a, b]);
      expect(out.map((s) => s.id)).toEqual([b.id]);
      expect(out[0]?.alternatives).toEqual([':', ';']);
      const c = mk({ range: { start: 4, end: 4 }, original: '', replacement: '.', confidence: 1 });
      expect(resolveOverlaps([a, c]).map((s) => s.id)).toEqual([c.id]);
    });

    it('keeps insertions at both ends of a span alongside it, in (start, end) order', () => {
      const atStart = mk({ range: { start: 5, end: 5 }, original: '', replacement: ',' });
      const span = mk({ range: { start: 5, end: 8 }, original: 'abc' });
      const atEnd = mk({ range: { start: 8, end: 8 }, original: '', replacement: '.' });
      const out = resolveOverlaps([atEnd, span, atStart]);
      expect(out.map((s) => [s.range.start, s.range.end])).toEqual([[5, 5], [5, 8], [8, 8]]);
    });

    it('an insertion strictly inside a span conflicts with it in both priority directions', () => {
      const inside = mk({ range: { start: 6, end: 6 }, original: '', replacement: ',', category: 'correctness', confidence: 1 });
      const span = mk({ range: { start: 5, end: 8 }, original: 'abc', category: 'clarity', confidence: 1 });
      expect(resolveOverlaps([span, inside]).map((s) => s.id)).toEqual([inside.id]);
      const inside2 = mk({ range: { start: 6, end: 6 }, original: '', replacement: ',', category: 'clarity' });
      const span2 = mk({ range: { start: 5, end: 8 }, original: 'abc', category: 'correctness' });
      expect(resolveOverlaps([inside2, span2]).map((s) => s.id)).toEqual([span2.id]);
    });

    it('never leaves the replacement among alternatives and dedupes them case-sensitively', () => {
      const s = mk({ range: { start: 0, end: 3 }, original: 'teh', replacement: 'the', alternatives: ['the', 'The', 'the', 'THE', 'The'] });
      expect(resolveOverlaps([s])[0]?.alternatives).toEqual(['The', 'THE']);
    });

    it('does not throw on NaN confidence and still returns a non-overlapping set', () => {
      const a = mk({ range: { start: 0, end: 3 }, original: 'abc', confidence: NaN });
      const b = mk({ range: { start: 2, end: 5 }, original: 'cde', confidence: NaN });
      const c = mk({ range: { start: 1, end: 4 }, original: 'bcd', confidence: 1 });
      const out = resolveOverlaps([a, b, c]);
      expect(out.length).toBeGreaterThan(0);
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const x = out[i];
          const y = out[j];
          if (x && y) expect(conflicts(x.range, y.range)).toBe(false);
        }
      }
    });

    it('resolves 5000 suggestions over 50KB inside the budget and the result applies without skips', () => {
      const suggestions: Suggestion[] = [];
      for (let i = 0; i < 5000; i++) {
        const start = i * 10;
        suggestions.push(mk({ range: { start, end: start + 3 }, original: PROSE_50KB.slice(start, start + 3), replacement: 'X', category: pick(makeRng(i), cats) }));
        if (i % 3 === 0) suggestions.push(mk({ range: { start: start + 2, end: start + 6 }, original: PROSE_50KB.slice(start + 2, start + 6), replacement: 'Y' }));
      }
      let resolved: Suggestion[] = [];
      expect(elapsed(() => { resolved = resolveOverlaps(suggestions); })).toBeLessThan(PERF_BUDGET_MS);
      expect(resolved.length).toBe(5000);
      const r = applyEdits(PROSE_50KB, resolved.map((s) => ({ range: s.range, original: s.original, replacement: s.replacement })));
      expect(r.skipped).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('applyEdits', () => {
    it('never lets a NaN, infinite or fractional edit disturb the order of the valid ones', () => {
      const valid = [edit(3, 6, 'def', 'Y'), edit(0, 3, 'abc', 'X')];
      const garbage: Edit[] = [
        { range: { start: NaN, end: NaN }, original: '', replacement: '!' },
        { range: { start: Infinity, end: Infinity }, original: '', replacement: '!' },
        { range: { start: -Infinity, end: 0 }, original: '', replacement: '!' },
        { range: { start: 1.5, end: 2 }, original: 'b', replacement: '!' },
        { range: { start: 2, end: 2.5 }, original: '', replacement: '!' },
      ];
      for (const g of garbage) {
        const perms: Edit[][] = [[valid[0]!, g, valid[1]!], [g, valid[0]!, valid[1]!], [valid[1]!, valid[0]!, g], [valid[0]!, valid[1]!, g], [g, valid[1]!, valid[0]!], [valid[1]!, g, valid[0]!]];
        for (const edits of perms) {
          const r = applyEdits('abcdef', edits);
          expect(r.text).toBe('XY');
          expect(r.applied.map((e) => e.range.start)).toEqual([0, 3]);
          expect(r.skipped).toEqual([g]);
        }
      }
    });

    it('handles edits at exactly text.length and whole-emoji edits at the end', () => {
      expect(applyEdits('hello', [edit(5, 5, '', '!')]).text).toBe('hello!');
      expect(applyEdits('hello', [edit(5, 6, '', '!')]).skipped).toHaveLength(1);
      expect(applyEdits('hello', [edit(4, 5, 'o', ''), edit(5, 5, '', '!')]).text).toBe('hell!');
      expect(applyEdits('hi 😀', [edit(3, 5, '😀', '😢')]).text).toBe('hi 😢');
      expect(applyEdits('hi 😀', [edit(5, 5, '', '😀')]).text).toBe('hi 😀😀');
      expect(applyEdits('', [edit(0, 0, '', 'a'), edit(0, 0, '', 'b')]).text).toBe('ab');
    });

    it('strips the CR of every CRLF with one edit per line', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
      const text = lines.join('\r\n');
      const edits: Edit[] = [];
      let idx = text.indexOf('\r');
      while (idx !== -1) {
        edits.push(edit(idx, idx + 1, '\r', ''));
        idx = text.indexOf('\r', idx + 1);
      }
      const r = applyEdits(text, edits);
      expect(r.applied).toHaveLength(lines.length - 1);
      expect(r.text).toBe(lines.join('\n'));
      expect(r.mapOffset(text.length)).toBe(r.text.length);
    });

    it('property: mapOffset is monotonic, in range, and preserves every character outside the edits', () => {
      const rng = makeRng(777);
      for (let iter = 0; iter < 300; iter++) {
        const text = randomText(rng, UNICODE_ALPHABET, 30);
        const edits: Edit[] = [];
        let cursor = 0;
        while (cursor <= text.length && rng() < 0.75) {
          const start = cursor + Math.floor(rng() * (text.length - cursor + 1));
          const end = start + Math.floor(rng() * (text.length - start + 1));
          edits.push(edit(start, end, text.slice(start, end), randomText(rng, UNICODE_ALPHABET, 3)));
          cursor = end + (end === start ? 1 : 0);
        }
        const r = applyEdits(text, edits);
        expect(r.skipped).toEqual([]);
        let last = 0;
        for (let o = 0; o <= text.length; o++) {
          const m = r.mapOffset(o);
          expect(m).toBeGreaterThanOrEqual(last);
          expect(m).toBeLessThanOrEqual(r.text.length);
          last = m;
          const insideEdit = r.applied.some((e) => e.range.start <= o && o < e.range.end);
          const atInsertion = r.applied.some((e) => e.range.start === e.range.end && e.range.start === o);
          if (!insideEdit && !atInsertion) expect(r.text.charAt(m)).toBe(text.charAt(o));
        }
      }
    });

    it('applies 2000 edits to 50KB inside the budget and matches a naive rebuild', () => {
      const edits: Edit[] = [];
      for (let i = 0; i < 2000; i++) {
        const s = i * 25;
        edits.push(edit(s, s + 3, PROSE_50KB.slice(s, s + 3), 'XYZW'));
      }
      let r: ReturnType<typeof applyEdits> | undefined;
      expect(elapsed(() => { r = applyEdits(PROSE_50KB, edits); })).toBeLessThan(PERF_BUDGET_MS);
      expect(r).toBeDefined();
      if (!r) return;
      let naive = '';
      let at = 0;
      for (const e of edits) {
        naive += PROSE_50KB.slice(at, e.range.start) + e.replacement;
        at = e.range.end;
      }
      naive += PROSE_50KB.slice(at);
      expect(r.text).toBe(naive);
      expect(r.skipped).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('statistics', () => {
    it('countWords: zero-width joiners and spaces do not split tokens, Unicode whitespace does', () => {
      expect(countWords('a​b')).toBe(1);
      expect(countWords('👨‍👩‍👧')).toBe(0);
      expect(countWords('a b c')).toBe(3);
      expect(countWords('a b　c\u000cd')).toBe(4);
      expect(countWords(' ​﻿')).toBe(0);
      expect(countWords('𝐀𝐁 𝟙')).toBe(2);
    });

    it('readingTimeSeconds returns 0 for NaN, negative and infinite wpm', () => {
      for (const wpm of [NaN, -1, 0, -Infinity]) expect(readingTimeSeconds('one two three', wpm)).toBe(0);
      expect(readingTimeSeconds('one two three', Infinity)).toBe(0);
      expect(readingTimeSeconds('one two three', 0.5)).toBe(360);
    });

    it('countSyllables never returns less than 1 and never throws on arbitrary tokens', () => {
      const rng = makeRng(123456);
      for (let iter = 0; iter < 300; iter++) {
        const token = randomText(rng, [...UNICODE_ALPHABET, 'y', 'e', 'd', 's', 'l', 'ÉCOLE'], 12);
        const n = countSyllables(token);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
      }
      expect(countSyllables('😀')).toBe(1);
      expect(countSyllables('​')).toBe(1);
    });

    it('property: computeScore is an integer in [0, 100], 100 only when clean, with consistent word counts', () => {
      const rng = makeRng(2468);
      for (let iter = 0; iter < 200; iter++) {
        const text = randomText(rng, [...UNICODE_ALPHABET, 'word', 'the'], 60);
        const count = Math.floor(rng() * 5);
        const suggestions = Array.from({ length: count }, () => mk({ range: { start: 0, end: 0 }, original: '', category: pick(rng, ['correctness', 'clarity', 'engagement', 'delivery'] as const) }));
        const score = computeScore(text, suggestions);
        expect(Number.isInteger(score.overall)).toBe(true);
        expect(score.overall).toBeGreaterThanOrEqual(0);
        expect(score.overall).toBeLessThanOrEqual(100);
        expect(score.wordCount).toBe(countWords(text));
        expect(score.readingTimeSeconds).toBe(readingTimeSeconds(text));
        if (score.wordCount === 0) expect(score).toEqual({ overall: 0, wordCount: 0, readingTimeSeconds: 0 });
        else if (count === 0) expect(score.overall).toBe(100);
        else expect(score.overall).toBeLessThanOrEqual(99);
      }
    });

    it('scores whitespace-, NBSP- and zero-width-only text as empty', () => {
      expect(computeScore(' ​﻿ ', [mk({ range: { start: 0, end: 0 }, original: '' })])).toEqual({ overall: 0, wordCount: 0, readingTimeSeconds: 0 });
      expect(fleschKincaidGrade(' ​')).toBe(0);
    });

    it('computes readability and score for 50KB inside the budget', () => {
      expect(elapsed(() => fleschKincaidGrade(PROSE_50KB))).toBeLessThan(PERF_BUDGET_MS);
      expect(elapsed(() => computeScore(PROSE_50KB, [mk({ range: { start: 0, end: 3 }, original: 'The' })]))).toBeLessThan(PERF_BUDGET_MS);
    });
  });

  // -------------------------------------------------------------------------
  describe('isLikelyCode / stripUrlsAndCode', () => {
    function assertMaskInvariants(text: string): { text: string; masked: TextRange[] } {
      const r = stripUrlsAndCode(text);
      expect(r.text.length).toBe(text.length);
      let cursor = 0;
      for (const m of r.masked) {
        expect(m.start).toBeGreaterThanOrEqual(cursor);
        expect(m.end).toBeGreaterThan(m.start);
        expect(m.end).toBeLessThanOrEqual(text.length);
        expect(r.text.slice(cursor, m.start)).toBe(text.slice(cursor, m.start));
        expect(r.text.slice(m.start, m.end)).toBe(' '.repeat(m.end - m.start));
        cursor = m.end;
      }
      expect(r.text.slice(cursor)).toBe(text.slice(cursor));
      return r;
    }
    const maskedStrings = (text: string): string[] => assertMaskInvariants(text).masked.map((m) => text.slice(m.start, m.end));

    it('scans a 20KB single token (hex blob, dotted run, hyphenated run, dots) inside the budget and calls none of them code', () => {
      const blobs = ['deadbeef'.repeat(2500), 'a.'.repeat(10_000), 'a-'.repeat(10_000), '.'.repeat(20_000), '-'.repeat(20_000), 'x_'.repeat(10_000)];
      for (const blob of blobs) {
        let code = true;
        expect(elapsed(() => { code = isLikelyCode(blob); })).toBeLessThan(PERF_BUDGET_MS);
        expect(code).toBe(false);
        let r: ReturnType<typeof stripUrlsAndCode> | undefined;
        expect(elapsed(() => { r = stripUrlsAndCode(blob); })).toBeLessThan(PERF_BUDGET_MS);
        expect(r?.masked).toEqual([]);
        expect(r?.text).toBe(blob);
      }
      const dottedDomain = 'a.'.repeat(9_998) + 'com';
      let masks: TextRange[] = [];
      expect(elapsed(() => { masks = stripUrlsAndCode(dottedDomain).masked; })).toBeLessThan(PERF_BUDGET_MS);
      expect(masks).toEqual([{ start: 0, end: dottedDomain.length }]);
    });

    it('keeps exact offsets around surrogate pairs and zero-width characters', () => {
      const text = '😀 me@x.com 😀 https://x.com/a​b @bob';
      expect(maskedStrings(text)).toEqual(['me@x.com', 'https://x.com/a​b', '@bob']);
      expect(assertMaskInvariants(text).masked).toEqual([{ start: 3, end: 11 }, { start: 15, end: 32 }, { start: 33, end: 37 }]);
    });

    it('masks spans that end exactly at text.length', () => {
      for (const [text, expected] of [['x `y`', '`y`'], ['a@b.co', 'a@b.co'], ['@x', '@x'], ['www.a.de', 'www.a.de'], ['go https://x.com', 'https://x.com'], ['see example.org', 'example.org']] as const) {
        const r = assertMaskInvariants(text);
        expect(r.masked).toHaveLength(1);
        expect(r.masked[0]?.end).toBe(text.length);
        expect(text.slice(r.masked[0]?.start, r.masked[0]?.end)).toBe(expected);
      }
    });

    it('masks adjacent spans without merging or overlapping them', () => {
      expect(maskedStrings('me@x.com@bob')).toEqual(['me@x.com', '@bob']);
      expect(maskedStrings('`a``b`')).toEqual(['`a`', '`b`']);
      expect(maskedStrings('https://x.com/me@y.com')).toEqual(['https://x.com/', 'me@y.com']);
    });

    it('email and domain matching still start at the earliest position of a run', () => {
      expect(maskedStrings('xme@x.com')).toEqual(['xme@x.com']);
      expect(maskedStrings('a@b@c.com')).toEqual(['b@c.com']);
      expect(maskedStrings('..@@me@x.com')).toEqual(['me@x.com']);
      expect(maskedStrings('(first-last.name+tag@mail.example.co.uk)')).toEqual(['first-last.name+tag@mail.example.co.uk']);
      expect(maskedStrings('visit sub.example.co.uk/path?x=1.')).toEqual(['sub.example.co.uk/path?x=1']);
      expect(maskedStrings('example.com.evil then')).toEqual(['example.com']);
      expect(maskedStrings('see non-profit.org and EXAMPLE.COM now')).toEqual(['non-profit.org', 'EXAMPLE.COM']);
      expect(maskedStrings('word.example.com')).toEqual(['word.example.com']);
      expect(maskedStrings('e.g. a.b.c.d. 1.2.3.4 v10.0.1')).toEqual([]);
    });

    it('does not throw on absurdly nested brackets or on empty containers', () => {
      const nested = '['.repeat(20_000) + ']'.repeat(20_000);
      let result = false;
      expect(() => { result = isLikelyCode(nested); }).not.toThrow();
      expect(typeof result).toBe('boolean');
      expect(isLikelyCode('{}')).toBe(false);
      expect(isLikelyCode('[]')).toBe(false);
      expect(isLikelyCode('null')).toBe(false);
      expect(isLikelyCode('"just a string"')).toBe(false);
      expect(isLikelyCode('42')).toBe(false);
      expect(isLikelyCode('{"a":1}')).toBe(true);
    });

    it('text that is entirely a fenced block or inline code is masked away and therefore not code', () => {
      expect(isLikelyCode('```js\nconst x = 1;\nreturn x;\n```')).toBe(false);
      expect(isLikelyCode('`const x = 1;`')).toBe(false);
      expect(isLikelyCode('`const x = 1;`\nconst y = 2;\nreturn y;')).toBe(true);
    });

    it('classifies 50KB prose and 50KB code and masks 50KB of URLs inside the budget', () => {
      let prose = true;
      expect(elapsed(() => { prose = isLikelyCode(PROSE_50KB); })).toBeLessThan(PERF_BUDGET_MS);
      expect(prose).toBe(false);
      let code = false;
      expect(elapsed(() => { code = isLikelyCode(CODE_50KB); })).toBeLessThan(PERF_BUDGET_MS);
      expect(code).toBe(true);
      const urls = build('see https://x.com/a me@x.com @bob `c` ', 50_000);
      let r: ReturnType<typeof stripUrlsAndCode> | undefined;
      expect(elapsed(() => { r = stripUrlsAndCode(urls); })).toBeLessThan(PERF_BUDGET_MS);
      expect(r?.masked.length).toBeGreaterThan(5000);
      assertMaskInvariants(urls);
      expect(elapsed(() => isLikelyCode('<a '.repeat(7000)))).toBeLessThan(PERF_BUDGET_MS);
    });
  });
});

// ---------------------------------------------------------------------------
// doubled punctuation at edit seams
// ---------------------------------------------------------------------------

describe('doubled punctuation at seams', () => {
  const edit = (text: string, original: string, replacement: string, at = text.indexOf(original)): Edit => ({ range: { start: at, end: at + original.length }, original, replacement });

  it('drops a trailing comma the text already has', () => {
    const text = 'Firstly, finance has not approved it.';
    const tidy = tidyEdit(text, edit(text, 'Firstly', 'First,'));
    expect(applyEdits(text, [tidy]).text).toBe('First, finance has not approved it.');
  });

  it('turns an insert of an existing comma into a no-op', () => {
    const text = 'not approved it yet, and we wait.';
    const at = text.indexOf(',');
    const tidy = tidyEdit(text, { range: { start: at, end: at }, original: '', replacement: ',' });
    expect(tidy.replacement).toBe(tidy.original);
  });

  it('drops a leading space or mark doubled by the text before', () => {
    const text = 'We met.  Then left';
    const tidy = tidyEdit(text, edit(text, 'Then', ' Then'));
    expect(tidy.replacement).toBe('Then');
  });

  it('leaves an ellipsis that was already doubled alone', () => {
    const text = 'wait... ok';
    const tidy = tidyEdit(text, edit(text, '..', '..'));
    expect(tidy.replacement).toBe('..');
  });

  it('resolveOverlaps keeps only one of two touching edits that would double a comma', () => {
    const text = 'Firstly finance has not approved it.';
    const replace = mk({ range: { start: 0, end: 7 }, original: 'Firstly', replacement: 'First,', confidence: 0.9 });
    const insert = mk({ range: { start: 7, end: 7 }, original: '', replacement: ',', confidence: 0.8 });
    const kept = resolveOverlaps([replace, insert]);
    expect(kept).toHaveLength(1);
    expect(applyEdits(text, kept).text).toBe('First, finance has not approved it.');
  });
});
