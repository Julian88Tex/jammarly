/**
 * Adapter behaviour in a real Chromium, without the extension: the adapter bundle (src/content/adapters/test-entry.ts)
 * is built with esbuild inside the test and injected into the fixture pages served by the fixture server.
 */
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

let bundle = '';
let server: Awaited<ReturnType<typeof startFixtureServer>>;

interface RectJson {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
interface BoxJson {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.join(root, 'src', 'content', 'adapters', 'test-entry.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
    target: ['chrome120'],
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]!.text;
  server = await startFixtureServer();
});

test.afterAll(async () => {
  await server.close();
});

async function open(page: Page, fixture: string): Promise<void> {
  await page.goto(new URL(fixture, server.url).toString());
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => typeof window.__jammarlyAdapters === 'object');
}

function expectInside(rects: RectJson[], box: BoxJson, tolerance = 1): void {
  expect(rects.length).toBeGreaterThan(0);
  for (const r of rects) {
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.left).toBeGreaterThanOrEqual(box.left - tolerance);
    expect(r.top).toBeGreaterThanOrEqual(box.top - tolerance);
    expect(r.right).toBeLessThanOrEqual(box.right + tolerance);
    expect(r.bottom).toBeLessThanOrEqual(box.bottom + tolerance);
  }
}

test.describe('textarea adapter', () => {
  test('execCommand rung applies with real undo, and rects lie inside the field', async ({ page }) => {
    await open(page, 'textarea.html');
    const before = await page.inputValue('#main');
    const result = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#main') as HTMLTextAreaElement;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const text = adapter.getText();
      const start = text.indexOf('tomorow');
      const outcome = await adapter.applyEdit({ range: { start, end: start + 'tomorow'.length }, original: 'tomorow', replacement: 'tomorrow' });
      const rects = adapter.getRangeRects({ start, end: start + 'tomorrow'.length }).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }));
      const b = el.getBoundingClientRect();
      return { outcome, rects, box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, label: adapter.getLabel(), focused: adapter.isFocused() };
    });
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.rung).toBe('execCommand');
    expect(result.outcome.text).toBe(before.replace('tomorow', 'tomorrow'));
    expect(result.focused).toBe(true);
    expect(result.label).toBe('Text field');
    expectInside(result.rects, result.box);
    await expect(page.locator('#main')).toHaveValue(before.replace('tomorow', 'tomorrow'));
    await page.keyboard.press('Control+z');
    await expect(page.locator('#main')).toHaveValue(before);
  });

  test('rects follow scrolling: scrolled-out text has no rects, visible text stays inside the box', async ({ page }) => {
    await open(page, 'textarea.html');
    const result = await page.evaluate(() => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#main') as HTMLTextAreaElement;
      const lines: string[] = [];
      for (let i = 0; i < 40; i++) lines.push(`Line ${i} has some words in it.`);
      el.value = lines.join('\n');
      el.scrollTop = el.scrollHeight;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const text = adapter.getText();
      const toJson = (rs: DOMRect[]) => rs.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }));
      const first = toJson(adapter.getRangeRects({ start: 0, end: 6 }));
      const lastStart = text.lastIndexOf('words');
      const last = toJson(adapter.getRangeRects({ start: lastStart, end: lastStart + 5 }));
      const b = el.getBoundingClientRect();
      return { first, last, box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, scrollTop: el.scrollTop };
    });
    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.first).toEqual([]);
    expectInside(result.last, result.box);
  });

  test('single-line input: rects inside the box and execCommand applies', async ({ page }) => {
    await open(page, 'textarea.html');
    const result = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#subject') as HTMLInputElement;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const text = adapter.getText();
      const start = text.indexOf('tommorow');
      const rects = adapter.getRangeRects({ start, end: start + 8 }).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }));
      const outcome = await adapter.applyEdit({ range: { start, end: start + 8 }, original: 'tommorow', replacement: 'tomorrow' });
      const b = el.getBoundingClientRect();
      return { kind: adapter.kind, rects, outcome, box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } };
    });
    expect(result.kind).toBe('input');
    expectInside(result.rects, result.box);
    expect(result.rects).toHaveLength(1);
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.rung).toBe('execCommand');
    await expect(page.locator('#subject')).toHaveValue("Meeting notes for tomorrow's standup");
  });

  test('applyEdits writes three fixes on one line as a single native undo step', async ({ page }) => {
    await open(page, 'textarea.html');
    const result = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#main') as HTMLTextAreaElement;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const text = adapter.getText();
      const at = (s: string) => text.indexOf(s);
      const edits = [
        { range: { start: at('Their'), end: at('Their') + 5 }, original: 'Their', replacement: "They're" },
        { range: { start: at('tomorow'), end: at('tomorow') + 7 }, original: 'tomorow', replacement: 'tomorrow' },
        { range: { start: at('the the'), end: at('the the') + 7 }, original: 'the the', replacement: 'the' },
      ];
      const outcome = await adapter.applyEdits(edits);
      return { outcome, expected: text.replace('Their', "They're").replace('tomorow', 'tomorrow').replace('the the', 'the') };
    });
    expect(result.outcome.applied).toHaveLength(3);
    expect(result.outcome.skipped).toEqual([]);
    // One line: the fixes go in as one write, so they appear together and one Ctrl+Z reverts them together.
    expect(result.outcome.nativeUndoSteps).toBe(1);
    expect(result.outcome.text).toBe(result.expected);
    await expect(page.locator('#main')).toHaveValue(result.expected);
  });

  test('classify in a real layout: eligible, too-small, password and opted-out fields', async ({ page }) => {
    await open(page, 'textarea.html');
    const result = await page.evaluate(() => {
      const api = window.__jammarlyAdapters!;
      const opts = { checkOptedOutFields: false, ignoreSiteOptOut: false };
      const c = (sel: string) => {
        const r = api.classify(document.querySelector(sel) as HTMLElement, opts);
        return r.ok ? `ok:${r.kind}` : r.reason;
      };
      const tiny = document.querySelector('#tiny') as HTMLElement;
      return {
        main: c('#main'),
        subject: c('#subject'),
        tiny: c('#tiny'),
        tinySmall: api.isSmallField(tiny.getBoundingClientRect()),
        pw: c('#pw'),
        optout: c('#optout'),
        optoutForced: (() => {
          const r = api.classify(document.querySelector('#optout') as HTMLElement, { checkOptedOutFields: true, ignoreSiteOptOut: false });
          return r.ok ? `ok:${r.kind}` : r.reason;
        })(),
        empty: c('#empty'),
      };
    });
    expect(result).toEqual({
      main: 'ok:textarea',
      subject: 'ok:input',
      // 120 × 28 px border-box with a 2 px border: the client box is 116 × 24, under the 120 px width gate.
      tiny: 'too-small',
      tinySmall: true, // and under 40 px tall, so a button for it would anchor outside the field
      pw: 'password',
      optout: 'opted-out',
      optoutForced: 'ok:textarea',
      empty: 'ok:textarea',
    });
  });
});

