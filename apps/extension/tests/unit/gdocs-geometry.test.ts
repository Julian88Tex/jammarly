import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY,
  RESYNC_MIN_CHARS,
  boxesForRange,
  buildLayoutIndex,
  charCountMeasure,
  collectTextRuns,
  composedTransform,
  mapRunsToText,
  matrixScale,
  multiply,
  parseTransform,
  rectsForRange,
  rectsJsonForRange,
  runBox,
  type TextRun,
} from '../../src/content/gdocs/geometry';
import { NBSP } from '../../src/content/gdocs/text';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface RunSpec {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  font?: string;
}

const mounted: Element[] = [];

/** Build `div.kix-canvas-tile-content > svg > g[transform] > rect…` like Docs does. */
function tile(runs: RunSpec[], transform = 'matrix(1,0,0,1,0,0)', parent: Element = document.body): HTMLElement {
  const div = document.createElement('div');
  div.className = 'kix-canvas-tile-content';
  const svg = document.createElementNS(SVG_NS, 'svg');
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', transform);
  for (const r of runs) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('aria-label', r.label);
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(r.w));
    rect.setAttribute('height', String(r.h));
    rect.setAttribute('fill', 'none');
    rect.setAttribute('data-font-css', r.font ?? '400 16px monospace');
    g.appendChild(rect);
  }
  svg.appendChild(g);
  div.appendChild(svg);
  parent.appendChild(div);
  mounted.push(div);
  return div;
}

function run(text: string, left: number, top: number, width = text.length * 10, height = 20): TextRun {
  return { text, box: { left, top, width, height }, font: '400 16px monospace', scale: 1 };
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe('transforms', () => {
  it('parses matrix()', () => {
    expect(parseTransform('matrix(1.25,0,0,1.25,96,134)')).toEqual({ a: 1.25, b: 0, c: 0, d: 1.25, e: 96, f: 134 });
  });

  it('parses translate() and scale() with one or two arguments', () => {
    expect(parseTransform('translate(10)')).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
    expect(parseTransform('translate(10, 20)')).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
    expect(parseTransform('scale(2)')).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    expect(parseTransform('scale(2 3)')).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
  });

  it('composes a transform list left to right (translate then scale)', () => {
    const m = parseTransform('translate(100, 50) scale(2)');
    // point (1,1): scale first → (2,2), then translate → (102, 52)
    expect(m.a * 1 + m.c * 1 + m.e).toBe(102);
    expect(m.b * 1 + m.d * 1 + m.f).toBe(52);
  });

  it('returns the identity for empty, null or malformed input', () => {
    expect(parseTransform(null)).toEqual(IDENTITY);
    expect(parseTransform('')).toEqual(IDENTITY);
    expect(parseTransform('rotate(45)')).toEqual(IDENTITY);
    expect(parseTransform('matrix(1,2,3)')).toEqual(IDENTITY);
    expect(parseTransform('matrix(a,b,c,d,e,f)')).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
  });

  it('multiplies outer · inner', () => {
    const translate = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 };
    const scale = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    expect(multiply(translate, scale)).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 5, f: 7 });
    expect(multiply(scale, translate)).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 14 });
  });

  it('reads the zoom scale from the matrix', () => {
    expect(matrixScale(parseTransform('matrix(1.25,0,0,1.25,0,0)'))).toBe(1.25);
    expect(matrixScale(IDENTITY)).toBe(1);
    expect(matrixScale({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBe(1);
  });
});

describe('runBox', () => {
  it('translates by the svg origin under the identity', () => {
    expect(runBox({ x: 10, y: 20, width: 100, height: 15 }, IDENTITY, { left: 300, top: 400 })).toEqual({ left: 310, top: 420, width: 100, height: 15 });
  });

  it('applies zoom and the group translation', () => {
    const m = parseTransform('matrix(1.25,0,0,1.25,96,134)');
    const b = runBox({ x: 8, y: 16, width: 80, height: 16 }, m, { left: 0, top: 0 });
    expect(b.left).toBeCloseTo(96 + 10);
    expect(b.top).toBeCloseTo(134 + 20);
    expect(b.width).toBeCloseTo(100);
    expect(b.height).toBeCloseTo(20);
  });

  it('bounds a rotated rect', () => {
    const rot90 = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }; // (x,y) → (-y, x)
    const b = runBox({ x: 0, y: 0, width: 40, height: 10 }, rot90, { left: 0, top: 0 });
    expect(b.left).toBeCloseTo(-10);
    expect(b.top).toBeCloseTo(0);
    expect(b.width).toBeCloseTo(10);
    expect(b.height).toBeCloseTo(40);
  });
});

