import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edit, FieldKind } from '@jammarly/shared/types';
import type { FieldAdapter } from '../../src/content/field-adapter';
import { GoogleDocsAdapter, announceGdocsStatus, createGdocsAdapter, findGdocsEditorElement, gdocsStatus, isGdocsDocumentPage, registerGdocsAdapter, waitForGdocsActivation, type GdocsAdapterFactory } from '../../src/content/gdocs/adapter';
import { charCountMeasure } from '../../src/content/gdocs/geometry';
import { STATUS_EVENT, TEXT_EVENT, decodeStatus, dispatchDetail, encodeSnapshot, encodeStatus, type GdocsApplyResult, type GdocsRpc, type GdocsStatus, type RpcMethod, type RpcParams, type RpcResult } from '../../src/content/gdocs/protocol';
import { DOCS_SENTINEL, NBSP, normalizeDocsText } from '../../src/content/gdocs/text';
import { generic } from '../../src/content/sites/generic';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A bridge stand-in: holds the raw Docs text, applies edits like the real bridge would and records every call. */
class FakeRpc implements GdocsRpc {
  raw: string;
  sel = { start: 1, end: 1 };
  calls: { method: RpcMethod; params: unknown }[] = [];
  status: GdocsStatus = { state: 'active', active: true, announcedId: 'abc' };
  /** Force the next applyEdit outcome. */
  forceApply: GdocsApplyResult | null = null;
  failWith: Error | null = null;

  constructor(text: string) {
    this.raw = `${DOCS_SENTINEL}${text}\n`;
  }

  setText(text: string): void {
    this.raw = `${DOCS_SENTINEL}${text}\n`;
  }

  async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    this.calls.push({ method, params });
    if (this.failWith) throw this.failWith;
    switch (method) {
      case 'status':
        return this.status as RpcResult<M>;
      case 'getText':
        return { raw: this.raw } as RpcResult<M>;
      case 'getSelection':
        return { ...this.sel } as RpcResult<M>;
      case 'setSelection': {
        const p = params as RpcParams<'setSelection'>;
        this.sel = { start: p.start, end: p.end };
        return { ok: true } as RpcResult<M>;
      }
      case 'applyEdit': {
        if (this.forceApply) return this.forceApply as RpcResult<M>;
        const p = params as RpcParams<'applyEdit'>;
        if (p.expectedRaw !== undefined && p.expectedRaw !== this.raw) return { ok: false, text: this.raw, reason: 'stale' } as RpcResult<M>;
        this.raw = this.raw.slice(0, p.start) + p.replacement + this.raw.slice(p.end);
        return { ok: true, text: this.raw, strategy: 'replace' } as RpcResult<M>;
      }
      case 'getGeometry':
        return [{ left: 1, top: 2, right: 11, bottom: 12, width: 10, height: 10 }] as RpcResult<M>;
      default:
        throw new Error(`unexpected method ${method}`);
    }
  }
}

const mounted: Element[] = [];
const adapters: GoogleDocsAdapter[] = [];

function editorDom(): { editor: HTMLElement; page: HTMLElement } {
  const root = document.createElement('div');
  root.id = 'docs-editor';
  const container = document.createElement('div');
  container.className = 'kix-appview-editor-container';
  const editor = document.createElement('div');
  editor.className = 'kix-appview-editor';
  const page = document.createElement('div');
  page.className = 'kix-page-paginated';
  editor.appendChild(page);
  container.appendChild(editor);
  root.appendChild(container);
  document.body.appendChild(root);
  mounted.push(root);
  return { editor, page };
}

function tile(parent: Element, runs: { label: string; x: number; y: number; w: number; h: number }[], transform = 'matrix(1,0,0,1,0,0)'): SVGRectElement[] {
  const div = document.createElement('div');
  div.className = 'kix-canvas-tile-content';
  const svg = document.createElementNS(SVG_NS, 'svg');
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', transform);
  const rects: SVGRectElement[] = [];
  for (const r of runs) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('aria-label', r.label);
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(r.w));
    rect.setAttribute('height', String(r.h));
    rect.setAttribute('data-font-css', '400 16px monospace');
    g.appendChild(rect);
    rects.push(rect);
  }
  svg.appendChild(g);
  div.appendChild(svg);
  parent.appendChild(div);
  return rects;
}

