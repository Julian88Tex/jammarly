import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldState, PublicDeviceSettings } from '@jammarly/shared/types';
import { mountPopup, needsSetup, syncLine, costLine, initialPopupState, type PopupApp } from '../../src/pages/popup/app';
import { fakeSettings, fakeSync, fakeUsage, flush, installChromeMock, type ChromeMock } from '../../src/pages/testing/chrome-mock';

let mock: ChromeMock;
let root: HTMLElement;
let app: PopupApp | null = null;
let closed = 0;

function field(partial: Partial<FieldState> = {}): FieldState {
  return {
    fieldId: 'f1',
    tabId: 7,
    frameId: 0,
    host: 'mail.google.com',
    fieldKind: 'contenteditable',
    label: 'Message body',
    version: 3,
    textPreview: 'Hello there',
    wordCount: 42,
    suggestions: [],
    status: 'suggestions',
    checkedBy: 'deep',
    active: true,
    undoAvailable: 0,
    transactions: [],
    ...partial,
  };
}

function suggestionStub(id: string, category: FieldState['suggestions'][number]['category']): FieldState['suggestions'][number] {
  return {
    id,
    category,
    rule: 'spelling',
    severity: 'error',
    kind: 'replace',
    source: 'llm',
    tier: 'A',
    anchor: 'exact',
    range: { start: 0, end: 5 },
    highlight: { start: 0, end: 5 },
    original: 'Hello',
    replacement: 'Hallo',
    alternatives: [],
    title: 'Correct the spelling',
    explanation: '',
    confidence: 0.95,
    meaningPreserving: true,
    autoApplySafe: true,
    blockId: 'b0',
    blockHash: 'h',
    conflictsWith: [],
    stale: false,
    promptVersion: '1',
    fingerprint: 'fp',
    learnedState: 'active',
  };
}

async function mount(): Promise<PopupApp> {
  root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  app = mountPopup(root, { closeWindow: () => (closed += 1) });
  await app.ready;
  await flush();
  return app;
}

beforeEach(() => {
  closed = 0;
  mock = installChromeMock({ usage: fakeUsage(0.04), sync: null });
});

