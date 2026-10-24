import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileOp, RuntimeRequest } from '@jammarly/shared/types';
import { defaultProfile, type ProfileDocument } from '@jammarly/shared/profile';
import { liveValues, mountOptions, parseWordList, parseWritingStyleFile, routeFromHash, validatePairing, writingStyleFile, type OptionsApp } from '../../src/pages/options/app';
import { ruleTitle } from '../../src/pages/options/view';
import { fakeSettings, fakeSync, flush, installChromeMock, type ChromeMock } from '../../src/pages/testing/chrome-mock';

let mock: ChromeMock;
let root: HTMLElement;
let app: OptionsApp | null = null;
let hash = '';
let downloads: { filename: string; text: string }[] = [];

function consentedProfile(): ProfileDocument {
  const p = defaultProfile();
  p.settings.privacy = { value: { ...p.settings.privacy.value, consentAt: '2026-10-01T10:00:00.000Z' }, hlc: '0000000000001-0000-dev' };
  return p;
}

async function mount(initialHash = ''): Promise<OptionsApp> {
  hash = initialHash;
  root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  app = mountOptions(root, {
    getHash: () => hash,
    setHash: (h) => {
      hash = h;
    },
    download: (filename, text) => downloads.push({ filename, text }),
  });
  await app.ready;
  await flush();
  return app;
}

function opsSent(): ProfileOp[][] {
  return mock.requests.filter((r): r is Extract<RuntimeRequest, { type: 'profile-ops' }> => r.type === 'profile-ops').map((r) => r.ops);
}

function settingsPatches(): Partial<Record<string, unknown>>[] {
  return mock.requests.filter((r): r is Extract<RuntimeRequest, { type: 'set-settings' }> => r.type === 'set-settings').map((r) => r.patch);
}

function click(selector: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

function type(selector: string, value: string): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event('input'));
  return el;
}

beforeEach(() => {
  downloads = [];
  mock = installChromeMock({ profile: consentedProfile() });
});

afterEach(() => {
  app?.dispose();
  app = null;
  mock.restore();
  document.body.replaceChildren();
});

describe('options: router', () => {
  it('defaults to #welcome while consent is missing and to #general afterwards', async () => {
    mock.profile = defaultProfile();
    await mount('');
    expect(app!.store.get().route).toBe('welcome');
    expect(root.querySelector('h1')?.textContent).toBe('Welcome to Jammarly');
    expect(root.querySelector('.jm-nav-link.is-active')?.getAttribute('data-route')).toBe('welcome');
    app!.dispose();
    document.body.replaceChildren();
    mock.profile = consentedProfile();
    await mount('');
    expect(app!.store.get().route).toBe('general');
    expect(routeFromHash('#dictionary', null)).toBe('dictionary');
    expect(routeFromHash('#nope', consentedProfile())).toBe('general');
    expect(routeFromHash('', null)).toBe('welcome');
  });

  it('navigates through the left nav, updates the hash and reacts to hashchange', async () => {
    await mount('#general');
    click('[data-route="dictionary"]');
    expect(hash).toBe('#dictionary');
    expect(root.querySelector('h1')?.textContent).toBe('Personal dictionary');
    hash = '#privacy';
    window.dispatchEvent(new Event('hashchange'));
    expect(root.querySelector('h1')?.textContent).toBe('Advanced');
    // The nav is down to the few pages an everyday user needs.
    expect(Array.from(root.querySelectorAll('.jm-nav-link')).map((a) => a.textContent)).toEqual(['Settings', 'Writing style', 'Sites', 'Dictionary', 'Advanced']);
    for (const route of ['style', 'sites', 'advanced', 'general']) {
      click(`[data-route="${route}"]`);
      expect(root.querySelector('.jm-nav-link.is-active')?.getAttribute('data-route')).toBe(route);
    }
  });
});

