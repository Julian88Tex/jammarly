import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldKind, Suggestion } from '@jammarly/shared/types';
import { ApplyEngine, postApplyEdits, validateEdit, type ApplyHost } from '../../../src/content/controller/apply';
import { SuggestionStore } from '../../../src/content/controller/store';
import { TextModel } from '../../../src/content/controller/text-model';
import { FAKE_TIMER_APIS, FakeAdapter, flushPromises, sugAt } from './helpers';

const TEXT = 'Their going to teh store, and i dont know.';

function makeHost(text: string, suggestions: Suggestion[], kind: FieldKind = 'contenteditable') {
  const adapter = new FakeAdapter(text, kind);
  const model = new TextModel(text);
  const store = new SuggestionStore();
  store.replaceLlm(suggestions);
  let own: Set<string> | null = null;
  let n = 0;
  const sync = (t: string): void => {
    if (t === model.text) return;
    const old = model.text;
    model.update(t, own ? { provenance: 'jammarly' } : 'insertText');
    store.rebase(old, t, own ? { ids: own } : undefined);
  };
  adapter.onChange((t) => sync(t));
  const host: ApplyHost = {
    fieldId: 'f1',
    adapter,
    model,
    store,
    beginOwnEdit: (_edits, ids) => {
      own = new Set(ids);
    },
    endOwnEdit: (t) => {
      sync(t);
      own = null;
    },
    now: () => Date.now(),
    newId: () => `tx${++n}`,
  };
  const engine = new ApplyEngine(host);
  return { adapter, model, store, engine };
}

function tierA(text: string) {
  return [
    sugAt(text, 'Their', { id: 'their', replacement: "They're", rule: 'confusable_word' }),
    sugAt(text, 'teh', { id: 'teh', replacement: 'the' }),
    sugAt(text, 'i', { id: 'i', replacement: 'I', rule: 'capitalization' }),
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.textContent = '';
});