function sinkFrame(): { iframe: HTMLIFrameElement; editable: HTMLElement } {
  const iframe = document.createElement('iframe');
  iframe.className = 'docs-texteventtarget-iframe';
  document.body.appendChild(iframe);
  mounted.push(iframe);
  const idoc = iframe.contentDocument!;
  const editable = idoc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  idoc.body.appendChild(editable);
  return { iframe, editable };
}

function snapshotOf(text: string, version = 1) {
  const n = normalizeDocsText(`${DOCS_SENTINEL}${text}\n`);
  return { raw: n.raw, text: n.text, leading: n.leading, trailing: n.trailing, version };
}

function make(rpc: FakeRpc, opts: Partial<ConstructorParameters<typeof GoogleDocsAdapter>[1]> = {}): { adapter: GoogleDocsAdapter; editor: HTMLElement; page: HTMLElement } {
  const { editor, page } = editorDom();
  const adapter = new GoogleDocsAdapter(editor, { rpc, measure: charCountMeasure, svgOrigin: () => ({ left: 0, top: 0 }), location: { pathname: '/document/d/DOC123/edit' }, ...opts });
  adapters.push(adapter);
  return { adapter, editor, page };
}

function edit(text: string, original: string, replacement: string, from = 0): Edit {
  const start = text.indexOf(original, from);
  if (start < 0) throw new Error(`"${original}" not in "${text}"`);
  return { range: { start, end: start + original.length }, original, replacement };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  for (const a of adapters.splice(0)) a.dispose();
  for (const el of mounted.splice(0)) el.remove();
  vi.useRealTimers();
});

describe('text', () => {
  it('seeds the text over the RPC and exposes it normalized', async () => {
    const rpc = new FakeRpc('Hello Docs');
    const { adapter } = make(rpc);
    expect(adapter.getText()).toBe('');
    await adapter.ready();
    expect(adapter.getText()).toBe('Hello Docs');
    expect(adapter.rawText).toBe(`${DOCS_SENTINEL}Hello Docs\n`);
    expect(rpc.calls.map((c) => c.method)).toEqual(['getText']);
    expect(adapter.kind).toBe('gdocs');
  });

  it('starts from an initial snapshot without a round trip', async () => {
    const rpc = new FakeRpc('x');
    const { adapter } = make(rpc, { initial: snapshotOf('Seeded') });
    expect(adapter.getText()).toBe('Seeded');
    await adapter.ready();
    expect(rpc.calls).toEqual([]);
    expect(adapter.textVersion).toBe(1);
  });

  it('adopts text events, notifies onChange with inputType null, and ignores identical snapshots', async () => {
    const rpc = new FakeRpc('one');
    const { adapter } = make(rpc, { initial: snapshotOf('one') });
    const seen: [string, string | null][] = [];
    const off = adapter.onChange((t, it) => seen.push([t, it]));
    dispatchDetail(document, TEXT_EVENT, encodeSnapshot(snapshotOf('one two', 2)));
    dispatchDetail(document, TEXT_EVENT, encodeSnapshot(snapshotOf('one two', 3)));
    dispatchDetail(document, TEXT_EVENT, 'garbage');
    expect(adapter.getText()).toBe('one two');
    expect(seen).toEqual([['one two', null]]);
    expect(adapter.textVersion).toBe(2);
    off();
    dispatchDetail(document, TEXT_EVENT, encodeSnapshot(snapshotOf('three', 4)));
    expect(seen).toHaveLength(1);
    expect(adapter.getText()).toBe('three');
  });

  it('does not let a late getText reply overwrite a fresher text event', async () => {
    const rpc = new FakeRpc('old');
    let release: () => void = () => undefined;
    const original = rpc.call.bind(rpc);
    rpc.call = (async (method: RpcMethod, params: unknown) => {
      if (method === 'getText') await new Promise<void>((r) => (release = r));
      return original(method as never, params as never);
    }) as typeof rpc.call;
    const { adapter } = make(rpc);
    dispatchDetail(document, TEXT_EVENT, encodeSnapshot(snapshotOf('fresh', 5)));
    release();
    await adapter.ready();
    expect(adapter.getText()).toBe('fresh');
  });

  it('stops reacting after dispose', async () => {
    const rpc = new FakeRpc('a');
    const { adapter } = make(rpc, { initial: snapshotOf('a') });
    adapter.dispose();
    dispatchDetail(document, TEXT_EVENT, encodeSnapshot(snapshotOf('b', 2)));
    expect(adapter.getText()).toBe('a');
    expect(adapter.getRangeRects({ start: 0, end: 1 })).toEqual([]);
    expect(await adapter.applyEdit({ range: { start: 0, end: 1 }, original: 'a', replacement: 'b' })).toMatchObject({ status: 'unsupported', rung: null });
  });
});