describe('options: welcome', () => {
  it('"I agree and continue" sends a set op on settings.privacy with an ISO consentAt and hlc ""', async () => {
    mock.profile = defaultProfile();
    await mount('#welcome');
    expect(root.textContent).toContain('sent to Anthropic');
    click('[data-focus-key="welcome:agree"]');
    await flush();
    const ops = opsSent();
    expect(ops.length).toBe(1);
    const op = ops[0]![0]!;
    expect(op.op).toBe('set');
    expect(op.hlc).toBe('');
    if (op.op !== 'set') throw new Error('expected set');
    expect(op.path).toBe('settings.privacy');
    const value = op.value as { consentAt: string; storeSnippets: boolean; retentionDays: number; learningEnabled: boolean };
    expect(value.storeSnippets).toBe(true);
    expect(value.retentionDays).toBe(90);
    expect(value.learningEnabled).toBe(true);
    expect(Number.isNaN(Date.parse(value.consentAt))).toBe(false);
    expect(value.consentAt).toBe(new Date(value.consentAt).toISOString());
    expect(mock.requests.filter((r) => r.type === 'get-profile').length).toBeGreaterThanOrEqual(2);
  });

  it('the API key is write-only: Save sends set-settings { apiKey }, the input clears and no key is ever rendered', async () => {
    mock.profile = defaultProfile();
    await mount('#welcome');
    type('[data-focus-key="input:apiKey"]', 'sk-ant-api03-secret-value-1234567890');
    click('[data-focus-key="welcome:save-key"]');
    await flush();
    expect(settingsPatches()).toContainEqual({ apiKey: 'sk-ant-api03-secret-value-1234567890' });
    expect(root.querySelector<HTMLInputElement>('[data-focus-key="input:apiKey"]')?.value).toBe('');
    expect(root.textContent).not.toContain('secret-value');
    expect(root.querySelector('.jm-toast')?.textContent).toBe('Saved');
    expect(root.textContent).toContain('A key is saved on this device.');
  });

  it('shows "Key saved, ends with …" only when the worker returns a hint, and validates empty keys inline', async () => {
    const base = mock.respond;
    mock.respond = (req) => {
      if (req.type === 'set-settings' && req.patch.apiKey) return { ok: true, type: 'settings', settings: { ...mock.settings, hasApiKey: true, apiKeyHint: '7890' } };
      return base(req);
    };
    await mount('#general');
    click('[data-focus-key="general:save-key"]');
    await flush();
    expect(root.querySelector('.jm-field-error')?.textContent).toBe('Enter your API key.');
    expect(settingsPatches().some((p) => 'apiKey' in p)).toBe(false);
    type('[data-focus-key="input:apiKey"]', 'sk-ant-api03-another-secret-value-000');
    click('[data-focus-key="general:save-key"]');
    await flush();
    expect(root.querySelector('.jm-toast')?.textContent).toBe('Key saved, ends with 7890');
  });

  it('"Test key" sends test-api-key with the typed value and shows the result', async () => {
    mock.profile = defaultProfile();
    await mount('#welcome');
    type('[data-focus-key="input:apiKey"]', 'sk-ant-api03-test-key-value-1234567890');
    click('[data-focus-key="welcome:test-key"]');
    await flush();
    expect(mock.requests).toContainEqual({ type: 'test-api-key', apiKey: 'sk-ant-api03-test-key-value-1234567890' });
    const result = root.querySelector<HTMLElement>('.jm-test-result')!;
    expect(result.dataset.valid).toBe('true');
    expect(result.textContent).toContain('claude-haiku-5-5');
    type('[data-focus-key="input:apiKey"]', 'not-a-real-key-but-long-enough-xx');
    click('[data-focus-key="welcome:test-key"]');
    await flush();
    expect(root.querySelector<HTMLElement>('.jm-test-result')?.dataset.valid).toBe('false');
    expect(root.querySelector('.jm-test-result')?.textContent).toContain('Invalid key');
  });

  it('pairing sends { type: "pair", pairingId, code } and validates the 6-digit code', async () => {
    mock.profile = defaultProfile();
    await mount('#welcome');
    type('[data-focus-key="input:pairingId"]', 'pair-abc');
    type('[data-focus-key="input:pairCode"]', '12');
    click('[data-focus-key="welcome:pair"]');
    await flush();
    expect(mock.requests.some((r) => r.type === 'pair')).toBe(false);
    expect(root.textContent).toContain('The code is 6 digits.');
    type('[data-focus-key="input:pairCode"]', '123456');
    click('[data-focus-key="welcome:pair"]');
    await flush();
    expect(mock.requests).toContainEqual({ type: 'pair', pairingId: 'pair-abc', code: '123456' });
    expect(app!.store.get().pairedDeviceId).toBe('dev-123');
    expect(root.textContent).toContain('Paired with https://jammarly.example');
    expect(validatePairing('', '123456')).toMatch(/pairing id/);
  });

  it('"Only sites I turn on" writes settings.checkOptedOutFields false; Finish goes to #general; no mock toggle outside dev builds', async () => {
    mock.profile = defaultProfile();
    await mount('#welcome');
    expect(root.querySelector('[data-focus-key="welcome:mock"]')).toBeNull();
    const radio = root.querySelector<HTMLInputElement>('[data-focus-key="welcome:sites:opt-in"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.checkOptedOutFields', value: false, hlc: '' }]);
    click('[data-focus-key="welcome:finish"]');
    expect(hash).toBe('#general');
    expect(root.querySelector('h1')?.textContent).toBe('Settings');
  });
});

