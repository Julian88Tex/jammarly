import { describe, expect, it } from 'vitest';
import { DOCS_SENTINEL, NBSP, docsTextsEquivalent, gdocsDocumentId, normalizeDocsText, normalizeNbsp, planDocsEdit, toPastePayload } from '../../src/content/gdocs/text';

describe('normalizeDocsText', () => {
  it('strips the leading sentinel and the trailing newline', () => {
    const m = normalizeDocsText(`${DOCS_SENTINEL}Hello world\n`);
    expect(m.text).toBe('Hello world');
    expect(m.leading).toBe(1);
    expect(m.trailing).toBe(1);
    expect(m.raw).toBe(`${DOCS_SENTINEL}Hello world\n`);
  });

  it('leaves text without sentinel or trailing newline untouched', () => {
    const m = normalizeDocsText('plain');
    expect(m.text).toBe('plain');
    expect(m.leading).toBe(0);
    expect(m.trailing).toBe(0);
    expect(m.toRaw(2)).toBe(2);
    expect(m.fromRaw(2)).toBe(2);
  });

  it('handles the degenerate raw strings of an empty document', () => {
    expect(normalizeDocsText('').text).toBe('');
    expect(normalizeDocsText(DOCS_SENTINEL).text).toBe('');
    expect(normalizeDocsText(`${DOCS_SENTINEL}\n`).text).toBe('');
    expect(normalizeDocsText('\n').text).toBe('');
    const m = normalizeDocsText(`${DOCS_SENTINEL}\n`);
    expect(m.leading).toBe(1);
    expect(m.trailing).toBe(1);
    expect(m.toRaw(0)).toBe(1);
    expect(m.fromRaw(1)).toBe(0);
  });

  it('strips only one trailing newline and keeps interior paragraph breaks', () => {
    const m = normalizeDocsText(`${DOCS_SENTINEL}a\nb\n\n`);
    expect(m.text).toBe('a\nb\n');
  });

  it('strips only one sentinel', () => {
    expect(normalizeDocsText(`${DOCS_SENTINEL}${DOCS_SENTINEL}x`).text).toBe(`${DOCS_SENTINEL}x`);
  });

  it('round-trips every body offset through toRaw/fromRaw', () => {
    const raw = `${DOCS_SENTINEL}The quick\nbrown fox\n`;
    const m = normalizeDocsText(raw);
    for (let r = 1; r <= raw.length - 1; r++) expect(m.toRaw(m.fromRaw(r))).toBe(r);
    for (let o = 0; o <= m.text.length; o++) expect(m.fromRaw(m.toRaw(o))).toBe(o);
    expect(m.toRaw(0)).toBe(1);
    expect(m.toRaw(m.text.length)).toBe(raw.length - 1);
    expect(raw.slice(m.toRaw(4), m.toRaw(9))).toBe('quick');
  });

  it('clamps offsets outside the body', () => {
    const m = normalizeDocsText(`${DOCS_SENTINEL}abc\n`);
    expect(m.toRaw(-5)).toBe(1);
    expect(m.toRaw(99)).toBe(4);
    expect(m.fromRaw(0)).toBe(0);
    expect(m.fromRaw(99)).toBe(3);
    expect(m.toRaw(1.7)).toBe(2);
  });
});

describe('NBSP helpers', () => {
  it('normalizes NBSP to spaces without changing length', () => {
    expect(normalizeNbsp(`a${NBSP}b`)).toBe('a b');
    expect(normalizeNbsp(`a${NBSP}b`).length).toBe(3);
  });

  it('compares texts NBSP-insensitively', () => {
    expect(docsTextsEquivalent(`x${NBSP}y`, 'x y')).toBe(true);
    expect(docsTextsEquivalent('x y', 'x  y')).toBe(false);
    expect(docsTextsEquivalent('same', 'same')).toBe(true);
  });
});

describe('toPastePayload', () => {
  it('converts leading and trailing ASCII spaces to NBSP and keeps interior spaces', () => {
    expect(toPastePayload('  a b ')).toBe(`${NBSP}${NBSP}a b${NBSP}`);
  });

  it('converts an all-space payload entirely', () => {
    expect(toPastePayload('   ')).toBe(NBSP.repeat(3));
  });

  it('leaves payloads without edge spaces alone', () => {
    expect(toPastePayload('tomorrow')).toBe('tomorrow');
    expect(toPastePayload('')).toBe('');
  });
});

