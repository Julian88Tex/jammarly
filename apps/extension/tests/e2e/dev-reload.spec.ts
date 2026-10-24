/**
 * Self-update of an unpacked install: when build.json in the extension folder changes (a `git pull` of the
 * extension-build branch), the running extension notices and reloads itself. This checks the real Chrome behaviour
 * the feature depends on: the alarm is armed for an unpacked install, packaged files are read from disk on every fetch
 * (so the worker sees the new build.json while it still runs the old code), and the check reloads the extension.
 */
import { test as base, chromium, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', '..', 'dist');

const test = base;

test('an unpacked install reloads itself when a newer build lands in its folder', async () => {
  test.setTimeout(120_000);
  const dir = await mkdtemp(path.join(tmpdir(), 'jammarly-dev-reload-'));
  try {
    await cp(distDir, dir, { recursive: true });
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: process.env.PW_HEADFUL ? false : true,
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    try {
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
      const id = new URL(sw.url()).host;
      // Extension APIs are driven from an extension page (Playwright's worker handle has no chrome.* bindings).
      const openPage = async () => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/popup/popup.html`);
        return page;
      };
      const page = await openPage();
      await expect.poll(async () => page.evaluate(async () => Boolean(await chrome.alarms.get('jammarly-dev-reload'))), { timeout: 15_000 }).toBe(true);
      const running = await page.evaluate(async () => (await chrome.storage.session.get('jammarlyRunningBuild')).jammarlyRunningBuild as string);
      expect(running).toContain('@');

      // A newer build lands on disk, and Chrome serves it without a reload.
      const buildPath = path.join(dir, 'build.json');
      const build = JSON.parse(await readFile(buildPath, 'utf8')) as Record<string, string>;
      await writeFile(buildPath, JSON.stringify({ ...build, commit: 'newer-build', builtAt: new Date().toISOString() }));
      const seen = await page.evaluate(async () => (await (await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' })).json()).commit as string);
      expect(seen).toBe('newer-build');

      // Fire the check now instead of waiting a minute; the reload closes extension pages.
      const closed = page.waitForEvent('close', { timeout: 30_000 });
      await page.evaluate(() => chrome.alarms.create('jammarly-dev-reload', { when: Date.now() + 200 }));
      await closed;
      // Coming back with the new files is Chrome's own behaviour for folders added with "Load unpacked" (the same
      // mechanism the reload arrow on chrome://extensions uses). A command-line-loaded test install is not
      // re-enabled after chrome.runtime.reload(), so the test stops at the reload itself.
    } finally {
      await context.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