describe('collectTextRuns', () => {
  it('reads runs in document order with their boxes, fonts and scale', () => {
    tile(
      [
        { label: 'This is pa', x: 0, y: 0, w: 100, h: 20, font: 'italic 400 14.6667px Arial' },
        { label: 'ragr', x: 100, y: 0, w: 40, h: 20 },
      ],
      'matrix(1.25,0,0,1.25,72,96)',
    );
    const runs = collectTextRuns(document, { origin: () => ({ left: 10, top: 20 }) });
    expect(runs.map((r) => r.text)).toEqual(['This is pa', 'ragr']);
    expect(runs[0]!.font).toBe('italic 400 14.6667px Arial');
    expect(runs[0]!.scale).toBe(1.25);
    expect(runs[0]!.box).toEqual({ left: 10 + 72, top: 20 + 96, width: 125, height: 25 });
    expect(runs[1]!.box.left).toBeCloseTo(10 + 72 + 125);
  });

  it('skips rects without aria-label and composes nested group transforms', () => {
    const div = tile([{ label: 'inner', x: 0, y: 0, w: 50, h: 10 }], 'translate(100, 0)');
    const g = div.querySelector('g')!;
    const g2 = document.createElementNS(SVG_NS, 'g');
    g2.setAttribute('transform', 'scale(2)');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '5');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '10');
    rect.setAttribute('height', '10');
    rect.setAttribute('aria-label', 'deep');
    g2.appendChild(rect);
    g.appendChild(g2);
    const bare = document.createElementNS(SVG_NS, 'rect');
    bare.setAttribute('x', '0');
    g.appendChild(bare);
    const runs = collectTextRuns(document, { origin: () => ({ left: 0, top: 0 }) });
    expect(runs.map((r) => r.text)).toEqual(['inner', 'deep']);
    expect(runs[1]!.box).toEqual({ left: 110, top: 0, width: 20, height: 20 });
    expect(runs[1]!.scale).toBe(2);
    expect(composedTransform(rect).e).toBe(100);
  });

  it('ignores rects outside a tile container and tolerates missing numeric attributes', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const g = document.createElementNS(SVG_NS, 'g');
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('aria-label', 'loose');
    g.appendChild(r);
    svg.appendChild(g);
    document.body.appendChild(svg);
    mounted.push(svg);
    tile([{ label: 'ok', x: 0, y: 0, w: 10, h: 10 }]);
    const inTile = document.querySelector('.kix-canvas-tile-content rect')!;
    inTile.removeAttribute('width');
    const runs = collectTextRuns(document, { origin: () => ({ left: 0, top: 0 }) });
    expect(runs.map((x) => x.text)).toEqual(['ok']);
    expect(runs[0]!.box.width).toBe(0);
  });
});

describe('mapRunsToText', () => {
  const text = 'This is paragraph one.\nThe meeting is tomorow at noon.';

  it('maps contiguous runs on one line', () => {
    const mapped = mapRunsToText([run('This is paragraph one.', 0, 0)], text);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ start: 0, end: 22 });
  });

  it('concatenates runs that split a word across tiles', () => {
    const mapped = mapRunsToText([run('This is pa', 0, 0), run('ragr', 100, 0), run('aph one.', 140, 0)], text);
    expect(mapped.map((m) => [m.start, m.end])).toEqual([
      [0, 10],
      [10, 14],
      [14, 22],
    ]);
  });

  it('bridges whitespace gaps: soft wraps and paragraph breaks', () => {
    const runs = [run('This is', 0, 0), run('paragraph one.', 0, 20), run('The meeting is', 0, 40), run('tomorow at noon.', 0, 60)];
    const mapped = mapRunsToText(runs, text);
    expect(mapped.map((m) => text.slice(m.start, m.end))).toEqual(['This is', 'paragraph one.', 'The meeting is', 'tomorow at noon.']);
  });

  it('is NBSP-insensitive in both directions', () => {
    const t = `a${NBSP}b c`;
    const mapped = mapRunsToText([run('a b', 0, 0), run(`c`, 40, 0)], t);
    expect(mapped.map((m) => [m.start, m.end])).toEqual([
      [0, 3],
      [4, 5],
    ]);
  });

  it('anchors on the first long run and maps short runs before it backwards', () => {
    const t = 'I am here. I think the meeting moved.';
    // visible tiles start at the second sentence; "I" alone would match offset 0 without the backward pass
    const mapped = mapRunsToText([run('I', 0, 0), run('think the', 20, 0), run('meeting moved.', 120, 0)], t);
    expect(mapped.map((m) => [m.start, m.end])).toEqual([
      [11, 12],
      [13, 22],
      [23, 37],
    ]);
  });

  it('drops runs it cannot place and keeps going', () => {
    const mapped = mapRunsToText([run('This is', 0, 0), run('NOTINTEXT', 80, 0), run('paragraph one.', 0, 20)], text);
    expect(mapped.map((m) => text.slice(m.start, m.end))).toEqual(['This is', 'paragraph one.']);
  });

  it('re-anchors after a non-whitespace gap only with a long enough run', () => {
    const t = 'alpha beta gamma delta epsilon';
    // "beta" was not rendered (missing tile); "gamma" is long enough to resync, a lone "d" after a gap is not
    const mapped = mapRunsToText([run('alpha', 0, 0), run('gamma', 60, 0), run('x', 200, 0)], t);
    expect(mapped.map((m) => t.slice(m.start, m.end))).toEqual(['alpha', 'gamma']);
    expect('gam'.length).toBeLessThan(RESYNC_MIN_CHARS);
    const short = mapRunsToText([run('alpha', 0, 0), run('gam', 60, 0)], 'alpha beta gam');
    expect(short.map((m) => m.start)).toEqual([0]);
  });

  it('ignores empty and whitespace-only runs and returns [] when nothing is mappable', () => {
    expect(mapRunsToText([run('', 0, 0), run('  ', 0, 0)], text)).toEqual([]);
    expect(mapRunsToText([], text)).toEqual([]);
    const mapped = mapRunsToText([run(' ', 0, 0), run('This is', 0, 0)], text);
    expect(mapped).toHaveLength(1);
  });

  it('resolves repeated words by document order', () => {
    const t = 'We will discuss the the budget.';
    const mapped = mapRunsToText([run('We will discuss the', 0, 0), run('the budget.', 0, 20)], t);
    expect(mapped.map((m) => [m.start, m.end])).toEqual([
      [0, 19],
      [20, 31],
    ]);
  });
});

