/**
 * The MAIN-world bridge against a fake Docs model in jsdom. The module auto-installs on import, so the no-auto-install
 * marker is set before the dynamic import and every test installs its own bridge with short timers.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCS_SENTINEL, NBSP } from '../../src/content/gdocs/text';
import { EventRpcClient, STATUS_EVENT, TEXT_EVENT, decodeSnapshot, decodeStatus, type GdocsStatus, type GdocsTextSnapshot } from '../../src/content/gdocs/protocol';
import type * as Bridge from '../../src/content/gdocs/main-bridge';

type DocsWin = Window & {
  _docs_annotate_getAnnotatedText?: (id?: string) => unknown;
  _docs_annotate_canvas_by_ext?: string;
  __jammarlyAnnouncedId?: string;
  __jammarlyGdocsBridge?: unknown;
  __jammarlyGdocsBridgeNoAutoInstall?: boolean;
};

const w = window as DocsWin;
let bridge: typeof Bridge;

beforeAll(async () => {
  w.__jammarlyGdocsBridgeNoAutoInstall = true;
  bridge = await import('../../src/content/gdocs/main-bridge');
});

const OUR_ID = 'abcdefghijklmnopabcdefghijklmnop';

interface FakeModel {
  raw: string;
  sel: { start: number; end: number };
  setSelectionCalls: [number, number][];
  getText(): string;
  getSelection(): unknown;
  setSelection(start: number, end: number): void;
}

function fakeModel(text: string): FakeModel {
  const m: FakeModel = {
    raw: `${DOCS_SENTINEL}${text}\n`,
    sel: { start: 1, end: 1 },
    setSelectionCalls: [],
    getText: () => m.raw,
    getSelection: () => [{ anchor: m.sel.start, focus: m.sel.end }],
    setSelection: (start, end) => {
      m.sel = { start, end };
      m.setSelectionCalls.push([start, end]);
    },
  };
  return m;
}

const handles: Bridge.GdocsBridgeHandle[] = [];
const mounted: Element[] = [];
const statuses: GdocsStatus[] = [];
const snapshots: GdocsTextSnapshot[] = [];
const onStatus = (ev: Event): void => {
  const s = decodeStatus((ev as CustomEvent).detail);
  if (s) statuses.push(s);
};
const onText = (ev: Event): void => {
  const s = decodeSnapshot((ev as CustomEvent).detail);
  if (s) snapshots.push(s);
};

function install(opts: Bridge.BridgeOptions = {}): Bridge.GdocsBridgeHandle {
  const h = bridge.installGdocsBridge(window, { activationTimeoutMs: 2000, activationPollMs: 50, textPollMs: 125, ...opts });
  handles.push(h);
  return h;
}

/** A fake `iframe.docs-texteventtarget-iframe` whose editable applies text/plain pastes to `model` like Docs does. */
function makeSink(model: FakeModel, behaviour: 'apply' | 'ignore' | 'garble' = 'apply'): { editable: HTMLElement; pastes: string[]; focusedAtPaste: boolean[] } {
  const iframe = document.createElement('iframe');
  iframe.className = 'docs-texteventtarget-iframe';
  document.body.appendChild(iframe);
  mounted.push(iframe);
  const idoc = iframe.contentDocument!;
  const iwin = iframe.contentWindow as unknown as Record<string, unknown>;
  const editable = idoc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  idoc.body.appendChild(editable);

  class FakeDataTransfer {
    private readonly data = new Map<string, string>();
    setData(type: string, value: string): void {
      this.data.set(type, value);
    }
    getData(type: string): string {
      return this.data.get(type) ?? '';
    }
  }
  const IEvent = iwin.Event as typeof Event;
  class FakeClipboardEvent extends IEvent {
    readonly clipboardData: FakeDataTransfer | null;
    constructor(type: string, init?: EventInit & { clipboardData?: FakeDataTransfer | null }) {
      super(type, init);
      this.clipboardData = init?.clipboardData ?? null;
    }
  }
  iwin.DataTransfer = FakeDataTransfer;
  iwin.ClipboardEvent = FakeClipboardEvent;

  const pastes: string[] = [];
  const focusedAtPaste: boolean[] = [];
  editable.addEventListener('paste', (ev) => {
    const payload = (ev as unknown as FakeClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    pastes.push(payload);
    focusedAtPaste.push(idoc.activeElement === editable);
    if (behaviour === 'ignore') return;
    const cleaned = behaviour === 'garble' ? 'ZZZ' : payload.replace(/^ +| +$/g, '').replace(/ /g, ' ');
    model.raw = model.raw.slice(0, model.sel.start) + cleaned + model.raw.slice(model.sel.end);
    model.sel = { start: model.sel.start + cleaned.length, end: model.sel.start + cleaned.length };
  });
  return { editable, pastes, focusedAtPaste };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.addEventListener(STATUS_EVENT, onStatus);
  document.addEventListener(TEXT_EVENT, onText);
  w.__jammarlyAnnouncedId = OUR_ID;
  w._docs_annotate_canvas_by_ext = OUR_ID;
});

afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const el of mounted.splice(0)) el.remove();
  document.removeEventListener(STATUS_EVENT, onStatus);
  document.removeEventListener(TEXT_EVENT, onText);
  statuses.length = 0;
  snapshots.length = 0;
  delete w._docs_annotate_getAnnotatedText;
  delete w.__jammarlyAnnouncedId;
  delete w._docs_annotate_canvas_by_ext;
  vi.useRealTimers();
});

describe('activation', () => {
  it('starts pending, then activates when Docs returns a model for the announced id', async () => {
    const model = fakeModel('Hello');
    const calls: string[] = [];
    w._docs_annotate_getAnnotatedText = async (id?: string) => {
      calls.push(id ?? '');
      return id === OUR_ID ? model : undefined;
    };
    const h = install();
    expect(h.status().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([OUR_ID]);
    expect(h.status()).toEqual({ state: 'active', active: true, announcedId: OUR_ID });
    expect(statuses.at(-1)).toEqual({ state: 'active', active: true, announcedId: OUR_ID });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ raw: `${DOCS_SENTINEL}Hello\n`, text: 'Hello', leading: 1, trailing: 1, version: 1 });
    expect(h.version()).toBe(1);
  });

  it('waits for the API to appear and uses the pre-set flag when another extension announced first', async () => {
    delete w.__jammarlyAnnouncedId;
    w._docs_annotate_canvas_by_ext = 'otherextensionid0000000000000000';
    const h = install();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.status().state).toBe('pending');
    const model = fakeModel('late');
    w._docs_annotate_getAnnotatedText = async (id?: string) => (id === 'otherextensionid0000000000000000' ? model : undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.status()).toMatchObject({ state: 'active', announcedId: 'otherextensionid0000000000000000' });
  });

  it('reports inactive when Docs returns no model for the id', async () => {
    w._docs_annotate_getAnnotatedText = async () => undefined;
    const h = install();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.status().state).toBe('inactive');
    expect(h.status().active).toBe(false);
    expect(h.status().error).toMatch(/no annotated-text model/);
    expect(statuses.at(-1)?.state).toBe('inactive');
    expect(snapshots).toHaveLength(0);
  });

  it('reports inactive when the API never appears within the activation window', async () => {
    const h = install({ activationTimeoutMs: 400 });
    await vi.advanceTimersByTimeAsync(350);
    expect(h.status().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.status().state).toBe('inactive');
    expect(h.status().error).toMatch(/did not expose/);
  });

  it('reports inactive when the API throws', async () => {
    w._docs_annotate_getAnnotatedText = async () => {
      throw new Error('kaboom');
    };
    const h = install();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.status().error).toMatch(/threw: kaboom/);
  });

  it('calls the API only once even though the activation poll keeps ticking during the call', async () => {
    let calls = 0;
    let resolveModel: (m: unknown) => void = () => undefined;
    w._docs_annotate_getAnnotatedText = () => {
      calls++;
      return new Promise((resolve) => {
        resolveModel = resolve;
      });
    };
    install();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);
    resolveModel(fakeModel('x'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    expect(statuses.at(-1)?.state).toBe('active');
  });

  it('a second install on the same window is inert until the first is disposed', async () => {
    w._docs_annotate_getAnnotatedText = async () => fakeModel('x');
    const first = install();
    const second = install();
    await vi.advanceTimersByTimeAsync(10);
    expect(first.status().state).toBe('active');
    expect(second.status()).toMatchObject({ state: 'inactive', error: 'bridge already installed' });
    expect(w.__jammarlyGdocsBridge).toEqual({ version: 1 });
    first.dispose();
    expect(w.__jammarlyGdocsBridge).toBeUndefined();
    const third = install();
    await vi.advanceTimersByTimeAsync(10);
    expect(third.status().state).toBe('active');
  });
});