describe('applyEdit', () => {
  it('translates normalized offsets to raw ones, sends the compare-and-swap guard and reports rung gdocs', async () => {
    const rpc = new FakeRpc('The meeting is tomorow at noon.');
    const { adapter } = make(rpc, { initial: snapshotOf('The meeting is tomorow at noon.') });
    const changes: string[] = [];
    adapter.onChange((t) => changes.push(t));
    const e = edit(adapter.getText(), 'tomorow', 'tomorrow');
    const outcome = await adapter.applyEdit(e);
    expect(outcome).toEqual({ status: 'applied', rung: 'gdocs', text: 'The meeting is tomorrow at noon.' });
    const call = rpc.calls.find((c) => c.method === 'applyEdit')!;
    expect(call.params).toEqual({ start: e.range.start + 1, end: e.range.end + 1, replacement: 'tomorrow', expectedRaw: `${DOCS_SENTINEL}The meeting is tomorow at noon.\n` });
    expect(adapter.getText()).toBe('The meeting is tomorrow at noon.');
    expect(changes).toEqual(['The meeting is tomorrow at noon.']);
  });

  it('accepts NBSP/space differences in the verified text', async () => {
    const rpc = new FakeRpc('a  b');
    const { adapter } = make(rpc, { initial: snapshotOf('a  b') });
    rpc.forceApply = { ok: true, text: `${DOCS_SENTINEL}a${NBSP}b\n` };
    const outcome = await adapter.applyEdit({ range: { start: 1, end: 3 }, original: '  ', replacement: ' ' });
    expect(outcome.status).toBe('applied');
    expect(outcome.text).toBe(`a${NBSP}b`);
  });

  it('refuses locally when the original no longer matches, without calling the bridge', async () => {
    const rpc = new FakeRpc('Hello world');
    const { adapter } = make(rpc, { initial: snapshotOf('Hello world') });
    const outcome = await adapter.applyEdit({ range: { start: 0, end: 5 }, original: 'Jello', replacement: 'Hi' });
    expect(outcome).toEqual({ status: 'mismatch', rung: null, text: 'Hello world' });
    expect(rpc.calls.filter((c) => c.method === 'applyEdit')).toEqual([]);
  });

  it('maps the bridge reasons to outcomes (stale/mismatch → mismatch, others → unsupported)', async () => {
    const rpc = new FakeRpc('Hello world');
    const { adapter } = make(rpc, { initial: snapshotOf('Hello world') });
    const e: Edit = { range: { start: 0, end: 5 }, original: 'Hello', replacement: 'Hi' };
    rpc.forceApply = { ok: false, text: `${DOCS_SENTINEL}Hello there\n`, reason: 'stale' };
    expect(await adapter.applyEdit(e)).toEqual({ status: 'mismatch', rung: 'gdocs', text: 'Hello there' });
    expect(adapter.getText()).toBe('Hello there'); // the live text was adopted
    rpc.forceApply = { ok: false, text: `${DOCS_SENTINEL}Hello there\n`, reason: 'mismatch' };
    expect((await adapter.applyEdit(e)).status).toBe('mismatch');
    for (const reason of ['no-effect', 'unsupported', 'error'] as const) {
      rpc.forceApply = { ok: false, text: `${DOCS_SENTINEL}Hello there\n`, reason };
      expect((await adapter.applyEdit(e)).status).toBe('unsupported');
    }
    rpc.forceApply = { ok: true, text: `${DOCS_SENTINEL}Hello there\n`, strategy: 'replace' }; // ok but wrong text
    expect((await adapter.applyEdit(e)).status).toBe('mismatch');
  });

  it('reports unsupported when the RPC fails', async () => {
    const rpc = new FakeRpc('Hello world');
    const { adapter } = make(rpc, { initial: snapshotOf('Hello world') });
    rpc.failWith = new Error('timeout');
    expect(await adapter.applyEdit({ range: { start: 0, end: 5 }, original: 'Hello', replacement: 'Hi' })).toEqual({ status: 'unsupported', rung: 'gdocs', text: 'Hello world' });
  });

  it('refuses a stale range when Docs text changed between read and apply', async () => {
    const rpc = new FakeRpc('The budget is fine.');
    const { adapter } = make(rpc, { initial: snapshotOf('The budget is fine.') });
    rpc.setText('A collaborator typed. The budget is fine.');
    const outcome = await adapter.applyEdit(edit('The budget is fine.', 'fine', 'final'));
    expect(outcome.status).toBe('mismatch');
    expect(outcome.text).toBe('A collaborator typed. The budget is fine.');
  });

  it('waits for the first snapshot before applying', async () => {
    const rpc = new FakeRpc('Hello world');
    const { adapter } = make(rpc);
    const outcome = await adapter.applyEdit({ range: { start: 0, end: 5 }, original: 'Hello', replacement: 'Hi' });
    expect(outcome.status).toBe('applied');
    expect(outcome.text).toBe('Hi world');
  });
});