describe('options: general', () => {
  it('device settings go through set-settings and show a Saved toast; usage is shown', async () => {
    await mount('#general');
    click('[data-focus-key="general:underlines"]');
    await flush();
    expect(settingsPatches()).toContainEqual({ showUnderlines: false });
    expect(root.querySelector('.jm-toast')?.textContent).toBe('Saved');
    expect(root.querySelector('[data-usage="today"]')?.textContent).toContain('$0.01');
    expect(root.querySelector('[data-usage="month"]')?.textContent).toContain('$0.42');
    app!.actions.navigate('advanced');
    const slider = root.querySelector<HTMLInputElement>('[data-focus-key="general:debounce"]')!;
    expect(slider.min).toBe('300');
    expect(slider.max).toBe('2000');
    slider.value = '1200';
    slider.dispatchEvent(new Event('change'));
    await flush();
    expect(settingsPatches()).toContainEqual({ debounceMs: 1200 });
  });

  it('unpaired: mode and model write device settings; paired: profile ops with a synced note', async () => {
    await mount('#advanced');
    const economy = root.querySelector<HTMLInputElement>('[data-focus-key="general:mode:economy"]')!;
    economy.checked = true;
    economy.dispatchEvent(new Event('change'));
    await flush();
    expect(settingsPatches()).toContainEqual({ mode: 'economy' });
    const model = root.querySelector<HTMLSelectElement>('[data-focus-key="general:model"]')!;
    model.value = 'claude-sonnet-5-5';
    model.dispatchEvent(new Event('change'));
    await flush();
    expect(settingsPatches()).toContainEqual({ model: 'claude-sonnet-5-5' });
    expect(opsSent()).toEqual([]);

    app!.dispose();
    document.body.replaceChildren();
    mock.settings = fakeSettings({ paired: true, appOrigin: 'https://jammarly.example' });
    mock.sync = fakeSync();
    const before = mock.requests.length;
    await mount('#advanced');
    expect(root.textContent).toContain('synced across devices');
    const fast = root.querySelector<HTMLSelectElement>('[data-focus-key="general:fastModel"]')!;
    fast.value = 'claude-sonnet-5-5';
    fast.dispatchEvent(new Event('change'));
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.fastModel', value: 'claude-sonnet-5-5', hlc: '' }]);
    const quality = root.querySelector<HTMLInputElement>('[data-focus-key="general:mode:quality"]')!;
    quality.checked = true;
    quality.dispatchEvent(new Event('change'));
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.mode', value: 'quality', hlc: '' }]);
    const afterPairing = mock.requests.slice(before).filter((r): r is Extract<RuntimeRequest, { type: 'set-settings' }> => r.type === 'set-settings');
    expect(afterPairing.some((r) => 'mode' in r.patch || 'fastModel' in r.patch)).toBe(false);
  });

  it('validates the daily budget inline and writes a rounded value (0 = unlimited)', async () => {
    await mount('#general');
    const input = type('[data-focus-key="general:budget"]', '-3');
    click('[data-focus-key="general:budget-save"]');
    await flush();
    expect(root.querySelector('.jm-field-error')?.textContent).toBe('Enter 0 or a positive amount.');
    expect(settingsPatches().some((p) => 'dailyBudgetUsd' in p)).toBe(false);
    type('[data-focus-key="general:budget"]', '1.005');
    click('[data-focus-key="general:budget-save"]');
    await flush();
    expect(settingsPatches()).toContainEqual({ dailyBudgetUsd: 1.01 });
    expect(root.querySelector('.jm-field-error')).toBeNull();
    type('[data-focus-key="general:budget"]', '0');
    root.querySelector<HTMLInputElement>('[data-focus-key="general:budget"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(settingsPatches()).toContainEqual({ dailyBudgetUsd: 0 });
    expect(root.querySelector('.jm-toast')?.textContent).toContain('No daily limit');
    void input;
  });

  it('a custom model id can be typed and is saved on Enter', async () => {
    await mount('#advanced');
    const model = root.querySelector<HTMLSelectElement>('[data-focus-key="general:model"]')!;
    model.value = '__custom__';
    model.dispatchEvent(new Event('change'));
    const input = type('[data-focus-key="input:model:custom"]', 'claude-custom-2027');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(settingsPatches()).toContainEqual({ model: 'claude-custom-2027' });
  });
});

describe('options: suggestions, sites, dictionary', () => {
  it('goals, dialect, categories and the writing style write set ops', async () => {
    await mount('#advanced');
    const formality = root.querySelector<HTMLSelectElement>('[data-focus-key="goals:formality"]')!;
    formality.value = 'formal';
    formality.dispatchEvent(new Event('change'));
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.goals', value: { audience: 'general', formality: 'formal', domain: 'general', intent: 'inform' }, hlc: '' }]);
    app!.actions.navigate('style');
    const dialect = root.querySelector<HTMLSelectElement>('[data-focus-key="dialect"]')!;
    dialect.value = 'en-GB';
    dialect.dispatchEvent(new Event('change'));
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: '' }]);
    app!.actions.navigate('general');
    click('[data-focus-key="category:engagement"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.categories', value: { correctness: true, clarity: true, engagement: false, delivery: true }, hlc: '' }]);
    app!.actions.navigate('style');
    const area = root.querySelector<HTMLTextAreaElement>('[data-focus-key="customInstructions"]')!;
    area.value = 'x'.repeat(2001);
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="style:save"]');
    await flush();
    expect(root.querySelector('.jm-field-error')?.textContent).toContain('2000');
    const area2 = root.querySelector<HTMLTextAreaElement>('[data-focus-key="customInstructions"]')!;
    area2.value = 'Prefer short sentences.';
    area2.dispatchEvent(new Event('input'));
    click('[data-focus-key="style:save"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.customInstructions', value: 'Prefer short sentences.', hlc: '' }]);
    expect(root.textContent).toContain('sound like the person described here');
  });

  it('lists live muted rules with titles and unmutes with a remove op', async () => {
    const p = consentedProfile();
    p.rules.muted = [
      { value: 'passive_voice', addedHlc: '0000000000002-0000-dev' },
      { value: 'hedging', addedHlc: '0000000000001-0000-dev', removedHlc: '0000000000003-0000-dev' },
      { value: 'mystery_rule', addedHlc: '0000000000004-0000-dev' },
    ];
    mock.profile = p;
    await mount('#advanced');
    const list = root.querySelector('[data-list="muted"]')!;
    expect(list.querySelectorAll('.jm-list-item').length).toBe(2);
    expect(list.textContent).toContain('Use the active voice');
    expect(list.textContent).not.toContain('Sound more confident');
    expect(ruleTitle('mystery_rule')).toBe('mystery_rule');
    expect(ruleTitle('other')).toBe('Consider this change');
    click('[data-focus-key="muted:passive_voice"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'remove', path: 'rules.muted', value: 'passive_voice', hlc: '' }]);
  });

  it('sites: adds a normalized disabled host, rejects junk inline, removes, and toggles opt-out settings', async () => {
    const p = consentedProfile();
    p.sites.disabled = [{ value: 'twitter.com', addedHlc: '0000000000002-0000-dev' }];
    p.settings.ignoreOptOutHosts = { value: ['app.slack.com'], hlc: '0000000000002-0000-dev' };
    mock.profile = p;
    await mount('#sites');
    expect(root.querySelector('[data-list="disabled"]')?.textContent).toContain('twitter.com');
    type('[data-focus-key="input:disabledSite"]', 'nonsense');
    click('[data-focus-key="sites:add-disabled"]');
    await flush();
    expect(root.querySelector('.jm-field-error')?.textContent).toContain('hostname');
    type('[data-focus-key="input:disabledSite"]', 'https://www.Reddit.com/r/all');
    click('[data-focus-key="sites:add-disabled"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'add', path: 'sites.disabled', value: 'reddit.com', hlc: '' }]);
    click('[data-focus-key="disabled:remove:twitter.com"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'remove', path: 'sites.disabled', value: 'twitter.com', hlc: '' }]);
    app!.actions.navigate('advanced');
    type('[data-focus-key="input:ignoreOptOutHost"]', 'discord.com');
    click('[data-focus-key="sites:add-ignore"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.ignoreOptOutHosts', value: ['app.slack.com', 'discord.com'], hlc: '' }]);
    click('[data-focus-key="sites:check-opted-out"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.checkOptedOutFields', value: true, hlc: '' }]);
  });

  it('dictionary: filters live elements, adds and removes words, exports and imports newline lists', async () => {
    const p = consentedProfile();
    p.dictionary = [
      { value: 'Jammarly', addedHlc: '0000000000002-0000-dev' },
      { value: 'removed', addedHlc: '0000000000001-0000-dev', removedHlc: '0000000000005-0000-dev' },
      { value: 'readded', addedHlc: '0000000000009-0000-dev', removedHlc: '0000000000005-0000-dev' },
    ];
    mock.profile = p;
    await mount('#dictionary');
    expect(liveValues(p.dictionary)).toEqual(['Jammarly', 'readded']);
    const list = root.querySelector('[data-list="dictionary"]')!;
    expect(list.querySelectorAll('.jm-list-item').length).toBe(2);
    expect(list.textContent).not.toContain('removed');
    type('[data-focus-key="input:word"]', 'two words');
    click('[data-focus-key="dictionary:add"]');
    await flush();
    expect(root.querySelector('.jm-field-error')?.textContent).toBe('Enter a single word.');
    type('[data-focus-key="input:word"]', 'Anthropic');
    click('[data-focus-key="dictionary:add"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'add', path: 'dictionary', value: 'Anthropic', hlc: '' }]);
    click('[data-focus-key="dictionary:remove:Jammarly"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'remove', path: 'dictionary', value: 'Jammarly', hlc: '' }]);
    const exported = app!.actions.exportDictionary();
    expect(exported).toBe('Jammarly\nreadded\n');
    expect(downloads[0]).toEqual({ filename: 'jammarly-dictionary.txt', text: exported });
    const added = await app!.actions.importDictionary('readded\nfoo\nbar\n\nfoo');
    expect(added).toBe(2);
    expect(opsSent().at(-1)).toEqual([
      { op: 'add', path: 'dictionary', value: 'foo', hlc: '' },
      { op: 'add', path: 'dictionary', value: 'bar', hlc: '' },
    ]);
    expect(parseWordList('a, b\nc  \n')).toEqual(['a', 'b', 'c']);
  });
});

