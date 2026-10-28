import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_TAG } from '../../../src/content/ui/overlay';
import { PREVIEW_ROWS, previewRowsFor } from '../../../src/content/ui/menu';
import { TOAST_DEFAULT_MS, ToastStack } from '../../../src/content/ui/toast';
import { FAKE_TIMER_APIS, fakeAdapter, harness, item, key, makeSuggestion, opts, rect, text, type Harness } from './helpers';
import type { FieldOverlay } from '../../../src/content/ui/overlay-api';

let h: Harness;
let f: FieldOverlay;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  h = harness();
  f = h.overlay.attach('f1', fakeAdapter(), opts());
});

afterEach(() => {
  h.overlay.dispose();
  vi.useRealTimers();
  for (const el of Array.from(document.querySelectorAll(HOST_TAG))) el.remove();
  document.body.textContent = '';
});

function menuItems(): Map<string, HTMLButtonElement> {
  const m = new Map<string, HTMLButtonElement>();
  for (const el of h.qAll<HTMLButtonElement>('[data-jm="menu-item"]')) m.set(el.dataset.action!, el);
  return m;
}

function menuEl(): HTMLElement {
  return h.q('[data-jm="menu"]');
}

describe('accept-all menu', () => {
  it('shows live counts with disabled items at zero and the rewrite note', () => {
    f.setStatus('suggestions', { grammar: 0, style: 0, rewrites: 0 }, 'rules');
    f.openMenu();
    expect(menuEl().dataset.open).toBe('true');
    expect(menuEl().getAttribute('role')).toBe('menu');
    let items = menuItems();
    expect(text(items.get('accept-grammar'))).toBe('Accept all grammar (0)');
    expect(items.get('accept-grammar')!.disabled).toBe(true);
    expect(text(items.get('accept-style'))).toBe('Accept all style and tone (0)');
    expect(items.get('accept-style')!.disabled).toBe(true);
    expect(text(items.get('accept-all'))).toBe('Accept everything (0)');
    expect(items.get('accept-all')!.disabled).toBe(true);
    expect(items.has('undo')).toBe(false);
    expect(items.has('check-here-anyway')).toBe(false);
    expect(text(items.get('open-panel'))).toBe('Open review panel');
    expect(text(items.get('recheck'))).toBe('Check now');
    expect(text(items.get('toggle-host'))).toBe(`Turn off on ${location.hostname}`);
    expect(text(items.get('toggle-field'))).toBe('Turn off this field');

    // counts update live while open
    f.setStatus('suggestions', { grammar: 3, style: 2, rewrites: 1 }, 'deep');
    items = menuItems();
    expect(text(items.get('accept-grammar'))).toBe('Accept all grammar (3)');
    expect(items.get('accept-grammar')!.disabled).toBe(false);
    expect(text(items.get('accept-style'))).toBe('Accept all style and tone (2)');
    expect(text(items.get('accept-all'))).toBe('Accept everything (5) (1 rewrite needs your choice)');
    expect(text(items.get('accept-all')!.querySelector('[data-jm="menu-sub"]'))).toBe('(1 rewrite needs your choice)');
    expect(h.debug().menuOpen).toBe(true);
  });

  it('dispatches accept-all scopes, recheck, panel and toggles, closing the menu', () => {
    f.setStatus('suggestions', { grammar: 3, style: 2, rewrites: 0 }, 'deep');
    const actions: [string, () => void][] = [
      ['accept-grammar', () => expect(h.events.onAcceptAll).toHaveBeenLastCalledWith('f1', { group: 'grammar' })],
      ['accept-style', () => expect(h.events.onAcceptAll).toHaveBeenLastCalledWith('f1', { group: 'style' })],
      ['accept-all', () => expect(h.events.onAcceptAll).toHaveBeenLastCalledWith('f1', { group: 'all' })],
      ['open-panel', () => expect(h.events.onOpenPanel).toHaveBeenCalledWith('f1')],
      ['recheck', () => expect(h.events.onRecheck).toHaveBeenCalledWith('f1')],
      ['toggle-host', () => expect(h.events.onToggleHost).toHaveBeenCalledWith(false)],
      ['toggle-field', () => expect(h.events.onToggleField).toHaveBeenCalledWith('f1', false, 'session')],
    ];
    for (const [action, check] of actions) {
      f.openMenu();
      menuItems().get(action)!.click();
      check();
      expect(h.debug().menuOpen).toBe(false);
    }
  });

  it('offers Undo last after a toast with a transaction id and Check here anyway for opt-out hosts', () => {
    f.toast('Applied 3 changes', { undoTransactionId: 'tx-1' });
    f.openMenu();
    const undo = menuItems().get('undo')!;
    expect(text(undo)).toBe('Undo last');
    undo.click();
    expect(h.events.onUndo).toHaveBeenCalledWith('f1', 'tx-1');

    f.setUnsupported('This site opted out of writing suggestions (data-gramm="false")');
    f.openMenu();
    const anyway = menuItems().get('check-here-anyway')!;
    expect(text(anyway)).toBe('Check here anyway');
    anyway.click();
    expect(h.events.onCheckHereAnyway).toHaveBeenCalledWith('f1');

    f.setUnsupported('Password fields are never checked');
    f.openMenu();
    expect(menuItems().has('check-here-anyway')).toBe(false);
  });

  it('shows a preview of up to 8 rows with category dots on hover of an accept-all item', () => {
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push(item(makeSuggestion({ id: `g${i}`, category: 'correctness', tier: 'A', range: { start: i * 10, end: i * 10 + 3 }, original: `teh${i}`, replacement: `the${i}` }), rect(10 + i * 30, 100, 20, 18)));
    }
    items.push(item(makeSuggestion({ id: 'st1', category: 'clarity', tier: 'B', kind: 'delete', range: { start: 200, end: 205 }, original: 'quite', replacement: '' }), rect(400, 100, 20, 18)));
    items.push(item(makeSuggestion({ id: 'rw', category: 'clarity', tier: 'C', kind: 'rewrite', range: { start: 300, end: 320 }, original: 'x', replacement: 'y' }), rect(500, 100, 20, 18)));
    f.setUnderlines(items);
    f.setStatus('suggestions', { grammar: 10, style: 1, rewrites: 1 }, 'deep');
    f.openMenu();
    const preview = h.q('[data-jm="menu-preview"]');
    // the first enabled item is focused on open, which previews it
    expect(preview.hidden).toBe(false);
    expect(preview.dataset.group).toBe('grammar');
    menuItems().get('toggle-field')!.dispatchEvent(new PointerEvent('pointerenter'));
    expect(preview.hidden).toBe(true);
    menuItems().get('accept-grammar')!.dispatchEvent(new PointerEvent('pointerenter'));
    expect(preview.hidden).toBe(false);
    expect(preview.dataset.group).toBe('grammar');
    const rows = h.qAll('[data-jm="preview-row"]');
    expect(rows.length).toBe(PREVIEW_ROWS);
    expect(text(rows[0])).toBe('teh0 → the0');
    expect(rows[0]!.querySelector('.jm-dot')!.getAttribute('data-category')).toBe('correctness');
    expect(text(preview.querySelector('.jm-preview-more'))).toBe('+2 more');
    menuItems().get('accept-style')!.dispatchEvent(new PointerEvent('pointerenter'));
    expect(h.qAll('[data-jm="preview-row"]').length).toBe(1);
    expect(text(h.q('[data-jm="preview-row"]'))).toBe('quite → Remove');
    menuItems().get('open-panel')!.dispatchEvent(new PointerEvent('pointerenter'));
    expect(preview.hidden).toBe(true);
    expect(previewRowsFor(items, 'all').length).toBe(11); // A ∪ B, rewrites excluded
  });

  it('is keyboard navigable and closes on Escape or click outside', () => {
    f.setStatus('suggestions', { grammar: 1, style: 0, rewrites: 0 }, 'deep');
    f.openMenu();
    expect((h.root.activeElement as HTMLElement).dataset.action).toBe('accept-grammar');
    key(menuEl(), 'ArrowDown');
    expect((h.root.activeElement as HTMLElement).dataset.action).toBe('accept-all'); // disabled accept-style skipped
    key(menuEl(), 'ArrowDown');
    expect((h.root.activeElement as HTMLElement).dataset.action).toBe('open-panel');
    key(menuEl(), 'ArrowUp');
    key(menuEl(), 'ArrowUp');
    expect((h.root.activeElement as HTMLElement).dataset.action).toBe('accept-grammar');
    const esc = key(menuEl(), 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(h.debug().menuOpen).toBe(false);
    expect(h.root.activeElement).toBe(h.q('[data-jm="button"]')); // focus returns to the button
    f.openMenu();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 900, clientY: 700 }));
    expect(h.debug().menuOpen).toBe(false);
  });

  it('opening the menu closes the card and vice versa', () => {
    const s = makeSuggestion({ id: 's1' });
    f.setUnderlines([item(s, rect(100, 100, 60, 18))]);
    f.openCard('s1', rect(100, 100, 60, 18));
    f.openMenu();
    expect(h.debug().cardOpen).toBe(false);
    expect(h.debug().menuOpen).toBe(true);
    f.openCard('s1', rect(100, 100, 60, 18));
    expect(h.debug().menuOpen).toBe(false);
    expect(h.debug().cardOpen).toBe(true);
  });
});