describe('planDocsEdit', () => {
  const raw = `${DOCS_SENTINEL}The meeting is tomorow at noon.\nWe will discuss the the budget.\n`;

  it('plans a replacement as a direct paste over the range', () => {
    const start = raw.indexOf('tomorow');
    const plan = planDocsEdit(raw, start, start + 'tomorow'.length, 'tomorrow');
    expect(plan).toEqual({
      selStart: start,
      selEnd: start + 7,
      payload: 'tomorrow',
      expected: raw.replace('tomorow', 'tomorrow'),
      strategy: 'replace',
    });
  });

  it('sends edge spaces of a replacement as NBSP', () => {
    const start = raw.indexOf(' at ');
    const plan = planDocsEdit(raw, start, start + 4, ' at ');
    expect(plan?.payload).toBe(`${NBSP}at${NBSP}`);
    expect(plan?.expected).toBe(raw);
  });

  it('carries a deletion with the character after the range', () => {
    const start = raw.indexOf('the the');
    const plan = planDocsEdit(raw, start, start + 4, ''); // delete "the " → next char is 't'
    expect(plan?.strategy).toBe('delete-right');
    expect(plan?.selStart).toBe(start);
    expect(plan?.selEnd).toBe(start + 5);
    expect(plan?.payload).toBe('t');
    expect(plan?.expected).toBe(raw.replace('the the', 'the'));
  });

  it('pastes NBSP when the borrowed neighbour is a space', () => {
    const start = raw.indexOf(' the budget');
    const plan = planDocsEdit(raw, start, start + 4, ''); // delete " the" → next char is ' '
    expect(plan?.strategy).toBe('delete-right');
    expect(plan?.payload).toBe(NBSP);
    expect(plan?.expected).toBe(raw.replace(' the the ', ' the '));
  });

  it('falls back to the character before the range at a paragraph end', () => {
    const start = raw.indexOf(' at noon.');
    const end = start + ' at noon.'.length; // followed by "\n"
    const plan = planDocsEdit(raw, start, end, '');
    expect(plan?.strategy).toBe('delete-left');
    expect(plan?.selStart).toBe(start - 1);
    expect(plan?.selEnd).toBe(end);
    expect(plan?.payload).toBe('w'); // last letter of "tomorow"
    expect(plan?.expected).toBe(raw.replace(' at noon.', ''));
  });

  it('falls back to the left neighbour at the end of the document body', () => {
    const start = raw.lastIndexOf(' budget.');
    const end = start + ' budget.'.length; // followed by the trailing "\n"
    const plan = planDocsEdit(raw, start, end, '');
    expect(plan?.strategy).toBe('delete-left');
    expect(plan?.payload).toBe('e');
  });

  it('refuses a deletion with no carrier character (whole paragraph between breaks)', () => {
    const r = `${DOCS_SENTINEL}a\nmiddle\nz\n`;
    const start = r.indexOf('middle');
    expect(planDocsEdit(r, start, start + 6, '')).toBeNull();
    expect(planDocsEdit(`${DOCS_SENTINEL}only\n`, 1, 5, '')).toBeNull();
  });

  it('keeps surrogate pairs whole when borrowing a neighbour', () => {
    const r = `${DOCS_SENTINEL}ab😀cd\n`;
    const right = planDocsEdit(r, 1, 3, ''); // delete "ab", next is the emoji
    expect(right?.payload).toBe('😀');
    expect(right?.selEnd).toBe(5);
    const left = planDocsEdit(r, 5, 7, ''); // delete "cd": right neighbour is "\n" → left is the emoji
    expect(left?.strategy).toBe('delete-left');
    expect(left?.payload).toBe('😀');
    expect(left?.selStart).toBe(3);
  });

  it('returns null for invalid ranges', () => {
    expect(planDocsEdit(raw, -1, 2, 'x')).toBeNull();
    expect(planDocsEdit(raw, 5, 2, 'x')).toBeNull();
    expect(planDocsEdit(raw, 0, raw.length + 1, 'x')).toBeNull();
    expect(planDocsEdit(raw, 1.5, 3, 'x')).toBeNull();
  });

  it('plans an insertion (empty range, non-empty replacement) as a paste at the caret', () => {
    const plan = planDocsEdit(raw, 5, 5, 'X');
    expect(plan?.strategy).toBe('replace');
    expect(plan?.selStart).toBe(5);
    expect(plan?.selEnd).toBe(5);
    expect(plan?.expected).toBe(raw.slice(0, 5) + 'X' + raw.slice(5));
  });
});

describe('gdocsDocumentId', () => {
  it('extracts the id from /document/d/<id>/edit', () => {
    expect(gdocsDocumentId('/document/d/1AbC_dEf-9/edit')).toBe('1AbC_dEf-9');
  });
  it('handles the /u/<n>/ account prefix', () => {
    expect(gdocsDocumentId('/document/u/1/d/XYZ/edit')).toBe('XYZ');
  });
  it('returns "" for other paths', () => {
    expect(gdocsDocumentId('/spreadsheets/d/1/edit')).toBe('');
    expect(gdocsDocumentId('/document/')).toBe('');
    expect(gdocsDocumentId('')).toBe('');
  });
});
