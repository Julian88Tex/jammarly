import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicDeviceSettings, RuntimeResponse } from '@jammarly/shared/types';
import { defaultProfile } from '@jammarly/shared/profile';
import { createWorker, type Worker } from '../../src/background/worker';
import { createKeepalive } from '../../src/background/keepalive';
import { installChromeMock, type ChromeMock } from './helpers/chrome-mock';

describe('runtime handlers', () => {
  let mock: ChromeMock;
  let worker: Worker;
  const ORIGIN = 'https://app.test';

  beforeEach(async () => {
    mock = installChromeMock({ tabs: [{ id: 3, windowId: 1, url: 'https://x.com/home', active: true }] });
    const profile = defaultProfile();
    profile.settings.privacy.value.consentAt = '2026-01-01T00:00:00.000Z';
    mock.storage.local.data.set('profile', profile);
    mock.storage.local.data.set('settings', { provider: 'mock', apiKey: 'sk-secret' });
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      const body = u.endsWith('/api/devices/pair/redeem') ? { deviceId: 'dev-9', token: 'jm1.dev-9.s', profile: defaultProfile(), etag: '"e"', version: 1 } : { error: { code: 'not_found', message: 'x' } };
      return { ok: u.endsWith('/redeem'), status: u.endsWith('/redeem') ? 200 : 404, headers: new Headers(), text: async () => JSON.stringify(body) } as unknown as Response;
    }) as typeof fetch;
    worker = createWorker({ chrome: mock.chrome, mockDelayMs: 1, appOrigin: ORIGIN, fetchImpl });
    await worker.ready;
  });
  afterEach(() => mock.uninstall());

  it('ping keeps the smoke contract and get-settings never exposes the key', async () => {
    expect(await mock.sendMessage({ type: 'ping' })).toEqual({ ok: true, type: 'ok' });
    const r = (await mock.sendMessage({ type: 'get-settings' })) as Extract<RuntimeResponse, { type: 'settings' }>;
    expect(r.ok).toBe(true);
    const s = r.settings as PublicDeviceSettings & { apiKey?: string; pairing?: unknown };
    expect(s.apiKey).toBeUndefined();
    expect(s.pairing).toBeUndefined();
    expect(s.hasApiKey).toBe(true);
    expect(s.paired).toBe(false);
    expect(s.appOrigin).toBe(ORIGIN);
  });

  it('set-settings validates the patch: known keys only, apiKey trimmed, budget >= 0, enums checked', async () => {
    const ok = (await mock.sendMessage({ type: 'set-settings', patch: { apiKey: '  sk-new  ', dailyBudgetUsd: 3, mode: 'economy' } })) as RuntimeResponse;
    expect(ok.ok).toBe(true);
    expect(worker.core.settings().apiKey).toBe('sk-new');
    expect(worker.core.settings().dailyBudgetUsd).toBe(3);
    expect(worker.core.settings().mode).toBe('economy');
    const bad1 = (await mock.sendMessage({ type: 'set-settings', patch: { dailyBudgetUsd: -1 } })) as RuntimeResponse;
    expect(bad1.ok).toBe(false);
    const bad2 = (await mock.sendMessage({ type: 'set-settings', patch: { provider: 'openai' } })) as RuntimeResponse;
    expect(bad2.ok).toBe(false);
    const bad3 = (await mock.sendMessage({ type: 'set-settings', patch: { pairing: { token: 'x' } } })) as RuntimeResponse;
    expect(bad3.ok).toBe(false);
    const bad4 = (await mock.sendMessage({ type: 'set-settings', patch: { unknownKey: true } })) as RuntimeResponse;
    expect(bad4.ok).toBe(false);
    expect(worker.core.settings().dailyBudgetUsd).toBe(3);
  });

  it('profile-ops stamps empty clocks, applies and reports rejected ops', async () => {
    const r = (await mock.sendMessage({ type: 'profile-ops', ops: [{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: '' }, { op: 'add', path: 'dictionary', value: 'okafor', hlc: '' }] })) as Extract<RuntimeResponse, { type: 'profile' }>;
    expect(r.ok).toBe(true);
    expect(r.profile.settings.dialect.value).toBe('en-GB');
    expect(r.profile.settings.dialect.hlc).toMatch(/^\d{13}-\d+-d_[0-9a-f]+$/);
    expect(r.profile.dictionary[0]?.value).toBe('okafor');
    const bad = (await mock.sendMessage({ type: 'profile-ops', ops: [{ op: 'set', path: 'learning.stats', value: {}, hlc: '' }] })) as RuntimeResponse;
    expect(bad.ok).toBe(false);
    expect((bad as { error: { code: string } }).error.code).toBe('op_rejected');
    const invalid = (await mock.sendMessage({ type: 'profile-ops', ops: [{ op: 'explode' }] })) as RuntimeResponse;
    expect(invalid.ok).toBe(false);
  });

  it('get-profile, get-usage, get-learning-summary, get-sync-state and learn-voice-now answer their contracts', async () => {
    expect(((await mock.sendMessage({ type: 'get-profile' })) as { type: string }).type).toBe('profile');
    const usage = (await mock.sendMessage({ type: 'get-usage' })) as Extract<RuntimeResponse, { type: 'usage' }>;
    expect(usage.usage.today.requests).toBe(0);
    expect(((await mock.sendMessage({ type: 'get-learning-summary' })) as { type: string }).type).toBe('learning-summary');
    expect(await mock.sendMessage({ type: 'get-sync-state' })).toEqual({ ok: true, type: 'sync-state', sync: null });
    const voice = (await mock.sendMessage({ type: 'learn-voice-now', context: 'messages' })) as RuntimeResponse;
    expect(voice).toEqual({ ok: false, error: { code: 'not-available', message: 'Runs in the web app in v1' } });
  });

  it('get-host-status and set-host-enabled flip sites.disabled', async () => {
    expect(await mock.sendMessage({ type: 'get-host-status', host: 'x.com' })).toEqual({ ok: true, type: 'host-status', host: 'x.com', enabled: true });
    expect(await mock.sendMessage({ type: 'set-host-enabled', host: 'x.com', enabled: false })).toEqual({ ok: true, type: 'host-status', host: 'x.com', enabled: false });
    expect(worker.core.profile().sites.disabled.some((d) => d.value === 'x.com' && !d.removedHlc)).toBe(true);
    expect(await mock.sendMessage({ type: 'set-host-enabled', host: 'x.com', enabled: true })).toMatchObject({ enabled: true });
  });

  it('test-api-key uses the configured provider (mock answers valid)', async () => {
    const r = (await mock.sendMessage({ type: 'test-api-key', apiKey: 'anything' })) as Extract<RuntimeResponse, { type: 'api-key-test' }>;
    expect(r.valid).toBe(true);
    expect(r.model).toBe('mock');
  });

  it('open-side-panel calls sidePanel.open synchronously with the sender tab (no storage await first)', async () => {
    let openedDuringDispatch = false;
    const original = mock.chrome.sidePanel.open;
    mock.chrome.sidePanel.open = (o: Record<string, unknown>) => {
      openedDuringDispatch = true;
      return original(o);
    };
    const p = mock.sendMessage({ type: 'open-side-panel' }, { tab: { id: 42 }, url: 'https://x.com/' });
    expect(openedDuringDispatch).toBe(true); // before any await settled
    expect(await p).toEqual({ ok: true, type: 'ok' });
    expect(mock.sidePanel.opened[0]).toEqual({ tabId: 42 });
    // From the popup (no sender tab) the active tab is used.
    await mock.sendMessage({ type: 'open-side-panel' });
    expect(mock.sidePanel.opened[1]).toEqual({ tabId: 3 });
  });

  it('open-options opens the options page with a hash via tabs.create, else openOptionsPage', async () => {
    await mock.sendMessage({ type: 'open-options', hash: 'welcome' });
    expect(mock.tabs.created[0]?.url).toBe(`chrome-extension://${mock.runtime.id}/options/options.html#welcome`);
    await mock.sendMessage({ type: 'open-options' });
    expect(mock.runtime.openOptionsPageCalls).toBe(1);
  });

  it('pair and unpair through runtime messages', async () => {
    const r = (await mock.sendMessage({ type: 'pair', pairingId: 'p', code: '123' })) as RuntimeResponse;
    expect(r).toEqual({ ok: true, type: 'paired', deviceId: 'dev-9', appOrigin: ORIGIN });
    expect(((await mock.sendMessage({ type: 'get-settings' })) as Extract<RuntimeResponse, { type: 'settings' }>).settings.paired).toBe(true);
    expect(await mock.sendMessage({ type: 'unpair' })).toEqual({ ok: true, type: 'ok' });
    expect(worker.core.settings().pairing).toBeNull();
  });

  it('external pairing accepts only the compiled origin and the jammarly.pair type', async () => {
    const wrong = await mock.sendExternalMessage({ type: 'jammarly.pair', pairingId: 'p', code: '1', appOrigin: ORIGIN }, { origin: 'https://evil.test', url: 'https://evil.test/' });
    expect(wrong).toEqual({ ok: false, error: 'origin_rejected' });
    const badType = await mock.sendExternalMessage({ type: 'other' }, { origin: ORIGIN, url: `${ORIGIN}/devices` });
    expect(badType).toEqual({ ok: false, error: 'bad_message' });
    const ok = await mock.sendExternalMessage({ type: 'jammarly.pair', pairingId: 'p', code: '1', appOrigin: 'https://ignored.test' }, { origin: ORIGIN, url: `${ORIGIN}/devices` });
    expect(ok).toEqual({ ok: true, deviceId: 'dev-9' });
    expect(worker.core.settings().pairing?.appOrigin).toBe(ORIGIN); // the compiled origin, never the message's
  });
});

