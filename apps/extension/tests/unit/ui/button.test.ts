import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_TAG } from '../../../src/content/ui/overlay';
import { BUTTON_SIZE, EXPAND_DELAY_MS, FloatingButton, errorPresentation, formatCount, toneChipText } from '../../../src/content/ui/button';
import type { CheckError } from '@jammarly/shared/types';
import { FAKE_TIMER_APIS, fakeAdapter, harness, opts, rect, text, type Harness } from './helpers';
import type { FieldOverlay } from '../../../src/content/ui/overlay-api';

let h: Harness;
let f: FieldOverlay;
const counts0 = { grammar: 0, style: 0, rewrites: 0 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  h = harness();
  f = h.overlay.attach('f1', fakeAdapter(rect(50, 50, 500, 200)), opts());
});

afterEach(() => {
  h.overlay.dispose();
  vi.useRealTimers();
  for (const el of Array.from(document.querySelectorAll(HOST_TAG))) el.remove();
  document.body.textContent = '';
});

function btn(): HTMLButtonElement {
  return h.q<HTMLButtonElement>('[data-jm="button"]');
}

describe('floating button states', () => {
  it('starts idle with the J glyph and brand tooltip, positioned inside the field corner', () => {
    expect(btn().dataset.state).toBe('idle');
    expect(btn().querySelector('[data-icon="j"]')).not.toBeNull();
    expect(btn().title).toBe('Jammarly');
    const wrap = h.q('[data-jm="button-wrap"]');
    expect(wrap.hasAttribute('hidden')).toBe(false);
    expect(wrap.dataset.anchor).toBe('inside');
    // wrap's right edge = button right edge (+2 px padding) and the box is 50..550 x 50..250
    expect(wrap.style.left).toBe(`${550 - 8 - BUTTON_SIZE + BUTTON_SIZE + 2}px`);
    expect(wrap.style.top).toBe(`${250 - 8 - BUTTON_SIZE - 2}px`);
  });

  it('setup: gray disc with a dot, tooltip "Finish setting up Jammarly", click opens setup instead of the menu', () => {
    f.setStatus('setup', counts0, 'rules');
    expect(btn().dataset.state).toBe('setup');
    expect(btn().title).toBe('Finish setting up Jammarly');
    expect(btn().querySelector('[data-icon="dot"]')).not.toBeNull();
    btn().click();
    expect(h.events.onOpenSetup).toHaveBeenCalledWith('f1');
    expect(h.debug().menuOpen).toBe(false);
  });

  it('checking shows the spinner, count shows the number (99+ cap), clean shows a check', () => {
    f.setStatus('checking', counts0, 'rules');
    expect(btn().dataset.state).toBe('checking');
    expect(btn().querySelector('[data-icon="spinner"]')).not.toBeNull();
    f.setStatus('suggestions', { grammar: 2, style: 1, rewrites: 1 }, 'fast');
    expect(btn().dataset.state).toBe('count');
    expect(text(btn().querySelector('[data-jm="count"]'))).toBe('4');
    expect(btn().title).toBe('4 suggestions');
    expect(btn().dataset.checkedBy).toBe('fast');
    f.setStatus('suggestions', { grammar: 120, style: 0, rewrites: 0 }, 'deep');
    expect(text(btn().querySelector('[data-jm="count"]'))).toBe('99+');
    f.setStatus('clean', counts0, 'deep');
    expect(btn().dataset.state).toBe('clean');
    expect(btn().querySelector('[data-icon="check"]')).not.toBeNull();
    expect(formatCount(99)).toBe('99');
    expect(formatCount(100)).toBe('99+');
  });

  it('off and unsupported are gray with their glyphs and tooltips', () => {
    f.setStatus('off', counts0, 'rules');
    expect(btn().dataset.state).toBe('off');
    expect(btn().title).toBe('Jammarly is off here');
    f.setUnsupported('This site opted out of writing suggestions');
    expect(btn().dataset.state).toBe('unsupported');
    expect(btn().querySelector('[data-icon="slash"]')).not.toBeNull();
    expect(btn().title).toBe('This site opted out of writing suggestions');
    // a later setStatus('unsupported') keeps the reason
    f.setStatus('unsupported', counts0, 'rules');
    expect(btn().title).toBe('This site opted out of writing suggestions');
  });

  it('error glyph and tooltip follow the CheckError code', () => {
    const cases: [CheckError['code'], string, string][] = [
      ['auth', 'key', 'Check your API key'],
      ['rate-limit', 'hourglass', 'Rate limited, retrying'],
      ['spend-cap', 'wallet', 'Anthropic spend cap reached'],
      ['budget', 'wallet', 'Daily budget reached, Haiku only until midnight'],
      ['network', 'wifi-off', 'Offline'],
      ['unknown', 'warning', 'Something odd happened'],
    ];
    for (const [code, icon, tooltip] of cases) {
      f.setStatus('error', counts0, 'rules', { code, message: 'Something odd happened', retryable: false });
      expect(btn().dataset.state).toBe('error');
      expect(btn().dataset.errorCode).toBe(code);
      expect(btn().querySelector(`[data-icon="${icon}"]`), code).not.toBeNull();
      expect(btn().title, code).toBe(tooltip);
    }
    expect(errorPresentation(undefined)).toEqual({ icon: 'warning', tooltip: 'Something went wrong' });
    expect(errorPresentation({ code: 'unknown', message: '  ', retryable: false }).tooltip).toBe('Something went wrong');
  });

  it('collapses to a dot while typing and expands 600 ms after typing stops', () => {
    f.setStatus('suggestions', { grammar: 3, style: 0, rewrites: 0 }, 'fast');
    f.setTyping(true);
    expect(btn().dataset.state).toBe('collapsed');
    expect(btn().querySelector('[data-jm="count"]')).toBeNull();
    f.setStatus('suggestions', { grammar: 4, style: 0, rewrites: 0 }, 'fast'); // stays collapsed
    expect(btn().dataset.state).toBe('collapsed');
    f.setTyping(false);
    vi.advanceTimersByTime(EXPAND_DELAY_MS - 1);
    expect(btn().dataset.state).toBe('collapsed');
    f.setTyping(true); // typing resumed: timer reset
    f.setTyping(false);
    vi.advanceTimersByTime(EXPAND_DELAY_MS - 1);
    expect(btn().dataset.state).toBe('collapsed');
    vi.advanceTimersByTime(1);
    expect(btn().dataset.state).toBe('count');
    expect(text(btn().querySelector('[data-jm="count"]'))).toBe('4');
  });

  it('follows setFieldBox, anchors outside small fields and hides off-screen fields', () => {
    f.setFieldBox(rect(50, 500, 500, 24));
    const wrap = h.q('[data-jm="button-wrap"]');
    expect(wrap.dataset.anchor).toBe('right');
    expect(wrap.hasAttribute('hidden')).toBe(false);
    f.setFieldBox(rect(50, -500, 500, 200));
    expect(wrap.hasAttribute('hidden')).toBe(true);
    f.setFieldBox(rect(50, 50, 500, 200));
    expect(wrap.hasAttribute('hidden')).toBe(false);
    h.overlay.setOptions({ showFloatingButton: false });
    expect(wrap.hasAttribute('hidden')).toBe(true);
  });

  it('shows the tone chip only from 150 characters, with TONE_EMOJI or the fallback', () => {
    const chip = h.q('[data-jm="tone"]');
    f.setTone({ labels: [{ label: 'confident', strength: 'moderate' }], summary: 'Sounds confident.' }, 120);
    expect(chip.hidden).toBe(true);
    f.setTone({ labels: [{ label: 'confident', strength: 'moderate' }], summary: 'Sounds confident.' }, 150);
    expect(chip.hidden).toBe(false);
    expect(text(chip)).toBe('🤝 Confident');
    expect(chip.title).toBe('Sounds confident.');
    f.setTone({ labels: [{ label: 'mysterious', strength: 'slight' }], summary: '' }, 400);
    expect(text(chip)).toBe('💬 Mysterious');
    f.setTone(undefined, 400);
    expect(chip.hidden).toBe(true);
    expect(toneChipText({ labels: [], summary: '' })).toBeNull();
  });

  it('hover reveals a power button whose menu turns the field off for the session or forever', () => {
    const wrap = h.q('[data-jm="button-wrap"]');
    wrap.dispatchEvent(new PointerEvent('pointerenter'));
    expect(wrap.classList.contains('jm-hover')).toBe(true);
    const power = h.q<HTMLButtonElement>('[data-jm="power"]');
    power.click();
    const menu = h.q('[data-jm="power-menu"]');
    expect(menu.hidden).toBe(false);
    const items = h.qAll<HTMLButtonElement>('[data-jm="power-item"]');
    expect(items.map((i) => text(i))).toEqual(['Turn off in this field until next visit', 'Turn off in this field forever']);
    items[0]!.click();
    expect(h.events.onToggleField).toHaveBeenCalledWith('f1', false, 'session');
    expect(menu.hidden).toBe(true);
    power.click();
    items[1]!.click();
    expect(h.events.onToggleField).toHaveBeenCalledWith('f1', false, 'forever');
    wrap.dispatchEvent(new PointerEvent('pointerleave'));
    expect(wrap.classList.contains('jm-hover')).toBe(false);
  });

  it('click opens the accept-all menu (and toggles it closed)', () => {
    f.setStatus('suggestions', { grammar: 1, style: 0, rewrites: 0 }, 'fast');
    btn().click();
    expect(h.debug().menuOpen).toBe(true);
    btn().click();
    expect(h.debug().menuOpen).toBe(false);
  });

  it('FloatingButton can be driven directly', () => {
    const parent = document.createElement('div');
    const cb = { onClick: vi.fn(), onOpenSetup: vi.fn(), onToggleField: vi.fn() };
    const b = new FloatingButton(parent, 'x', cb);
    expect(b.state()).toBe('idle');
    b.setStatus('clean', counts0, 'deep');
    expect(b.state()).toBe('clean');
    b.setTyping(true);
    expect(b.state()).toBe('collapsed');
    b.button.click();
    expect(cb.onClick).toHaveBeenCalled();
    b.dispose();
    expect(parent.children.length).toBe(0);
  });
});
