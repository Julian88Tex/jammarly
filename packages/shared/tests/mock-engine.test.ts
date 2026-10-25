import { describe, expect, it } from 'vitest';
import type { CheckRequest, Suggestion } from '../src/types';
import { applyEdits, splitParagraphs } from '../src/text';
import { anchorSuggestions, lintVoiceProfile, maskRequestBlocks, parseEngineOutput, parseEngineOutputDetailed, renderVoiceBlock, EngineOutputSchema, ENGINE_RULE_IDS, PROMPT_VERSION, TONE_LABELS } from '../src/prompts';
import { mockCheck, mockVoiceProfile, MOCK_MODEL } from '../src/mock-engine';

// Texts of apps/extension/tests/fixtures/*.html as the content script serializes them.
const FIXTURES = {
  textarea: 'Their going to the the store tomorow, and i dont think its a good idea.  We was hoping you could of came with us.',
  subjectInput: "Meeting notes for tommorow's standup",
  controlled: 'This sentance has a speling mistake.',
  contenteditable: 'Their going to the the store tomorow.\nI definately think that we should of went earlier, irregardless of the weather.\n\nKind regards,\nSam',
  gmail: 'Hi team,\n\nI just wanted to kind of touch base and see if maybe you could possibly send me the the report when you get a chance.',
  scrolled: 'Paragraph one has an error: recieve.\nParagraph two is fine.\nParagraph three has another: seperate.\nParagraph four is fine.\nParagraph five has one more: occured.',
} as const;

function makeRequest(text: string, overrides: Partial<CheckRequest> = {}): CheckRequest {
  return {
    fieldId: 'f1',
    version: 1,
    text,
    blocks: splitParagraphs(text),
    dirtyBlockHashes: 'all',
    pass: 'fast',
    host: 'localhost',
    context: 'doc',
    fieldKind: 'textarea',
    protectedRanges: [],
    ...overrides,
  };
}

const CATEGORIES = ['correctness', 'clarity', 'engagement', 'delivery'] as const;

/** Runs the whole pipeline the worker runs: mock -> parse -> anchor. */
function pipeline(text: string, overrides: Partial<CheckRequest> = {}) {
  const req = makeRequest(text, overrides);
  const result = mockCheck(req);
  const parsed = parseEngineOutputDetailed(result.output);
  const blocks = maskRequestBlocks(req, req.blocks.map((b) => `b${b.index}`));
  const anchored = anchorSuggestions(parsed.output, blocks, req.blocks, text, { model: result.model, promptVersion: PROMPT_VERSION, categories: CATEGORIES });
  return { req, result, parsed, anchored };
}

function edit(s: Suggestion) {
  return { range: s.range, original: s.original, replacement: s.replacement };
}

