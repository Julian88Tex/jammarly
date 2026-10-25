import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_TAG, HOVER_INTENT_MS, LEAVE_GRACE_MS } from '../../../src/content/ui/overlay';
import { CHUNK_SIZE, UnderlineLayer, isRectVisible, planFragments, pointInRect, sortBySpanLength, zIndexForLength } from '../../../src/content/ui/underlines';
import { CATEGORY_PATTERNS } from '../../../src/content/ui/overlay-api';
import { FAKE_TIMER_APIS, cardOpen, click, fakeAdapter, harness, item, makeSuggestion, opts, pointerDown, pointerMove, rect, type Harness } from './helpers';

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  h = harness();
});

afterEach(() => {
  h.overlay.dispose();
  vi.useRealTimers();
  for (const el of Array.from(document.querySelectorAll(HOST_TAG))) el.remove();
  document.body.textContent = '';
});

const S1 = makeSuggestion({ id: 's1', category: 'correctness', range: { start: 0, end: 3 } });
const S2 = makeSuggestion({ id: 's2', category: 'clarity', kind: 'replace', range: { start: 10, end: 40 }, original: 'in order to', replacement: 'to' });
const S3 = makeSuggestion({ id: 's3', category: 'engagement', range: { start: 50, end: 55 } });
const S4 = makeSuggestion({ id: 's4', category: 'delivery', range: { start: 60, end: 70 } });

describe('underline rendering', () => {
  it('draws one 2 px div per rect fragment with category and suggestion data', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([
      item(S1, rect(100, 100, 30, 18)),
      item(S2, rect(200, 100, 120, 18), rect(10, 120, 40, 18)),
      item(S3, rect(300, 140, 40, 18)),
      item(S4, rect(400, 140, 40, 18)),
    ]);
    const frags = h.qAll<HTMLDivElement>('[data-jm="underline"]');
    expect(frags.length).toBe(5);
    const s1 = frags.find((el) => el.dataset.suggestionId === 's1')!;
    expect(s1.dataset.category).toBe('correctness');
    expect(s1.style.height).toBe('');
    expect(s1.style.left).toBe('100px');
    expect(s1.style.width).toBe('30px');
    // bottom-aligned: top = rect.bottom - 2
    expect(s1.style.top).toBe(`${118 - 2}px`);
    const cats = new Set(frags.map((el) => el.dataset.category));
    expect(cats).toEqual(new Set(['correctness', 'clarity', 'engagement', 'delivery']));
    for (const el of frags) expect(el.dataset.pattern).toBe(CATEGORY_PATTERNS[el.dataset.category as keyof typeof CATEGORY_PATTERNS]);
    expect(h.debug().underlines).toBe(5);
  });

  it('orders longer spans below shorter ones (DOM order and z-index)', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18)), item(S2, rect(90, 100, 200, 18))]);
    const frags = h.qAll<HTMLDivElement>('[data-jm="underline"]');
    expect(frags[0]!.dataset.suggestionId).toBe('s2'); // 30 chars, drawn first = below
    expect(frags[1]!.dataset.suggestionId).toBe('s1');
    expect(Number(frags[1]!.style.zIndex)).toBeGreaterThan(Number(frags[0]!.style.zIndex));
    expect(zIndexForLength(3)).toBeGreaterThan(zIndexForLength(30));
    expect(sortBySpanLength([item(S1), item(S2)]).map((i) => i.suggestion.id)).toEqual(['s2', 's1']);
  });

  it('hides fragments outside the viewport', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18), rect(100, -50, 30, 18), rect(100, window.innerHeight + 10, 30, 18), rect(-80, 100, 30, 18))]);
    const frags = h.qAll<HTMLDivElement>('[data-jm="underline"]');
    expect(frags.length).toBe(4);
    expect(frags.filter((el) => el.hasAttribute('hidden')).length).toBe(3);
    expect(h.debug().visibleUnderlines).toBe(1);
    expect(isRectVisible({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }, { width: 100, height: 100 })).toBe(true);
    expect(isRectVisible({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, { width: 100, height: 100 })).toBe(false);
  });

  it('updateRects moves fragments and showUnderlines=false hides the layer', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18))]);
    f.updateRects([item(S1, rect(130, 200, 30, 18))]);
    const frag = h.q<HTMLDivElement>('[data-jm="underline"]');
    expect(frag.style.left).toBe('130px');
    expect(frag.style.top).toBe(`${218 - 2}px`);
    h.overlay.setOptions({ showUnderlines: false });
    expect(h.qAll('[data-jm="underline"]').length).toBe(0);
    h.overlay.setOptions({ showUnderlines: true });
    expect(h.qAll('[data-jm="underline"]').length).toBe(1);
  });

  it('chunks a re-layout of more than ~200 fragments across animation frames', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    const rects: DOMRect[] = [];
    for (let i = 0; i < CHUNK_SIZE + 50; i++) rects.push(rect(10, 10 + i, 20, 5));
    f.setUnderlines([item(S1, ...rects)]);
    const frags = h.qAll<HTMLDivElement>('[data-jm="underline"]');
    expect(frags.length).toBe(CHUNK_SIZE + 50);
    expect(frags[0]!.dataset.suggestionId).toBe('s1');
    expect(frags[CHUNK_SIZE - 1]!.dataset.suggestionId).toBe('s1');
    expect(frags[CHUNK_SIZE]!.dataset.suggestionId).toBeUndefined(); // not yet laid out
    vi.advanceTimersByTime(40); // one rAF
    expect(frags[CHUNK_SIZE]!.dataset.suggestionId).toBe('s1');
    expect(frags[CHUNK_SIZE + 49]!.dataset.suggestionId).toBe('s1');
  });

  it('pure helpers: planFragments and pointInRect', () => {
    const plan = planFragments([item(S1, rect(0, 0, 10, 10), rect(0, 20, 10, 10)), item(S2, rect(0, 40, 10, 10))]);
    expect(plan.map((p) => p.suggestionId)).toEqual(['s2', 's1', 's1']);
    expect(pointInRect(5, 5, { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })).toBe(true);
    expect(pointInRect(5, 11.5, { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })).toBe(true); // 2 px slop
    expect(pointInRect(5, 13, { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })).toBe(false);
    expect(pointInRect(11, 5, { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })).toBe(false);
  });

  it('UnderlineLayer.hitTest returns the topmost (shortest) suggestion', () => {
    const parent = document.createElement('div');
    const layer = new UnderlineLayer(parent, 'x');
    layer.setItems([item(S1, rect(100, 100, 30, 18)), item(S2, rect(90, 100, 200, 18))]);
    expect(layer.hitTest(110, 110)).toBe('s1');
    expect(layer.hitTest(250, 110)).toBe('s2');
    expect(layer.hitTest(5, 5)).toBeNull();
    expect(layer.rectsFor('s2').length).toBe(1);
    layer.dispose();
    expect(parent.children.length).toBe(0);
  });
});