test.describe('contenteditable adapter', () => {
  test('execCommand rung applies with real undo, Gmail profile labels the body, rects lie inside the field', async ({ page }) => {
    await open(page, 'contenteditable.html');
    const result = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#editor') as HTMLElement;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const before = adapter.getText();
      const start = before.indexOf('definately');
      const outcome = await adapter.applyEdit({ range: { start, end: start + 10 }, original: 'definately', replacement: 'definitely' });
      const rects = adapter.getRangeRects({ start, end: start + 10 }).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }));
      const b = el.getBoundingClientRect();
      const gmailEl = document.querySelector('#gmail') as HTMLElement;
      const gmailAdapter = api.createAdapter(gmailEl, api.resolveProfile('mail.google.com', gmailEl));
      return {
        before,
        outcome,
        after: adapter.getText(),
        rects,
        box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
        boldKept: el.querySelector('b')?.textContent,
        gmailLabel: gmailAdapter.getLabel(),
        gmailLadder: api.resolveProfile('mail.google.com', gmailEl).ladder,
      };
    });
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.rung).toBe('execCommand');
    expect(result.after).toBe(result.before.replace('definately', 'definitely'));
    expect(result.boldKept).toBe('definitely'); // replacement stayed inside the <b> leaf
    expectInside(result.rects, result.box);
    expect(result.gmailLabel).toBe('Message body');
    expect(result.gmailLadder).toEqual(['execCommand', 'paste', 'splice']);
    await page.keyboard.press('Control+z');
    const restored = await page.evaluate(() => (document.querySelector('#editor') as HTMLElement).innerText);
    expect(restored).toContain('definately');
  });

  test('protected ranges from chips on a Gmail-like body', async ({ page }) => {
    await open(page, 'contenteditable.html');
    const result = await page.evaluate(() => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#gmail') as HTMLElement;
      const chip = document.createElement('span');
      chip.setAttribute('contenteditable', 'false');
      chip.textContent = '@ann';
      el.querySelector('div[dir] > div:last-child')!.appendChild(chip);
      const quote = document.createElement('div');
      quote.className = 'gmail_quote';
      quote.textContent = 'On Monday, Ann wrote: hello';
      el.appendChild(quote);
      const adapter = api.createAdapter(el, api.resolveProfile('mail.google.com', el));
      const text = adapter.getText();
      return { text, protectedRanges: adapter.getProtectedRanges() };
    });
    const chipStart = result.text.indexOf('@ann');
    const quoteStart = result.text.indexOf('On Monday');
    expect(result.protectedRanges).toEqual([
      { start: chipStart, end: chipStart + 4 },
      { start: quoteStart, end: result.text.length },
    ]);
  });
});