describe('applyEdits', () => {
  it('applies right to left against one snapshot and reports the batch', async () => {
    const text = 'teh cat sat on teh mat';
    const rpc = new FakeRpc(text);
    const { adapter } = make(rpc, { initial: snapshotOf(text) });
    const first = edit(text, 'teh', 'the');
    const second = edit(text, 'teh', 'the', 5);
    const result = await adapter.applyEdits([first, second]);
    expect(result.applied).toEqual([second, first]);
    expect(result.skipped).toEqual([]);
    expect(result.text).toBe('the cat sat on the mat');
    expect(result.nativeUndoSteps).toBe(0);
    const starts = rpc.calls.filter((c) => c.method === 'applyEdit').map((c) => (c.params as RpcParams<'applyEdit'>).start);
    expect(starts).toEqual([second.range.start + 1, first.range.start + 1]);
  });

  it('aborts on the first mismatch and reports the rest as skipped', async () => {
    const text = 'aaa bbb ccc';
    const rpc = new FakeRpc(text);
    const { adapter } = make(rpc, { initial: snapshotOf(text) });
    const a = edit(text, 'aaa', 'A');
    const b: Edit = { range: { start: 4, end: 7 }, original: 'xxx', replacement: 'B' };
    const c = edit(text, 'ccc', 'C');
    const result = await adapter.applyEdits([a, b, c]);
    expect(result.applied).toEqual([c]);
    expect(result.skipped).toEqual([
      { edit: b, reason: 'mismatch' },
      { edit: a, reason: 'mismatch' },
    ]);
    expect(result.text).toBe('aaa bbb C');
  });
});