describe('hover intent and grace', () => {
  it('pointermove over a fragment sets the hover state and opens the card after 100 ms', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18)), item(S2, rect(200, 100, 120, 18))]);
    pointerMove(110, 110);
    const frag = h.qAll<HTMLDivElement>('[data-jm="underline"]').find((el) => el.dataset.suggestionId === 's1')!;
    expect(frag.classList.contains('jm-ul-active')).toBe(true);
    expect(frag.style.top).toBe(`${118 - 3}px`); // 3 px while active
    expect(h.qAll('[data-jm="underline-tint"]').length).toBe(1);
    expect(h.debug().hoverSuggestionId).toBe('s1');
    expect(cardOpen(h)).toBe(false);
    vi.advanceTimersByTime(HOVER_INTENT_MS - 1);
    expect(cardOpen(h)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cardOpen(h)).toBe(true);
    expect(h.q('[data-jm="card"]').dataset.suggestionId).toBe('s1');
    expect(h.events.onCardShown).toHaveBeenCalledWith('f1', 's1');
  });

  it('leaving before the intent delay never opens the card', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18))]);
    pointerMove(110, 110);
    vi.advanceTimersByTime(50);
    pointerMove(500, 500);
    vi.advanceTimersByTime(500);
    expect(cardOpen(h)).toBe(false);
    const frag = h.q<HTMLDivElement>('[data-jm="underline"]');
    expect(frag.classList.contains('jm-ul-active')).toBe(false);
    expect(h.qAll('[data-jm="underline-tint"]').length).toBe(0);
  });

  it('closes after the 250 ms grace once the pointer leaves, unless it enters the card', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18))]);
    pointerMove(110, 110);
    vi.advanceTimersByTime(HOVER_INTENT_MS);
    expect(cardOpen(h)).toBe(true);
    pointerMove(600, 600);
    vi.advanceTimersByTime(LEAVE_GRACE_MS - 1);
    expect(cardOpen(h)).toBe(true);
    // pointer enters the card within the grace period: stays open
    const card = h.q('[data-jm="card"]');
    card.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, composed: true }));
    pointerMove(5, 5, card);
    vi.advanceTimersByTime(1000);
    expect(cardOpen(h)).toBe(true);
    // leaves the card for good
    card.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, composed: true }));
    pointerMove(600, 600);
    vi.advanceTimersByTime(LEAVE_GRACE_MS);
    expect(cardOpen(h)).toBe(false);
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's1');
  });

  it('clicking a fragment opens the card immediately; clicking outside closes it', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18)), item(S2, rect(200, 100, 120, 18))]);
    pointerDown(110, 110);
    expect(cardOpen(h)).toBe(true);
    expect(h.q('[data-jm="card"]').dataset.suggestionId).toBe('s1');
    click(250, 110);
    expect(h.q('[data-jm="card"]').dataset.suggestionId).toBe('s2');
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's1');
    expect(h.events.onCardShown).toHaveBeenCalledWith('f1', 's2');
    pointerDown(700, 700);
    expect(cardOpen(h)).toBe(false);
  });

  it('a hovered suggestion that disappears from the set clears the hover and closes its card', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18))]);
    pointerDown(110, 110);
    expect(cardOpen(h)).toBe(true);
    f.setUnderlines([]);
    expect(cardOpen(h)).toBe(false);
    expect(h.debug().hoverSuggestionId).toBeNull();
  });

  it('setTyping(true) hides the card; the controller closing the card clears the active state', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18))]);
    f.openCard('s1', rect(100, 100, 30, 18));
    expect(cardOpen(h)).toBe(true);
    expect(h.q<HTMLDivElement>('[data-jm="underline"]').classList.contains('jm-ul-active')).toBe(true);
    f.setTyping(true);
    expect(cardOpen(h)).toBe(false);
    f.openCard('s1', rect(100, 100, 30, 18));
    f.closeCard();
    expect(cardOpen(h)).toBe(false);
    expect(h.q<HTMLDivElement>('[data-jm="underline"]').classList.contains('jm-ul-active')).toBe(false);
  });

  it('Escape typed in the page closes the card without claiming the key', () => {
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(S1, rect(100, 100, 30, 18))]);
    f.openCard('s1', rect(100, 100, 30, 18));
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(cardOpen(h)).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });
});
