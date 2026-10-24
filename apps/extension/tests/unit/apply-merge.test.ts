import { describe, expect, it } from 'vitest';
import type { Edit, EditOutcome } from '@jammarly/shared/types';
import { applyEditsRightToLeft, mergeEdits } from '../../src/content/adapters/common';

function edit(text: string, original: string, replacement: string, from = 0): Edit {
  const start = text.indexOf(original, from);
  return { range: { start, end: start + original.length }, original, replacement };
}

/** A field whose writes always stick (or are refused when `refuseOver` chars or more are replaced at once). */
function field(initial: string, refuseOver = Infinity) {
  let text = initial;
  const writes: Edit[] = [];
  const applyOne = async (e: Edit): Promise<EditOutcome> => {
    writes.push(e);
    if (text.slice(e.range.start, e.range.end) !== e.original) return { status: 'mismatch', rung: null, text };
    if (e.original.length >= refuseOver) return { status: 'unsupported', rung: 'splice', text };
    text = text.slice(0, e.range.start) + e.replacement + text.slice(e.range.end);
    return { status: 'applied', rung: 'splice', text };
  };
  return { applyOne, read: () => text, writes };
}

describe('applyEditsRightToLeft merging', () => {
  const TEXT = 'Their going to teh store tomorow.\nMe and him is here.';

  it('writes every fix on a line in one go and keeps lines apart', async () => {
    const f = field(TEXT);
    const edits = [edit(TEXT, 'Their', 'They’re'), edit(TEXT, 'teh', 'the'), edit(TEXT, 'tomorow', 'tomorrow'), edit(TEXT, 'is', 'are')];
    const out = await applyEditsRightToLeft(edits, f.applyOne, f.read, () => true);
    expect(f.read()).toBe('They’re going to the store tomorrow.\nMe and him are here.');
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]!.original).toBe('Their going to teh store tomorow');
    expect(out.applied).toHaveLength(4);
    expect(out.applied.map((e) => e.original)).toEqual(['is', 'tomorow', 'teh', 'Their']);
    expect(out.skipped).toEqual([]);
  });

  it('does not merge a span the adapter calls unsafe, or without canMerge', async () => {
    const edits = [edit(TEXT, 'Their', 'They’re'), edit(TEXT, 'teh', 'the')];
    const a = field(TEXT);
    await applyEditsRightToLeft(edits, a.applyOne, a.read, () => false);
    expect(a.writes).toHaveLength(2);
    const b = field(TEXT);
    await applyEditsRightToLeft(edits, b.applyOne, b.read);
    expect(b.writes).toHaveLength(2);
    expect(b.read()).toBe(a.read());
  });

  it('falls back to one write per edit when the merged write does not stick', async () => {
    const f = field(TEXT, 10);
    const edits = [edit(TEXT, 'Their', 'They’re'), edit(TEXT, 'teh', 'the'), edit(TEXT, 'tomorow', 'tomorrow')];
    const out = await applyEditsRightToLeft(edits, f.applyOne, f.read, () => true);
    expect(f.read()).toBe('They’re going to the store tomorrow.\nMe and him is here.');
    expect(f.writes).toHaveLength(4);
    expect(out.applied).toHaveLength(3);
  });

  it('mergeEdits composes the span against the text', () => {
    expect(mergeEdits(TEXT, [edit(TEXT, 'teh', 'the'), edit(TEXT, 'tomorow', 'tomorrow')])).toEqual({
      range: { start: 15, end: 32 },
      original: 'teh store tomorow',
      replacement: 'the store tomorrow',
    });
  });
});