afterEach(() => {
  app?.dispose();
  app = null;
  mock.restore();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('popup', () => {
  it('loads settings, usage, sync state and the host status for the active tab', async () => {
    await mount();
    const types = mock.requests.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['get-settings', 'get-usage', 'get-sync-state', 'get-host-status']));
    expect(mock.requests.find((r) => r.type === 'get-host-status')).toEqual({ type: 'get-host-status', host: 'mail.google.com' });
    expect(root.textContent).toContain('On mail.google.com');
    expect(root.querySelector('.jm-cost-line')?.textContent).toBe('Today $0.04 of $2.00');
    expect(root.querySelector('.jm-sync-line')?.textContent).toBe('Not paired');
    expect(mock.ports[0]?.sent[0]).toEqual({ type: 'hello', role: 'sidepanel' });
  });

  it('the master switch writes set-settings { enabled }', async () => {
    await mount();
    const master = root.querySelector<HTMLButtonElement>('[data-focus-key="master"]')!;
    expect(master.getAttribute('aria-checked')).toBe('true');
    master.click();
    await flush();
    expect(mock.requests.find((r) => r.type === 'set-settings')).toEqual({ type: 'set-settings', patch: { enabled: false } });
    expect(root.querySelector('[data-focus-key="master"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('the site switch writes set-host-enabled for the tab host', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-focus-key="host"]')!.click();
    await flush();
    expect(mock.requests.find((r) => r.type === 'set-host-enabled')).toEqual({ type: 'set-host-enabled', host: 'mail.google.com', enabled: false });
    expect(root.textContent).toContain('Paused on this site');
  });

  it('shows the setup notice without a key and routes "Set up" to the welcome page', async () => {
    mock.settings = fakeSettings({ hasApiKey: false });
    await mount();
    expect(root.textContent).toContain('Finish setting up Jammarly');
    root.querySelector<HTMLButtonElement>('[data-focus-key="setup"]')!.click();
    await flush();
    expect(mock.requests.find((r) => r.type === 'open-options')).toEqual({ type: 'open-options', hash: 'welcome' });
  });

  it('falls back to opening the options tab when the worker cannot handle open-options', async () => {
    mock.settings = fakeSettings({ hasApiKey: false });
    const base = mock.respond;
    mock.respond = (req) => (req.type === 'open-options' ? undefined : base(req));
    await mount();
    root.querySelector<HTMLButtonElement>('[data-focus-key="setup"]')!.click();
    await flush();
    expect(mock.tabsCreated[0]).toEqual({ url: 'chrome-extension://test-extension-id/options/options.html#welcome' });
  });

  it('shows the setup notice when consent is missing even with a key', async () => {
    await mount();
    expect(root.textContent).not.toContain('Finish setting up Jammarly');
    mock.ports[0]!.emit({ type: 'config', config: { consented: false, enabled: true, categories: {} }, settings: mock.settings, sync: null });
    expect(root.textContent).toContain('Finish setting up Jammarly');
    expect(needsSetup({ ...initialPopupState(), settings: fakeSettings({ hasApiKey: false, provider: 'mock' }) })).toBe(false);
  });

  it('"Open review panel" sends open-side-panel from the click and closes the window', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-focus-key="open-panel"]')!.click();
    await flush();
    expect(mock.requests.some((r) => r.type === 'open-side-panel')).toBe(true);
    expect(closed).toBe(1);
  });

  it('"Settings" opens the options page through chrome.runtime.openOptionsPage', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-focus-key="settings"]')!.click();
    await flush();
    expect(mock.openOptionsPage.calls).toBe(1);
  });

  it('renders the active field of the current tab with per-category counts', async () => {
    await mount();
    const f = field({ suggestions: [suggestionStub('a', 'correctness'), suggestionStub('b', 'correctness'), suggestionStub('c', 'clarity')] });
    const other = field({ fieldId: 'f2', tabId: 99, label: 'Other tab', active: true });
    mock.ports[0]!.emit({ type: 'fields', fields: [other, f] });
    const card = root.querySelector('.jm-field-card')!;
    expect(card.getAttribute('data-field-id')).toBe('f1');
    expect(card.textContent).toContain('Message body');
    expect(card.querySelector('[data-category="correctness"]')?.textContent).toBe('2');
    expect(card.querySelector('[data-category="clarity"]')?.textContent).toBe('1');
    expect(card.querySelector('[data-category="delivery"]')?.textContent).toBe('0');
    expect(card.textContent).toContain('3 suggestions');
    mock.ports[0]!.emit({ type: 'field-state', state: field({ status: 'clean', suggestions: [] }) });
    expect(root.querySelector('.jm-field-status')?.textContent).toBe('Looks good');
  });

  it('sync and cost lines cover paired states', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const paired = fakeSettings({ paired: true, appOrigin: 'https://jammarly.example' });
    expect(syncLine(null, null)).toBe('Not paired');
    expect(syncLine(paired, fakeSync({ lastPollAt: '2026-10-21T11:57:00Z' }), now)).toBe('Synced 3 min ago');
    expect(syncLine(paired, fakeSync({ status: 'paused' }), now)).toBe('Sync paused');
    expect(syncLine(paired, null, now)).toBe('Paired');
    expect(costLine(fakeUsage(0.04), fakeSettings({ dailyBudgetUsd: 0 }))).toBe('Today $0.04');
    expect(costLine(null, null)).toBe('Today $0.00');
  });

  it('still renders when the worker answers garbage or rejects', async () => {
    mock.respond = () => ({ nonsense: true });
    await mount();
    expect(root.querySelector('.jm-notice-error')?.textContent).toContain('unexpected format');
    expect(root.querySelector('[data-focus-key="open-panel"]')).not.toBeNull();
    app!.dispose();
    document.body.replaceChildren();
    mock.respond = () => Promise.reject(new Error('Receiving end does not exist'));
    await mount();
    expect(root.querySelector('.jm-notice-error')?.textContent).toContain("Can't reach");
    expect(root.querySelector('.jm-cost-line')?.textContent).toBe('Today $0.00');
  });

  it('says the page is not available for non-http tabs', async () => {
    mock.tabs = [{ id: 1, url: 'chrome://extensions', active: true } as chrome.tabs.Tab];
    await mount();
    expect(root.textContent).toContain('Not available on this page');
    expect(mock.requests.some((r) => r.type === 'get-host-status')).toBe(false);
  });
});

