import { afterEach, describe, expect, it } from 'vitest';
import { createOverlay } from '../../../src/content/ui';
import { HOST_ATTR, HOST_TAG } from '../../../src/content/ui/overlay';
import { OVERLAY_CSS, applyStyles, resetStyleCache } from '../../../src/content/ui/styles';
import { CATEGORY_COLORS, CATEGORY_COLORS_COLORBLIND, CATEGORY_COLORS_DARK, INTERACTIVE_COLOR, INTERACTIVE_COLOR_DARK, BRAND_COLOR } from '../../../src/content/ui/overlay-api';
import { fakeAdapter, harness, makeSuggestion, item, opts, rect, spyEvents } from './helpers';

afterEach(() => {
  for (const el of Array.from(document.querySelectorAll(HOST_TAG))) el.remove();
  document.body.textContent = '';
});

describe('overlay host', () => {
  it('appends exactly one <jammarly-root> to <html> with an open shadow root and the marker attribute', () => {
    const h = harness();
    const hosts = document.querySelectorAll(HOST_TAG);
    expect(hosts.length).toBe(1);
    expect(hosts[0]!.parentElement).toBe(document.documentElement);
    expect(hosts[0]!.hasAttribute(HOST_ATTR)).toBe(true);
    expect(hosts[0]!.shadowRoot).not.toBeNull();
    expect(hosts[0]!.shadowRoot!.mode).toBe('open');
    expect(h.host.style.getPropertyValue('position')).toBe('fixed');
    expect(h.host.style.getPropertyPriority('position')).toBe('important');
    expect(h.host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(h.host.style.getPropertyValue('z-index')).toBe('2147483646');
    expect(['0', '0px']).toContain(h.host.style.getPropertyValue('inset'));
    h.overlay.dispose();
    expect(document.querySelectorAll(HOST_TAG).length).toBe(0);
  });

  it('keeps a single instance: a second createOverlay replaces the first host', () => {
    const first = createOverlay(spyEvents());
    const second = createOverlay(spyEvents());
    expect(document.querySelectorAll(HOST_TAG).length).toBe(1);
    // the stale host from an orphaned instance is also removed
    const orphan = document.createElement(HOST_TAG);
    document.documentElement.appendChild(orphan);
    const third = createOverlay(spyEvents());
    expect(document.querySelectorAll(HOST_TAG).length).toBe(1);
    expect(document.querySelector(HOST_TAG)).not.toBe(orphan);
    first.dispose();
    second.dispose();
    third.dispose();
  });

  it('applies styles through the inline <style> fallback when adoptedStyleSheets is unavailable (jsdom)', () => {
    const h = harness();
    const style = h.root.querySelector('style[data-jm="styles"]');
    expect(style).not.toBeNull();
    const css = style!.textContent ?? '';
    expect(css).toContain(':host');
    expect(css).toContain('all: initial');
    expect(css).toContain('color-scheme: light dark');
    expect(css).toContain(`--jm-correctness: ${CATEGORY_COLORS.correctness}`);
    expect(css).toContain(`--jm-clarity: ${CATEGORY_COLORS.clarity}`);
    expect(css).toContain(`--jm-engagement: ${CATEGORY_COLORS.engagement}`);
    expect(css).toContain(`--jm-delivery: ${CATEGORY_COLORS.delivery}`);
    expect(css).toContain(`--jm-brand: ${BRAND_COLOR}`);
    expect(css).toContain(`--jm-accent: ${INTERACTIVE_COLOR}`);
    expect(css).toContain(`--jm-correctness: ${CATEGORY_COLORS_DARK.correctness}`);
    expect(css).toContain(`--jm-accent: ${INTERACTIVE_COLOR_DARK}`);
    expect(css).toContain(`--jm-correctness: ${CATEGORY_COLORS_COLORBLIND.correctness}`);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('-apple-system');
    expect(css).toContain('"Segoe UI"');
    expect(css).toContain('border-radius: var(--jm-radius-card)');
    expect(css).toContain('--jm-radius-card: 8px');
    expect(css).toContain('--jm-radius-btn: 4px');
    expect(css).toContain('0 4px 16px rgba(0, 0, 0, .18)');
    expect(css).not.toContain('@font-face');
    expect(css).not.toMatch(/^\s*:root\b/m);
    expect(h.debug().styleMode).toBe('inline');
    h.overlay.dispose();
  });

  it('uses adoptedStyleSheets when the shadow root supports it', () => {
    resetStyleCache();
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const adopted: CSSStyleSheet[] = [];
    Object.defineProperty(root, 'adoptedStyleSheets', {
      get: () => adopted,
      set: (v: CSSStyleSheet[]) => {
        adopted.splice(0, adopted.length, ...v);
      },
      configurable: true,
    });
    const mode = applyStyles(root);
    expect(mode).toBe('adopted');
    expect(adopted.length).toBe(1);
    expect(root.querySelector('style')).toBeNull();
    expect(OVERLAY_CSS.length).toBeGreaterThan(1000);
    resetStyleCache();
  });

  it('attach is idempotent per fieldId and detach removes the field UI', () => {
    const h = harness();
    const a = h.overlay.attach('f1', fakeAdapter(), opts());
    const b = h.overlay.attach('f1', fakeAdapter(), opts());
    expect(a).toBe(b);
    expect(h.debug().fields).toBe(1);
    expect(h.qAll('[data-jm="button"]').length).toBe(1);
    h.overlay.attach('f2', fakeAdapter(), opts());
    expect(h.qAll('[data-jm="button"]').length).toBe(2);
    h.overlay.detach('f1');
    expect(h.qAll('[data-jm="button"]').length).toBe(1);
    expect(h.debug().fields).toBe(1);
    h.overlay.detach('f1'); // no-op
    h.overlay.dispose();
  });

  it('toggles colorblind mode on the host via theme options', () => {
    const h = harness();
    h.overlay.attach('f1', fakeAdapter(), opts({ theme: { colorblindMode: true } }));
    expect(h.host.classList.contains('jm-colorblind')).toBe(true);
    h.overlay.setOptions({ theme: { colorblindMode: false } });
    expect(h.host.classList.contains('jm-colorblind')).toBe(false);
    expect(h.debug().colorblind).toBe(false);
    h.overlay.dispose();
  });

  it('isInteracting reflects pointer and focus inside the overlay', () => {
    const h = harness();
    h.overlay.attach('f1', fakeAdapter(), opts());
    expect(h.overlay.isInteracting()).toBe(false);
    const button = h.q<HTMLButtonElement>('[data-jm="button"]');
    button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
    expect(h.overlay.isInteracting()).toBe(true);
    button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, composed: true, relatedTarget: document.body }));
    expect(h.overlay.isInteracting()).toBe(false);
    button.focus();
    expect(h.overlay.isInteracting()).toBe(true);
    button.blur();
    expect(h.overlay.isInteracting()).toBe(false);
    h.overlay.dispose();
  });

  it('__debug reports counts', () => {
    const h = harness();
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(makeSuggestion({ id: 's1' }), rect(10, 10, 50, 16), rect(10, 30, 20, 16))]);
    const d = h.debug();
    expect(d.hostCount).toBe(1);
    expect(d.fields).toBe(1);
    expect(d.underlines).toBe(2);
    expect(d.cardOpen).toBe(false);
    expect(d.menuOpen).toBe(false);
    expect(d.toasts).toBe(0);
    h.overlay.dispose();
  });

  it('interactive elements stop pointerdown/mousedown/click from reaching the page', () => {
    const h = harness();
    const f = h.overlay.attach('f1', fakeAdapter(), opts());
    f.setUnderlines([item(makeSuggestion({ id: 's1' }), rect(100, 100, 60, 18))]);
    f.openCard('s1', rect(100, 100, 60, 18));
    const seen: string[] = [];
    const listener = (ev: Event) => seen.push(ev.type);
    for (const t of ['pointerdown', 'mousedown', 'click']) document.addEventListener(t, listener);
    const card = h.q('[data-jm="card"]');
    const button = h.q('[data-jm="button"]');
    for (const el of [card, button]) {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }
    expect(seen).toEqual([]);
    for (const t of ['pointerdown', 'mousedown', 'click']) document.removeEventListener(t, listener);
    h.overlay.dispose();
  });
});