describe('worker lifecycle', () => {
  let mock: ChromeMock;
  afterEach(() => mock.uninstall());

  it('onInstalled(install) opens the welcome page and generates a device id and user salt', async () => {
    mock = installChromeMock();
    const worker = createWorker({ chrome: mock.chrome, appOrigin: '' });
    await worker.ready;
    await worker.onInstalled({ reason: 'install' });
    expect(mock.tabs.created[0]?.url).toBe(`chrome-extension://${mock.runtime.id}/options/options.html#welcome`);
    expect(worker.core.deviceId()).toMatch(/^d_[0-9a-f]{12}$/);
    expect(worker.core.profile().settings.userSalt.value).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.sidePanel.behavior).toEqual({ openPanelOnActionClick: false });
    expect(mock.storage.local.accessLevel).toBe('TRUSTED_CONTEXTS');
  });

  it('onInstalled(update) re-injects the content script into http(s) tabs, ignoring per-tab errors, and clears the cache', async () => {
    mock = installChromeMock({ tabs: [{ id: 1, windowId: 1, url: 'https://a.com/', active: true }, { id: 2, windowId: 1, url: 'chrome://extensions', active: false }, { id: 3, windowId: 1, url: 'http://b.com/', active: false }] });
    mock.scripting.failFor.add(3);
    const worker = createWorker({ chrome: mock.chrome, appOrigin: '' });
    await worker.ready;
    worker.core.cache.set('k', 'h', { pass: 'deep', model: 'm', suggestions: [], at: 0 });
    await worker.onInstalled({ reason: 'update', previousVersion: '0.0.9' });
    expect(mock.scripting.executed.map((e) => (e.target as { tabId: number }).tabId).sort()).toEqual([1, 3]);
    expect(mock.scripting.executed[0]).toMatchObject({ target: { allFrames: true }, files: ['content/content-script.js'] });
    expect(worker.core.cache.size).toBe(0);
    expect(mock.tabs.created).toHaveLength(0);
  });

  it('startup emits a cancelled check-result for persisted in-flight requests once the field reattaches', async () => {
    mock = installChromeMock();
    mock.storage.session.data.set('inflight', { 'f1:4:deep': { requestId: 'f1:4:deep', fieldId: 'f1', version: 4, pass: 'deep', tabId: 7, frameId: 0, at: '' } });
    const worker = createWorker({ chrome: mock.chrome, appOrigin: '' });
    await worker.ready;
    expect(mock.storage.session.data.get('inflight')).toEqual({});
    const pair = mock.connect('jammarly-content', { tab: { id: 7 }, frameId: 0, url: 'https://x.com/' });
    pair.client.postMessage({ type: 'field-attached', fieldId: 'f1', fieldKind: 'textarea', label: 'l', docKey: 'd' });
    await mock.flush(6);
    const cancelled = pair.client.received.find((m) => (m as { type: string }).type === 'check-result') as { result: { version: number; error: { code: string; retryable: boolean } } } | undefined;
    expect(cancelled?.result.version).toBe(4);
    expect(cancelled?.result.error).toMatchObject({ code: 'cancelled', retryable: true });
  });

  it('keepalive calls getPlatformInfo every 20 s only while a request is in flight', () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const ka = createKeepalive({ getPlatformInfo: () => void calls++ });
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(0);
      ka.begin();
      ka.begin();
      vi.advanceTimersByTime(20_000);
      expect(calls).toBe(1);
      ka.end();
      vi.advanceTimersByTime(20_000);
      expect(calls).toBe(2); // one request still active
      ka.end();
      expect(ka.running).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(2);
      ka.tick();
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commands: toggle-on-site flips the active host, accept-all (everything) and accept-grammar target the active field', async () => {
    mock = installChromeMock({ tabs: [{ id: 7, windowId: 1, url: 'https://x.com/home', active: true }] });
    mock.storage.local.data.set('settings', { provider: 'mock' });
    const worker = createWorker({ chrome: mock.chrome, appOrigin: '' });
    await worker.ready;
    mock.commands.onCommand.dispatch('toggle-on-site', { id: 7, url: 'https://x.com/home' } as never);
    await mock.flush(6);
    expect(worker.core.configFor('x.com').enabledOnHost).toBe(false);
    const pair = mock.connect('jammarly-content', { tab: { id: 7 }, frameId: 0, url: 'https://x.com/home' });
    pair.client.postMessage({ type: 'hello', role: 'content', host: 'x.com', href: 'https://x.com/home', frameToken: 't', extVersion: '0.1.0' });
    pair.client.postMessage({ type: 'field-attached', fieldId: 'fA', fieldKind: 'textarea', label: 'l', docKey: 'd' });
    pair.client.postMessage({ type: 'field-state', state: { fieldId: 'fA', host: 'x.com', fieldKind: 'textarea', label: 'l', version: 1, textPreview: '', wordCount: 0, suggestions: [], status: 'suggestions', checkedBy: 'deep', active: true, undoAvailable: 0, transactions: [] } });
    await mock.flush(6);
    mock.commands.onCommand.dispatch('accept-all', { id: 7, url: 'https://x.com/home' } as never);
    await mock.flush(6);
    const action = pair.client.received.find((m) => (m as { type: string }).type === 'panel-action') as { action: unknown } | undefined;
    expect(action?.action).toEqual({ type: 'accept-all', fieldId: 'fA', scope: { group: 'all' } });
    mock.commands.onCommand.dispatch('accept-grammar', { id: 7, url: 'https://x.com/home' } as never);
    await mock.flush(6);
    const actions = pair.client.received.filter((m) => (m as { type: string }).type === 'panel-action') as { action: unknown }[];
    expect(actions.at(-1)?.action).toEqual({ type: 'accept-all', fieldId: 'fA', scope: { group: 'grammar' } });
  });
});