describe('geometry', () => {
  it('reads rects from the SVG annotation layer and caches per text version', async () => {
    const text = 'This is paragraph one.';
    const rpc = new FakeRpc(text);
    const { adapter, page } = make(rpc, { initial: snapshotOf(text) });
    tile(page, [{ label: 'This is pa', x: 0, y: 0, w: 100, h: 20 }], 'matrix(1,0,0,1,72,96)');
    tile(
      page,
      [
        { label: 'ragr', x: 100, y: 0, w: 40, h: 20 },
        { label: 'aph one.', x: 140, y: 0, w: 80, h: 20 },
      ],
      'matrix(1,0,0,1,72,96)',
    );
    await flush(); // let the MutationObserver settle
    const rects = adapter.getRangeRects({ start: 8, end: 17 }); // "paragraph" across the split tiles
    expect(rects).toHaveLength(1);
    expect(rects[0]!.left).toBe(72 + 80);
    expect(rects[0]!.right).toBe(72 + 170);
    expect(rects[0]!.top).toBe(96);
    expect(rects[0]!.height).toBe(20);
    const again = adapter.getRangeRects({ start: 10, end: 14 });
    expect(again[0]!.left).toBe(172);
    expect(again[0]!.width).toBe(40);
  });

  it('invalidates the layout index on scroll and on annotation mutations', async () => {
    const text = 'word';
    const rpc = new FakeRpc(text);
    const { adapter, editor, page } = make(rpc, { initial: snapshotOf(text) });
    const [rect] = tile(page, [{ label: 'word', x: 0, y: 0, w: 40, h: 10 }]);
    await flush();
    expect(adapter.getRangeRects({ start: 0, end: 4 })[0]!.left).toBe(0);
    rect!.setAttribute('x', '50');
    editor.dispatchEvent(new Event('scroll'));
    expect(adapter.getRangeRects({ start: 0, end: 4 })[0]!.left).toBe(50);
    rect!.setAttribute('x', '70');
    await flush(); // MutationObserver callback
    expect(adapter.getRangeRects({ start: 0, end: 4 })[0]!.left).toBe(70);
  });

  it('fires onLayout (coalesced) after scroll and resize', async () => {
    const rpc = new FakeRpc('x');
    const { adapter, editor } = make(rpc, { initial: snapshotOf('x') });
    let fired = 0;
    const off = adapter.onLayout(() => fired++);
    editor.dispatchEvent(new Event('scroll'));
    editor.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
    off();
    editor.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
  });

  it('returns [] before the first snapshot and resolves the RPC geometry asynchronously', async () => {
    const rpc = new FakeRpc('abc');
    const { adapter } = make(rpc);
    expect(adapter.getRangeRects({ start: 0, end: 1 })).toEqual([]);
    expect(await adapter.getRangeRectsAsync({ start: 0, end: 1 })).toEqual([]);
    await adapter.ready();
    const rects = await adapter.getRangeRectsAsync({ start: 0, end: 1 });
    expect(rects).toHaveLength(1);
    expect(rects[0]!.width).toBe(10);
    expect(rpc.calls.at(-1)).toEqual({ method: 'getGeometry', params: { start: 1, end: 2 } });
  });
});

