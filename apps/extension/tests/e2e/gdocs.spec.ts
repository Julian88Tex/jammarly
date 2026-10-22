/**
 * Google Docs bridge in real Chromium against tests/fixtures/gdocs.html, which mocks Docs' annotated-canvas DOM and
 * `_docs_annotate_getAnnotatedText` (research 06 §7.2). The manifest's MAIN-world scripts match only
 * https://docs.google.com/document/*, so this spec bundles bootstrap.ts, main-bridge.ts and the isolated-world test
 * entry (src/content/gdocs/test-entry.ts) with bundleFixtureScript and injects them itself: the bootstrap as an init
 * script (before the fixture's inline mock runs), then the bridge and the entry as script tags, in that order.
 *
 * Those tests use a plain Chromium context without the extension (the same override as overlay.spec.ts): the real
 * content script would run its own registry in the page. The last test loads the built extension on the fixture
 * served over http to show that a non-Docs host gets no Docs wiring at all.
 */
import { test as extensionTest, expect, bundleFixtureScript } from './fixtures';
import { chromium, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldKind } from '@jammarly/shared/types';
import type { SiteProfile } from '../../src/content/field-adapter';
import type { GdocsAdapterFactory, GoogleDocsAdapter } from '../../src/content/gdocs/adapter';
import type { jammarlyGdocs } from '../../src/content/gdocs/test-entry';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', 'fixtures');

/** The id the bundled bootstrap announces (a release build derives it from the script URL or the build define). */
const ANNOUNCED_ID = 'jammarlyjammarlyjammarlyjammarly';
/** Another extension's flag, already set before our bootstrap runs. */
const OTHER_ID = 'otherextensionidotherextensionid';

interface FixtureRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  tile: number;
}
interface FixtureApi {
  expected: string;
  flagAtLoad: string | undefined;
  zoom(): number;
  setZoom(z: number): void;
  text(): string;
  raw(): string;
  setText(t: string): void;
  selection(): { anchor: number; focus: number };
  caretRect(): { left: number; top: number; width: number; height: number };
  sinkFocused(): boolean;
  rectsFor(start: number, end: number): FixtureRect[];
  runsFor(start: number, end: number): { tile: number; text: string; font: string; line: number }[];
  calls: { id: unknown; flag: unknown; accepted: boolean }[];
  pastes: { payload: string; focused: boolean; applied: boolean; text: string | null }[];
  selections: [number, number][];
  statusEvents: { detailType: string; detail: unknown }[];
  textEventCount(): number;
}

declare global {
  interface Window {
    __gdocsFixture: FixtureApi;
    __gdocsAdapter?: GoogleDocsAdapter;
    _docs_annotate_canvas_by_ext?: string;
    __jammarlyAnnouncedId?: string;
    __jammarlyGdocsBridge?: { version: number };
  }
}

type Gdocs = typeof jammarlyGdocs;

const test = extensionTest.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const browser = await chromium.launch({
      channel: 'chromium', // same build as fixtures.ts; the extension is deliberately not loaded here
      headless: process.env.PW_HEADFUL ? false : true,
    });
    const context = await browser.newContext();
    await use(context);
    await context.close();
    await browser.close();
  },
});

let bootstrapSource = '';
let bridgePath = '';
let entryPath = '';

test.beforeAll(async () => {
  const bootstrap = await bundleFixtureScript('src/content/gdocs/bootstrap.ts', 'gdocs-bootstrap.js');
  bridgePath = await bundleFixtureScript('src/content/gdocs/main-bridge.ts', 'gdocs-bridge.js');
  entryPath = await bundleFixtureScript('src/content/gdocs/test-entry.ts', 'gdocs-entry.js');
  bootstrapSource = await readFile(path.join(fixturesDir, bootstrap), 'utf8');
});

/**
 * The bootstrap takes its id from the build-time define `__JAMMARLY_GDOCS_ANNOUNCE_ID__` (the build script sets it;
 * `idFromScriptUrl()` is empty for an init script), so the bundle is wrapped in a scope that provides it.
 */
function bootstrapInit(id: string): string {
  return `(() => { const __JAMMARLY_GDOCS_ANNOUNCE_ID__ = ${JSON.stringify(id)};\n${bootstrapSource}\n})();`;
}

interface OpenOptions {
  /** The id the fixture's mock accepts ('none' never activates). */
  expect: string;
  /** Pre-set `_docs_annotate_canvas_by_ext` before the bootstrap runs. */
  presetFlag?: string;
  zoom?: number;
}