describe('options: sync and privacy', () => {
  it('sync: shows the pair form when unpaired, and the state table, Sync now and Unpair (after confirm) when paired', async () => {
    await mount('#sync');
    expect(root.querySelector('[data-focus-key="sync:pair"]')).not.toBeNull();
    app!.dispose();
    document.body.replaceChildren();
    mock.settings = fakeSettings({ paired: true, appOrigin: 'https://jammarly.example' });
    mock.sync = fakeSync({ status: 'paused', pendingOps: [{ op: 'add', path: 'dictionary', value: 'x', hlc: '1' }] });
    await mount('#sync');
    expect(root.querySelector('[data-sync="status"]')?.textContent).toBe('Paused (quota)');
    expect(root.textContent).toContain('https://jammarly.example');
    expect(root.textContent).toContain('Pending changes');
    click('[data-focus-key="sync:now"]');
    await flush();
    expect(mock.requests.some((r) => r.type === 'sync-now')).toBe(true);
    click('[data-focus-key="sync:unpair"]');
    expect(mock.requests.some((r) => r.type === 'unpair')).toBe(false);
    click('.jm-confirm [data-focus-key="confirm:yes"]');
    await flush();
    expect(mock.requests.some((r) => r.type === 'unpair')).toBe(true);
    expect(root.querySelector('[data-focus-key="sync:pair"]')).not.toBeNull();
  });

  it('privacy: toggles write merged privacy values, withdrawing consent sets consentAt null after confirm, private sites update', async () => {
    await mount('#privacy');
    click('[data-focus-key="privacy:snippets"]');
    await flush();
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.privacy', value: { storeSnippets: false, retentionDays: 90, learningEnabled: true, consentAt: '2026-10-01T10:00:00.000Z' }, hlc: '' }]);
    const retention = root.querySelector<HTMLSelectElement>('[data-focus-key="privacy:retention"]')!;
    retention.value = '30';
    retention.dispatchEvent(new Event('change'));
    await flush();
    expect(opsSent().at(-1)).toEqual([{ op: 'set', path: 'settings.privacy', value: { storeSnippets: true, retentionDays: 30, learningEnabled: true, consentAt: '2026-10-01T10:00:00.000Z' }, hlc: '' }]);
    click('[data-focus-key="privacy:withdraw"]');
    expect(root.querySelector('.jm-confirm')?.textContent).toContain('Checking stops');
    click('.jm-confirm [data-focus-key="confirm:yes"]');
    await flush();
    expect(opsSent().at(-1)).toEqual([{ op: 'set', path: 'settings.privacy', value: { storeSnippets: true, retentionDays: 90, learningEnabled: true, consentAt: null }, hlc: '' }]);
    type('[data-focus-key="input:privateSite"]', 'mail.example.com');
    click('[data-focus-key="privacy:add-private"]');
    await flush();
    expect(opsSent().at(-1)).toEqual([{ op: 'set', path: 'settings.privateSites', value: ['mail.example.com'], hlc: '' }]);
    expect(root.textContent).toContain('not paired');
  });

  it('advanced: gdocs inline mode, extension id/version and the side panel button', async () => {
    await mount('#advanced');
    expect(root.querySelector('[data-info="id"]')?.textContent).toBe('test-extension-id');
    expect(root.querySelector('[data-info="version"]')?.textContent).toBe('0.1.0');
    const sel = root.querySelector<HTMLSelectElement>('[data-focus-key="advanced:gdocs"]')!;
    sel.value = 'off';
    sel.dispatchEvent(new Event('change'));
    await flush();
    expect(settingsPatches()).toContainEqual({ gdocsInline: 'off' });
    click('[data-focus-key="advanced:open-panel"]');
    await flush();
    expect(mock.requests.some((r) => r.type === 'open-side-panel')).toBe(true);
  });
});

