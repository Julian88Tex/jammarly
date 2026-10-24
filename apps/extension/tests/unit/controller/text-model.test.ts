import { describe, expect, it } from 'vitest';
import { TextModel, provenanceForInputType, shiftRangeThrough } from '../../../src/content/controller/text-model';

describe('TextModel', () => {
  it('bumps the version and logs one DiffRegion per change; identical text is a no-op', () => {
    const m = new TextModel('hello world');
    expect(m.version).toBe(0);
    const change = m.update('hello brave world', 'insertText');
    expect(change).toEqual(expect.objectContaining({ fromVersion: 0, toVersion: 1, provenance: 'typed', inputType: 'insertText' }));
    expect(change!.region).toEqual({ start: 6, oldEnd: 6, newEnd: 12 });
    expect(m.version).toBe(1);
    expect(m.update('hello brave world')).toBeNull();
    expect(m.version).toBe(1);
    expect(m.snapshot(0)).toBe('hello world');
    expect(m.snapshot(1)).toBe('hello brave world');
    expect(m.changes).toHaveLength(1);
  });

  it('shiftThrough rebases a range stepwise through later edits', () => {
    const m = new TextModel('The teh cat sat.');
    m.update('The big teh cat sat.', 'insertText'); // insert before the span
    m.update('The big teh cat.', 'deleteContentBackward'); // delete after it
    expect(m.shiftThrough(0, { start: 4, end: 7 })).toEqual({ start: 8, end: 11 });
    expect(m.text.slice(8, 11)).toBe('teh');
    expect(m.shiftBetween(0, 1, { start: 4, end: 7 })).toEqual({ start: 8, end: 11 });
    expect(m.shiftBetween(1, 2, { start: 8, end: 11 })).toEqual({ start: 8, end: 11 });
  });

  it('shiftThrough returns null when an edit touched the range', () => {
    const m = new TextModel('The teh cat sat.');
    m.update('The tXeh cat sat.', 'insertText');
    expect(m.shiftThrough(0, { start: 4, end: 7 })).toBeNull();
    expect(shiftRangeThrough({ start: 4, end: 7 }, { start: 5, oldEnd: 5, newEnd: 6 })).toBeNull();
    expect(shiftRangeThrough({ start: 0, end: 3 }, { start: 5, oldEnd: 5, newEnd: 6 })).toEqual({ start: 0, end: 3 });
    expect(shiftRangeThrough({ start: 5, end: 7 }, { start: 2, oldEnd: 4, newEnd: 3 })).toEqual({ start: 4, end: 6 });
  });

  it('retains regions and snapshots until prune(oldestNeeded)', () => {
    const m = new TextModel('a');
    m.update('ab');
    m.update('abc');
    m.update('abcd');
    expect(m.canRebaseFrom(0)).toBe(true);
    expect(m.regionsSince(1)).toHaveLength(2);
    expect(m.changesSince(3)).toHaveLength(0);
    m.prune(2);
    expect(m.canRebaseFrom(1)).toBe(false);
    expect(m.canRebaseFrom(2)).toBe(true);
    expect(m.snapshot(1)).toBeUndefined();
    expect(m.snapshot(2)).toBe('abc');
    expect(m.regionsSince(1)).toBeNull();
    expect(m.shiftThrough(1, { start: 0, end: 1 })).toBeNull();
    expect(m.shiftThrough(2, { start: 0, end: 1 })).toEqual({ start: 0, end: 1 });
    expect(m.canRebaseFrom(99)).toBe(false);
  });

  it('caps the log at maxLog and reports the oldest retained version', () => {
    const m = new TextModel('', { maxLog: 2 });
    m.update('a');
    m.update('ab');
    m.update('abc');
    expect(m.oldestRetained).toBe(1);
    expect(m.canRebaseFrom(0)).toBe(false);
    expect(m.canRebaseFrom(1)).toBe(true);
    expect(m.changes).toHaveLength(2);
  });

  it('tracks typed, pasted and Jammarly provenance; pre-existing text is never typed', () => {
    const m = new TextModel('Hi. ');
    m.update('Hi. I typed this.', 'insertText');
    m.update('Hi. I typed this. Pasted stuff here.', 'insertFromPaste');
    m.update('Hi. I typed this. Pasted stuff here. Fixed.', { provenance: 'jammarly' });
    const ranges = m.provenanceRanges();
    expect(ranges.map((r) => r.kind)).toEqual(['typed', 'pasted', 'jammarly']);
    expect(m.isTyped({ start: 4, end: 17 })).toBe(true);
    expect(m.isTyped({ start: 0, end: 3 })).toBe(false); // initial text
    expect(m.isTyped({ start: 17, end: 36 })).toBe(false); // pasted
    expect(m.isTyped({ start: 2, end: 10 })).toBe(false); // mixed
    expect(m.isTyped({ start: 5, end: 5 })).toBe(false); // empty
    expect(m.provenanceAt(5)).toBe('typed');
    expect(m.provenanceAt(20)).toBe('pasted');
    expect(m.provenanceAt(40)).toBe('jammarly');
    expect(m.provenanceAt(1)).toBeNull();
    expect(provenanceForInputType('insertFromDrop')).toBe('pasted');
    expect(provenanceForInputType('insertCompositionText')).toBe('typed');
    expect(provenanceForInputType(null)).toBe('typed');
  });

  it('splits and shifts provenance ranges around a deletion, merging adjacent runs of one kind', () => {
    const m = new TextModel('Hi. ');
    m.update('Hi. I typed this.', 'insertText'); // typed [4,17)
    m.update('Hi. I typthis.', 'deleteContentBackward'); // delete "ed " at [9,12)
    expect(m.provenanceRanges()).toEqual([{ start: 4, end: 14, kind: 'typed' }]);
    m.update('Hi. I typ[x]this.', 'insertFromPaste'); // paste inside the typed run
    expect(m.provenanceRanges()).toEqual([
      { start: 4, end: 9, kind: 'typed' },
      { start: 9, end: 12, kind: 'pasted' },
      { start: 12, end: 17, kind: 'typed' },
    ]);
    expect(m.isTyped({ start: 4, end: 17 })).toBe(false);
    expect(m.isTyped({ start: 12, end: 17 })).toBe(true);
  });
});