async function openDocs(page: Page, fixtureUrl: (n: string) => string, opts: OpenOptions): Promise<void> {
  if (opts.presetFlag) {
    await page.addInitScript((flag: string) => {
      window._docs_annotate_canvas_by_ext = flag;
    }, opts.presetFlag);
  }
  await page.addInitScript({ content: bootstrapInit(ANNOUNCED_ID) });
  const q = new URLSearchParams({ expect: opts.expect, zoom: String(opts.zoom ?? 1) });
  await page.goto(fixtureUrl(`gdocs.html?${q.toString()}`));
  await page.addScriptTag({ url: fixtureUrl(bridgePath) });
  await page.addScriptTag({ url: fixtureUrl(entryPath) });
}

/** Builds the adapter for the page's editor, waits for its first snapshot and returns the normalized text. */
async function attachAdapter(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const g = window.__jammarlyGdocs as Gdocs;
    const adapter = g.createGdocsAdapter(document);
    if (!adapter) throw new Error('fixture has no .kix-appview-editor');
    window.__gdocsAdapter = adapter;
    await adapter.ready();
    return adapter.getText();
  });
}

function union(rects: FixtureRect[]): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

function expectClose(actual: { left: number; top: number; right: number; bottom: number }, expected: { left: number; top: number; right: number; bottom: number }, tolerance = 1): void {
  expect(Math.abs(actual.left - expected.left)).toBeLessThan(tolerance);
  expect(Math.abs(actual.right - expected.right)).toBeLessThan(tolerance);
  expect(Math.abs(actual.top - expected.top)).toBeLessThan(tolerance);
  expect(Math.abs(actual.bottom - expected.bottom)).toBeLessThan(tolerance);
}