describe('selection, focus and misc', () => {
  it('returns the cached selection and refreshes it from the bridge in normalized offsets', async () => {
    const rpc = new FakeRpc('Hello world');
    rpc.sel = { start: 7, end: 12 }; // raw: "world"
    const { adapter } = make(rpc, { initial: snapshotOf('Hello world') });
    expect(adapter.getSelection()).toBeNull();
    expect(await adapter.refreshSelection()).toEqual({ start: 6, end: 11 });
    expect(adapter.getSelection()).toEqual({ start: 6, end: 11 });
  });

  it('forwards setSelection in raw offsets and caches it', async () => {
    const rpc = new FakeRpc('Hello world');
    const { adapter } = make(rpc, { initial: snapshotOf('Hello world') });
    adapter.setSelection({ start: 0, end: 5 });
    await flush();
    expect(rpc.sel).toEqual({ start: 1, end: 6 });
    expect(adapter.getSelection()).toEqual({ start: 0, end: 5 });
  });

  it('reports focus when the input iframe or the editor holds it and focuses the sink editable', () => {
    const rpc = new FakeRpc('x');
    const { adapter, editor } = make(rpc, { initial: snapshotOf('x') });
    const { iframe, editable } = sinkFrame();
    expect(adapter.isFocused()).toBe(false);
    iframe.setAttribute('tabindex', '0');
    iframe.focus();
    expect(document.activeElement).toBe(iframe);
    expect(adapter.isFocused()).toBe(true);
    const btn = document.createElement('button');
    editor.appendChild(btn);
    btn.focus();
    expect(adapter.isFocused()).toBe(true);
    document.body.focus();
    (document.activeElement as HTMLElement | null)?.blur();
    adapter.focus();
    expect(iframe.contentDocument!.activeElement).toBe(editable);
  });

  it('emits onFocusChange transitions once per change', () => {
    const rpc = new FakeRpc('x');
    const { adapter, editor } = make(rpc, { initial: snapshotOf('x') });
    const seen: boolean[] = [];
    adapter.onFocusChange((f) => seen.push(f));
    const btn = document.createElement('button');
    editor.appendChild(btn);
    btn.focus();
    btn.focus();
    btn.blur();
    expect(seen).toEqual([true, false]);
  });

  it('exposes label, doc hint, protected ranges, composing and box', () => {
    const rpc = new FakeRpc('x');
    const { adapter, editor } = make(rpc, { initial: snapshotOf('x') });
    expect(adapter.getLabel()).toBe('Document');
    expect(adapter.getDocHint()).toBe('gdoc:DOC123');
    expect(adapter.getProtectedRanges()).toEqual([]);
    expect(adapter.isComposing()).toBe(false);
    expect(adapter.getBox()).toEqual(editor.getBoundingClientRect());
    expect(adapter.element).toBe(editor);
    const other = new GoogleDocsAdapter(editor, { rpc, location: { pathname: '/spreadsheets/d/1/edit' } });
    adapters.push(other);
    expect(other.getDocHint()).toBe('');
  });
});

