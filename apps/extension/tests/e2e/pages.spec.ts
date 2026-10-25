/**
 * The three extension pages load in headless Chromium against the built dist/ and render a sane state even though
 * the service worker may still be a placeholder (answers only `ping`): no uncaught errors, no console errors.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`Uncaught ${err.message}`));
  return errors;
}

test.describe('extension pages', () => {
  test('side panel renders the empty state and the scratch section without console errors', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-page', 'sidepanel');
    await expect(app).toHaveClass(/jm-panel/);
    await expect(page.getByText('Focus a text field to see suggestions')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check text' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Text to check' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check now' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Text to check' }).fill('Teh quick brown fox.');
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    await page.waitForTimeout(500);
    expect(errors.filter((e) => e.startsWith('Uncaught'))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('options page opens on #welcome with the disclosure and consent button', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(`chrome-extension://${extensionId}/options/options.html#welcome`);
    await expect(page.locator('#app')).toHaveClass(/jm-options/);
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Jammarly' })).toBeVisible();
    await expect(page.getByText('sent to Anthropic')).toBeVisible();
    await expect(page.getByRole('button', { name: 'I agree and continue' })).toBeVisible();
    await expect(page.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password');
    await page.getByRole('link', { name: 'Dictionary' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Personal dictionary' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#dictionary');
    await page.waitForTimeout(300);
    expect(errors.filter((e) => e.startsWith('Uncaught'))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('popup renders its controls without console errors', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect(page.locator('#app')).toHaveClass(/jm-popup/);
    await expect(page.getByRole('button', { name: 'Open review panel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(1);
    await expect(page.locator('.jm-cost-line')).toContainText('Today');
    await page.waitForTimeout(300);
    expect(errors.filter((e) => e.startsWith('Uncaught'))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('openSidePanelPage fixture still works with the new panel', async ({ openSidePanelPage }) => {
    const panel = await openSidePanelPage();
    await expect(panel.locator('#app')).toHaveAttribute('data-page', 'sidepanel');
    await expect(panel.getByRole('button', { name: 'Settings' })).toBeVisible();
  });

  test('adversarial: clicking Check in the scratch section never wedges the panel, whatever the worker answers', async ({ openSidePanelPage }) => {
    const panel = await openSidePanelPage();
    const errors = watchErrors(panel);
    await panel.getByRole('textbox', { name: 'Text to check' }).fill('Teh quick brown fox jumps over teh lazy dog.');
    await panel.getByRole('button', { name: 'Check', exact: true }).click();
    // Whether the worker answers with a result, an error (no key / consent) or nothing yet, the status line is present
    // and the page keeps working: the text stays, Clear is enabled and the Settings button still responds.
    await expect(panel.locator('.jm-status')).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Text to check' })).toHaveValue('Teh quick brown fox jumps over teh lazy dog.');
    await expect(panel.getByRole('button', { name: 'Clear' })).toBeEnabled();
    await panel.waitForTimeout(1500);
    const status = (await panel.locator('.jm-status').textContent()) ?? '';
    expect(status.length).toBeGreaterThan(0);
    expect(status.toLowerCase()).not.toMatch(/haiku|opus|sonnet/);
    await panel.getByRole('button', { name: 'Clear' }).click();
    await expect(panel.getByRole('textbox', { name: 'Text to check' })).toHaveValue('');
    expect(errors.filter((e) => e.startsWith('Uncaught'))).toEqual([]);
    expect(errors).toEqual([]);
    await panel.close();
  });

  test('adversarial: the popup "Set up" button reaches options.html#welcome through the worker or the tab fallback', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    const errors = watchErrors(popup);
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect(popup.locator('#app')).toHaveClass(/jm-popup/);
    const setup = popup.getByRole('button', { name: 'Set up' });
    if ((await setup.count()) === 0) {
      // A profile with consent and a key already recorded hides the notice; nothing to click.
      await popup.close();
      return;
    }
    const opened = context.waitForEvent('page', { timeout: 15_000 });
    await setup.click();
    const optionsPage = await opened;
    await optionsPage.waitForLoadState('domcontentloaded');
    const url = new URL(optionsPage.url());
    expect(url.pathname).toBe('/options/options.html');
    expect(url.hash).toBe('#welcome');
    await expect(optionsPage.getByRole('heading', { level: 1, name: 'Welcome to Jammarly' })).toBeVisible();
    expect(errors.filter((e) => e.startsWith('Uncaught'))).toEqual([]);
    await optionsPage.close();
    await popup.close();
  });
});