test.describe('Google Docs bridge (Chromium, mocked annotated canvas)', () => {
  test('the bootstrap announces our id before the page script runs and never overwrites a pre-set flag', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    const own = await page.evaluate(() => ({
      flag: window._docs_annotate_canvas_by_ext,
      announced: window.__jammarlyAnnouncedId,
      flagAtLoad: window.__gdocsFixture.flagAtLoad,
    }));
    expect(own).toEqual({ flag: ANNOUNCED_ID, announced: ANNOUNCED_ID, flagAtLoad: ANNOUNCED_ID });

    // Another extension announced first: its flag stays and is the id the bridge calls Docs with.
    const other = await page.context().newPage();
    await openDocs(other, fixtureUrl, { expect: OTHER_ID, presetFlag: OTHER_ID });
    const preset = await other.evaluate(async () => {
      const g = window.__jammarlyGdocs as Gdocs;
      const status = await g.waitForGdocsActivation();
      return {
        flag: window._docs_annotate_canvas_by_ext,
        announced: window.__jammarlyAnnouncedId,
        flagAtLoad: window.__gdocsFixture.flagAtLoad,
        status,
        calls: window.__gdocsFixture.calls,
      };
    });
    expect(preset.flag).toBe(OTHER_ID);
    expect(preset.announced).toBe(OTHER_ID);
    expect(preset.flagAtLoad).toBe(OTHER_ID);
    expect(preset.status).toEqual({ state: 'active', active: true, announcedId: OTHER_ID });
    expect(preset.calls).toEqual([{ id: OTHER_ID, flag: OTHER_ID, accepted: true }]);
    await other.close();
  });

  test('the bridge activates when the page expects the announced id and reports not active otherwise', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    const active = await page.evaluate(async () => {
      const g = window.__jammarlyGdocs as Gdocs;
      const status = await g.waitForGdocsActivation();
      const viaRpc = await g.gdocsStatus();
      return { status, viaRpc, calls: window.__gdocsFixture.calls, statusEvents: window.__gdocsFixture.statusEvents, textEvents: window.__gdocsFixture.textEventCount(), marker: window.__jammarlyGdocsBridge };
    });
    expect(active.status).toEqual({ state: 'active', active: true, announcedId: ANNOUNCED_ID });
    expect(active.viaRpc).toEqual(active.status);
    expect(active.calls).toEqual([{ id: ANNOUNCED_ID, flag: ANNOUNCED_ID, accepted: true }]);
    expect(active.marker).toEqual({ version: 1 });
    // The bridge's own event crosses worlds as a JSON string; the first text snapshot followed activation.
    expect(active.statusEvents.some((e) => e.detailType === 'string' && (e.detail as { state: string }).state === 'active')).toBe(true);
    expect(active.textEvents).toBeGreaterThanOrEqual(1);

    const none = await page.context().newPage();
    await openDocs(none, fixtureUrl, { expect: 'none' });
    const inactive = await none.evaluate(async () => {
      const g = window.__jammarlyGdocs as Gdocs;
      const status = await g.waitForGdocsActivation();
      let rpcError = '';
      try {
        await g.defaultGdocsRpc().call('getText', {});
      } catch (e) {
        rpcError = e instanceof Error ? e.message : String(e);
      }
      return { status, rpcError, calls: window.__gdocsFixture.calls, textEvents: window.__gdocsFixture.textEventCount() };
    });
    expect(inactive.status.state).toBe('inactive');
    expect(inactive.status.active).toBe(false);
    expect(inactive.status.announcedId).toBe(ANNOUNCED_ID);
    expect(inactive.status.error).toMatch(/no annotated-text model for id/);
    expect(inactive.rpcError).toMatch(/inactive/);
    expect(inactive.calls).toEqual([{ id: ANNOUNCED_ID, flag: ANNOUNCED_ID, accepted: false }]);
    expect(inactive.textEvents).toBe(0);
    await none.close();
  });

  test('content-script wiring: the factory is registered only when active and the registry hears an object-detail status', async ({ page, fixtureUrl }) => {
    // The exact sequence src/content/content-script.ts runs on a Docs document page.
    const wire = async () => {
      const g = window.__jammarlyGdocs as Gdocs;
      const factories: Partial<Record<FieldKind, GdocsAdapterFactory>> = {};
      const before = window.__gdocsFixture.statusEvents.length;
      const status = await g.waitForGdocsActivation();
      if (status.active) g.registerGdocsAdapter(factories);
      g.announceGdocsStatus(status);
      await new Promise((r) => setTimeout(r, 20));
      const relayed = window.__gdocsFixture.statusEvents.slice(before).filter((e) => e.detailType === 'object');
      let adapterText: string | null = null;
      if (factories.gdocs) {
        const el = document.querySelector<HTMLElement>('.kix-appview-editor')!;
        const adapter = factories.gdocs(el, undefined as unknown as SiteProfile) as GoogleDocsAdapter; // the Docs factory ignores the profile
        await adapter.ready();
        adapterText = adapter.getText();
        adapter.dispose();
      }
      return { active: status.active, hasFactory: typeof factories.gdocs === 'function', relayed, adapterText, modelText: window.__gdocsFixture.text() };
    };

    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    const on = await page.evaluate(wire);
    expect(on.active).toBe(true);
    expect(on.hasFactory).toBe(true);
    expect(on.relayed).toHaveLength(1);
    // What controller/registry.ts reads: `detail.active === true` → it attaches the gdocs adapter.
    expect(on.relayed[0]!.detail).toEqual({ state: 'active', active: true, announcedId: ANNOUNCED_ID });
    expect(on.adapterText).toBe(on.modelText);

    const none = await page.context().newPage();
    await openDocs(none, fixtureUrl, { expect: 'none' });
    const off = await none.evaluate(wire);
    expect(off.active).toBe(false);
    expect(off.hasFactory).toBe(false);
    expect(off.relayed).toHaveLength(1);
    // `detail.active` is false → the registry shows the "not supported inline" sentinel (side panel remains the path).
    expect(off.relayed[0]!.detail).toMatchObject({ state: 'inactive', active: false, announcedId: ANNOUNCED_ID, error: expect.stringMatching(/no annotated-text model/) });
    await none.close();
  });

  test('getText is normalized and selection offsets map across the sentinel', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    const text = await attachAdapter(page);
    const probe = await page.evaluate(async () => {
      const adapter = window.__gdocsAdapter!;
      const fixture = window.__gdocsFixture;
      const text = adapter.getText();
      const start = text.indexOf('tomorow');
      const end = start + 'tomorow'.length;
      const caretBefore = fixture.caretRect();
      adapter.setSelection({ start, end });
      // setSelection is fire-and-forget; the model answers the RPC synchronously, so the selection is set now.
      const modelSel = fixture.selection();
      const refreshed = await adapter.refreshSelection();
      const caretAfter = fixture.caretRect();
      return { text, raw: adapter.rawText, body: fixture.text(), start, end, modelSel, refreshed, cached: adapter.getSelection(), caretMoved: caretAfter.left !== caretBefore.left, docHint: adapter.getDocHint(), label: adapter.getLabel(), focused: adapter.isFocused(), selections: fixture.selections };
    });
    expect(text).toBe(probe.body);
    expect(probe.text).not.toContain('\u0003');
    expect(probe.text.endsWith('\n')).toBe(false);
    expect(probe.raw).toBe(`\u0003${probe.text}\n`);
    expect(probe.text.split('\n')).toHaveLength(3);
    // Normalized offset n ↔ raw offset n + 1 (the sentinel).
    expect(probe.modelSel).toEqual({ anchor: probe.start + 1, focus: probe.end + 1 });
    expect(probe.selections).toEqual([[probe.start + 1, probe.end + 1]]);
    expect(probe.refreshed).toEqual({ start: probe.start, end: probe.end });
    expect(probe.cached).toEqual({ start: probe.start, end: probe.end });
    expect(probe.caretMoved).toBe(true);
    expect(probe.docHint).toBe(''); // not a /document/d/<id>/ URL on the fixture host
    expect(probe.label).toBe('Document');
    expect(probe.focused).toBe(true); // the hidden input iframe holds focus
  });

  test('geometry: word rects from the annotation layer, a word split across tiles merges into one, zoom follows the transform', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    const text = await attachAdapter(page);
    const read = (word: string) =>
      page.evaluate(async (w) => {
        const adapter = window.__gdocsAdapter!;
        const fixture = window.__gdocsFixture;
        const start = adapter.getText().indexOf(w);
        const end = start + w.length;
        const toJson = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
        return {
          start,
          sync: adapter.getRangeRects({ start, end }).map(toJson),
          viaBridge: (await adapter.getRangeRectsAsync({ start, end })).map(toJson),
          fixture: fixture.rectsFor(start, end),
          runs: fixture.runsFor(start, end),
          zoom: fixture.zoom(),
        };
      }, word);

    const word = await read('tomorow');
    expect(word.start).toBeGreaterThan(0);
    expect(word.runs).toHaveLength(1);
    expect(word.sync).toHaveLength(1);
    expectClose(word.sync[0]!, union(word.fixture));
    expectClose(word.viaBridge[0]!, union(word.fixture));
    expect(word.sync[0]!.height).toBeCloseTo(17, 0);

    // "paragraph" is rendered as "This is pa" + "ragr" + "aph two. …" with a tile boundary before "ragr".
    const split = await read('paragraph');
    expect(split.runs.map((r) => r.text)).toEqual(['This is pa', 'ragr', expect.stringMatching(/^aph two\. /)]);
    expect(split.runs.map((r) => r.tile)).toEqual([0, 1, 1]);
    expect(new Set(split.runs.map((r) => r.tile)).size).toBe(2);
    expect(split.fixture).toHaveLength(3);
    expect(split.sync).toHaveLength(1); // same line → one merged rect
    expectClose(split.sync[0]!, union(split.fixture));
    expectClose(split.viaBridge[0]!, union(split.fixture));

    // The soft-wrapped third paragraph: a phrase spanning the wrap gives one rect per line.
    const wrapped = await page.evaluate(async () => {
      const adapter = window.__gdocsAdapter!;
      const text = adapter.getText();
      const third = text.lastIndexOf('\n') + 1;
      const runs = window.__gdocsFixture.runsFor(third, text.length);
      const lastWord = text.slice(text.lastIndexOf(' ') + 1);
      const firstWordEnd = text.indexOf(' ', third);
      return { lines: new Set(runs.map((r) => r.line)).size, rects: adapter.getRangeRects({ start: third, end: text.length }).length, firstWordEnd, lastWord, textLength: text.length };
    });
    expect(wrapped.lines).toBe(2);
    expect(wrapped.rects).toBe(2);

    // Zoom 125 %: the group transform scales; rects follow the fixture's geometry and grow by the factor.
    await page.evaluate(async () => {
      window.__gdocsFixture.setZoom(1.25);
      await new Promise((r) => requestAnimationFrame(() => r(0)));
    });
    const zoomed = await read('tomorow');
    expect(zoomed.zoom).toBe(1.25);
    expect(zoomed.sync).toHaveLength(1);
    expectClose(zoomed.sync[0]!, union(zoomed.fixture));
    expectClose(zoomed.viaBridge[0]!, union(zoomed.fixture));
    expect(zoomed.sync[0]!.width / word.sync[0]!.width).toBeCloseTo(1.25, 2);
    expect(zoomed.sync[0]!.height / word.sync[0]!.height).toBeCloseTo(1.25, 2);
    expect(text).toBe(await page.evaluate(() => window.__gdocsAdapter!.getText())); // zoom changes no text
  });

  test('applyEdit replaces a word with one synthetic paste and verifies by re-reading; edge spaces travel as NBSP', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    await attachAdapter(page);
    const first = await page.evaluate(async () => {
      const adapter = window.__gdocsAdapter!;
      const fixture = window.__gdocsFixture;
      const before = adapter.getText();
      const start = before.indexOf('tomorow');
      const changes: string[] = [];
      const off = adapter.onChange((t) => changes.push(t));
      const outcome = await adapter.applyEdit({ range: { start, end: start + 'tomorow'.length }, original: 'tomorow', replacement: 'tomorrow' });
      off();
      return { outcome, before, after: adapter.getText(), model: fixture.text(), pastes: fixture.pastes, selections: fixture.selections, changes, version: adapter.textVersion, sinkFocused: fixture.sinkFocused() };
    });
    expect(first.outcome).toEqual({ status: 'applied', rung: 'gdocs', text: first.before.replace('tomorow', 'tomorrow') });
    expect(first.after).toBe(first.outcome.text);
    expect(first.model).toBe(first.outcome.text);
    expect(first.pastes).toEqual([{ payload: 'tomorrow', focused: true, applied: true, text: first.model }]);
    const s = first.before.indexOf('tomorow') + 1;
    expect(first.selections).toEqual([[s, s + 'tomorow'.length]]); // raw offsets: setSelection, then one paste
    expect(first.changes).toEqual([first.after]);
    expect(first.sinkFocused).toBe(true); // the bridge refocused the editable that setSelection blurred

    // A replacement with a leading space: the bridge sends it as NBSP (Docs would strip an ASCII edge space).
    const second = await page.evaluate(async () => {
      const adapter = window.__gdocsAdapter!;
      const fixture = window.__gdocsFixture;
      const before = adapter.getText();
      const start = before.indexOf(' at noon');
      const outcome = await adapter.applyEdit({ range: { start, end: start + ' at noon'.length }, original: ' at noon', replacement: ' at midday' });
      return { outcome, before, pastes: fixture.pastes.slice(1), model: fixture.text() };
    });
    expect(second.outcome.status).toBe('applied');
    expect(second.outcome.text).toBe(second.before.replace(' at noon', ' at midday'));
    expect(second.pastes).toHaveLength(1);
    expect(second.pastes[0]!.payload).toBe(' at midday');
    expect(second.pastes[0]!.applied).toBe(true);
    expect(second.model).toBe(second.outcome.text); // the fixture turned the NBSP back into a regular space
    expect(second.model).not.toContain(' ');
  });

  test('a deletion borrows a neighbouring character and never pastes an empty string', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    await attachAdapter(page);
    const result = await page.evaluate(async () => {
      const adapter = window.__gdocsAdapter!;
      const fixture = window.__gdocsFixture;
      const before = adapter.getText();
      const start = before.indexOf(' the budget');
      const outcome = await adapter.applyEdit({ range: { start, end: start + ' the'.length }, original: ' the', replacement: '' });
      return { outcome, before, model: fixture.text(), pastes: fixture.pastes, selections: fixture.selections, start };
    });
    expect(result.before).toContain('discuss the the budget');
    expect(result.outcome.status).toBe('applied');
    expect(result.outcome.rung).toBe('gdocs');
    expect(result.outcome.text).toBe(result.before.replace(' the the budget', ' the budget'));
    expect(result.model).toBe(result.outcome.text);
    expect(result.pastes).toHaveLength(1);
    for (const p of result.pastes) expect(p.payload.length).toBeGreaterThan(0);
    // delete-right: the selection grew by the following space, which came back as NBSP.
    expect(result.pastes[0]!.payload).toBe(' ');
    expect(result.selections).toEqual([[result.start + 1, result.start + 1 + ' the'.length + 1]]);

    // Deleting a whole paragraph has no carrier inside it: refused as unsupported, still without an empty paste.
    const refused = await page.evaluate(async () => {
      const adapter = window.__gdocsAdapter!;
      const fixture = window.__gdocsFixture;
      fixture.setText('only');
      await new Promise((r) => setTimeout(r, 300)); // let the bridge's 125 ms poll push the new snapshot
      const outcome = await adapter.applyEdit({ range: { start: 0, end: 4 }, original: 'only', replacement: '' });
      return { outcome, text: adapter.getText(), pastes: fixture.pastes.slice(1) };
    });
    expect(refused.text).toBe('only');
    expect(refused.outcome.status).toBe('unsupported');
    expect(refused.pastes).toEqual([]);
  });

  test('a stale range is refused when the model text changed between read and apply', async ({ page, fixtureUrl }) => {
    await openDocs(page, fixtureUrl, { expect: ANNOUNCED_ID });
    await attachAdapter(page);
    const result = await page.evaluate(async () => {
      const g = window.__jammarlyGdocs as Gdocs;
      const adapter = window.__gdocsAdapter!;
      const fixture = window.__gdocsFixture;
      const stale = adapter.getText();
      const staleRaw = adapter.rawText;
      const start = stale.indexOf('tomorow');
      // A collaborator edits elsewhere; the adapter's snapshot is still the old one (no poll tick has run yet).
      fixture.setText(stale.replace('noon', 'midnight'));
      const outcome = await adapter.applyEdit({ range: { start, end: start + 'tomorow'.length }, original: 'tomorow', replacement: 'tomorrow' });
      const afterAdapter = adapter.getText();
      // The bridge's compare-and-swap guard on its own.
      const rpc = new g.EventRpcClient(document, 2000);
      const direct = await rpc.call('applyEdit', { start: start + 1, end: start + 1 + 'tomorow'.length, replacement: 'tomorrow', expectedRaw: staleRaw });
      rpc.dispose();
      // With a fresh snapshot the same edit applies.
      const fresh = adapter.getText();
      const retry = await adapter.applyEdit({ range: { start, end: start + 'tomorow'.length }, original: 'tomorow', replacement: 'tomorrow' });
      return { outcome, afterAdapter, direct, fresh, retry, model: fixture.text(), pastes: fixture.pastes.map((p) => p.payload) };
    });
    expect(result.outcome.status).toBe('mismatch');
    expect(result.outcome.rung).toBe('gdocs');
    expect(result.outcome.text).toContain('midnight');
    expect(result.afterAdapter).toBe(result.outcome.text); // the adapter adopted the live text from the refusal
    expect(result.direct).toEqual({ ok: false, text: `\u0003${result.afterAdapter}\n`, reason: 'stale' });
    expect(result.fresh).toContain('midnight');
    expect(result.retry.status).toBe('applied');
    expect(result.model).toBe(result.fresh.replace('tomorow', 'tomorrow'));
    expect(result.pastes).toEqual(['tomorrow']); // the stale attempts pasted nothing
  });
});

