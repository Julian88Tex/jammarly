import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edit } from '@jammarly/shared/types';
import { TextareaAdapter, setNativeValue, translateMirrorRects, type RectLike } from '../../src/content/adapters/textarea';
import { VERIFY_DELAY_MS, verifyWindows } from '../../src/content/adapters/common';
import { generic } from '../../src/content/sites/generic';
import { gmail } from '../../src/content/sites/gmail';

const mounted: Element[] = [];
const adapters: TextareaAdapter[] = [];

function mount<T extends Element>(el: T): T {
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

function makeTextarea(value: string): HTMLTextAreaElement {
  const ta = mount(document.createElement('textarea'));
  ta.value = value;
  return ta;
}

function adapterFor(el: HTMLTextAreaElement | HTMLInputElement, profile = generic): TextareaAdapter {
  const a = new TextareaAdapter(el, profile);
  adapters.push(a);
  return a;
}

function edit(text: string, original: string, replacement: string, occurrence = 0): Edit {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(original, start + 1);
  if (start < 0) throw new Error(`"${original}" not in "${text}"`);
  return { range: { start, end: start + original.length }, original, replacement };
}

/** Run the fake clock far enough for every verification window to pass and return the outcome. */
async function settle<T>(p: Promise<T>, ms = 1000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

/** React-style controlled component: an own `value` property that forwards to the native one, plus an input listener. */
function controlled(ta: HTMLTextAreaElement): { model: () => string; events: InputEvent[] } {
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
  let state = ta.value;
  const events: InputEvent[] = [];
  Object.defineProperty(ta, 'value', {
    get() {
      return desc.get!.call(this);
    },
    set(v: string) {
      desc.set!.call(this, v); // tracked, but the model only updates on an input event
    },
    configurable: true,
  });
  ta.addEventListener('input', (ev) => {
    events.push(ev as InputEvent);
    state = ta.value;
  });
  return { model: () => state, events };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16));
});

afterEach(() => {
  for (const a of adapters.splice(0)) a.dispose();
  for (const el of mounted.splice(0)) el.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TextareaAdapter reading', () => {
  it('reports kind and text for textareas and inputs', () => {
    const ta = makeTextarea('hello world');
    expect(adapterFor(ta).kind).toBe('textarea');
    expect(adapterFor(ta).getText()).toBe('hello world');
    const inp = mount(document.createElement('input'));
    inp.type = 'text';
    inp.value = 'subject line';
    const a = adapterFor(inp);
    expect(a.kind).toBe('input');
    expect(a.getText()).toBe('subject line');
    expect(a.getProtectedRanges()).toEqual([]);
    expect(a.element).toBe(inp);
  });

  it('exposes label and doc hint through the profile', () => {
    const inp = mount(document.createElement('input'));
    inp.type = 'text';
    inp.name = 'subjectbox';
    const a = adapterFor(inp, gmail);
    expect(a.getLabel()).toBe('Subject');
    expect(a.getDocHint()).toBe(''); // jsdom location has no compose id
  });

  it('round-trips the selection', () => {
    const ta = makeTextarea('hello world');
    const a = adapterFor(ta);
    a.setSelection({ start: 6, end: 11 });
    expect(a.getSelection()).toEqual({ start: 6, end: 11 });
    a.setSelection({ start: -5, end: 99 });
    expect(a.getSelection()).toEqual({ start: 0, end: 11 });
  });

  it('builds a hidden mirror in document.body holding value + sentinel and removes it on dispose', () => {
    const ta = makeTextarea('line one\nline two  ');
    const a = adapterFor(ta);
    expect(a.getRangeRects({ start: 0, end: 4 })).toEqual([]); // jsdom has no Range.getClientRects
    const mirror = document.body.querySelector('[data-jammarly-mirror]') as HTMLDivElement;
    expect(mirror).not.toBeNull();
    expect(mirror.getAttribute('aria-hidden')).toBe('true');
    expect(mirror.style.position).toBe('absolute');
    expect(mirror.style.visibility).toBe('hidden');
    expect(mirror.style.pointerEvents).toBe('none');
    expect(mirror.style.whiteSpace).toBe('pre-wrap');
    expect(mirror.firstChild!.textContent).toBe('line one\nline two  ​');
    ta.value = 'changed';
    a.getRangeRects({ start: 0, end: 2 });
    expect(mirror.firstChild!.textContent).toBe('changed​');
    a.dispose();
    expect(document.body.querySelector('[data-jammarly-mirror]')).toBeNull();
  });

  it('uses white-space: pre for inputs and for textarea wrap="off"', () => {
    const inp = mount(document.createElement('input'));
    inp.type = 'text';
    inp.value = 'abc';
    adapterFor(inp).getRangeRects({ start: 0, end: 1 });
    const mirrors = document.body.querySelectorAll('[data-jammarly-mirror]');
    expect((mirrors[0] as HTMLElement).style.whiteSpace).toBe('pre');
    const ta = makeTextarea('abc');
    ta.setAttribute('wrap', 'off');
    adapterFor(ta).getRangeRects({ start: 0, end: 1 });
    const all = document.body.querySelectorAll('[data-jammarly-mirror]');
    expect((all[all.length - 1] as HTMLElement).style.whiteSpace).toBe('pre');
  });
});