describe('adversarial', () => {
  it('field-removed clears the shown field and counts above 99 render compactly', async () => {
    await mount();
    const many = Array.from({ length: 120 }, (_, i) => suggestionStub(`s${i}`, i % 2 === 0 ? 'correctness' : 'clarity'));
    mock.ports[0]!.emit({ type: 'fields', fields: [field({ suggestions: many })] });
    const card = root.querySelector('.jm-field-card')!;
    expect(card.querySelector('[data-category="correctness"]')?.textContent).toBe('60');
    expect(card.textContent).toContain('120 suggestions');
    mock.ports[0]!.emit({ type: 'field-state', state: field({ suggestions: Array.from({ length: 150 }, (_, i) => suggestionStub(`c${i}`, 'correctness')) }) });
    const count = root.querySelector<HTMLElement>('[data-category="correctness"]')!;
    expect(count.textContent).toBe('99+');
    expect(count.title).toContain('150');
    mock.ports[0]!.emit({ type: 'field-removed', fieldId: 'f1' });
    expect(root.querySelector('.jm-field-card')?.classList.contains('jm-field-empty')).toBe(true);
    expect(root.textContent).toContain('No text field focused');
    // A field-removed for some other field changes nothing.
    mock.ports[0]!.emit({ type: 'fields', fields: [field()] });
    mock.ports[0]!.emit({ type: 'field-removed', fieldId: 'zzz' });
    expect(root.querySelector('.jm-field-card')?.getAttribute('data-field-id')).toBe('f1');
    // Garbage field states are ignored instead of thrown on.
    mock.ports[0]!.emit({ type: 'field-state', state: { fieldId: 'f1', tabId: 7, status: 'suggestions', suggestions: [{ id: 'x' }, 'junk'], active: true } });
    expect(root.querySelector('.jm-field-card')?.getAttribute('data-field-id')).toBe('f1');
    expect(root.querySelector('[data-category="correctness"]')?.textContent).toBe('0');
  });

  it('{ ok:false } on set-settings reverts the master switch with a toast; a bare ok acknowledgment keeps the optimistic state', async () => {
    await mount();
    const base = mock.respond;
    mock.respond = (req) => (req.type === 'set-settings' ? { ok: false, error: { code: 'storage', message: 'Storage failed.' } } : base(req));
    root.querySelector<HTMLButtonElement>('[data-focus-key="master"]')!.click();
    expect(root.querySelector('[data-focus-key="master"]')?.getAttribute('aria-checked')).toBe('false');
    await flush();
    expect(root.querySelector('[data-focus-key="master"]')?.getAttribute('aria-checked')).toBe('true');
    expect(root.querySelector('.jm-toast-error')?.textContent).toBe('Storage failed.');
    // The site switch (only enabled while the master is on) reverts on a rejected promise too.
    mock.respond = (req) => (req.type === 'set-host-enabled' ? Promise.reject(new Error('gone')) : req.type === 'set-settings' ? { ok: true, type: 'ok' } : base(req));
    root.querySelector<HTMLButtonElement>('[data-focus-key="host"]')!.click();
    expect(root.querySelector('[data-focus-key="host"]')?.getAttribute('aria-checked')).toBe('false');
    await flush();
    expect(root.querySelector('[data-focus-key="host"]')?.getAttribute('aria-checked')).toBe('true');
    expect(root.querySelector('.jm-toast-error')?.textContent).toContain("Can't reach");
    // A bare acknowledgment keeps the optimistic value.
    root.querySelector<HTMLButtonElement>('[data-focus-key="master"]')!.click();
    await flush();
    expect(root.querySelector('[data-focus-key="master"]')?.getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('[data-focus-key="host"]')?.disabled).toBe(true);
    // A settings reply that smuggles the key never lands in page state.
    mock.respond = (req) => (req.type === 'set-settings' ? { ok: true, type: 'settings', settings: { ...mock.settings, apiKey: 'sk-ant-leak-000' } } : base(req));
    root.querySelector<HTMLButtonElement>('[data-focus-key="master"]')!.click();
    await flush();
    expect(JSON.stringify(app!.store.get())).not.toContain('sk-ant-leak');
  });

  it('"Set up" falls back to a tab when the worker hangs on open-options, and the welcome hash survives', async () => {
    vi.useFakeTimers();
    mock.settings = fakeSettings({ hasApiKey: false });
    const base = mock.respond;
    mock.respond = (req) => (req.type === 'open-options' ? new Promise(() => undefined) : base(req));
    root = document.createElement('div');
    document.body.appendChild(root);
    app = mountPopup(root, { closeWindow: () => (closed += 1) });
    await vi.advanceTimersByTimeAsync(50);
    root.querySelector<HTMLButtonElement>('[data-focus-key="setup"]')!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.tabsCreated.length).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mock.tabsCreated).toEqual([{ url: 'chrome-extension://test-extension-id/options/options.html#welcome' }]);
    expect(mock.openOptionsPage.calls).toBe(0);
    vi.useRealTimers();
  });

  it('a popup whose port never opens still loads over sendMessage and shows the field-less state', async () => {
    mock.connectThrows = true;
    await mount();
    expect(mock.ports.length).toBe(0);
    expect(root.querySelector('.jm-notice-error')).toBeNull();
    expect(root.textContent).toContain('On mail.google.com');
    expect(root.textContent).toContain('No text field focused');
    expect(app!.port.status).toBe('connecting');
  });
});