describe('boxesForRange / rectsForRange', () => {
  const runs = mapRunsToText([run('This is pa', 0, 100), run('ragr', 100, 100), run('aph one.', 140, 100), run('Second line here.', 0, 130)], 'This is paragraph one.\nSecond line here.');

  it('returns the whole box for a fully covered run', () => {
    expect(boxesForRange(runs, 10, 14)).toEqual([{ left: 100, top: 100, width: 40, height: 20 }]);
  });

  it('slices partial runs proportionally and spans several runs', () => {
    const boxes = boxesForRange(runs, 8, 17); // "paragraph" = "pa" + "ragr" + "aph"
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toEqual({ left: 80, top: 100, width: 20, height: 20 });
    expect(boxes[1]).toEqual({ left: 100, top: 100, width: 40, height: 20 });
    expect(boxes[2]).toEqual({ left: 140, top: 100, width: 30, height: 20 });
  });

  it('uses the injected measurer for partial runs', () => {
    const wide = (text: string): number => text.replace(/[^a]/g, '').length * 2 + text.length; // 'a' counts triple
    const boxes = boxesForRange(runs, 8, 10, wide); // "pa" at the end of "This is pa"
    const total = wide('This is pa');
    expect(boxes[0]!.left).toBeCloseTo((100 * wide('This is ')) / total);
    expect(boxes[0]!.width).toBeCloseTo((100 * wide('pa')) / total);
  });

  it('returns nothing for empty or non-overlapping ranges', () => {
    expect(boxesForRange(runs, 5, 5)).toEqual([]);
    expect(boxesForRange(runs, 500, 600)).toEqual([]);
    expect(boxesForRange(runs, 10, 5)).toEqual([]);
  });

  it('merges the boxes of one line into one DOMRect and keeps lines apart', () => {
    const rects = rectsForRange(runs, 8, 17);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.left).toBe(80);
    expect(rects[0]!.right).toBe(170);
    expect(rects[0]!.top).toBe(100);
    expect(rects[0]!.height).toBe(20);
    const two = rectsForRange(runs, 15, 30); // "ph one." + "Second l"
    expect(two).toHaveLength(2);
    expect(two[0]!.top).toBe(100);
    expect(two[1]!.top).toBe(130);
    expect(two[1]!.left).toBe(0);
    expect(two[1]!.width).toBe(70);
  });

  it('exposes plain JSON rects for the RPC', () => {
    const json = rectsJsonForRange(runs, 10, 14, charCountMeasure);
    expect(json).toEqual([{ left: 100, top: 100, right: 140, bottom: 120, width: 40, height: 20 }]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('buildLayoutIndex (DOM end to end)', () => {
  it('collects, maps and measures runs from a Docs-like tile at 125 % zoom', () => {
    tile([{ label: 'This is pa', x: 0, y: 0, w: 100, h: 20 }], 'matrix(1.25,0,0,1.25,72,0)');
    tile(
      [
        { label: 'ragr', x: 100, y: 0, w: 40, h: 20 },
        { label: 'aph one.', x: 140, y: 0, w: 80, h: 20 },
      ],
      'matrix(1.25,0,0,1.25,72,0)',
    );
    const runs = buildLayoutIndex(document, 'This is paragraph one.', { origin: () => ({ left: 8, top: 16 }) });
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [0, 10],
      [10, 14],
      [14, 22],
    ]);
    const [rect] = rectsForRange(runs, 8, 17);
    expect(rect!.left).toBeCloseTo(8 + 72 + 100 * 1.25 * 0.8);
    expect(rect!.right).toBeCloseTo(8 + 72 + (140 + 30) * 1.25);
    expect(rect!.top).toBe(16);
    expect(rect!.height).toBe(25);
  });
});