describe('translateMirrorRects (pure)', () => {
  const rect = (left: number, top: number, right: number, bottom: number): RectLike => ({ left, top, right, bottom, width: right - left, height: bottom - top });

  it('shifts by (field box − mirror box) minus scroll offsets', () => {
    const out = translateMirrorRects([rect(10, 20, 60, 36)], {
      mirrorBox: { left: 0, top: 0 },
      fieldBox: { left: 100, top: 200 },
      scrollLeft: 0,
      scrollTop: 0,
      clientLeft: 2,
      clientTop: 2,
      clientWidth: 500,
      clientHeight: 300,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.left).toBe(110);
    expect(out[0]!.top).toBe(220);
    expect(out[0]!.width).toBe(50);
    expect(out[0]!.height).toBe(16);

    const scrolled = translateMirrorRects([rect(10, 120, 60, 136)], {
      mirrorBox: { left: 0, top: 0 },
      fieldBox: { left: 100, top: 200 },
      scrollLeft: 5,
      scrollTop: 100,
      clientLeft: 2,
      clientTop: 2,
      clientWidth: 500,
      clientHeight: 300,
    });
    expect(scrolled[0]!.left).toBe(105);
    expect(scrolled[0]!.top).toBe(220);
  });

  it('clips to the client box (borders excluded) and drops rects outside it', () => {
    const g = { mirrorBox: { left: 0, top: 0 }, fieldBox: { left: 100, top: 200 }, scrollLeft: 0, scrollTop: 50, clientLeft: 2, clientTop: 2, clientWidth: 200, clientHeight: 100 };
    // Scrolled out above the client box: top 20 - 50 + 200 = 170 < 202.
    expect(translateMirrorRects([rect(10, 20, 60, 36)], g)).toEqual([]);
    // Partially clipped at the right edge: 100 + 2 + 200 = 302.
    const partial = translateMirrorRects([rect(150, 80, 260, 96)], g);
    expect(partial).toHaveLength(1);
    expect(partial[0]!.left).toBe(250);
    expect(partial[0]!.right).toBe(302);
    expect(partial[0]!.top).toBe(230);
    // Partially clipped at the top edge.
    const top = translateMirrorRects([rect(10, 40, 60, 60)], g);
    expect(top[0]!.top).toBe(202);
    expect(top[0]!.bottom).toBe(210);
  });

  it('merges fragments on the same line and keeps lines sorted', () => {
    const g = { mirrorBox: { left: 0, top: 0 }, fieldBox: { left: 0, top: 0 }, scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0, clientWidth: 1000, clientHeight: 1000 };
    const out = translateMirrorRects([rect(300, 40, 350, 56), rect(10, 20, 60, 36), rect(60, 20, 120, 36), rect(0, 0, 0, 0)], g);
    expect(out).toHaveLength(2);
    expect(out[0]!.top).toBe(20);
    expect(out[0]!.left).toBe(10);
    expect(out[0]!.right).toBe(120);
    expect(out[1]!.top).toBe(40);
  });
});

describe('setNativeValue', () => {
  it('bypasses an own instance setter and still updates the underlying value', () => {
    const ta = makeTextarea('a');
    const ownSetter = vi.fn();
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    Object.defineProperty(ta, 'value', {
      get() {
        return desc.get!.call(this);
      },
      set(v: string) {
        ownSetter(v);
        desc.set!.call(this, v);
      },
      configurable: true,
    });
    setNativeValue(ta, 'b');
    expect(ta.value).toBe('b');
    expect(ownSetter).not.toHaveBeenCalled();
  });
});

describe('TextareaAdapter.applyEdit', () => {
  it('falls through to the splice rung without execCommand and updates a React-controlled model via a native input event', async () => {
    const text = 'This sentance has a speling mistake.';
    const ta = makeTextarea(text);
    const { model, events } = controlled(ta);
    const changeSpy = vi.fn();
    ta.addEventListener('change', changeSpy);
    const a = adapterFor(ta);
    const e = edit(text, 'sentance', 'sentence');
    const out = await settle(a.applyEdit(e));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('splice');
    expect(out.text).toBe('This sentence has a speling mistake.');
    expect(ta.value).toBe(out.text);
    expect(model()).toBe(out.text);
    expect(events).toHaveLength(1);
    expect(events[0]!.inputType).toBe('insertReplacementText');
    expect(events[0]!.data).toBe('sentence');
    expect(events[0]!.bubbles).toBe(true);
    expect(changeSpy).not.toHaveBeenCalled();
    // Caret at the end of the replacement.
    expect(ta.selectionStart).toBe(e.range.start + 'sentence'.length);
    expect(ta.selectionEnd).toBe(ta.selectionStart);
  });

  it('deletes with deleteContentBackward and no data', async () => {
    const text = 'the the store';
    const ta = makeTextarea(text);
    const { events } = controlled(ta);
    const a = adapterFor(ta);
    const out = await settle(a.applyEdit(edit(text, 'the ', '')));
    expect(out.status).toBe('applied');
    expect(ta.value).toBe('the store');
    expect(events[0]!.inputType).toBe('deleteContentBackward');
    expect(events[0]!.data).toBeNull();
  });

  it('returns mismatch without writing when the original no longer matches', async () => {
    const ta = makeTextarea('hello world');
    const { events } = controlled(ta);
    const a = adapterFor(ta);
    const out = await settle(a.applyEdit({ range: { start: 0, end: 5 }, original: 'jello', replacement: 'yellow' }));
    expect(out.status).toBe('mismatch');
    expect(out.rung).toBeNull();
    expect(out.text).toBe('hello world');
    expect(events).toHaveLength(0);
    const oob = await settle(a.applyEdit({ range: { start: 6, end: 20 }, original: 'world', replacement: 'x' }));
    expect(oob.status).toBe('mismatch');
  });

  it('uses the execCommand rung first when the browser provides it and counts it as native undo', async () => {
    const text = 'hello world';
    const ta = makeTextarea(text);
    const exec = vi.fn((_cmd: string, _ui: boolean, value: string) => {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + value + ta.value.slice(e);
      ta.setSelectionRange(s + value.length, s + value.length);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return true;
    });
    (document as Document & { execCommand?: unknown }).execCommand = exec;
    try {
      const a = adapterFor(ta);
      const out = await settle(a.applyEdit(edit(text, 'world', 'there')));
      expect(out.status).toBe('applied');
      expect(out.rung).toBe('execCommand');
      expect(exec).toHaveBeenCalledWith('insertText', false, 'there');
      expect(ta.value).toBe('hello there');
      const batch = await settle(a.applyEdits([edit('hello there', 'hello', 'hi')]));
      expect(batch.nativeUndoSteps).toBe(1);
      expect(batch.text).toBe('hi there');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('never re-runs a rung: a no-op execCommand falls through to splice exactly once', async () => {
    const text = 'hello world';
    const ta = makeTextarea(text);
    const exec = vi.fn(() => false);
    (document as Document & { execCommand?: unknown }).execCommand = exec;
    try {
      const a = adapterFor(ta);
      const out = await settle(a.applyEdit(edit(text, 'world', 'there')));
      expect(out.status).toBe('applied');
      expect(out.rung).toBe('splice');
      expect(exec).toHaveBeenCalledTimes(1);
      expect(ta.value).toBe('hello there');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('verifies at the next frame and at +150 ms, reporting a host that reverts the write', async () => {
    const text = 'hello world';
    const ta = makeTextarea(text);
    // A host that reverts foreign writes shortly after they land.
    ta.addEventListener('input', () => {
      setTimeout(() => setNativeValue(ta, text), 40);
    });
    const a = adapterFor(ta);
    let resolved = false;
    const p = a.applyEdit(edit(text, 'world', 'there')).then((o) => {
      resolved = true;
      return o;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(ta.value).toBe('hello there'); // written synchronously
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect(resolved).toBe(false); // the frame check passed; now inside the +150 ms window
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS + 50);
    expect(resolved).toBe(true);
    const out = await p;
    expect(out.status).toBe('reverted');
    expect(out.rung).toBe('splice');
    expect(out.text).toBe(text);
  });

  it('resolves only after the +150 ms window when the write sticks', async () => {
    const text = 'hello world';
    const ta = makeTextarea(text);
    const a = adapterFor(ta);
    let resolved = false;
    const p = a.applyEdit(edit(text, 'world', 'there')).then((o) => {
      resolved = true;
      return o;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
    expect((await p).status).toBe('applied');
  });

  it('verifyWindows resolves early on an immediate miss and waits the full window when patient', async () => {
    let n = 0;
    const early = verifyWindows(() => false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await early).toBe('no-effect');
    const late = verifyWindows(() => ++n >= 3, Date.now(), true); // becomes true only at the third (final) check
    await vi.advanceTimersByTimeAsync(300);
    expect(await late).toBe('applied');
  });

  it('refuses to write while an IME composition is active', async () => {
    const text = 'hello world';
    const ta = makeTextarea(text);
    const a = adapterFor(ta);
    ta.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(a.isComposing()).toBe(true);
    const out = await settle(a.applyEdit(edit(text, 'world', 'there')));
    expect(out).toEqual({ status: 'composing', rung: null, text });
    expect(ta.value).toBe(text);
    ta.dispatchEvent(new CompositionEvent('compositionend'));
    expect(a.isComposing()).toBe(false);
    const after = await settle(a.applyEdit(edit(text, 'world', 'there')));
    expect(after.status).toBe('applied');
  });
});

describe('TextareaAdapter.applyEdits', () => {
  it('applies right-to-left against one snapshot and reports what was applied', async () => {
    const text = 'aaa bbb ccc ddd';
    const ta = makeTextarea(text);
    const a = adapterFor(ta);
    const edits = [edit(text, 'aaa', 'A'), edit(text, 'ccc', 'CCCC'), edit(text, 'bbb', '')];
    const out = await settle(a.applyEdits(edits), 3000);
    expect(ta.value).toBe('A  CCCC ddd');
    expect(out.text).toBe(ta.value);
    expect(out.applied.map((e) => e.original)).toEqual(['ccc', 'bbb', 'aaa']);
    expect(out.skipped).toEqual([]);
    expect(out.nativeUndoSteps).toBe(0);
  });

  it('aborts on the first mismatch and skips the rest', async () => {
    const text = 'aaa bbb ccc';
    const ta = makeTextarea(text);
    const a = adapterFor(ta);
    const bad: Edit = { range: { start: 4, end: 7 }, original: 'xxx', replacement: 'B' };
    const out = await settle(a.applyEdits([edit(text, 'aaa', 'A'), bad, edit(text, 'ccc', 'C')]), 3000);
    expect(ta.value).toBe('aaa bbb C');
    expect(out.applied.map((e) => e.original)).toEqual(['ccc']);
    expect(out.skipped.map((s) => [s.edit.original, s.reason])).toEqual([
      ['xxx', 'mismatch'],
      ['aaa', 'mismatch'],
    ]);
  });

  it('skips overlapping edits without aborting', async () => {
    const text = 'aaa bbb ccc';
    const ta = makeTextarea(text);
    const a = adapterFor(ta);
    const overlapping: Edit = { range: { start: 6, end: 9 }, original: 'b c', replacement: 'X' };
    const out = await settle(a.applyEdits([edit(text, 'ccc', 'C'), overlapping, edit(text, 'aaa', 'A')]), 3000);
    expect(ta.value).toBe('A bbb C');
    expect(out.skipped).toEqual([{ edit: overlapping, reason: 'mismatch' }]);
  });
});

describe('TextareaAdapter subscriptions', () => {
  it('reports input events with their inputType, skips composing input and emits on compositionend', () => {
    const ta = makeTextarea('a');
    const a = adapterFor(ta);
    const cb = vi.fn();
    const off = a.onChange(cb);
    ta.value = 'ab';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'b' }));
    expect(cb).toHaveBeenCalledWith('ab', 'insertText');
    ta.dispatchEvent(new CompositionEvent('compositionstart'));
    ta.value = 'abc';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'c', isComposing: true }));
    expect(cb).toHaveBeenCalledTimes(1);
    ta.dispatchEvent(new CompositionEvent('compositionend'));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('abc', 'insertCompositionText');
    off();
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('reports layout changes on field scroll, document scroll and window resize', () => {
    const ta = makeTextarea('a');
    const a = adapterFor(ta);
    const cb = vi.fn();
    const off = a.onLayout(cb);
    ta.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledTimes(1);
    const scroller = mount(document.createElement('div'));
    scroller.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('resize'));
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    ta.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('reports focus changes', () => {
    const ta = makeTextarea('a');
    const a = adapterFor(ta);
    const cb = vi.fn();
    a.onFocusChange(cb);
    ta.focus();
    expect(cb).toHaveBeenLastCalledWith(true);
    expect(a.isFocused()).toBe(true);
    ta.blur();
    expect(cb).toHaveBeenLastCalledWith(false);
    expect(a.isFocused()).toBe(false);
  });

  it('dispose removes every listener', () => {
    const ta = makeTextarea('a');
    const a = adapterFor(ta);
    const change = vi.fn();
    const layout = vi.fn();
    a.onChange(change);
    a.onLayout(layout);
    a.dispose();
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    ta.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(change).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
  });
});