describe('options: writing style', () => {
  it('saves whose style it is with the style, exports it, imports someone else\'s and resets', async () => {
    await mount('#style');
    expect(root.querySelector('h1')?.textContent).toBe('Your writing style');
    type('[data-focus-key="input:styleOwner"]', 'Julian');
    const area = root.querySelector<HTMLTextAreaElement>('[data-focus-key="customInstructions"]')!;
    area.value = 'Short, direct sentences. Never use em dashes.';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="style:save"]');
    await flush();
    expect(settingsPatches()).toContainEqual({ styleOwner: 'Julian' });
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.customInstructions', value: 'Short, direct sentences. Never use em dashes.', hlc: '' }]);
    expect(root.querySelector('.jm-card-title')?.textContent).toBe('Julian’s style');

    const exported = app!.actions.exportWritingStyle();
    expect(downloads.at(-1)?.filename).toBe('jammarly-style-julian.json');
    // The test worker does not apply profile ops, so the exported style is the loaded (empty) one.
    expect(parseWritingStyleFile(exported)).toEqual({ owner: 'Julian', style: '' });
    expect(parseWritingStyleFile(writingStyleFile('Julian', 'Short.'))).toEqual({ owner: 'Julian', style: 'Short.' });
    expect(parseWritingStyleFile('Plain text style')).toEqual({ owner: '', style: 'Plain text style' });

    expect(await app!.actions.importWritingStyle(writingStyleFile('Sam', 'Warm and chatty.'))).toBe(true);
    expect(settingsPatches()).toContainEqual({ styleOwner: 'Sam' });
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.customInstructions', value: 'Warm and chatty.', hlc: '' }]);
    expect(await app!.actions.importWritingStyle('{"not":"a style"}')).toBe(false);

    click('[data-focus-key="style:reset"]');
    expect(root.textContent).toContain('Export it first');
    await app!.actions.confirmResetStyle();
    await flush();
    expect(settingsPatches()).toContainEqual({ styleOwner: '' });
    expect(opsSent()).toContainEqual([{ op: 'set', path: 'settings.customInstructions', value: '', hlc: '' }]);
  });
});