describe('registration and page helpers', () => {
  it('registers a gdocs factory that builds GoogleDocsAdapter', () => {
    const factories: Partial<Record<FieldKind, GdocsAdapterFactory>> = {};
    const rpc = new FakeRpc('x');
    registerGdocsAdapter(factories, { rpc, initial: snapshotOf('x') });
    const { editor } = editorDom();
    const adapter: FieldAdapter = factories.gdocs!(editor, generic);
    adapters.push(adapter as GoogleDocsAdapter);
    expect(adapter).toBeInstanceOf(GoogleDocsAdapter);
    expect(adapter.kind).toBe('gdocs');
    expect(adapter.getText()).toBe('x');
  });

  it('recognizes Docs document pages', () => {
    expect(isGdocsDocumentPage({ hostname: 'docs.google.com', pathname: '/document/d/abc/edit' })).toBe(true);
    expect(isGdocsDocumentPage({ hostname: 'docs.google.com', pathname: '/spreadsheets/d/abc/edit' })).toBe(false);
    expect(isGdocsDocumentPage({ hostname: 'drive.google.com', pathname: '/document/d/abc/edit' })).toBe(false);
  });

  it('finds the editor element and builds an adapter for the page', () => {
    expect(findGdocsEditorElement(document)).toBeNull();
    expect(createGdocsAdapter(document, { rpc: new FakeRpc('x') })).toBeNull();
    const { editor } = editorDom();
    expect(findGdocsEditorElement(document)).toBe(editor);
    const adapter = createGdocsAdapter(document, { rpc: new FakeRpc('x'), initial: snapshotOf('x') });
    adapters.push(adapter!);
    expect(adapter?.element).toBe(editor);
  });

  it('gdocsStatus answers inactive when the bridge does not respond', async () => {
    const rpc = new FakeRpc('x');
    expect(await gdocsStatus(rpc)).toEqual({ state: 'active', active: true, announcedId: 'abc' });
    rpc.failWith = new Error('gdocs rpc timeout: status');
    const s = await gdocsStatus(rpc);
    expect(s.state).toBe('inactive');
    expect(s.error).toMatch(/bridge unavailable: gdocs rpc timeout/);
  });

  it('waitForGdocsActivation resolves from the RPC when final, else from the next status event', async () => {
    const rpc = new FakeRpc('x');
    expect(await waitForGdocsActivation({ rpc, target: document })).toMatchObject({ state: 'active' });
    rpc.status = { state: 'pending', active: false, announcedId: 'abc' };
    const p = waitForGdocsActivation({ rpc, target: document, timeoutMs: 5000 });
    await flush();
    dispatchDetail(document, STATUS_EVENT, encodeStatus({ state: 'pending', active: false, announcedId: 'abc' }));
    dispatchDetail(document, STATUS_EVENT, encodeStatus({ state: 'inactive', active: false, announcedId: 'abc', error: 'no api' }));
    expect(await p).toEqual({ state: 'inactive', active: false, announcedId: 'abc', error: 'no api' });
  });

  it('waitForGdocsActivation keeps waiting when the RPC is unavailable and times out as inactive', async () => {
    vi.useFakeTimers();
    const rpc = new FakeRpc('x');
    rpc.failWith = new Error('no bridge');
    const p = waitForGdocsActivation({ rpc, target: document, timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(100);
    dispatchDetail(document, STATUS_EVENT, encodeStatus({ state: 'pending', active: false, announcedId: 'abc' }));
    await vi.advanceTimersByTimeAsync(300);
    const s = await p;
    expect(s.state).toBe('inactive');
    expect(s.error).toMatch(/timed out/);
  });
});

describe('announceGdocsStatus (registry relay)', () => {
  /** What controller/registry.ts does with the event: read `detail.active` from an object detail. */
  function registryListener(target: EventTarget): { seen: (boolean | null)[]; details: unknown[]; stop(): void } {
    const seen: (boolean | null)[] = [];
    const details: unknown[] = [];
    const onStatus = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ active?: boolean }>).detail;
      details.push(detail);
      seen.push(detail && typeof detail === 'object' ? detail.active === true : null);
    };
    target.addEventListener(STATUS_EVENT, onStatus, true);
    return { seen, details, stop: () => target.removeEventListener(STATUS_EVENT, onStatus, true) };
  }

  it('the bridge\'s own string-detail event is unreadable for the registry, the relayed object detail is not', () => {
    const reg = registryListener(document);
    dispatchDetail(document, STATUS_EVENT, encodeStatus({ state: 'active', active: true, announcedId: 'abc' }));
    expect(reg.seen).toEqual([null]);
    announceGdocsStatus({ state: 'active', active: true, announcedId: 'abc' }, document, (fn) => fn());
    expect(reg.seen).toEqual([null, true]);
    expect(reg.details[1]).toEqual({ state: 'active', active: true, announcedId: 'abc' });
    expect(decodeStatus(reg.details[1])).toEqual({ state: 'active', active: true, announcedId: 'abc' });
    reg.stop();
  });

  it('relays inactive verdicts with their error and never claims active for a non-active state', () => {
    const reg = registryListener(document);
    announceGdocsStatus({ state: 'inactive', active: false, announcedId: 'abc', error: 'no api' }, document, (fn) => fn());
    announceGdocsStatus({ state: 'pending', active: true, announcedId: 'abc' }, document, (fn) => fn());
    expect(reg.seen).toEqual([false, false]);
    expect(reg.details[0]).toEqual({ state: 'inactive', active: false, announcedId: 'abc', error: 'no api' });
    expect(reg.details[1]).toEqual({ state: 'pending', active: false, announcedId: 'abc' });
    reg.stop();
  });

  it('defers one macrotask by default so a registry booting a tick later still hears it', async () => {
    vi.useFakeTimers();
    const reg = registryListener(document);
    announceGdocsStatus({ state: 'active', active: true, announcedId: 'abc' }, document);
    expect(reg.seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.seen).toEqual([true]);
    reg.stop();
  });

  it('swallows a dispatch failure', () => {
    const target = { dispatchEvent: () => { throw new Error('no'); }, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as EventTarget;
    expect(() => announceGdocsStatus({ state: 'active', active: true, announcedId: 'abc' }, target, (fn) => fn())).not.toThrow();
  });
});