extensionTest.describe('built extension on the fixture over http', () => {
  extensionTest('a non-Docs host gets no Docs wiring; an ordinary textarea still attaches', async ({ page, fixtureUrl }) => {
    await page.goto(fixtureUrl('gdocs.html?expect=none'));
    await expect(page.locator('html')).toHaveAttribute('data-jammarly', 'loaded');
    await expect(page.locator('html')).toHaveAttribute('data-jammarly-sw', JSON.stringify({ ok: true, type: 'ok' }));
    await page.waitForTimeout(500);
    const probe = await page.evaluate(() => ({
      flag: window._docs_annotate_canvas_by_ext,
      announced: window.__jammarlyAnnouncedId,
      bridge: window.__jammarlyGdocsBridge,
      calls: window.__gdocsFixture.calls.length,
      statusEvents: window.__gdocsFixture.statusEvents.length,
      textEvents: window.__gdocsFixture.textEventCount(),
    }));
    // The MAIN-world scripts match only https://docs.google.com/document/*, and the content script registers nothing.
    expect(probe.flag).toBeUndefined();
    expect(probe.announced).toBeUndefined();
    expect(probe.bridge).toBeUndefined();
    expect(probe.calls).toBe(0);
    expect(probe.statusEvents).toBe(0);
    expect(probe.textEvents).toBe(0);
    // No field attached yet: in particular no "not supported inline" sentinel for the kix editor.
    const root = page.locator('jammarly-root');
    const buttons = root.locator('[data-jm="button"]');
    await expect(buttons).toHaveCount(0);

    await page.locator('#notes').click();
    await expect(root).toHaveCount(1, { timeout: 10_000 });
    await expect(buttons).toHaveCount(1, { timeout: 10_000 });
    await expect(buttons.first()).not.toHaveAttribute('data-state', 'unsupported');
    expect(await root.locator('[data-jm="button"][data-state="unsupported"]').count()).toBe(0);
    expect(await page.evaluate(() => window.__gdocsFixture.statusEvents.length)).toBe(0);
  });
});
