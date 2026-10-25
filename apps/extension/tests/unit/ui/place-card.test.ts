import { describe, expect, it } from 'vitest';
import { placeCard } from '../../../src/content/ui/overlay-api';
import { placeAbove } from '../../../src/content/ui/menu';
import { BUTTON_INSET, BUTTON_SIZE, computeButtonPosition } from '../../../src/content/ui/button';

const vp = { width: 1000, height: 800 };
const card = { width: 320, height: 160 };

function anchor(left: number, top: number, width = 60, height = 18): DOMRect {
  return new DOMRect(left, top, width, height);
}

describe('placeCard', () => {
  it('places the card 8 px below the anchor, left-aligned', () => {
    const p = placeCard(anchor(100, 100), card, vp);
    expect(p).toEqual({ top: 118 + 8, left: 100, placement: 'below' });
  });

  it('flips above when the card would overflow the bottom and there is room above', () => {
    const p = placeCard(anchor(100, 700), card, vp);
    expect(p.placement).toBe('above');
    expect(p.top).toBe(700 - 8 - 160);
  });

  it('clamps to the viewport with an 8 px margin when neither side fits', () => {
    const small = { width: 400, height: 300 };
    const p = placeCard(anchor(100, 120), card, small);
    expect(p.placement).toBe('below'); // not enough room above either (120 - 8 - 160 < 8)
    expect(p.top).toBe(300 - 160 - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it('clamps horizontally on both sides', () => {
    expect(placeCard(anchor(900, 100), card, vp).left).toBe(1000 - 320 - 8);
    expect(placeCard(anchor(-40, 100), card, vp).left).toBe(8);
  });
});

describe('placeAbove (menu)', () => {
  it('prefers above, right-aligned to the anchor', () => {
    const a = { left: 500, top: 600, right: 528, bottom: 628, width: 28, height: 28 };
    const p = placeAbove(a, { width: 260, height: 300 }, vp);
    expect(p.placement).toBe('above');
    expect(p.top).toBe(600 - 8 - 300);
    expect(p.left).toBe(528 - 260);
  });

  it('flips below when there is no room above and clamps', () => {
    const a = { left: 10, top: 20, right: 38, bottom: 48, width: 28, height: 28 };
    const p = placeAbove(a, { width: 260, height: 300 }, vp);
    expect(p.placement).toBe('below');
    expect(p.top).toBe(48 + 8);
    expect(p.left).toBe(8);
  });
});

describe('computeButtonPosition', () => {
  it('sits inside the bottom-right corner (inset 8 px) for fields at least 40 px tall', () => {
    const box = { left: 50, top: 50, right: 550, bottom: 250, width: 500, height: 200 };
    const p = computeButtonPosition(box, vp);
    expect(p).toEqual({ left: 550 - BUTTON_INSET - BUTTON_SIZE, top: 250 - BUTTON_INSET - BUTTON_SIZE, anchor: 'inside', visible: true });
  });

  it('sits just outside the bottom-right corner for a 24 px chat prompt box', () => {
    const box = { left: 50, top: 500, right: 550, bottom: 524, width: 500, height: 24 };
    const p = computeButtonPosition(box, vp);
    expect(p.anchor).toBe('right');
    expect(p.left).toBe(550 + 4);
    expect(p.top).toBe(524 - BUTTON_SIZE);
    expect(p.visible).toBe(true);
  });

  it('falls back below (or above) the corner when the small field reaches the viewport edge', () => {
    const wide = { left: 0, top: 500, right: 1000, bottom: 524, width: 1000, height: 24 };
    const below = computeButtonPosition(wide, vp);
    expect(below.anchor).toBe('below');
    expect(below.top).toBe(524 + 4);
    const atBottom = { left: 0, top: 770, right: 1000, bottom: 794, width: 1000, height: 24 };
    const above = computeButtonPosition(atBottom, vp);
    expect(above.anchor).toBe('above');
    expect(above.top).toBe(770 - 4 - BUTTON_SIZE);
  });

  it('reports visible=false when the field is off-screen', () => {
    const box = { left: 50, top: -300, right: 550, bottom: -100, width: 500, height: 200 };
    expect(computeButtonPosition(box, vp).visible).toBe(false);
  });
});