describe('text polling', () => {
  it('emits a snapshot only when the text changed', async () => {
    const model = fakeModel('one');
    w._docs_annotate_getAnnotatedText = async () => model;
    install();
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(snapshots).toHaveLength(1);
    model.raw = `${DOCS_SENTINEL}one two\n`;
    await vi.advanceTimersByTimeAsync(125);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ text: 'one two', version: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(snapshots).toHaveLength(2);
  });

  it('goes inactive after repeated getText failures', async () => {
    const model = fakeModel('one');
    w._docs_annotate_getAnnotatedText = async () => model;
    const h = install({ maxPollFailures: 3 });
    await vi.advanceTimersByTimeAsync(10);
    model.getText = () => {
      throw new Error('gone');
    };
    await vi.advanceTimersByTimeAsync(125 * 2);
    expect(h.status().state).toBe('active');
    await vi.advanceTimersByTimeAsync(125);
    expect(h.status()).toMatchObject({ state: 'inactive', error: expect.stringMatching(/getText\(\) failed: gone/) });
  });
});

describe('RPC', () => {
  let client: EventRpcClient;
  let model: FakeModel;

  beforeEach(async () => {
    model = fakeModel('The meeting is tomorow at noon.\nWe will discuss the the budget.');
    w._docs_annotate_getAnnotatedText = async (id?: string) => (id === OUR_ID ? model : undefined);
    install();
    await vi.advanceTimersByTimeAsync(10);
    client = new EventRpcClient(document, 1000);
  });

  afterEach(() => {
    client.dispose();
  });

  /** Advance timers until the promise settles (applyEdit awaits setTimeout(0) ticks). */
  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(20);
    return p;
  }

  it('answers status, getText and getSelection', async () => {
    await expect(client.call('status', {})).resolves.toEqual({ state: 'active', active: true, announcedId: OUR_ID });
    await expect(client.call('getText', {})).resolves.toEqual({ raw: model.raw });
    model.sel = { start: 9, end: 4 };
    await expect(client.call('getSelection', {})).resolves.toEqual({ start: 4, end: 9 });
  });

  it('forwards setSelection to the model', async () => {
    await expect(client.call('setSelection', { start: 2, end: 5 })).resolves.toEqual({ ok: true });
    expect(model.setSelectionCalls).toEqual([[2, 5]]);
  });

  it('replaces a word with one paste, refocusing the sink, and verifies by re-reading', async () => {
    const sink = makeSink(model);
    const start = model.raw.indexOf('tomorow');
    const before = model.raw;
    const result = await settle(client.call('applyEdit', { start, end: start + 7, replacement: 'tomorrow', expectedRaw: before }));
    expect(result).toEqual({ ok: true, text: before.replace('tomorow', 'tomorrow'), strategy: 'replace' });
    expect(sink.pastes).toEqual(['tomorrow']);
    expect(sink.focusedAtPaste).toEqual([true]);
    expect(model.setSelectionCalls).toEqual([[start, start + 7]]);
    expect(snapshots.at(-1)?.text).toContain('tomorrow');
  });

  it('deletes by borrowing the neighbouring character (NBSP for a space)', async () => {
    const sink = makeSink(model);
    const start = model.raw.indexOf(' the budget');
    const result = await settle(client.call('applyEdit', { start, end: start + 4, replacement: '' }));
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('delete-right');
    expect(result.text).toContain('discuss the budget.');
    expect(result.text).not.toContain('the the');
    expect(sink.pastes).toEqual([NBSP]);
    expect(model.setSelectionCalls).toEqual([[start, start + 5]]);
  });

  it('refuses a stale compare-and-swap guard without pasting', async () => {
    const sink = makeSink(model);
    const result = await settle(client.call('applyEdit', { start: 1, end: 4, replacement: 'x', expectedRaw: `${DOCS_SENTINEL}something else\n` }));
    expect(result).toEqual({ ok: false, text: model.raw, reason: 'stale' });
    expect(sink.pastes).toEqual([]);
    expect(model.setSelectionCalls).toEqual([]);
  });

  it('reports no-effect when Docs ignored the paste and mismatch when it produced other text', async () => {
    const ignore = makeSink(model, 'ignore');
    const before = model.raw;
    const r1 = await settle(client.call('applyEdit', { start: 1, end: 4, replacement: 'XYZ' }));
    expect(r1).toEqual({ ok: false, text: before, reason: 'no-effect' });
    expect(ignore.pastes).toEqual(['XYZ']);
    ignore.editable.remove();
    mounted.forEach((el) => el.remove());
    mounted.length = 0;
    makeSink(model, 'garble');
    const r2 = await settle(client.call('applyEdit', { start: 1, end: 4, replacement: 'XYZ' }));
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('mismatch');
    expect(r2.text).toContain('ZZZ');
  });

  it('answers unsupported without a sink, for a bad range, and for an uncarriable deletion', async () => {
    expect(await settle(client.call('applyEdit', { start: 1, end: 4, replacement: 'x' }))).toMatchObject({ ok: false, reason: 'unsupported' });
    makeSink(model);
    expect(await settle(client.call('applyEdit', { start: 1, end: model.raw.length + 5, replacement: 'x' }))).toMatchObject({ ok: false, reason: 'mismatch' });
    const whole = fakeModel('only');
    model.raw = whole.raw;
    await vi.advanceTimersByTimeAsync(125);
    expect(await settle(client.call('applyEdit', { start: 1, end: 5, replacement: '' }))).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('treats an edit that changes nothing as a no-op success', async () => {
    const sink = makeSink(model);
    const r = await settle(client.call('applyEdit', { start: 1, end: 4, replacement: 'The' }));
    expect(r).toEqual({ ok: true, text: model.raw, strategy: 'noop' });
    expect(sink.pastes).toEqual([]);
  });

  it('returns geometry for raw offsets from the annotation layer', async () => {
    const div = document.createElement('div');
    div.className = 'kix-canvas-tile-content';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'matrix(1,0,0,1,72,96)');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('aria-label', 'The meeting is tomorow at noon.');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '310');
    rect.setAttribute('height', '20');
    g.appendChild(rect);
    svg.appendChild(g);
    div.appendChild(svg);
    document.body.appendChild(div);
    mounted.push(div);
    const start = model.raw.indexOf('tomorow');
    const rects = await client.call('getGeometry', { start, end: start + 7 }); // raw offsets
    expect(rects).toHaveLength(1);
    expect(rects[0]!.left).toBeCloseTo(72 + 150);
    expect(rects[0]!.width).toBeCloseTo(70);
    expect(rects[0]!.top).toBe(96);
  });

  it('rejects RPC calls once the bridge is inactive', async () => {
    for (const h of handles) h.dispose();
    handles.length = 0;
    w._docs_annotate_getAnnotatedText = async () => undefined;
    install();
    await vi.advanceTimersByTimeAsync(10);
    await expect(client.call('getText', {})).rejects.toThrow(/inactive/);
  });
});