describe('mockCheck', () => {
  it('returns the mock model, zero cost and a valid EngineOutput', () => {
    const { result, parsed } = pipeline(FIXTURES.textarea);
    expect(result.model).toBe('mock');
    expect(MOCK_MODEL).toBe('mock');
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(parsed.dropped).toEqual([]);
    expect(EngineOutputSchema.safeParse(result.output).success).toBe(true);
  });

  it('is deterministic: identical output and stable ids across runs', () => {
    const a = pipeline(FIXTURES.contenteditable);
    const b = pipeline(FIXTURES.contenteditable);
    expect(JSON.stringify(a.result.output)).toBe(JSON.stringify(b.result.output));
    expect(a.anchored.suggestions.map((s) => s.id)).toEqual(b.anchored.suggestions.map((s) => s.id));
    expect(new Set(a.anchored.suggestions.map((s) => s.id)).size).toBe(a.anchored.suggestions.length);
  });

  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`anchors cleanly on the ${name} fixture`, () => {
      const { result, anchored } = pipeline(text);
      expect(anchored.dropped).toEqual([]);
      const emitted = result.output.blocks.reduce((n, b) => n + b.suggestions.length, 0);
      expect(anchored.suggestions).toHaveLength(emitted);
      expect(emitted).toBeGreaterThan(0);
      for (const s of anchored.suggestions) {
        expect(text.slice(s.range.start, s.range.end)).toBe(s.original);
        expect(s.anchor).toBe('exact');
        expect(s.source).toBe('llm');
        expect(s.model).toBe('mock');
      }
      // Anchor fields are what a real model would send: verbatim original, short context, 1-based occurrence.
      for (const b of result.output.blocks) {
        const para = splitParagraphs(text).find((p) => `b${p.index}` === b.block_id);
        for (const s of b.suggestions) {
          expect(para?.text.includes(s.original)).toBe(true);
          expect(s.occurrence).toBeGreaterThanOrEqual(1);
          expect(s.prefix.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
          expect(s.suffix.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
          expect(s.explanation.length).toBeLessThanOrEqual(140);
          expect(s.id).toMatch(/^s\d+$/);
        }
      }
    });
  }

  it('fixes the textarea fixture into correct English when every span edit is applied', () => {
    const { anchored } = pipeline(FIXTURES.textarea);
    const byRule = (rule: string) => anchored.suggestions.filter((s) => s.rule === rule);
    expect(byRule('confusable_word').map((s) => [s.original, s.replacement])).toEqual([['Their', "They're"]]);
    expect(byRule('repeated_word').map((s) => [s.original, s.replacement])).toEqual([['the ', '']]);
    expect(byRule('spelling').map((s) => [s.original, s.replacement])).toEqual([['tomorow', 'tomorrow']]);
    expect(byRule('capitalization').map((s) => [s.original, s.replacement])).toEqual([['i', 'I']]);
    expect(byRule('apostrophe').map((s) => [s.original, s.replacement])).toEqual([
      ['dont', "don't"],
      ['its', "it's"],
    ]);
    expect(byRule('subject_verb_agreement').map((s) => [s.original, s.replacement])).toEqual([['was', 'were']]);
    expect(byRule('verb_form').map((s) => [s.original, s.replacement])).toEqual([['of came', 'have come']]);
    expect(anchored.suggestions.every((s) => s.tier === 'A')).toBe(true);
    const applied = applyEdits(FIXTURES.textarea, anchored.suggestions.map(edit));
    expect(applied.skipped).toEqual([]);
    expect(applied.text).toBe("They're going to the store tomorrow, and I don't think it's a good idea.  We were hoping you could have come with us.");
  });

  it('handles the single-line input and the controlled textarea', () => {
    const subject = pipeline(FIXTURES.subjectInput);
    expect(subject.anchored.suggestions.map((s) => [s.rule, s.original, s.replacement])).toEqual([['spelling', 'tommorow', 'tomorrow']]);
    const controlled = pipeline(FIXTURES.controlled);
    expect(controlled.anchored.suggestions.map((s) => [s.original, s.replacement])).toEqual([
      ['sentance', 'sentence'],
      ['speling', 'spelling'],
    ]);
    expect(applyEdits(FIXTURES.controlled, controlled.anchored.suggestions.map(edit)).text).toBe('This sentence has a spelling mistake.');
  });

  it('covers the contenteditable fixture: should of went, irregardless, definately', () => {
    const { anchored } = pipeline(FIXTURES.contenteditable);
    const pairs = anchored.suggestions.map((s) => [s.blockId, s.rule, s.original, s.replacement]);
    expect(pairs).toEqual([
      ['b0', 'confusable_word', 'Their', "They're"],
      ['b0', 'repeated_word', 'the ', ''],
      ['b0', 'spelling', 'tomorow', 'tomorrow'],
      ['b1', 'spelling', 'definately', 'definitely'],
      ['b1', 'confusable_word', 'of went', 'have gone'],
      ['b1', 'confusable_word', 'irregardless', 'regardless'],
    ]);
    const applied = applyEdits(FIXTURES.contenteditable, anchored.suggestions.map(edit));
    expect(applied.text).toBe("They're going to the store tomorrow.\nI definitely think that we should have gone earlier, regardless of the weather.\n\nKind regards,\nSam");
  });

  it('covers the Gmail fixture: wordy phrase, hedging, repeated word and a confident rewrite with one alternative', () => {
    const { result, anchored } = pipeline(FIXTURES.gmail, { context: 'email', host: 'mail.google.com' });
    const sentence = 'I just wanted to kind of touch base and see if maybe you could possibly send me the the report when you get a chance.';
    const rewrite = anchored.suggestions.find((s) => s.kind === 'rewrite');
    expect(rewrite).toBeDefined();
    expect(rewrite?.rule).toBe('tone_rewrite_confident');
    expect(rewrite?.category).toBe('delivery');
    expect(rewrite?.original).toBe(sentence);
    expect(rewrite?.replacement).toBe('Could you send me the report when you get a chance?');
    expect(rewrite?.alternatives).toEqual(['Could you send me the report when you have a moment?']);
    expect(rewrite?.tier).toBe('C');
    expect(rewrite?.meaningPreserving).toBe(false);

    const spans = anchored.suggestions.filter((s) => s.kind !== 'rewrite');
    expect(spans.map((s) => [s.rule, s.original, s.replacement, s.tier])).toEqual([
      ['wordy_phrase', 'kind of touch base', 'check in', 'B'],
      ['hedging', 'maybe you could possibly', 'could you', 'C'],
      ['repeated_word', 'the ', '', 'A'],
    ]);
    const hedging = spans.find((s) => s.rule === 'hedging');
    expect(hedging?.meaningPreserving).toBe(false);
    expect(hedging?.autoApplySafe).toBe(false);
    // Every span sits inside the rewrite and is linked to it.
    expect(rewrite?.conflictsWith.sort()).toEqual(spans.map((s) => s.id).sort());
    for (const s of spans) expect(s.conflictsWith).toEqual([rewrite?.id]);
    // Only the dirty block carries suggestions; the greeting block is clean.
    expect(result.output.blocks.map((b) => [b.block_id, b.suggestions.length])).toEqual([
      ['b0', 0],
      ['b1', 4],
    ]);
    expect(result.output.document.tone).toEqual([
      { label: 'friendly', strength: 'moderate' },
      { label: 'informal', strength: 'slight' },
    ]);
  });

  it('covers every paragraph of the scrolled editor fixture', () => {
    const { anchored, result } = pipeline(FIXTURES.scrolled);
    expect(anchored.suggestions.map((s) => [s.blockId, s.original, s.replacement])).toEqual([
      ['b0', 'recieve', 'receive'],
      ['b2', 'seperate', 'separate'],
      ['b4', 'occured', 'occurred'],
    ]);
    expect(result.output.blocks.map((b) => b.block_id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(result.output.document.tone).toEqual([{ label: 'direct', strength: 'moderate' }]);
  });

  it('emits suggestions only for the dirty blocks', () => {
    const req = makeRequest(FIXTURES.scrolled);
    const dirty = [req.blocks[2]?.hash ?? '', req.blocks[4]?.hash ?? ''];
    const { output } = mockCheck({ ...req, dirtyBlockHashes: dirty });
    expect(output.blocks.map((b) => b.block_id)).toEqual(['b2', 'b4']);
    expect(output.blocks.every((b) => b.suggestions.length === 1)).toBe(true);
    expect(mockCheck({ ...req, dirtyBlockHashes: [] }).output.blocks).toEqual([]);
  });

  it('skips whitespace-only blocks and never overlaps span suggestions', () => {
    const text = 'Could of course we should of done it, in order to be very very sure.\n   \nWe was there.';
    const { result, anchored } = pipeline(text);
    expect(result.output.blocks.map((b) => b.block_id)).toEqual(['b0', 'b2']);
    const spans = anchored.suggestions.filter((s) => s.kind !== 'rewrite').sort((a, b) => a.range.start - b.range.start);
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      expect(cur !== undefined && prev !== undefined && cur.range.start >= prev.range.end).toBe(true);
    }
    const pairs = spans.map((s) => [s.rule, s.original, s.replacement]);
    // Anchoring trims shared words: "in order to" -> "to" becomes a deletion of "in order ".
    expect(pairs).toEqual([
      ['confusable_word', 'of', 'have'],
      ['wordy_phrase', 'in order ', ''],
      ['overused_word', 'very ', ''],
      ['subject_verb_agreement', 'was', 'were'],
    ]);
    expect(applyEdits(text, spans.map(edit)).text).toBe('Could of course we should have done it, to be very sure.\n   \nWe were there.');
    // "Could of course" is legitimate English and stays untouched.
    expect(spans.some((s) => s.range.start < text.indexOf('should'))).toBe(false);
  });

  it('adds a consistency note when both US and U.S. appear', () => {
    const both = mockCheck(makeRequest('We ship to the US today. The U.S. office agrees. The U.S. team too.'));
    expect(both.output.document.consistency).toEqual([
      { variants: ['US', 'U.S.'], recommended: 'U.S.', explanation: 'Both "US" and "U.S." appear; pick one form and use it throughout.' },
    ]);
    expect(mockCheck(makeRequest('Only the US form here.')).output.document.consistency).toEqual([]);
    expect(mockCheck(makeRequest('Only the U.S. form here.')).output.document.consistency).toEqual([]);
  });

  it('reports friendly/informal tone for greetings and direct otherwise', () => {
    expect(mockCheck(makeRequest('Hello Sam, quick note.')).output.document.tone[0]?.label).toBe('friendly');
    expect(mockCheck(makeRequest('The build is red.')).output.document.tone).toEqual([{ label: 'direct', strength: 'moderate' }]);
    expect(mockCheck(makeRequest('   ')).output.document.tone).toEqual([]);
  });

  it('round-trips through parseEngineOutput unchanged', () => {
    const { output } = mockCheck(makeRequest(FIXTURES.gmail));
    expect(parseEngineOutput(JSON.parse(JSON.stringify(output)))).toEqual(output);
  });
});

describe('mockVoiceProfile', () => {
  it('passes the lint and renders a cached block for both contexts', () => {
    for (const ctx of ['messages', 'documents'] as const) {
      const profile = mockVoiceProfile(ctx);
      expect(profile.context).toBe(ctx);
      expect(lintVoiceProfile(profile)).toEqual({ ok: true, problems: [] });
      const block = renderVoiceBlock(profile, { strength: 2, notes: '' });
      expect(block.startsWith(`<user_voice_profile ctx="${ctx}" v="3" strength="2">`)).toBe(true);
      expect(block).toContain('<traits>');
      expect(block).toContain('<style_guide>');
      expect(block.length).toBeLessThan(4000);
      expect(block).toBe(renderVoiceBlock(mockVoiceProfile(ctx), { strength: 2, notes: '' }));
    }
  });
});

// ---------------------------------------------------------------------------
// adversarial: the mock must behave like a model that only sees masked prose
// ---------------------------------------------------------------------------

describe('adversarial', () => {
  it('never flags inside URLs, emails, code, handles or DOM-protected ranges', () => {
    const text = 'Visit tomorow.com or https://x.com/recieve and mail recieve@x.com, run `teh cmd` or ```\nteh\n``` then ping @teh_user; the the end.';
    const protectedRanges = [{ start: text.indexOf('the the end'), end: text.indexOf('the the end') + 'the the'.length }];
    const { result, anchored, req } = pipeline(text, { protectedRanges });
    expect(anchored.dropped).toEqual([]);
    expect(result.output.blocks.flatMap((b) => b.suggestions)).toEqual([]);
    // Lift the DOM protection and the only prose error surfaces, anchored outside every mask.
    const open = pipeline(text);
    expect(open.anchored.dropped).toEqual([]);
    expect(open.anchored.suggestions.map((s) => [s.rule, s.original, s.replacement])).toEqual([['repeated_word', 'the ', '']]);
    const masks = maskRequestBlocks(req, ['b0'])[0]?.maskedRanges ?? [];
    // bare domain, URL, email and inline code are masked inside b0; the fence that opens at the end of b0 closes in a later block
    expect(masks.length).toBeGreaterThanOrEqual(4);
    for (const s of open.anchored.suggestions) for (const m of masks) expect(s.range.start >= m.end || s.range.end <= m.start).toBe(true);
    // A protected range that cuts a word in half still blanks the whole match.
    const half = mockCheck(makeRequest('Their going home.', { protectedRanges: [{ start: 2, end: 4 }] }));
    expect(half.output.blocks[0]?.suggestions).toEqual([]);
  });

  it('stays silent on false-positive traps and keeps the real errors', () => {
    const quiet = [
      'Their going-away party is tomorrow.',
      'I know that that is true, and what it is is a problem.',
      'Could of course be. Should of course not.',
      'The i.e. case, i18n, wi-fi and e-i-e-i-o are fine.',
      'We were there and they were too.',
      'Check its paint and its color; its a matter of taste only in the fixture phrase.',
      'Dr. Smith will receive it; see Fig. 2.',
      'im not sure (lowercase im is not the pronoun).',
    ];
    for (const text of quiet) expect(mockCheck(makeRequest(text)).output.blocks.flatMap((b) => b.suggestions), text).toEqual([]);
    const noisy = pipeline('hi, i think its a good idea and Im sure teh plan is fine.');
    expect(noisy.anchored.dropped).toEqual([]);
    expect(noisy.anchored.suggestions.map((s) => [s.rule, s.original, s.replacement])).toEqual([
      ['capitalization', 'i', 'I'],
      ['apostrophe', 'its', "it's"],
      ['apostrophe', 'Im', "I'm"],
      ['spelling', 'teh', 'the'],
    ]);
  });

  it('anchors every copy of a repeated error to its own position with unique ids', () => {
    const text = 'tomorow we say tomorow, and tomorow again tomorow.';
    const { result, anchored } = pipeline(text);
    expect(anchored.dropped).toEqual([]);
    expect(result.output.blocks[0]?.suggestions.map((s) => s.occurrence)).toEqual([1, 2, 3, 4]);
    expect(anchored.suggestions.map((s) => s.range.start)).toEqual([0, 15, 28, 42]);
    expect(new Set(anchored.suggestions.map((s) => s.id)).size).toBe(4);
    expect(applyEdits(text, anchored.suggestions.map(edit)).text).toBe('tomorrow we say tomorrow, and tomorrow again tomorrow.');
    // The same paragraph twice: block-relative ids repeat by design, the anchoring step makes them unique.
    const twice = pipeline('I recieve it.\nI recieve it.');
    expect(twice.anchored.suggestions.map((s) => s.blockId)).toEqual(['b0', 'b1']);
    expect(new Set(twice.anchored.suggestions.map((s) => s.id)).size).toBe(2);
    expect(twice.anchored.suggestions[1]?.id).toBe(`${twice.anchored.suggestions[0]?.id}~2`);
  });

  it('is order-independent and honours dirty hashes, blank blocks and unknown hashes', () => {
    const req = makeRequest(FIXTURES.scrolled);
    const shuffled = { ...req, blocks: [...req.blocks].reverse() };
    expect(JSON.stringify(mockCheck(shuffled).output)).toBe(JSON.stringify(mockCheck(req).output));
    expect(mockCheck({ ...req, dirtyBlockHashes: ['not-a-hash'] }).output.blocks).toEqual([]);
    const blank = makeRequest('recieve\n   \n\t\nrecieve');
    const out = mockCheck({ ...blank, dirtyBlockHashes: blank.blocks.map((b) => b.hash) }).output;
    expect(out.blocks.map((b) => b.block_id)).toEqual(['b0', 'b3']);
  });

  it('emits only contract-valid fields the real schema would accept', () => {
    const text = `${FIXTURES.textarea}\n${FIXTURES.gmail}\n${FIXTURES.contenteditable}\nUS and U.S. and https://x.com/US.`;
    const { result, parsed } = pipeline(text);
    expect(parsed.dropped).toEqual([]);
    const ids = new Set<string>();
    for (const b of result.output.blocks) {
      for (const s of b.suggestions) {
        expect((ENGINE_RULE_IDS as readonly string[]).includes(s.rule), s.rule).toBe(true);
        expect(['error', 'warning', 'suggestion']).toContain(s.severity);
        expect(['replace', 'delete', 'insert', 'flag', 'rewrite']).toContain(s.kind);
        expect(s.confidence).toBeGreaterThanOrEqual(0.5);
        expect(s.confidence).toBeLessThanOrEqual(1);
        expect(s.explanation.length).toBeLessThanOrEqual(140);
        expect(s.original.length).toBeGreaterThan(0);
        expect(s.kind === 'flag' ? s.replacement === s.original : s.replacement !== s.original).toBe(true);
        expect(s.kind === 'rewrite' || s.alternatives.length === 0).toBe(true);
        expect(Number.isInteger(s.occurrence) && s.occurrence >= 1).toBe(true);
        expect(ids.has(s.id)).toBe(false);
        ids.add(s.id);
      }
    }
    expect(result.output.document.consistency).toEqual([{ variants: ['US', 'U.S.'], recommended: 'U.S.', explanation: 'Both "US" and "U.S." appear; pick one form and use it throughout.' }]);
    // "US" only inside a URL is not prose.
    expect(mockCheck(makeRequest('See https://x.com/US and the U.S. office.')).output.document.consistency).toEqual([]);
    expect(result.output.document.tone.every((t) => (TONE_LABELS as readonly string[]).includes(t.label))).toBe(true);
  });

  it('stays fast on a long field', () => {
    const paragraph = `${FIXTURES.textarea} See https://example.com/${'x'.repeat(200)} and \`${'y'.repeat(200)}\`. `.repeat(4);
    const text = Array.from({ length: 60 }, () => paragraph).join('\n');
    const t0 = performance.now();
    const { anchored } = pipeline(text);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(anchored.dropped).toEqual([]);
    expect(anchored.suggestions.length).toBe(60 * 4 * 8);
  });
});
