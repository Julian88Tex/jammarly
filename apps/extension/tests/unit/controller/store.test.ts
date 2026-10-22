import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  SuggestionStore,
  acceptAllCounts,
  editKey,
  mergeSuggestions,
  rebaseAcrossChange,
  selectAcceptAll,
  stabilizeRuleIds,
} from '../../../src/content/controller/store';
import { makeSuggestion, sugAt } from './helpers';

const TEXT = 'This are the report we send yesterday.';

describe('mergeSuggestions', () => {
  it('resolves overlaps among span edits only: correctness beats clarity', () => {
    const rules = [sugAt(TEXT, 'are', { id: 'r1', source: 'rules', rule: 'subject_verb_agreement', replacement: 'is' })];
    const llm = [sugAt(TEXT, 'This are', { id: 'l1', category: 'clarity', severity: 'suggestion', replacement: 'This is', confidence: 0.9 })];
    const merged = mergeSuggestions({ rules, llm, filters: DEFAULT_FILTERS, isSuppressed: () => false });
    expect(merged.map((s) => s.id)).toEqual(['r1']);
  });

  it('folds an identical rules hit into the LLM twin as source "both" with the stable LLM id', () => {
    const rules = [sugAt(TEXT, 'are', { id: 'r1', source: 'rules', replacement: 'is', confidence: 1 })];
    const llm = [sugAt(TEXT, 'are', { id: 'l1', source: 'llm', replacement: 'is', confidence: 0.9 })];
    const merged = mergeSuggestions({ rules, llm, filters: DEFAULT_FILTERS, isSuppressed: () => false });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('l1');
    expect(merged[0]!.source).toBe('both');
    expect(merged[0]!.confidence).toBe(1);
  });

  it('links rewrites and flags to the spans they overlap in both directions and leaves them out of overlap resolution', () => {
    const spanA = sugAt(TEXT, 'are', { id: 'a', replacement: 'is' });
    const spanB = sugAt(TEXT, 'send', { id: 'b', replacement: 'sent', rule: 'verb_tense' });
    const rewrite = sugAt(TEXT, TEXT, { id: 'rw', kind: 'rewrite', category: 'clarity', tier: 'C', replacement: 'This is the report we sent yesterday.', rule: 'sentence_rewrite' });
    const flag = sugAt(TEXT, 'yesterday', { id: 'fl', kind: 'flag', category: 'delivery', tier: 'C', replacement: 'yesterday', rule: 'hedging' });
    const other = makeSuggestion({ id: 'far', range: { start: 100, end: 103 }, original: 'xyz' });
    const merged = mergeSuggestions({ rules: [], llm: [spanA, spanB, rewrite, flag, other], filters: DEFAULT_FILTERS, isSuppressed: () => false });
    const byId = new Map(merged.map((s) => [s.id, s]));
    expect(byId.get('rw')!.conflictsWith.sort()).toEqual(['a', 'b']);
    expect(byId.get('a')!.conflictsWith).toEqual(['rw']);
    expect(byId.get('b')!.conflictsWith).toEqual(['rw']);
    expect(byId.get('fl')!.conflictsWith).toEqual([]);
    expect(byId.get('far')!.conflictsWith).toEqual([]);
    expect(merged.map((s) => s.id)).toEqual(['rw', 'a', 'b', 'fl', 'far']);
  });

  it('applies filters: muted rules, disabled categories, dictionary words, suppressed fingerprints', () => {
    const llm = [
      sugAt(TEXT, 'are', { id: 'muted', rule: 'subject_verb_agreement', replacement: 'is' }),
      sugAt(TEXT, 'send', { id: 'delivery', category: 'delivery', severity: 'suggestion', replacement: 'sent' }),
      sugAt(TEXT, 'yesterday', { id: 'dict', rule: 'spelling', replacement: 'yesterdays' }),
      sugAt(TEXT, 'report', { id: 'dismissed', rule: 'word_choice', replacement: 'document', fingerprint: 'fp-x' }),
      sugAt(TEXT, 'This', { id: 'kept', rule: 'capitalization', replacement: 'this' }),
    ];
    const merged = mergeSuggestions({
      rules: [],
      llm,
      filters: { mutedRules: new Set(['subject_verb_agreement']), categories: { correctness: true, clarity: true, engagement: true, delivery: false }, dictionary: new Set(['yesterday']) },
      isSuppressed: (s) => s.fingerprint === 'fp-x',
    });
    expect(merged.map((s) => s.id)).toEqual(['kept']);
  });
});

