/**
 * Overlay UI in real Chromium: the parts jsdom cannot run (Popover API top layer, adoptedStyleSheets, real pointer
 * hit-testing against fragment rects, color-mix tint, button geometry). The harness bundle is built from
 * tests/e2e/harness/overlay-harness.ts before the suite runs.
 */
import { test, expect, bundleFixtureScript } from './fixtures';
import type { Page } from '@playwright/test';

test.beforeAll(async () => {
  await bundleFixtureScript('tests/e2e/harness/overlay-harness.ts', 'overlay-harness.js');
});

async function openHarness(page: Page, fixtureUrl: (n: string) => string): Promise<void> {
  await page.goto(fixtureUrl('overlay-harness.html'));
  await expect(page.locator('html')).toHaveAttribute('data-jm-harness', 'ready');
}

type Logged = { name: string; args: unknown[] };
async function events(page: Page): Promise<Logged[]> {
  return page.evaluate(() => window.__jm.events);
}

test.describe('overlay UI (Chromium)', () => {
  test('single host with adopted styles, fixed non-interactive host, underlines under the flagged words', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const info = await page.evaluate(() => {
      const host = document.querySelector('jammarly-root')!;
      const root = host.shadowRoot!;
      const cs = getComputedStyle(host);
      return {
        hosts: document.querySelectorAll('jammarly-root').length,
        marker: host.hasAttribute('data-jammarly-shadow-root'),
        adopted: root.adoptedStyleSheets.length,
        inlineStyle: root.querySelector('style') !== null,
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        underlines: root.querySelectorAll('[data-jm="underline"]').length,
        debug: window.__jm.debug() as { styleMode: string; underlines: number },
      };
    });
    expect(info.hosts).toBe(1);
    expect(info.marker).toBe(true);
    expect(info.adopted).toBe(1);
    expect(info.inlineStyle).toBe(false);
    expect(info.debug.styleMode).toBe('adopted');
    expect(info.position).toBe('fixed');
    expect(info.pointerEvents).toBe('none');
    expect(info.zIndex).toBe('2147483646');
    expect(info.underlines).toBe(3);

    const geo = await page.evaluate(() => {
      const span = document.querySelector('[data-err="s1"]')!.getBoundingClientRect();
      const root = document.querySelector('jammarly-root')!.shadowRoot!;
      const ul = root.querySelector<HTMLElement>('[data-jm="underline"][data-suggestion-id="s1"]')!;
      const r = ul.getBoundingClientRect();
      const clarity = root.querySelector<HTMLElement>('[data-jm="underline"][data-suggestion-id="s3"]')!;
      return {
        span: { left: span.left, right: span.right, bottom: span.bottom },
        ul: { left: r.left, right: r.right, bottom: r.bottom, height: r.height },
        color: getComputedStyle(ul).backgroundColor,
        clarityColor: getComputedStyle(clarity).backgroundColor,
        radius: getComputedStyle(ul).borderRadius,
      };
    });
    expect(Math.abs(geo.ul.left - geo.span.left)).toBeLessThan(1.5);
    expect(Math.abs(geo.ul.right - geo.span.right)).toBeLessThan(1.5);
    expect(Math.abs(geo.ul.bottom - geo.span.bottom)).toBeLessThan(1.5);
    expect(geo.ul.height).toBe(2);
    expect(geo.radius).toBe('1px');
    expect(geo.color).toBe('rgb(224, 55, 44)'); // #E0372C
    expect(geo.clarityColor).toBe('rgb(42, 125, 225)'); // #2A7DE1
  });

  test('hovering a word opens the popover card below it; clicking the replacement accepts', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const word = page.locator('[data-err="s1"]');
    const card = page.locator('[data-jm="card"]');
    await word.hover();
    await expect(card).toHaveAttribute('data-open', 'true');
    await expect(card).toHaveAttribute('data-suggestion-id', 's1');
    expect(await card.evaluate((el) => el.matches(':popover-open'))).toBe(true);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-jm="card-category"]')).toHaveText('Correctness');
    await expect(card.locator('[data-jm="card-title"]')).toHaveText('Correct the spelling');
    await expect(card.locator('[data-jm="card-original"]')).toHaveText('teh');
    await expect(card.locator('[data-jm="replacement"]')).toHaveText('the');
    await expect(card.locator('[data-jm="card-badge"]')).toHaveText('Auto');
    await expect(card.locator('[data-jm="card-footer"]')).toContainText('Jammarly helps you write clearly and mistake-free.');

    // placed below the highlight, left-aligned, inside the viewport
    const cardBox = (await card.boundingBox())!;
    const wordBox = (await word.boundingBox())!;
    expect(cardBox.y).toBeGreaterThanOrEqual(wordBox.y + wordBox.height + 7);
    expect(Math.abs(cardBox.x - wordBox.x)).toBeLessThan(2);
    expect(cardBox.width).toBeGreaterThanOrEqual(280);
    expect(cardBox.width).toBeLessThanOrEqual(360);

    // active underline: 3 px and a tint behind the text
    const active = await page.evaluate(() => {
      const root = document.querySelector('jammarly-root')!.shadowRoot!;
      const ul = root.querySelector<HTMLElement>('[data-jm="underline"][data-suggestion-id="s1"]')!;
      const tint = root.querySelector<HTMLElement>('[data-jm="underline-tint"]');
      return { height: ul.getBoundingClientRect().height, tint: tint ? getComputedStyle(tint).backgroundColor : null, tintHidden: tint?.hasAttribute('hidden') };
    });
    expect(active.height).toBe(3);
    expect(active.tint).toMatch(/^(rgba|color)\(/);
    expect(active.tintHidden).toBe(false);

    await card.locator('[data-jm="replacement"]').click();
    await expect(card).toHaveAttribute('data-open', 'false');
    const log = await events(page);
    expect(log.some((e) => e.name === 'onCardShown' && e.args[0] === 'f1' && e.args[1] === 's1')).toBe(true);
    expect(log.some((e) => e.name === 'onAccept' && e.args[0] === 'f1' && e.args[1] === 's1')).toBe(true);
    expect(log.some((e) => e.name === 'onCardHidden' && e.args[1] === 's1')).toBe(true);
    // the intro footer is gone after the first accept
    await page.locator('[data-err="s2"]').hover();
    await expect(card).toHaveAttribute('data-suggestion-id', 's2');
    await expect(card).toBeVisible(); // a second open must really show the popover again
    expect(await card.evaluate((el) => el.matches(':popover-open'))).toBe(true);
    await expect(card.locator('[data-jm="card-footer"]')).toHaveCount(0);
    await expect(card.locator('[data-jm="option"]')).toHaveCount(2);
  });

  test('card closes after the leave grace, on click outside, and on Esc; a long explanation collapses', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const card = page.locator('[data-jm="card"]');
    const phrase = page.locator('[data-err="s3"]');
    await phrase.hover();
    await expect(card).toHaveAttribute('data-suggestion-id', 's3');
    await expect(card.locator('[data-jm="card-badge"]')).toHaveCount(0); // tier B: no badge
    await expect(card.locator('[data-jm="learn-more"]')).toHaveText('Learn more');
    await card.locator('[data-jm="learn-more"]').click();
    await expect(card.locator('[data-jm="explanation"]')).toHaveAttribute('data-expanded', 'true');
    await expect(card.locator('[data-jm="learn-more"]')).toHaveCount(0);

    // pointer leaves to empty space (inside the viewport): closes after the grace period
    await page.mouse.move(1000, 600, { steps: 4 });
    await expect(card).toHaveAttribute('data-open', 'false', { timeout: 2000 });
    await expect(card).toBeHidden();

    // click opens immediately, click outside closes
    await page.locator('[data-err="s1"]').click();
    await expect(card).toHaveAttribute('data-open', 'true');
    await expect(card).toBeVisible();
    await page.mouse.click(1000, 620);
    await expect(card).toHaveAttribute('data-open', 'false');

    // Esc typed in the page closes it too
    await page.locator('[data-err="s1"]').click();
    await expect(card).toHaveAttribute('data-open', 'true');
    await page.keyboard.press('Escape');
    await expect(card).toHaveAttribute('data-open', 'false');
  });

  test('clicks inside the card never reach the page (host dialogs stay open)', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const card = page.locator('[data-jm="card"]');
    await page.locator('[data-err="s1"]').click();
    await expect(card).toHaveAttribute('data-open', 'true');
    const before = Number(await page.locator('#page-clicks').textContent());
    await card.locator('[data-jm="more"]').click();
    await expect(card.locator('[data-jm="more-panel"]')).toBeVisible();
    await card.locator('[data-jm="dismiss-reason"][data-reason="not_error"]').click();
    const after = Number(await page.locator('#page-clicks').textContent());
    expect(after).toBe(before);
    const log = await events(page);
    expect(log.some((e) => e.name === 'onDismiss' && e.args[2] === 'not_error')).toBe(true);
  });

  test('keyboard: focused card accepts with a, shortcut-safe mode leaves letters alone', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const card = page.locator('[data-jm="card"]');
    await page.evaluate(() => window.__jm.focusSuggestion('s2'));
    await expect(card).toHaveAttribute('data-open', 'true');
    expect(await page.evaluate(() => document.querySelector('jammarly-root')!.shadowRoot!.activeElement?.getAttribute('data-jm'))).toBe('card');
    await page.keyboard.press('2');
    let log = await events(page);
    expect(log.some((e) => e.name === 'onAccept' && e.args[1] === 's2' && e.args[2] === 0)).toBe(true);
    await expect(card).toHaveAttribute('data-open', 'false');

    await page.evaluate(() => window.__jm.setOptions({ shortcutSafe: true }));
    await page.evaluate(() => window.__jm.focusSuggestion('s1'));
    await expect(card).toHaveAttribute('data-open', 'true');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    const accepts = (await events(page)).filter((e) => e.name === 'onAccept').length;
    await page.keyboard.press('a');
    await page.keyboard.press('d');
    log = await events(page);
    expect(log.filter((e) => e.name === 'onAccept').length).toBe(accepts);
    expect(log.filter((e) => e.name === 'onDismiss').length).toBe(0);
    await expect(card).toHaveAttribute('data-open', 'true');
    await page.keyboard.press('Enter');
    log = await events(page);
    expect(log.filter((e) => e.name === 'onAccept').length).toBe(accepts + 1);
  });

  test('floating button sits inside the editor corner, collapses while typing, opens the menu with live counts', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const button = page.locator('[data-jm="button"][data-field-id="f1"], [data-jm="button-wrap"][data-field-id="f1"] [data-jm="button"]').first();
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('data-state', 'count');
    await expect(button.locator('[data-jm="count"]')).toHaveText('3');
    const editorBox = (await page.locator('#editor').boundingBox())!;
    const btnBox = (await button.boundingBox())!;
    expect(btnBox.width).toBe(28);
    expect(btnBox.height).toBe(28);
    expect(Math.abs(btnBox.x + btnBox.width - (editorBox.x + editorBox.width - 8))).toBeLessThan(1.5);
    expect(Math.abs(btnBox.y + btnBox.height - (editorBox.y + editorBox.height - 8))).toBeLessThan(1.5);
    expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(224, 55, 44)');

    await page.evaluate(() => window.__jm.setTyping(true));
    await expect(button).toHaveAttribute('data-state', 'collapsed');
    await expect.poll(async () => (await button.boundingBox())!.width).toBeLessThanOrEqual(7);
    await page.evaluate(() => window.__jm.setTyping(false));
    await expect(button).toHaveAttribute('data-state', 'count', { timeout: 2000 });

    await button.click();
    const menu = page.locator('[data-jm="menu"]');
    await expect(menu).toHaveAttribute('data-open', 'true');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('data-open', 'false');
    await expect(menu).toBeHidden();
    await button.click();
    await expect(menu).toBeVisible(); // re-open after close must really show the popover again
    expect(await menu.evaluate((el) => el.matches(':popover-open'))).toBe(true);
    await expect(menu.locator('[data-action="accept-grammar"]')).toHaveText('Accept all grammar (2)');
    await expect(menu.locator('[data-action="accept-style"]')).toHaveText('Accept all style and tone (1)');
    await expect(menu.locator('[data-action="accept-all"]')).toContainText('Accept everything (3)');
    const menuBox = (await menu.boundingBox())!;
    const placement = await menu.getAttribute('data-placement');
    // Anchored to the button: above when there is room, otherwise flipped below; right edges aligned.
    if (placement === 'above') expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(btnBox.y + 1);
    else expect(menuBox.y).toBeGreaterThanOrEqual(btnBox.y + btnBox.height + 7);
    expect(Math.abs(menuBox.x + menuBox.width - (btnBox.x + btnBox.width))).toBeLessThan(2);
    expect(menuBox.y).toBeGreaterThanOrEqual(8);
    await menu.locator('[data-action="accept-grammar"]').hover();
    await expect(menu.locator('[data-jm="preview-row"]')).toHaveCount(2);
    await menu.locator('[data-action="accept-grammar"]').click();
    const log = await events(page);
    expect(log.some((e) => e.name === 'onAcceptAll' && JSON.stringify(e.args) === JSON.stringify(['f1', { group: 'grammar' }]))).toBe(true);
    await expect(menu).toHaveAttribute('data-open', 'false');
  });

  test('hovering the button reveals the power menu with its two turn-off items', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    const wrap = page.locator('[data-jm="button-wrap"][data-field-id="f1"]');
    const button = wrap.locator('[data-jm="button"]');
    const power = wrap.locator('[data-jm="power"]');
    expect(await power.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await button.hover();
    await expect.poll(() => power.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await power.click();
    const menu = page.locator('[data-jm="power-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-jm="power-item"]')).toHaveText(['Turn off in this field until next visit', 'Turn off in this field forever']);
    await menu.locator('[data-duration="forever"]').click();
    const log = await events(page);
    expect(log.some((e) => e.name === 'onToggleField' && JSON.stringify(e.args) === JSON.stringify(['f1', false, 'forever']))).toBe(true);
    await expect(menu).toBeHidden();
  });

  test('a 24 px input gets its button just outside the bottom-right corner; toast with Undo', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    await page.evaluate(() => window.__jm.attachInput('chat'));
    const wrap = page.locator('[data-jm="button-wrap"][data-field-id="chat"]');
    await expect(wrap).toHaveAttribute('data-anchor', 'right');
    const button = wrap.locator('[data-jm="button"]');
    await expect(button).toBeVisible();
    const inputBox = (await page.locator('#chat').boundingBox())!;
    const btnBox = (await button.boundingBox())!;
    expect(btnBox.x).toBeGreaterThanOrEqual(inputBox.x + inputBox.width + 3);
    expect(Math.abs(btnBox.y + btnBox.height - (inputBox.y + inputBox.height))).toBeLessThan(1.5);

    await page.evaluate(() => window.__jm.toast('Applied 3 changes', 'tx-1'));
    const toast = page.locator('[data-jm="toast"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Applied 3 changes');
    const toastBox = (await toast.boundingBox())!;
    const vw = await page.evaluate(() => window.innerWidth);
    const vh = await page.evaluate(() => window.innerHeight);
    expect(Math.abs(toastBox.x + toastBox.width / 2 - vw / 2)).toBeLessThan(2);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(vh - 20);
    await toast.locator('[data-jm="toast-undo"]').click();
    await expect(toast).toHaveCount(0);
    const log = await events(page);
    expect(log.some((e) => e.name === 'onUndo' && e.args[0] === 'f1' && e.args[1] === 'tx-1')).toBe(true);
  });

  test('scrolling keeps underlines under the words; off-screen fragments are hidden', async ({ page, fixtureUrl }) => {
    await openHarness(page, fixtureUrl);
    await page.evaluate(() => window.scrollTo(0, 120));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__jm.layout());
    const geo = await page.evaluate(() => {
      const span = document.querySelector('[data-err="s1"]')!.getBoundingClientRect();
      const ul = document.querySelector('jammarly-root')!.shadowRoot!.querySelector<HTMLElement>('[data-jm="underline"][data-suggestion-id="s1"]')!.getBoundingClientRect();
      return { span: span.bottom, ul: ul.bottom };
    });
    expect(Math.abs(geo.ul - geo.span)).toBeLessThan(1.5);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__jm.layout());
    const hidden = await page.evaluate(() => {
      const root = document.querySelector('jammarly-root')!.shadowRoot!;
      return Array.from(root.querySelectorAll('[data-jm="underline"]')).every((el) => el.hasAttribute('hidden'));
    });
    expect(hidden).toBe(true);
  });
});