describe('helpers', () => {
  it('parses the selection endpoint variants', () => {
    expect(bridge.parseDocsSelection([{ anchor: 5, focus: 2 }])).toEqual({ start: 2, end: 5 });
    expect(bridge.parseDocsSelection([{ base: 1, extent: 3 }])).toEqual({ start: 1, end: 3 });
    expect(bridge.parseDocsSelection({ start: 4, end: 4 })).toEqual({ start: 4, end: 4 });
    expect(bridge.parseDocsSelection([{ anchor: { index: 7 }, focus: { index: 9 } }])).toEqual({ start: 7, end: 9 });
    expect(bridge.parseDocsSelection([])).toBeNull();
    expect(bridge.parseDocsSelection(null)).toBeNull();
    expect(bridge.parseDocsSelection([{ foo: 1 }])).toBeNull();
  });

  it('finds no paste sink without the input iframe', () => {
    expect(bridge.findPasteSink(document)).toBeNull();
  });

  it('refuses to paste when the iframe realm lacks the clipboard constructors', () => {
    const iframe = document.createElement('iframe');
    iframe.className = 'docs-texteventtarget-iframe';
    document.body.appendChild(iframe);
    mounted.push(iframe);
    const idoc = iframe.contentDocument!;
    const editable = idoc.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    idoc.body.appendChild(editable);
    const sink = bridge.findPasteSink(document);
    expect(sink?.editable).toBe(editable);
    delete (iframe.contentWindow as unknown as Record<string, unknown>).ClipboardEvent;
    expect(bridge.dispatchPaste(sink!, 'x')).toBe(false);
  });
});