test.describe('React-controlled textarea', () => {
  test('the model updates through execCommand, and through the native-setter splice when execCommand is unavailable', async ({ page }) => {
    await open(page, 'react-controlled.html');
    const first = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#controlled') as HTMLTextAreaElement;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const text = adapter.getText();
      const start = text.indexOf('sentance');
      const outcome = await adapter.applyEdit({ range: { start, end: start + 8 }, original: 'sentance', replacement: 'sentence' });
      return { outcome, model: document.querySelector('#model')!.textContent };
    });
    expect(first.outcome.status).toBe('applied');
    expect(first.outcome.rung).toBe('execCommand');
    expect(first.model).toBe('model: "This sentence has a speling mistake."');

    const second = await page.evaluate(async () => {
      Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true });
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#controlled') as HTMLTextAreaElement;
      const adapter = api.createAdapter(el, api.resolveProfile(location.hostname, el));
      const text = adapter.getText();
      const start = text.indexOf('speling');
      const outcome = await adapter.applyEdit({ range: { start, end: start + 7 }, original: 'speling', replacement: 'spelling' });
      return { outcome, model: document.querySelector('#model')!.textContent, value: el.value };
    });
    expect(second.outcome.status).toBe('applied');
    expect(second.outcome.rung).toBe('splice');
    expect(second.value).toBe('This sentence has a spelling mistake.');
    expect(second.model).toBe('model: "This sentence has a spelling mistake."');
  });
});

test.describe('framework-like editors', () => {
  test('a Slate-marked editor is written through beforeinput and its model updates', async ({ page }) => {
    await open(page, 'framework-like.html');
    const result = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#slate') as HTMLElement;
      const profile = api.resolveProfile(location.hostname, el);
      const adapter = api.createAdapter(el, profile);
      const text = adapter.getText();
      const start = text.indexOf('Their');
      const outcome = await adapter.applyEdit({ range: { start, end: start + 5 }, original: 'Their', replacement: "They're" });
      const editors = (window as unknown as { __editors: Record<string, { state: string; stats: { reverts: number; beforeinputs: number } }> }).__editors;
      return { profile: profile.id, ladder: profile.ladder, outcome, model: editors.slate!.state, stats: editors.slate!.stats, after: adapter.getText() };
    });
    expect(result.profile).toBe('slate');
    expect(result.ladder).toEqual(['beforeinput', 'paste', 'splice']);
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.rung).toBe('beforeinput');
    expect(result.model).toBe("They're going to the store tomorow.");
    expect(result.after).toBe("They're going to the store tomorow.");
    expect(result.stats.beforeinputs).toBe(1);
    expect(result.stats.reverts).toBe(0);
  });

  test('an unmarked reverting editor: execCommand is reverted, the ladder recovers through beforeinput', async ({ page }) => {
    await open(page, 'framework-like.html');
    const result = await page.evaluate(async () => {
      const api = window.__jammarlyAdapters!;
      const el = document.querySelector('#reverting') as HTMLElement;
      const profile = api.resolveProfile(location.hostname, el);
      const adapter = api.createAdapter(el, profile);
      const text = adapter.getText();
      const start = text.indexOf('could of');
      const outcome = await adapter.applyEdit({ range: { start, end: start + 8 }, original: 'could of', replacement: 'could have' });
      const editors = (window as unknown as { __editors: Record<string, { state: string; stats: { reverts: number; beforeinputs: number } }> }).__editors;
      return { profile: profile.id, outcome, model: editors.reverting!.state, stats: editors.reverting!.stats, after: adapter.getText() };
    });
    expect(result.profile).toBe('generic');
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.rung).toBe('beforeinput');
    expect(result.stats.reverts).toBeGreaterThanOrEqual(1);
    expect(result.stats.beforeinputs).toBe(1);
    expect(result.model).toBe('We was hoping you could have came.');
    expect(result.after).toBe('We was hoping you could have came.');
  });
});