describe('toast', () => {
  it('keeps one persistent progress toast with a spinner, updates it in place and removes it on null', () => {
    f.progress('Checking everything…');
    let all = h.qAll('[data-jm="toast"]');
    expect(all).toHaveLength(1);
    expect(all[0]!.querySelector('.jm-icon-spinner')).not.toBeNull();
    f.progress('Applied 2 changes, checking again…');
    all = h.qAll('[data-jm="toast"]');
    expect(all).toHaveLength(1);
    expect(text(all[0]!.querySelector('.jm-toast-msg'))).toBe('Applied 2 changes, checking again…');
    vi.advanceTimersByTime(TOAST_DEFAULT_MS * 3);
    expect(h.qAll('[data-jm="toast"]')).toHaveLength(1);
    f.progress(null);
    expect(h.qAll('[data-jm="toast"]')).toHaveLength(0);
  });

  it('shows "Applied N changes — Undo" with an Undo button, auto-dismisses after 10 s and stacks', () => {
    f.toast('Applied 3 changes', { undoTransactionId: 'tx-9' });
    const toasts = h.q('[data-jm="toasts"]');
    expect(toasts.getAttribute('aria-live')).toBe('polite');
    let all = h.qAll('[data-jm="toast"]');
    expect(all.length).toBe(1);
    expect(all[0]!.getAttribute('role')).toBe('status');
    expect(text(all[0]!.querySelector('.jm-toast-msg'))).toBe('Applied 3 changes');
    expect(text(all[0]!.querySelector('[data-jm="toast-undo"]'))).toBe('Undo');
    f.toast('Second', { durationMs: 2000 });
    all = h.qAll('[data-jm="toast"]');
    expect(all.length).toBe(2);
    expect(h.debug().toasts).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(h.qAll('[data-jm="toast"]').length).toBe(1);
    vi.advanceTimersByTime(TOAST_DEFAULT_MS - 2000);
    expect(h.qAll('[data-jm="toast"]').length).toBe(0);
  });

  it('Undo fires onUndo with the transaction id and removes the toast; × dismisses', () => {
    f.toast('Applied 2 changes', { undoTransactionId: 'tx-2' });
    h.q<HTMLButtonElement>('[data-jm="toast-undo"]').click();
    expect(h.events.onUndo).toHaveBeenCalledWith('f1', 'tx-2');
    expect(h.qAll('[data-jm="toast"]').length).toBe(0);
    f.toast('Plain message');
    expect(h.root.querySelector('[data-jm="toast-undo"]')).toBeNull();
    h.q<HTMLButtonElement>('[data-jm="toast-close"]').click();
    expect(h.qAll('[data-jm="toast"]').length).toBe(0);
  });

  it('ToastStack can be driven directly and dispose clears everything', () => {
    const parent = document.createElement('div');
    const stack = new ToastStack(parent);
    const onUndo = vi.fn();
    const t = stack.show('Hello', { onUndo, undoLabel: 'Revert' });
    expect(stack.count()).toBe(1);
    expect(t.element.querySelector('[data-jm="toast-undo"]')!.textContent).toBe('Revert');
    t.dismiss();
    t.dismiss(); // idempotent
    expect(stack.count()).toBe(0);
    stack.show('A');
    stack.show('B');
    stack.dispose();
    expect(parent.children.length).toBe(0);
  });
});
