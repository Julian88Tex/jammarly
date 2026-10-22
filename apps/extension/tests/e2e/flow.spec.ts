/**
 * Full in-page flow with the built extension and the mock engine: a textarea gets underlines, the floating button
 * shows a count, hovering a word opens the card, Accept rewrites the text, and the accept-all menu applies the rest.
 *
 * Storage is seeded from an extension page (see background.spec.ts for why the fixture's setSettings is not used).
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const idFile = path.resolve(here, '..', '..', 'EXTENSION_ID');
const PINNED_ID = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : '';

const CONSENTED_PROFILE = {
  schemaVersion: 1,
  version: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'e2e',
  settings: {
    privacy: {
      value: { storeSnippets: true, retentionDays: 90, learningEnabled: true, consentAt: '2026-01-01T00:00:00.000Z' },
      hlc: '1700000000000-0000-e2e',
    },
  },
};

async function seed(context: import('@playwright/test').BrowserContext, extensionId: string): Promise<void> {
  const id = PINNED_ID || extensionId;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
  await page.evaluate(
    (s) => new Promise<void>((resolve) => chrome.storage.local.set(s, () => resolve())),
    { settings: { provider: 'mock', apiKey: '', debounceMs: 300, showFloatingButton: true }, profile: CONSENTED_PROFILE },
  );
  await page.waitForTimeout(300);
  await page.close();
}

/** Shadow-root-aware helpers: the overlay lives under <jammarly-root>'s open shadow root. */
function shadow(page: Page) {
  return page.locator('jammarly-root');
}

test.describe('in-page flow (mock engine)', () => {
  test('textarea gets underlines, a count badge, a hover card, and Accept rewrites the text', async ({ context, extensionId, fixtureUrl }) => {
    await seed(context, extensionId);
    const page = await context.newPage();
    await page.goto(fixtureUrl('textarea.html'));
    await expect(page.locator('html')).toHaveAttribute('data-jammarly', 'loaded');

    const ta = page.locator('#main');
    await ta.click();
    await page.keyboard.press('End');

    // The overlay host appears once a field attaches.
    await expect(shadow(page)).toHaveCount(1, { timeout: 10_000 });

    // Underlines: local rules fire first (the the, i), then the mock engine adds the rest.
    const underlines = shadow(page).locator('[data-jm="underline"]');
    await expect.poll(async () => underlines.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

    // The floating button shows a count.
    const button = shadow(page).locator('[data-jm="button"]');
    await expect(button).toBeVisible();
    await expect(shadow(page).locator('[data-jm="count"]')).toBeVisible({ timeout: 15_000 });

    // Hover the underline covering "the the" and accept from the card.
    const before = await ta.inputValue();
    const target = underlines.filter({ has: page.locator(':scope') }).first();
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 1);
    const card = shadow(page).locator('[data-jm="card"]');
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('[data-jm="card-title"]')).not.toBeEmpty();
    await card.locator('[data-jm="accept"]').click();
    await expect.poll(async () => ta.inputValue()).not.toBe(before);
  });

  test('the accept-all menu applies the grammar tier in one go and offers Undo', async ({ context, extensionId, fixtureUrl }) => {
    await seed(context, extensionId);
    const page = await context.newPage();
    await page.goto(fixtureUrl('textarea.html'));
    const ta = page.locator('#main');
    await ta.click();
    await page.keyboard.press('End');
    const underlines = shadow(page).locator('[data-jm="underline"]');
    await expect.poll(async () => underlines.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await expect(shadow(page).locator('[data-jm="count"]')).toBeVisible({ timeout: 15_000 });

    const before = await ta.inputValue();
    // Park the pointer away from the text so no hover card is open, then open the menu from the button.
    await page.mouse.move(5, 5);
    await page.keyboard.press('Escape');
    await expect(shadow(page).locator('[data-jm="card"]')).toBeHidden();
    await shadow(page).locator('[data-jm="button"]').click();
    const menu = shadow(page).locator('[data-jm="menu"]');
    await expect(menu).toBeVisible();
    const grammar = menu.locator('[data-jm="menu-item"]', { hasText: /Accept all grammar/ });
    await expect(grammar).toBeVisible();
    await grammar.click();
    // Each edit is verified at the next frame and at +150 ms; the toast marks the end of the transaction.
    const toast = shadow(page).locator('[data-jm="toast"]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/Applied \d+ changes/);
    const after = await ta.inputValue();
    expect(after).not.toBe(before);
    expect(after).not.toContain('the the');
    expect(after).toContain('could have');

    await toast.locator('[data-jm="toast-undo"]').click();
    await expect.poll(async () => ta.inputValue()).toBe(before);
  });
  test('popup-style panel actions accept everything and turn the field off without the floating button', async ({ context, extensionId, fixtureUrl }) => {
    const id = PINNED_ID || extensionId;
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
    await setup.evaluate(
      (s) => new Promise<void>((resolve) => chrome.storage.local.set(s, () => resolve())),
      { settings: { provider: 'mock', apiKey: '', debounceMs: 300, showFloatingButton: false }, profile: CONSENTED_PROFILE },
    );
    await setup.waitForTimeout(300);

    const page = await context.newPage();
    await page.goto(fixtureUrl('textarea.html'));
    const ta = page.locator('#main');
    await ta.click();
    await page.keyboard.press('End');
    const underlines = shadow(page).locator('[data-jm="underline"]');
    await expect.poll(async () => underlines.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await expect(shadow(page).locator('[data-jm="button"]')).toBeHidden();
    const before = await ta.inputValue();

    // The popup talks to the worker over the panel port; drive the same messages from an extension page.
    const send = (action: Record<string, unknown>) =>
      setup.evaluate(
        (src) =>
          new Promise<void>((resolve, reject) => {
            const port = chrome.runtime.connect({ name: 'jammarly-sidepanel' });
            const timer = setTimeout(() => reject(new Error('no fields message')), 5000);
            port.onMessage.addListener((msg: { type: string; fields?: { fieldId: string; active: boolean }[] }) => {
              if (msg.type !== 'fields' || !msg.fields?.length) return;
              clearTimeout(timer);
              const fieldId = msg.fields[0]!.fieldId;
              port.postMessage({ type: 'panel-action', action: { ...src, fieldId } });
              setTimeout(() => {
                port.disconnect();
                resolve();
              }, 200);
            });
            port.postMessage({ type: 'hello', role: 'sidepanel' });
          }),
        action,
      );

    await send({ type: 'accept-all', scope: { group: 'all' } });
    await expect.poll(async () => ta.inputValue(), { timeout: 10_000 }).not.toContain('the the');
    expect(await ta.inputValue()).not.toBe(before);

    await send({ type: 'set-field-enabled', enabled: false });
    await expect.poll(async () => underlines.count(), { timeout: 5_000 }).toBe(0);
  });
});