describe('rebaseAcrossChange', () => {
  it('shifts suggestions after a user edit and drops the ones the edit touched', () => {
    const s1 = sugAt(TEXT, 'are', { id: 's1', replacement: 'is' });
    const s2 = sugAt(TEXT, 'send', { id: 's2', replacement: 'sent' });
    const after = 'This are the report we sent yesterday.';
    const r = rebaseAcrossChange([s1, s2], TEXT, after);
    expect(r.kept.map((s) => s.id)).toEqual(['s1']);
    expect(r.dropped.map((s) => s.id)).toEqual(['s2']);
    const inserted = 'Oh! This are the report we send yesterday.';
    const r2 = rebaseAcrossChange([s1, s2], TEXT, inserted);
    expect(r2.kept.map((s) => s.range.start)).toEqual([9, 27]);
    expect(inserted.slice(9, 12)).toBe('are');
    const same = rebaseAcrossChange([s1], TEXT, TEXT);
    expect(same.kept).toHaveLength(1);
    expect(same.dropped).toHaveLength(0);
  });

  it("our own edit removes the applied id, transforms the enclosing rewrite's original and marks it stale, and drops conflicting spans", () => {
    const spanA = sugAt(TEXT, 'are', { id: 'a', replacement: 'is' });
    const spanB = sugAt(TEXT, 'send', { id: 'b', replacement: 'sent' });
    const rewrite = sugAt(TEXT, TEXT, { id: 'rw', kind: 'rewrite', category: 'clarity', tier: 'C', replacement: 'This is the report we sent yesterday.' });
    const after = 'This is the report we send yesterday.';
    const r = rebaseAcrossChange([spanA, spanB, rewrite], TEXT, after, { ids: new Set(['a']) });
    expect(r.dropped.map((s) => s.id)).toEqual(['a']);
    expect(r.transformed.map((s) => s.id)).toEqual(['rw']);
    const rw = r.kept.find((s) => s.id === 'rw')!;
    expect(rw.stale).toBe(true);
    expect(rw.original).toBe(after);
    expect(rw.range).toEqual({ start: 0, end: after.length });
    const b = r.kept.find((s) => s.id === 'b')!;
    expect(b.range).toEqual({ start: 22, end: 26 });
    expect(after.slice(22, 26)).toBe('send');

    // Accepting the rewrite itself: spans inside it overlap the region and go away with it.
    const applied = 'This is the report we sent yesterday.';
    const r2 = rebaseAcrossChange([spanA, spanB, rewrite], TEXT, applied, { ids: new Set(['rw']) });
    expect(r2.kept).toHaveLength(0);
    expect(r2.dropped.map((s) => s.id).sort()).toEqual(['a', 'b', 'rw']);
  });
});

describe('stabilizeRuleIds / selectAcceptAll / counts', () => {
  it('keeps the previous id for a rules hit with the same fingerprint at the same range', () => {
    const prev = [makeSuggestion({ id: 'old', source: 'rules', range: { start: 5, end: 8 }, original: 'teh', fingerprint: 'fp' })];
    const next = [makeSuggestion({ id: 'new', source: 'rules', range: { start: 5, end: 8 }, original: 'teh', fingerprint: 'fp' }), makeSuggestion({ id: 'other', source: 'rules', range: { start: 20, end: 23 }, fingerprint: 'fp2' })];
    expect(stabilizeRuleIds(prev, next).map((s) => s.id)).toEqual(['old', 'other']);
  });

  it('selects tier A for grammar, tier B for style, both for all; excludes stale, normalized anchors (A), non-span kinds and overlaps', () => {
    const a = makeSuggestion({ id: 'a', tier: 'A', range: { start: 0, end: 3 }, original: 'teh' });
    const aNorm = makeSuggestion({ id: 'an', tier: 'A', anchor: 'normalized', range: { start: 10, end: 13 }, original: 'teh' });
    const b = makeSuggestion({ id: 'b', tier: 'B', category: 'clarity', range: { start: 20, end: 25 }, original: 'quite', replacement: '' , kind: 'delete' });
    const bStale = makeSuggestion({ id: 'bs', tier: 'B', category: 'clarity', stale: true, range: { start: 30, end: 33 }, original: 'abc' });
    const bOverlap = makeSuggestion({ id: 'bo', tier: 'B', category: 'engagement', range: { start: 1, end: 4 }, original: 'ehx' });
    const rw = makeSuggestion({ id: 'rw', kind: 'rewrite', tier: 'C', range: { start: 0, end: 40 }, original: 'x'.repeat(40) });
    const flag = makeSuggestion({ id: 'fl', kind: 'flag', tier: 'C', range: { start: 50, end: 52 }, original: 'ok', replacement: 'ok' });
    const notMp = makeSuggestion({ id: 'nm', tier: 'B', category: 'clarity', meaningPreserving: false, range: { start: 60, end: 62 }, original: 'ok' });
    const all = [a, aNorm, b, bStale, bOverlap, rw, flag, notMp];

    const grammar = selectAcceptAll(all, { group: 'grammar' });
    expect(grammar.selected.map((s) => s.id)).toEqual(['a']);
    expect(grammar.pendingRewrites).toEqual([]);

    const style = selectAcceptAll(all, { group: 'style' });
    expect(style.selected.map((s) => s.id).sort()).toEqual(['b', 'bo']);
    expect(style.pendingRewrites.map((s) => s.id)).toEqual(['rw']);

    const every = selectAcceptAll(all, { group: 'all' });
    expect(every.selected.map((s) => s.id)).toEqual(['b', 'a']); // descending start; the overlapping B loses to A
    expect(every.excluded.map((s) => s.id)).toEqual(['bo']);
    expect(every.pendingRewrites.map((s) => s.id)).toEqual(['rw']);

    const subset = selectAcceptAll(all, { group: 'all', suggestionIds: ['b'] });
    expect(subset.selected.map((s) => s.id)).toEqual(['b']);

    expect(acceptAllCounts(all)).toEqual({ grammar: 1, style: 2, rewrites: 1 });
  });
});

