/**
 * Service-worker e2e: a scratch check over the side-panel port with the mock engine (first run from the model,
 * second run from the block cache), the smoke `ping` contract and the no-secrets `get-settings` reply.
 *
 * Storage is seeded from an extension page (chrome.storage.local is available there) rather than through the
 * fixture's `setSettings`: that helper evaluates inside the first service-worker instance Chromium starts at
 * install, which Chromium stops again moments later, so the handle is stale by the time a spec runs. The extension
 * id is read from EXTENSION_ID (pinned by the manifest `key`) so the spec never races the `serviceworker` event.
 */
import { test, expect } from './fixtures';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitParagraphs } from '../../../../packages/shared/src/text';

const here = path.dirname(fileURLToPath(import.meta.url));
const idFile = path.resolve(here, '..', '..', 'EXTENSION_ID');
const PINNED_ID = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : '';

const TEXT = 'I just wanted to kind of touch base and see if maybe you could possibly send me the the report when you get a chance.';

interface Suggestion {
  rule: string;
  range: { start: number; end: number };
}
interface CheckResult {
  fieldId: string;
  version: number;
  suggestions: Suggestion[];
  fromCache: boolean;
  error?: { code: string };
}

const CONSENTED_PROFILE = {
  schemaVersion: 1,
  version: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'e2e',
  settings: { privacy: { value: { storeSnippets: true, retentionDays: 90, learningEnabled: true, consentAt: '2026-01-01T00:00:00.000Z' }, hlc: '1700000000000-0-e2e' } },
};

test.describe('service worker', () => {
  /** Opens the side-panel page (an extension page) and seeds chrome.storage.local from it. */
  async function panelPage(context: import('@playwright/test').BrowserContext, extensionId: string, settings: Record<string, unknown>): Promise<import('@playwright/test').Page> {
    const id = PINNED_ID || extensionId;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
    await page.evaluate((s) => new Promise<void>((resolve) => chrome.storage.local.set(s, () => resolve())), settings);
    // Let the worker observe the storage change before the first message.
    await page.waitForTimeout(200);
    return page;
  }

  test('answers a scratch check over the side-panel port with the mock engine, then serves it from cache', async ({ context, extensionId }) => {
    const page = await panelPage(context, extensionId, { settings: { provider: 'mock', apiKey: '' }, profile: CONSENTED_PROFILE });
    const blocks = splitParagraphs(TEXT);

    const results = await page.evaluate(
      async ({ text, blocks }) => {
        const port = chrome.runtime.connect({ name: 'jammarly-sidepanel' });
        const received: { type: string; result?: CheckResult }[] = [];
        port.onMessage.addListener((m: { type: string; result?: CheckResult }) => received.push(m));
        const waitFor = (pred: () => boolean): Promise<void> =>
          new Promise((resolve, reject) => {
            const start = Date.now();
            const tick = (): void => {
              if (pred()) resolve();
              else if (Date.now() - start > 15_000) reject(new Error('timeout; got ' + JSON.stringify(received.map((r) => r.type))));
              else setTimeout(tick, 25);
            };
            tick();
          });
        port.postMessage({ type: 'hello', role: 'sidepanel' });
        await waitFor(() => received.some((m) => m.type === 'config'));
        const request = (version: number) => ({
          fieldId: 'panel:1',
          version,
          text,
          blocks,
          dirtyBlockHashes: 'all',
          pass: 'deep',
          host: 'sidepanel',
          context: 'other',
          fieldKind: 'scratch',
          protectedRanges: [],
        });
        port.postMessage({ type: 'check', request: request(1) });
        await waitFor(() => received.some((m) => m.type === 'check-result' && m.result?.version === 1));
        port.postMessage({ type: 'check', request: request(2) });
        await waitFor(() => received.some((m) => m.type === 'check-result' && m.result?.version === 2));
        const first = received.find((m) => m.type === 'check-result' && m.result?.version === 1)!.result!;
        const second = received.find((m) => m.type === 'check-result' && m.result?.version === 2)!.result!;
        const progress = received.filter((m) => m.type === 'check-progress').length;
        const config = received.find((m) => m.type === 'config') as { config?: { consented: boolean; engineReady: boolean }; settings?: Record<string, unknown> } | undefined;
        return { first, second, progress, config: config?.config, settings: config?.settings };
      },
      { text: TEXT, blocks },
    );

    expect(results.config?.consented).toBe(true);
    expect(results.config?.engineReady).toBe(true);
    expect(results.settings && 'apiKey' in results.settings).toBe(false);
    expect(results.first.error).toBeUndefined();
    expect(results.first.fromCache).toBe(false);
    expect(results.first.suggestions.length).toBeGreaterThanOrEqual(3);
    const repeated = results.first.suggestions.find((s) => s.rule === 'repeated_word');
    expect(repeated).toBeDefined();
    expect(['the the', 'the ']).toContain(TEXT.slice(repeated!.range.start, repeated!.range.end));
    expect(results.progress).toBeGreaterThanOrEqual(2);
    expect(results.second.fromCache).toBe(true);
    expect(results.second.suggestions.map((s) => s.rule)).toEqual(results.first.suggestions.map((s) => s.rule));
  });

  test('keeps the smoke ping contract and never exposes the API key to pages', async ({ context, extensionId }) => {
    const page = await panelPage(context, extensionId, { settings: { provider: 'mock', apiKey: 'sk-should-not-leak' } });
    const replies = await page.evaluate(async () => {
      const ping = await chrome.runtime.sendMessage({ type: 'ping' });
      const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
      return { ping, settings };
    });
    expect(replies.ping).toEqual({ ok: true, type: 'ok' });
    expect(replies.settings.ok).toBe(true);
    expect(replies.settings.type).toBe('settings');
    expect('apiKey' in replies.settings.settings).toBe(false);
    expect('pairing' in replies.settings.settings).toBe(false);
    expect(replies.settings.settings.hasApiKey).toBe(true);
    expect(replies.settings.settings.provider).toBe('mock');
    expect(replies.settings.settings.paired).toBe(false);
    expect(JSON.stringify(replies.settings)).not.toContain('sk-should-not-leak');
  });
});