describe('ApplyEngine.accept', () => {
  it('re-validates, writes through the adapter, records a transaction with the post-apply range and removes the suggestion', async () => {
    const { adapter, model, store, engine } = makeHost(TEXT, tierA(TEXT));
    const result = await engine.accept('teh');
    expect(result.status).toBe('applied');
    expect(adapter.text).toBe("Their going to the store, and i dont know.");
    expect(model.text).toBe(adapter.text);
    expect(model.version).toBe(1);
    // Provenance follows the changed characters ('t' is shared by 'teh' and 'the').
    expect(model.provenanceRanges()).toEqual([{ start: 16, end: 18, kind: 'jammarly' }]);
    const tx = result.transaction!;
    expect(tx.edits).toEqual([{ range: { start: 15, end: 18 }, original: 'teh', replacement: 'the' }]);
    expect(tx.items).toEqual([{ id: 'teh', title: 'Correct the spelling', category: 'correctness', original: 'teh', replacement: 'the' }]);
    expect(tx.appliedIds).toEqual(['teh']);
    expect(store.get('teh')).toBeUndefined();
    expect(store.get('their')).toBeDefined();
    expect(store.get('i')!.range).toEqual({ start: 30, end: 31 }); // same length edit: unchanged
    expect(engine.undoAvailable).toBe(1);
    expect(engine.history[0]!.id).toBe(tx.id);
    // the inverse edit is suppressed from now on
    store.replaceLlm([sugAt(adapter.text, 'the', { id: 'inv', replacement: 'teh' })]);
    expect(store.get('inv')).toBeUndefined();
  });

  it('uses the chosen alternative and reports a missing suggestion', async () => {
    const text = 'That was very good.';
    const s = sugAt(text, 'very good', { id: 'alt', kind: 'rewrite', category: 'engagement', tier: 'C', replacement: 'excellent', alternatives: ['superb', 'outstanding'] });
    const { adapter, engine } = makeHost(text, [s]);
    const result = await engine.accept('alt', 0); // alternativeIndex is 0-based into `alternatives` (card option 2)
    expect(result.status).toBe('applied');
    expect(result.replacement).toBe('superb');
    expect(adapter.text).toBe('That was superb.');
    expect((await engine.accept('nope')).status).toBe('missing');
  });

  it('aborts on a mismatch (text changed under the suggestion) and refuses protected spans', async () => {
    const { adapter, model, engine, store } = makeHost(TEXT, tierA(TEXT));
    // Simulate a stale store entry: the text changed but the store was not rebased.
    (model as unknown as { current: string }).current = TEXT.replace('teh', 'tXh');
    adapter.text = model.text;
    expect((await engine.accept('teh')).status).toBe('mismatch');
    expect(adapter.applyCalls).toHaveLength(0);
    (model as unknown as { current: string }).current = TEXT;
    adapter.text = TEXT;
    adapter.protectedRanges = [{ start: 14, end: 20 }];
    expect((await engine.accept('teh')).status).toBe('protected');
    expect(store.get('teh')).toBeDefined();
    expect(validateEdit('abc', { range: { start: 0, end: 5 }, original: 'abc', replacement: 'x' }, [])).toBe('mismatch');
    expect(validateEdit('a b', { range: { start: 0, end: 3 }, original: 'a b', replacement: 'x' }, [])).toBe('ok');
  });

  it('queues an accept while an IME composition is active and applies after compositionend + 50 ms', async () => {
    const { adapter, engine } = makeHost(TEXT, tierA(TEXT));
    adapter.composing = true;
    let settled: Awaited<ReturnType<typeof engine.accept>> | null = null;
    void engine.accept('teh').then((r) => {
      settled = r;
    });
    await flushPromises();
    expect(adapter.applyCalls).toHaveLength(0);
    adapter.composing = false;
    adapter.element.dispatchEvent(new Event('compositionend'));
    vi.advanceTimersByTime(49);
    await flushPromises();
    expect(adapter.applyCalls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flushPromises(5);
    expect(settled).not.toBeNull();
    expect(settled!.status).toBe('applied');
    expect(adapter.text).toContain('the store');
  });

  it('reports a failed write without recording a transaction', async () => {
    const { adapter, engine, store } = makeHost(TEXT, tierA(TEXT));
    adapter.failNext = 'reverted';
    const r = await engine.accept('teh');
    expect(r.status).toBe('failed');
    expect(engine.undoAvailable).toBe(0);
    expect(store.get('teh')).toBeDefined();
  });
});

describe('ApplyEngine.acceptAll', () => {
  it('applies the selected tier right-to-left as one transaction and leaves tier C pending', async () => {
    const styleB = sugAt(TEXT, 'going to', { id: 'b', category: 'clarity', tier: 'B', replacement: 'headed to', severity: 'suggestion' });
    const rewrite = sugAt(TEXT, TEXT, { id: 'rw', kind: 'rewrite', category: 'clarity', tier: 'C', replacement: "They're headed to the store, and I don't know." });
    const { adapter, store, engine } = makeHost(TEXT, [...tierA(TEXT), styleB, rewrite]);
    const result = await engine.acceptAll({ group: 'grammar' });
    expect(result.applied.map((s) => s.id)).toEqual(['i', 'teh', 'their']);
    expect(adapter.batchCalls).toHaveLength(1);
    expect(adapter.batchCalls[0]!.map((e) => e.range.start)).toEqual([30, 15, 0]);
    expect(adapter.text).toBe("They're going to the store, and I dont know.");
    const tx = result.transaction!;
    expect(tx.edits.map((e) => e.range)).toEqual([
      { start: 32, end: 33 },
      { start: 17, end: 20 },
      { start: 0, end: 7 },
    ]);
    expect(tx.appliedIds).toEqual(['i', 'teh', 'their']);
    expect(result.report).toEqual({ fieldId: 'f1', appliedIds: ['i', 'teh', 'their'], skippedIds: [], pendingRewriteIds: [], transactionId: tx.id });
    expect(result.pendingRewrites).toEqual([]);
    // style B shifted, rewrite transformed + stale
    expect(store.get('b')!.range).toEqual({ start: 8, end: 16 });
    expect(store.get('rw')!.stale).toBe(true);
    expect(store.get('rw')!.original).toBe(adapter.text);

    const everything = await engine.acceptAll({ group: 'all' });
    expect(everything.applied.map((s) => s.id)).toEqual(['b']);
    expect(everything.pendingRewrites.map((s) => s.id)).toEqual(['rw']);
    expect(everything.report!.pendingRewriteIds).toEqual(['rw']);
    expect(adapter.text).toBe("They're headed to the store, and I dont know.");
    expect(engine.undoAvailable).toBe(2);
    expect(engine.history).toHaveLength(2);
  });

  it('aborts on the first mismatch and reports what was applied', async () => {
    const { adapter, engine, store } = makeHost(TEXT, tierA(TEXT));
    adapter.failOn = (edit) => edit.original === 'teh';
    const result = await engine.acceptAll({ group: 'grammar' });
    expect(result.applied.map((s) => s.id)).toEqual(['i']);
    expect(result.skipped.map((s) => s.id).sort()).toEqual(['teh', 'their']);
    expect(result.report!.skippedIds.sort()).toEqual(['teh', 'their']);
    expect(adapter.text).toBe('Their going to teh store, and I dont know.');
    expect(store.get('teh')).toBeDefined();
    expect(store.get('their')).toBeDefined();
    expect(store.get('i')).toBeUndefined();
  });

  it('returns nothing to apply when the scope is empty', async () => {
    const { engine } = makeHost(TEXT, [sugAt(TEXT, TEXT, { id: 'rw', kind: 'rewrite', tier: 'C', replacement: 'x' })]);
    const result = await engine.acceptAll({ group: 'grammar' });
    expect(result.transaction).toBeNull();
    expect(result.applied).toEqual([]);
    expect(engine.undoAvailable).toBe(0);
  });
});

describe('ApplyEngine.undo / revert', () => {
  it('maps the inverse edits through later user edits, re-validates and restores the suggestions', async () => {
    const { adapter, model, store, engine } = makeHost(TEXT, tierA(TEXT));
    await engine.acceptAll({ group: 'grammar' });
    const fixed = "They're going to the store, and I dont know.";
    expect(adapter.text).toBe(fixed);
    adapter.type('Hey! ' + fixed); // user inserts before everything
    adapter.type('Hey! ' + fixed + ' Bye.'); // and after
    expect(model.version).toBe(5);
    const result = await engine.undo();
    expect(result.status).toBe('undone');
    expect(result.revertedIds.sort()).toEqual(['i', 'teh', 'their']);
    expect(adapter.text).toBe('Hey! ' + TEXT + ' Bye.');
    expect(adapter.batchCalls[1]!.map((e) => e.range.start)).toEqual([37, 22, 5]);
    expect(engine.undoAvailable).toBe(0);
    expect(engine.history[0]!.revertedIds.sort()).toEqual(['i', 'teh', 'their']);
    expect(store.get('teh')!.range).toEqual({ start: 20, end: 23 });
    expect(adapter.text.slice(20, 23)).toBe('teh');
    expect(store.get('their')!.range).toEqual({ start: 5, end: 10 });
    expect((await engine.undo()).status).toBe('nothing');
  });

  it('skips an edit the user already changed and reports partial; fails when nothing can be mapped (contenteditable)', async () => {
    const { adapter, engine, store } = makeHost(TEXT, tierA(TEXT));
    await engine.acceptAll({ group: 'grammar' });
    // user edits inside the applied "the" span
    adapter.type("They're going to thee store, and I dont know.");
    const result = await engine.undo();
    expect(result.status).toBe('partial');
    expect(result.revertedIds.sort()).toEqual(['i', 'their']);
    expect(adapter.text).toBe('Their going to thee store, and i dont know.');
    expect(store.get('teh')).toBeUndefined();
    expect(engine.undoAvailable).toBe(1); // "teh" is still recorded as applied
    const again = await engine.undo();
    expect(again.status).toBe('failed');
    expect(again.revertedIds).toEqual([]);
  });

  it('textarea/input fall back to a whole-text restore when the adapter cannot apply inverses and nothing changed since', async () => {
    const { adapter, engine, store } = makeHost(TEXT, tierA(TEXT), 'textarea');
    await engine.acceptAll({ group: 'grammar' });
    adapter.failBatch = true;
    const result = await engine.undo();
    expect(result.status).toBe('undone');
    expect(adapter.text).toBe(TEXT);
    expect(adapter.applyCalls.at(-1)).toEqual({ range: { start: 0, end: "They're going to the store, and I dont know.".length }, original: "They're going to the store, and I dont know.", replacement: TEXT });
    expect(store.get('teh')!.range).toEqual({ start: 15, end: 18 });
  });

  it('reverts a single item of a transaction and counts undoAvailable per transaction', async () => {
    const { adapter, engine } = makeHost(TEXT, tierA(TEXT));
    await engine.acceptAll({ group: 'grammar' });
    const result = await engine.revert('teh');
    expect(result.status).toBe('undone');
    expect(result.revertedIds).toEqual(['teh']);
    expect(adapter.text).toBe("They're going to teh store, and I dont know.");
    expect(engine.undoAvailable).toBe(1);
    expect(engine.history[0]!.revertedIds).toEqual(['teh']);
    expect((await engine.revert('teh')).status).toBe('nothing');
    await engine.revert('their');
    await engine.revert('i');
    expect(engine.undoAvailable).toBe(0);
    expect(adapter.text).toBe(TEXT);
  });

  it('reconcileNativeUndo marks edits whose replacement is gone as reverted', async () => {
    const { adapter, engine } = makeHost(TEXT, tierA(TEXT));
    await engine.accept('teh');
    await engine.accept('i');
    adapter.type("Their going to teh store, and I dont know.", 'historyUndo'); // host undid the first accept
    const marked = engine.reconcileNativeUndo();
    expect(marked).toEqual(['teh']);
    expect(engine.undoAvailable).toBe(1);
    expect(engine.oldestNeededVersion).toBe(2);
  });

  it('postApplyEdits accumulates deltas in reading order (insert and replace at the same offset)', () => {
    const posts = postApplyEdits([
      { range: { start: 10, end: 13 }, original: 'teh', replacement: 'the' },
      { range: { start: 0, end: 5 }, original: 'Their', replacement: "They're" },
      { range: { start: 10, end: 10 }, original: '', replacement: '  ' },
    ]);
    expect(posts).toEqual([
      { range: { start: 14, end: 17 }, original: 'teh', replacement: 'the' },
      { range: { start: 0, end: 7 }, original: 'Their', replacement: "They're" },
      { range: { start: 12, end: 14 }, original: '', replacement: '  ' },
    ]);
  });
});