describe('options: resilience', () => {
  it('renders the welcome page with an error banner when the worker never answers, and writes report failures', async () => {
    mock.respond = () => undefined;
    await mount('');
    expect(app!.store.get().route).toBe('welcome');
    expect(root.querySelector('.jm-notice-error')?.textContent).toContain("Can't reach");
    expect(root.querySelector('[data-focus-key="welcome:agree"]')).not.toBeNull();
    click('[data-focus-key="welcome:agree"]');
    await flush();
    expect(root.querySelector('.jm-toast-error')).not.toBeNull();
    click('[data-route="advanced"]');
    expect(root.querySelector('[data-debug="last-error"]')?.textContent).toContain('no-reply');
  });

  it('survives garbage replies and rejected promises without throwing', async () => {
    mock.respond = (req) => (req.type === 'get-profile' ? Promise.reject(new Error('nope')) : { weird: 1 });
    await mount('#general');
    expect(root.querySelector('h1')?.textContent).toBe('Settings');
    expect(root.querySelector('.jm-notice-error')).not.toBeNull();
    expect(app!.store.get().profile).toBeNull();
    click('[data-route="dictionary"]');
    expect(root.textContent).toContain('Your dictionary is empty.');
  });
});

describe('adversarial', () => {
  it('a worker that answers { ok:false } to everything still renders every section and reports each failed write', async () => {
    mock.respond = () => ({ ok: false, error: { code: 'storage-locked', message: 'Storage is locked.' } });
    await mount('#general');
    expect(root.querySelector('.jm-notice-error')?.textContent).toContain('Storage is locked.');
    expect(app!.store.get().profile).toBeNull();
    for (const route of ['style', 'sites', 'dictionary', 'advanced', 'welcome', 'general'] as const) {
      app!.actions.navigate(route);
      expect(root.querySelector('h1')).not.toBeNull();
    }
    // Device switches stay disabled while the settings are unknown: the page never writes a value it has not seen.
    app!.actions.navigate('general');
    expect(root.querySelector<HTMLButtonElement>('[data-focus-key="general:underlines"]')?.disabled).toBe(true);
    click('[data-focus-key="general:underlines"]');
    await flush();
    expect(mock.requests.some((r) => r.type === 'set-settings')).toBe(false);
    // Profile writes that need no prior state (dictionary) go out, fail, and are reported.
    app!.actions.navigate('dictionary');
    type('[data-focus-key="input:word"]', 'Anthropic');
    click('[data-focus-key="dictionary:add"]');
    await flush();
    expect(mock.requests.some((r) => r.type === 'profile-ops')).toBe(true);
    expect(root.querySelector('.jm-toast-error')?.textContent).toBe('Storage is locked.');
    expect(app!.store.get().lastError?.message).toBe('storage-locked: Storage is locked.');
    // The draft is kept for a retry, the dictionary stays empty (no optimistic insert).
    expect(root.querySelector<HTMLInputElement>('[data-focus-key="input:word"]')?.value).toBe('Anthropic');
    expect(root.textContent).toContain('Your dictionary is empty.');
    app!.actions.navigate('advanced');
    expect(root.querySelector('[data-debug="last-error"]')?.textContent).toContain('storage-locked');
    expect(app!.store.get().settings).toBeNull();
  });

  it('dictionary: removedHlc newer than addedHlc hides, older or absent shows, equal hides, malformed entries are skipped', async () => {
    const p = consentedProfile();
    p.dictionary = [
      { value: 'newer-removed', addedHlc: '0000000000001-0000-a', removedHlc: '0000000000002-0000-a' },
      { value: 'older-removed', addedHlc: '0000000000003-0000-a', removedHlc: '0000000000002-0000-a' },
      { value: 'equal', addedHlc: '0000000000002-0000-a', removedHlc: '0000000000002-0000-a' },
      { value: 'counter-wins', addedHlc: '0000000000002-0001-a', removedHlc: '0000000000002-0000-b' },
      { value: 'plain', addedHlc: '0000000000005-0000-a' },
      { value: 42, addedHlc: '0000000000005-0000-a' } as unknown as (typeof p.dictionary)[number],
      null as unknown as (typeof p.dictionary)[number],
      { value: 'twice', addedHlc: '0000000000001-0000-a', removedHlc: '0000000000009-0000-a' },
      { value: 'twice', addedHlc: '0000000000010-0000-a' },
    ];
    mock.profile = p;
    expect(liveValues(p.dictionary)).toEqual(['counter-wins', 'older-removed', 'plain', 'twice']);
    expect(liveValues(undefined)).toEqual([]);
    expect(liveValues('nope' as unknown as [])).toEqual([]);
    await mount('#dictionary');
    const list = root.querySelector('[data-list="dictionary"]')!;
    expect(Array.from(list.querySelectorAll('.jm-list-value')).map((el) => el.textContent)).toEqual(['counter-wins', 'older-removed', 'plain', 'twice']);
    expect(root.querySelector('.jm-count-line')?.textContent).toBe('4 words');
  });

  it('consent: "I agree" preserves the existing privacy values and later privacy writes build on the reloaded profile', async () => {
    const p = defaultProfile();
    p.settings.privacy = { value: { storeSnippets: false, retentionDays: 30, learningEnabled: false, consentAt: null }, hlc: '0000000000001-0000-dev' };
    mock.profile = p;
    const base = mock.respond;
    mock.respond = (req) => {
      if (req.type === 'profile-ops') {
        for (const op of req.ops) {
          if (op.op === 'set' && op.path === 'settings.privacy') mock.profile = { ...mock.profile, settings: { ...mock.profile.settings, privacy: { value: op.value as typeof p.settings.privacy.value, hlc: '0000000000002-0000-dev' } } };
        }
        return { ok: true, type: 'ok' };
      }
      return base(req);
    };
    await mount('');
    expect(app!.store.get().route).toBe('welcome');
    const t0 = Date.now();
    click('[data-focus-key="welcome:agree"]');
    await flush();
    const first = opsSent()[0]![0]!;
    if (first.op !== 'set') throw new Error('expected set');
    const value = first.value as { consentAt: string; storeSnippets: boolean; retentionDays: number; learningEnabled: boolean };
    expect(value.storeSnippets).toBe(false);
    expect(value.retentionDays).toBe(30);
    expect(value.learningEnabled).toBe(false);
    expect(Math.abs(Date.parse(value.consentAt) - t0)).toBeLessThan(5000);
    expect(Object.keys(value).sort()).toEqual(['consentAt', 'learningEnabled', 'retentionDays', 'storeSnippets']);
    expect(root.textContent).toContain('You agreed on');
    expect(root.querySelector('[data-focus-key="welcome:agree"]')).toBeNull();
    // Later toggles keep the consent timestamp and the other values.
    app!.actions.navigate('advanced');
    click('[data-focus-key="privacy:learning"]');
    await flush();
    const last = opsSent().at(-1)![0]!;
    if (last.op !== 'set') throw new Error('expected set');
    expect(last.value).toEqual({ storeSnippets: false, retentionDays: 30, learningEnabled: true, consentAt: value.consentAt });
  });

  it('pairing: the code must be exactly six ASCII digits and worker errors surface inline and in the debug block', async () => {
    expect(validatePairing('p', '12345')).toBe('The code is 6 digits.');
    expect(validatePairing('p', '1234567')).toBe('The code is 6 digits.');
    expect(validatePairing('p', 'abcdef')).toBe('The code is 6 digits.');
    expect(validatePairing('p', '１２３４５６')).toBe('The code is 6 digits.');
    expect(validatePairing('p', '12 456')).toBe('The code is 6 digits.');
    expect(validatePairing('p', ' 123456 ')).toBeNull();
    expect(validatePairing('   ', '123456')).toMatch(/pairing id/);
    await mount('#sync');
    type('[data-focus-key="input:pairingId"]', '  pair-1  ');
    type('[data-focus-key="input:pairCode"]', ' 123456 ');
    const base = mock.respond;
    mock.respond = (req) => (req.type === 'pair' ? { ok: false, error: { code: 'pairing_expired', message: 'This code has expired.' } } : base(req));
    click('[data-focus-key="sync:pair"]');
    await flush();
    expect(mock.requests).toContainEqual({ type: 'pair', pairingId: 'pair-1', code: '123456' });
    expect(root.querySelector('.jm-field-error')?.textContent).toBe('This code has expired.');
    expect(app!.store.get().settings?.paired).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[data-focus-key="input:pairCode"]')?.value).toBe(' 123456 ');
    app!.actions.navigate('advanced');
    expect(root.querySelector('[data-debug="last-error"]')?.textContent).toContain('pairing_expired');
    expect(root.textContent).toContain('pair  pairing_expired');
  });

  it('custom instructions: exactly 2,000 characters save, 2,001 are rejected inline and the counter goes red', async () => {
    await mount('#suggestions');
    const area = root.querySelector<HTMLTextAreaElement>('[data-focus-key="customInstructions"]')!;
    const limit = 'é'.repeat(2000);
    area.value = limit;
    area.dispatchEvent(new Event('input'));
    expect(root.querySelector('.jm-counter')?.textContent).toBe('2000 / 2000');
    expect(root.querySelector('.jm-counter')?.classList.contains('is-over')).toBe(false);
    click('[data-focus-key="style:save"]');
    await flush();
    expect(opsSent().at(-1)).toEqual([{ op: 'set', path: 'settings.customInstructions', value: limit, hlc: '' }]);
    const area2 = root.querySelector<HTMLTextAreaElement>('[data-focus-key="customInstructions"]')!;
    area2.value = `${limit}x`;
    area2.dispatchEvent(new Event('input'));
    expect(root.querySelector('.jm-counter')?.classList.contains('is-over')).toBe(true);
    const before = opsSent().length;
    click('[data-focus-key="style:save"]');
    await flush();
    expect(opsSent().length).toBe(before);
    expect(root.querySelector('.jm-field-error')?.textContent).toBe('Keep it under 2000 characters.');
    // The over-long draft survives the error re-render so the user can trim it.
    expect(root.querySelector<HTMLTextAreaElement>('[data-focus-key="customInstructions"]')?.value.length).toBe(2001);
  });

  it('the API key never reaches the DOM even when the worker echoes it back inside the settings reply or as a long "hint"', async () => {
    const secret = 'sk-ant-api03-echoed-back-secret-0123456789';
    const base = mock.respond;
    mock.respond = (req) => {
      if (req.type === 'set-settings' && req.patch.apiKey) return { ok: true, type: 'settings', settings: { ...mock.settings, hasApiKey: true, apiKey: req.patch.apiKey, apiKeyHint: req.patch.apiKey, pairing: { token: 'jm1.x.y' } } };
      if (req.type === 'get-settings') return { ok: true, type: 'settings', settings: { ...mock.settings, apiKey: secret, pairing: { token: 'jm1.x.y', deviceId: 'd', appOrigin: 'https://a', pairedAt: '' } } };
      return base(req);
    };
    await mount('#general');
    expect(JSON.stringify(app!.store.get().settings)).not.toContain(secret);
    expect(JSON.stringify(app!.store.get().settings)).not.toContain('jm1.');
    type('[data-focus-key="input:apiKey"]', secret);
    click('[data-focus-key="general:save-key"]');
    await flush();
    expect(root.querySelector('.jm-toast')?.textContent).toBe('Saved');
    expect(document.body.textContent).not.toContain(secret);
    expect(document.body.textContent).not.toContain('echoed-back');
    expect(root.querySelector<HTMLInputElement>('[data-focus-key="input:apiKey"]')?.value).toBe('');
    expect(JSON.stringify(app!.store.get())).not.toContain(secret);
    expect(JSON.stringify(mock.requests.filter((r) => r.type !== 'set-settings' && r.type !== 'test-api-key'))).not.toContain(secret);
    // A short hint still works.
    mock.respond = (req) => (req.type === 'set-settings' ? { ok: true, type: 'settings', settings: { ...mock.settings, hasApiKey: true, apiKeyHint: '7890' } } : base(req));
    type('[data-focus-key="input:apiKey"]', 'sk-ant-api03-another-valid-looking-key-000');
    click('[data-focus-key="general:save-key"]');
    await flush();
    expect(root.querySelector('.jm-toast')?.textContent).toBe('Key saved, ends with 7890');
    expect(root.textContent).toContain('ends with 7890');
  });

  it('a garbage profile from the worker renders the defaults and treats consent as missing instead of throwing', async () => {
    const base = mock.respond;
    mock.respond = (req) => (req.type === 'get-profile' ? { ok: true, type: 'profile', profile: { settings: { privacy: 'yes', goals: { value: { formality: 'formal' } } }, dictionary: 'none', rules: null } } : base(req));
    await mount('');
    expect(app!.store.get().route).toBe('welcome');
    expect(app!.store.get().profile?.settings.privacy.value.consentAt).toBeNull();
    expect(app!.store.get().profile?.settings.goals.value).toEqual({ audience: 'general', formality: 'formal', domain: 'general', intent: 'inform' });
    for (const route of ['general', 'style', 'sites', 'dictionary', 'advanced'] as const) {
      app!.actions.navigate(route);
      expect(root.querySelector('h1')?.textContent?.length).toBeGreaterThan(0);
    }
    app!.actions.navigate('dictionary');
    expect(root.textContent).toContain('Your dictionary is empty.');
    // A profile reply with no settings at all is ignored (previous state kept) rather than crashing the render.
    mock.respond = (req) => (req.type === 'get-profile' ? { ok: true, type: 'profile', profile: { nope: true } } : base(req));
    await app!.actions.reload();
    expect(app!.store.get().profile?.settings.goals.value.formality).toBe('formal');
  });

  it('a javascript: appOrigin is displayed as text but never becomes a link target', async () => {
    mock.settings = fakeSettings({ paired: true, appOrigin: 'javascript:alert(1)//' });
    mock.sync = fakeSync();
    await mount('#sync');
    expect(root.textContent).toContain('javascript:alert(1)//');
    const hrefs = Array.from(root.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => /^\s*javascript:/i.test(h))).toBe(false);
    app!.actions.navigate('advanced');
    const links = Array.from(root.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '');
    expect(links.some((h) => /javascript:/i.test(h))).toBe(false);
    expect(root.textContent).toContain('not paired');
  });
});

describe('options: keyboard shortcuts', () => {
  it('lists the commands with their keys and opens Chrome\'s shortcuts page', async () => {
    await mount('#general');
    const keys = (name: string) => root.querySelector(`[data-shortcut="${name}"]`)?.textContent;
    expect(keys('accept-all')).toBe('Alt+Shift+A');
    expect(keys('accept-grammar')).toBe('Not set');
    expect(root.querySelector('[data-shortcut="_execute_action"]')).toBeNull();
    click('[data-focus-key="general:shortcuts"]');
    await flush();
    expect(mock.tabsCreated).toEqual([{ url: 'chrome://extensions/shortcuts' }]);
    // Back from Chrome's page with a key set: the list follows.
    mock.commands = mock.commands.map((c) => (c.name === 'accept-grammar' ? { ...c, shortcut: 'Ctrl+Shift+Y' } : c));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(keys('accept-grammar')).toBe('Ctrl+Shift+Y');
  });
});
