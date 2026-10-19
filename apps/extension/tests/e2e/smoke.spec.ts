import { test, expect } from './fixtures';

test.describe('extension smoke', () => {
  test('loads, injects the content script and answers a ping from the service worker', async ({ page, fixtureUrl }) => {
    await page.goto(fixtureUrl('textarea.html'));
    await expect(page.locator('html')).toHaveAttribute('data-jammarly', 'loaded');
    await expect(page.locator('html')).toHaveAttribute('data-jammarly-sw', JSON.stringify({ ok: true, type: 'ok' }));
  });

  test('injects into same-origin iframes', async ({ page, fixtureUrl }) => {
    await page.goto(fixtureUrl('iframe.html'));
    const frame = page.frameLocator('#frame');
    await expect(frame.locator('html')).toHaveAttribute('data-jammarly', 'loaded');
  });

  test('extension pages are reachable', async ({ openSidePanelPage }) => {
    const panel = await openSidePanelPage();
    await expect(panel.locator('#app')).toHaveAttribute('data-page', 'sidepanel');
  });
});
