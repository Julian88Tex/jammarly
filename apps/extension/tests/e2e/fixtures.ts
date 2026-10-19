/**
 * Playwright harness that loads the built extension (dist/) into a persistent Chromium context
 * and serves tests/fixtures over HTTP (content scripts do not inject into about:blank).
 *
 * Usage in a spec:
 *   import { test, expect } from './fixtures';
 *   test('...', async ({ page, fixtureUrl, extensionId, setSettings }) => { ... });
 */
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const distDir = path.join(root, 'dist');
const fixturesDir = path.join(root, 'tests', 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(fixturesDir, rel));
      if (!file.startsWith(fixturesDir)) throw new Error('path escape');
      const body = await readFile(file);
      res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        // Chromium keeps HTTP keep-alive sockets open; server.close() alone would wait for them.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type Settings = Record<string, unknown>;

type Fixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  fixtureUrl: (name: string) => string;
  /** Writes keys into chrome.storage.local from inside the service worker (the extension's settings store). */
  setSettings: (settings: Settings) => Promise<void>;
  /** Opens the side panel page directly as a tab (chrome.sidePanel UI itself cannot be driven headlessly). */
  openSidePanelPage: () => Promise<import('@playwright/test').Page>;
};

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(path.join(distDir, 'manifest.json'))) {
      throw new Error('dist/manifest.json not found. Run `npm run build` before `npm run test:e2e`.');
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // new headless mode supports extensions; old headless_shell does not
      headless: process.env.PW_HEADFUL ? false : true,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  // eslint-disable-next-line no-empty-pattern
  fixtureUrl: async ({}, use) => {
    const server = await startFixtureServer();
    await use((name: string) => new URL(name, server.url).toString());
    await server.close();
  },
  setSettings: async ({ serviceWorker }, use) => {
    await use(async (settings: Settings) => {
      await serviceWorker.evaluate(
        (s) => new Promise<void>((resolve) => chrome.storage.local.set(s, () => resolve())),
        settings,
      );
    });
  },
  openSidePanelPage: async ({ context, extensionId }, use) => {
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
      return page;
    });
  },
});

export { expect } from '@playwright/test';