describe('SuggestionStore', () => {
  it('filters dismissed fingerprints even when the id differs, and suppresses the inverse of an applied edit', () => {
    const store = new SuggestionStore();
    const s = sugAt(TEXT, 'are', { id: 's1', replacement: 'is', fingerprint: 'fp-are-is' });
    store.replaceLlm([s]);
    expect(store.all).toHaveLength(1);
    store.dismiss(s);
    expect(store.all).toHaveLength(0);
    store.replaceLlm([{ ...s, id: 's1-again' }]);
    expect(store.get('s1-again')).toBeUndefined();

    const fixed = 'This is the report we send yesterday.';
    store.recordApplied([{ range: { start: 5, end: 8 }, original: 'are', replacement: 'is' }]);
    const inverse = sugAt(fixed, 'is', { id: 'inv', replacement: 'are', fingerprint: 'fp-other' });
    const unrelated = sugAt(fixed, 'send', { id: 'ok', replacement: 'sent', fingerprint: 'fp-ok' });
    store.replaceLlm([inverse, unrelated]);
    expect(store.all.map((x) => x.id)).toEqual(['ok']);
    expect(editKey('are', 'is')).toBe(editKey('ARE', 'is'.toUpperCase()));
  });

  it('rebases rules and LLM sets together, re-links conflicts and can restore an undone suggestion', () => {
    const store = new SuggestionStore();
    const span = sugAt(TEXT, 'are', { id: 'a', replacement: 'is' });
    const rule = sugAt(TEXT, 'send', { id: 'r', source: 'rules', replacement: 'sent' });
    const rw = sugAt(TEXT, TEXT, { id: 'rw', kind: 'rewrite', category: 'clarity', tier: 'C', replacement: 'x' });
    store.replaceLlm([span, rw]);
    store.setRules([rule]);
    expect(store.get('rw')!.conflictsWith.sort()).toEqual(['a', 'r']);
    const after = 'Oh! ' + TEXT;
    const r = store.rebase(TEXT, after);
    expect(r.dropped).toHaveLength(0);
    expect(store.get('a')!.range.start).toBe(9);
    expect(store.get('r')!.range.start).toBe(27);
    expect(store.get('rw')!.range).toEqual({ start: 4, end: 4 + TEXT.length });

    store.remove(['a']);
    store.recordApplied([{ range: { start: 9, end: 12 }, original: 'are', replacement: 'is' }]);
    expect(store.get('a')).toBeUndefined();
    expect(store.restore(span, { start: 9, end: 12 }, after)).toBe(true);
    expect(store.get('a')!.range).toEqual({ start: 9, end: 12 });
    expect(store.restore(span, { start: 0, end: 3 }, after)).toBe(false);
    store.markStale(['rw']);
    expect(store.get('rw')!.stale).toBe(true);
    expect(store.counts()).toEqual({ grammar: 2, style: 0, rewrites: 1 });
    store.clear();
    expect(store.all).toHaveLength(0);
  });
});
