import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckRequest, ContentToWorker, PanelToWorker, WorkerToContent, WorkerToPanel } from '@jammarly/shared/types';
import { defaultProfile } from '@jammarly/shared/profile';
import { splitParagraphs } from '@jammarly/shared/text';
import { createWorker, type Worker } from '../../src/background/worker';
import { installChromeMock, type ChromeMock, type PortPair } from './helpers/chrome-mock';

const TEXT = 'I just wanted to kind of touch base and see if maybe you could possibly send me the the report when you get a chance.';

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function msgs<T>(pair: PortPair, type: string): T[] {
  return pair.client.received.filter((m) => (m as { type: string }).type === type) as T[];
}

function request(text: string, over: Partial<CheckRequest> = {}): CheckRequest {
  return { fieldId: 'f1', version: 1, text, blocks: splitParagraphs(text), dirtyBlockHashes: 'all', pass: 'deep', host: 'mail.google.com', context: 'email', fieldKind: 'contenteditable', protectedRanges: [], ...over };
}

describe('port hub', () => {
  let mock: ChromeMock;
  let worker: Worker;

  beforeEach(async () => {
    mock = installChromeMock({ tabs: [{ id: 7, windowId: 1, url: 'https://mail.google.com/mail/u/0/', active: true }, { id: 8, windowId: 1, url: 'https://app.slack.com/client', active: false }] });
    const profile = defaultProfile();
    profile.settings.privacy.value.consentAt = '2026-01-01T00:00:00.000Z';
    mock.storage.local.data.set('settings', { provider: 'mock' });
    mock.storage.local.data.set('profile', profile);
    worker = createWorker({ chrome: mock.chrome, mockDelayMs: 1, appOrigin: '' });
    await worker.ready;
  });

  afterEach(() => {
    mock.uninstall();
  });

  const connectContent = (tabId = 7, url = 'https://mail.google.com/mail/u/0/', frameId = 0): PortPair => mock.connect('jammarly-content', { tab: { id: tabId }, frameId, url });
  const hello = (pair: PortPair, host = 'mail.google.com'): void => pair.client.postMessage({ type: 'hello', role: 'content', host, href: `https://${host}/`, frameToken: 't', extVersion: '0.1.0' } satisfies ContentToWorker);
  const attach = (pair: PortPair, fieldId = 'f1'): void => pair.client.postMessage({ type: 'field-attached', fieldId, fieldKind: 'contenteditable', label: 'Message body', docKey: 'doc-1' } satisfies ContentToWorker);

  it('answers hello with the EffectiveConfig for the host', async () => {
    const pair = connectContent();
    hello(pair);
    const config = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'config' }>>(pair, 'config')[0]);
    expect(config.config.host).toBe('mail.google.com');
    expect(config.config.context).toBe('email');
    expect(config.config.consented).toBe(true);
    expect(config.config.engineReady).toBe(true);
    expect(config.config.userSalt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('registers fields, broadcasts field-state / field-removed to panels and lists them on panel hello', async () => {
    const content = connectContent();
    hello(content);
    attach(content);
    const panel = mock.connect('jammarly-sidepanel');
    panel.client.postMessage({ type: 'hello', role: 'sidepanel', windowId: 1 } satisfies PanelToWorker);
    const fields = await waitFor(() => msgs<Extract<WorkerToPanel, { type: 'fields' }>>(panel, 'fields')[0]);
    expect(fields.fields.map((f) => f.fieldId)).toEqual(['f1']);
    expect(fields.fields[0]).toMatchObject({ tabId: 7, frameId: 0, host: 'mail.google.com', status: 'idle', checkedBy: 'rules', label: 'Message body' });
    const panelConfig = msgs<Extract<WorkerToPanel, { type: 'config' }>>(panel, 'config')[0]!;
    expect(panelConfig.config.host).toBe('mail.google.com');
    expect('apiKey' in panelConfig.settings).toBe(false);
    expect(panelConfig.settings.hasApiKey).toBe(false);
    expect(panelConfig.sync).toBeNull();

    content.client.postMessage({ type: 'field-state', state: { fieldId: 'f1', host: 'mail.google.com', fieldKind: 'contenteditable', label: 'Message body', version: 3, textPreview: 'Hi', wordCount: 1, suggestions: [], status: 'clean', checkedBy: 'deep', active: true, undoAvailable: 0, transactions: [] } } satisfies ContentToWorker);
    const state = await waitFor(() => msgs<Extract<WorkerToPanel, { type: 'field-state' }>>(panel, 'field-state').find((m) => m.state.version === 3));
    expect(state.state.tabId).toBe(7);
    expect(state.state.active).toBe(true);
    expect(worker.hub.activeField(7)?.fieldId).toBe('f1');

    content.client.postMessage({ type: 'field-detached', fieldId: 'f1' } satisfies ContentToWorker);
    await waitFor(() => msgs<Extract<WorkerToPanel, { type: 'field-removed' }>>(panel, 'field-removed')[0]);
    expect(worker.hub.fields()).toHaveLength(0);
  });

  it('routes panel actions to the owning content port and never for panel:* fields', async () => {
    const gmail = connectContent(7);
    hello(gmail);
    attach(gmail, 'f1');
    const slack = connectContent(8, 'https://app.slack.com/client');
    hello(slack, 'app.slack.com');
    attach(slack, 'f2');
    await mock.flush();
    const panel = mock.connect('jammarly-sidepanel');
    panel.client.postMessage({ type: 'panel-action', action: { type: 'accept', fieldId: 'f2', suggestionId: 's1' } } satisfies PanelToWorker);
    panel.client.postMessage({ type: 'panel-action', action: { type: 'recheck', fieldId: 'panel:1' } } satisfies PanelToWorker);
    await mock.flush();
    expect(msgs(slack, 'panel-action')).toEqual([{ type: 'panel-action', action: { type: 'accept', fieldId: 'f2', suggestionId: 's1' } }]);
    expect(msgs(gmail, 'panel-action')).toHaveLength(0);
    expect(worker.hub.sendPanelAction({ type: 'recheck', fieldId: 'panel:1' })).toBe(false);
    expect(worker.hub.sendPanelAction({ type: 'recheck', fieldId: 'nope' })).toBe(false);
  });

  it('runs a content check: progress and result on the port, mirrored to panels', async () => {
    const content = connectContent();
    hello(content);
    attach(content);
    const panel = mock.connect('jammarly-sidepanel');
    content.client.postMessage({ type: 'check', request: request(TEXT) } satisfies ContentToWorker);
    const result = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'check-result' }>>(content, 'check-result')[0]);
    expect(result.result.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(result.result.fromCache).toBe(false);
    expect(msgs(content, 'check-progress').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => msgs(panel, 'check-result')[0]);
  });

  it('answers a scratch check on the panel port only', async () => {
    const content = connectContent();
    hello(content);
    const panel = mock.connect('jammarly-sidepanel');
    panel.client.postMessage({ type: 'check', request: request(TEXT, { fieldId: 'panel:1', host: 'sidepanel', fieldKind: 'scratch', context: 'other' }) } satisfies PanelToWorker);
    const result = await waitFor(() => msgs<Extract<WorkerToPanel, { type: 'check-result' }>>(panel, 'check-result')[0]);
    expect(result.result.fieldId).toBe('panel:1');
    expect(result.result.suggestions.some((s) => s.rule === 'repeated_word')).toBe(true);
    expect(msgs(content, 'check-result')).toHaveLength(0);
  });

  it('set-goals writes global settings or a site override and rechecks fields on that host', async () => {
    const gmail = connectContent(7);
    hello(gmail);
    attach(gmail, 'f1');
    const slack = connectContent(8, 'https://app.slack.com/client');
    hello(slack, 'app.slack.com');
    attach(slack, 'f2');
    await mock.flush();
    const panel = mock.connect('jammarly-sidepanel');
    const goals = { audience: 'expert', formality: 'formal', domain: 'business', intent: 'convince' } as const;
    panel.client.postMessage({ type: 'set-goals', goals, scope: 'host', host: 'app.slack.com' } satisfies PanelToWorker);
    await waitFor(() => worker.core.profile().sites.overrides['app.slack.com']);
    expect(worker.core.profile().sites.overrides['app.slack.com']?.value.goals).toEqual(goals);
    expect(worker.core.profile().settings.goals.value.formality).toBe('neutral');
    await waitFor(() => msgs(slack, 'panel-action').some((m) => (m as { action: { type: string } }).action.type === 'recheck'));
    expect(msgs(gmail, 'panel-action').some((m) => (m as { action: { type: string } }).action.type === 'recheck')).toBe(false);

    panel.client.postMessage({ type: 'set-goals', goals: { ...goals, formality: 'informal' }, scope: 'global' } satisfies PanelToWorker);
    await waitFor(() => worker.core.profile().settings.goals.value.formality === 'informal');
    await waitFor(() => msgs(gmail, 'panel-action').some((m) => (m as { action: { type: string } }).action.type === 'recheck'));
    const cfg = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'config' }>>(gmail, 'config').find((m) => m.config.goals.formality === 'informal'));
    expect(cfg.config.goals.formality).toBe('informal');
  });

  it('dismiss reasons: not_this_site mutes on the host, never mutes globally, core correctness only stores the dismissal', async () => {
    const content = connectContent();
    hello(content);
    attach(content);
    await mock.flush();
    const dismiss = (rule: string, reason: 'not_this_site' | 'never' | 'not_error', fingerprint: string): void =>
      content.client.postMessage({ type: 'dismiss', fieldId: 'f1', suggestionId: 's', fingerprint, rule, docKey: 'doc-1', reason } satisfies ContentToWorker);
    dismiss('hedging', 'not_this_site', 'fp1');
    await waitFor(() => worker.core.profile().rules.muted.some((m) => m.value === 'hedging@mail.google.com'));
    dismiss('cliche', 'never', 'fp2');
    await waitFor(() => worker.core.profile().rules.muted.some((m) => m.value === 'cliche'));
    dismiss('spelling', 'never', 'fp3');
    dismiss('intensifier', 'not_error', 'fp4');
    await mock.flush(10);
    expect(worker.core.profile().rules.muted.some((m) => m.value === 'spelling')).toBe(false);
    expect([...worker.core.dismissed('doc-1')].sort()).toEqual(['fp1', 'fp2', 'fp3', 'fp4']);
    const cfg = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'config' }>>(content, 'config').find((m) => m.config.mutedRules.includes('cliche') && m.config.mutedRules.includes('hedging')));
    expect(cfg.config.mutedRules).toEqual(['cliche', 'hedging']);
  });

  it('add-to-dictionary normalizes the word and broadcasts config to every content port; toggle-host flips sites.disabled', async () => {
    const gmail = connectContent(7);
    hello(gmail);
    const slack = connectContent(8, 'https://app.slack.com/client');
    hello(slack, 'app.slack.com');
    await mock.flush();
    gmail.client.postMessage({ type: 'add-to-dictionary', word: '  Jammarly ' } satisfies ContentToWorker);
    const cfg = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'config' }>>(slack, 'config').find((m) => m.config.dictionary.includes('jammarly')));
    expect(cfg.config.dictionary).toEqual(['jammarly']);

    gmail.client.postMessage({ type: 'toggle-host', enabled: false } satisfies ContentToWorker);
    const off = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'config' }>>(gmail, 'config').find((m) => !m.config.enabledOnHost));
    expect(off.config.enabledOnHost).toBe(false);
    gmail.client.postMessage({ type: 'toggle-host', enabled: true } satisfies ContentToWorker);
    await waitFor(() => worker.core.configFor('mail.google.com').enabledOnHost);
  });

  it('apply-report records applied fingerprints so they are filtered from the next result; ping is answered', async () => {
    const content = connectContent();
    hello(content);
    attach(content);
    content.client.postMessage({ type: 'check', request: request(TEXT) } satisfies ContentToWorker);
    const first = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'check-result' }>>(content, 'check-result')[0]);
    const repeated = first.result.suggestions.find((s) => s.rule === 'repeated_word')!;
    content.client.postMessage({ type: 'apply-report', report: { fieldId: 'f1', appliedIds: [repeated.id], skippedIds: [], pendingRewriteIds: [], transactionId: 't1' } } satisfies ContentToWorker);
    await waitFor(() => worker.core.applied('f1').has(repeated.fingerprint));
    content.client.postMessage({ type: 'check', request: request(TEXT, { version: 2 }) } satisfies ContentToWorker);
    const second = await waitFor(() => msgs<Extract<WorkerToContent, { type: 'check-result' }>>(content, 'check-result')[1]);
    expect(second.result.suggestions.some((s) => s.rule === 'repeated_word')).toBe(false);

    const before = mock.runtime.getPlatformInfoCalls;
    content.client.postMessage({ type: 'ping' } satisfies ContentToWorker);
    await waitFor(() => msgs(content, 'ping')[0]);
    expect(mock.runtime.getPlatformInfoCalls).toBe(before + 1);
  });

  it('disconnecting a content port removes its fields and cancels their checks', async () => {
    const content = connectContent();
    hello(content);
    attach(content);
    const panel = mock.connect('jammarly-sidepanel');
    await mock.flush();
    expect(worker.hub.contentPortCount()).toBe(1);
    content.client.disconnect();
    await waitFor(() => msgs(panel, 'field-removed')[0]);
    expect(worker.hub.contentPortCount()).toBe(0);
    expect(worker.hub.fields()).toHaveLength(0);
  });
});