// Keep the type import used in a way tsc is happy with (documenting the settings shape under test).
const _settingsShape: PublicDeviceSettings = fakeSettings();
void _settingsShape;

describe('popup field actions (moved from the floating button)', () => {
  function rowByKey(key: string): HTMLButtonElement {
    const el = root.querySelector<HTMLButtonElement>(`[data-focus-key="${key}"]`);
    if (!el) throw new Error(`no row ${key}`);
    return el;
  }

  it('shows bulk accept counts and sends accept-all for the focused field, then closes', async () => {
    {
      await mount();
      const style = { ...suggestionStub('s1', 'clarity'), tier: 'B' as const, range: { start: 6, end: 9 }, highlight: { start: 6, end: 9 } };
      mock.ports[0]!.emit({ type: 'field-state', state: field({ suggestions: [suggestionStub('g1', 'correctness'), style] }) });
      await flush();
      expect(rowByKey('accept-grammar').textContent).toContain('1');
      expect(rowByKey('accept-style').textContent).toContain('1');
      expect(rowByKey('accept-all').textContent).toContain('2');
      rowByKey('accept-grammar').click();
      expect(mock.ports[0]!.sent.at(-1)).toEqual({ type: 'panel-action', action: { type: 'accept-all', fieldId: 'f1', scope: { group: 'grammar' } } });
      await new Promise((r) => setTimeout(r, 120));
      expect(closed).toBe(1);
    }
  });

  it('disables bulk rows when there is nothing to accept and offers check now and the field switch', async () => {
    await mount();
    mock.ports[0]!.emit({ type: 'field-state', state: field({ status: 'clean', suggestions: [] }) });
    await flush();
    expect(rowByKey('accept-all').disabled).toBe(true);
    expect(root.querySelector('[data-focus-key="undo"]')).toBeNull();
    rowByKey('recheck').click();
    expect(mock.ports[0]!.sent.at(-1)).toEqual({ type: 'panel-action', action: { type: 'recheck', fieldId: 'f1' } });
    rowByKey('toggle-field').click();
    expect(mock.ports[0]!.sent.at(-1)).toEqual({ type: 'panel-action', action: { type: 'set-field-enabled', fieldId: 'f1', enabled: false } });
    expect(closed).toBe(0);
  });

  it('offers undo when a transaction exists and turning the field back on when it is off', async () => {
    await mount();
    mock.ports[0]!.emit({ type: 'field-state', state: field({ status: 'off', undoAvailable: 1 }) });
    await flush();
    rowByKey('undo').click();
    expect(mock.ports[0]!.sent.at(-1)).toEqual({ type: 'panel-action', action: { type: 'undo', fieldId: 'f1' } });
    expect(rowByKey('toggle-field').textContent).toContain('Turn on');
    rowByKey('toggle-field').click();
    expect(mock.ports[0]!.sent.at(-1)).toEqual({ type: 'panel-action', action: { type: 'set-field-enabled', fieldId: 'f1', enabled: true } });
  });
});

describe('popup counts add up', () => {
  it('counts every fixable suggestion whatever its tier, rewrites included in Accept everything', async () => {
    await mount();
    const grammar = suggestionStub('g1', 'correctness');
    const hedge = { ...suggestionStub('h1', 'delivery'), tier: 'C' as const, meaningPreserving: false, kind: 'delete' as const, replacement: '', range: { start: 10, end: 18 }, highlight: { start: 10, end: 18 } };
    const wordy = { ...suggestionStub('w1', 'clarity'), tier: 'B' as const, range: { start: 20, end: 30 }, highlight: { start: 20, end: 30 } };
    const rewrite = { ...suggestionStub('r1', 'clarity'), tier: 'C' as const, kind: 'rewrite' as const, range: { start: 40, end: 80 }, highlight: { start: 40, end: 80 } };
    mock.ports[0]!.emit({ type: 'field-state', state: field({ suggestions: [grammar, hedge, wordy, rewrite] }) });
    await flush();
    const text = (key: string) => root.querySelector(`[data-focus-key="${key}"]`)?.textContent ?? '';
    expect(text('accept-grammar')).toContain('1');
    expect(text('accept-style')).toContain('2');
    // Accept everything takes the rewrite too (first wording); nothing is left needing a choice.
    expect(text('accept-all')).toContain('4');
    expect(root.querySelector('.jm-action-note')).toBeNull();
  });
});
