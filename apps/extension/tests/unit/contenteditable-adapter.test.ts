import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edit } from '@jammarly/shared/types';
import type { SiteProfile } from '../../src/content/field-adapter';
import { ContentEditableAdapter, deletionLadder, edgeSpacesToNbsp, elementRange, mergeRanges } from '../../src/content/adapters/contenteditable';
import { serializeEditable } from '../../src/content/dom-text';
import { defineProfile } from '../../src/content/sites/base';
import { discord } from '../../src/content/sites/discord';
import { facebook } from '../../src/content/sites/facebook';
import { generic } from '../../src/content/sites/generic';
import { gmail } from '../../src/content/sites/gmail';
import { prosemirror } from '../../src/content/sites/prosemirror';
import { twitter } from '../../src/content/sites/twitter';

const mounted: Element[] = [];
const adapters: ContentEditableAdapter[] = [];

function editor(html: string, attrs: Record<string, string> = {}): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('contenteditable', 'true');
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  root.innerHTML = html;
  document.body.appendChild(root);
  mounted.push(root);
  return root;
}

function adapterFor(root: HTMLElement, profile: SiteProfile = generic): ContentEditableAdapter {
  const a = new ContentEditableAdapter(root, profile);
  adapters.push(a);
  return a;
}

function edit(text: string, original: string, replacement: string): Edit {
  const start = text.indexOf(original);
  if (start < 0) throw new Error(`"${original}" not in "${text}"`);
  return { range: { start, end: start + original.length }, original, replacement };
}

async function settle<T>(p: Promise<T>, ms = 1000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

async function microtasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Minimal stand-ins for APIs jsdom lacks (used only by the paste-rung tests). */
class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  get types(): string[] {
    return [...this.data.keys()];
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}
class FakeClipboardEvent extends Event {
  readonly clipboardData: FakeDataTransfer | null;
  constructor(type: string, init?: EventInit & { clipboardData?: FakeDataTransfer | null }) {
    super(type, init);
    this.clipboardData = init?.clipboardData ?? null;
  }
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

const GMAIL_HTML = '<div dir="ltr">Hi team,<div><br></div><div>I just wanted to touch base and see if you could send me the the report.</div></div>';

describe('reading', () => {
  it('serializes like dom-text and caches until the next mutation', () => {
    const root = editor(GMAIL_HTML);
    const a = adapterFor(root, gmail);
    expect(a.kind).toBe('contenteditable');
    expect(a.getText()).toBe(serializeEditable(root).text);
    expect(a.getText()).toBe('Hi team,\n\nI just wanted to touch base and see if you could send me the the report.');
    root.querySelector('div[dir] > div:last-child')!.textContent = 'Changed.';
    // Mutation records are pending (not yet delivered): the cache must still be refreshed on read.
    expect(a.getText()).toBe('Hi team,\n\nChanged.');
  });

  it('labels a Gmail body through the profile and reports an empty doc hint under jsdom', () => {
    const root = editor('x', { g_editable: 'true', 'aria-label': 'Nachrichtentext' });
    const a = adapterFor(root, gmail);
    expect(a.getLabel()).toBe('Message body');
    expect(a.getDocHint()).toBe('');
  });

  it('returns no rects in jsdom (no Range.getClientRects) and never throws on bad offsets', () => {
    const a = adapterFor(editor('<p>hello</p>'));
    expect(a.getRangeRects({ start: 0, end: 5 })).toEqual([]);
    expect(a.getRangeRects({ start: 3, end: 1 })).toEqual([]);
    expect(a.getRangeRects({ start: -1, end: 99 })).toEqual([]);
  });

  it('round-trips the selection through dom-text', () => {
    const root = editor('<div>Hi team,</div><div>Second <b>line</b> here</div>');
    const a = adapterFor(root);
    const text = a.getText();
    const start = text.indexOf('line');
    a.setSelection({ start, end: start + 4 });
    expect(document.getSelection()!.toString()).toBe('line');
    expect(a.getSelection()).toEqual({ start, end: start + 4 });
  });

  it('is not focused until focused, and focus() focuses the root', () => {
    const root = editor('<p>hello</p>', { tabindex: '0' });
    const a = adapterFor(root);
    expect(a.isFocused()).toBe(false);
    const spy = vi.spyOn(root, 'focus');
    a.focus();
    expect(spy).toHaveBeenCalled();
    expect(a.isFocused()).toBe(document.activeElement === root);
  });
});

describe('protected ranges', () => {
  it('unions atomic chips, zero-width characters and profile selectors', () => {
    const root = editor(
      '<div>Hi <span contenteditable="false">@bob</span> see​ this</div><div class="gmail_quote">On Monday, Ann wrote:<br>quoted</div><div class="gmail_signature">-- Sam</div>',
    );
    const a = adapterFor(root, gmail);
    const text = a.getText();
    const chip = text.indexOf('@bob');
    const zw = text.indexOf('​');
    const quote = text.indexOf('On Monday');
    const sig = text.indexOf('-- Sam');
    expect(a.getProtectedRanges()).toEqual([
      { start: chip, end: chip + 4 },
      { start: zw, end: zw + 1 },
      { start: quote, end: sig - 1 },
      { start: sig, end: text.length },
    ]);
  });

  it('protects framework decorators and replaced elements (zero-length)', () => {
    const root = editor('<p>Hello <span data-lexical-decorator="true">[poll]</span> world <img alt="emoji"> end</p>', { 'data-lexical-editor': 'true' });
    const a = adapterFor(root, facebook);
    const text = a.getText();
    const deco = text.indexOf('[poll]');
    const img = text.indexOf(' end');
    expect(a.getProtectedRanges()).toEqual([
      { start: deco, end: deco + 6 },
      { start: img, end: img },
    ]);
  });

  it('elementRange and mergeRanges are pure helpers', () => {
    const root = editor('<div>abc</div><div class="q">def</div>');
    const s = serializeEditable(root);
    expect(elementRange(s, root.querySelector('.q')!)).toEqual({ start: 4, end: 7 });
    expect(mergeRanges([{ start: 5, end: 9 }, { start: 1, end: 3 }, { start: 2, end: 6 }, { start: 7, end: 7 }, { start: 12, end: 12 }])).toEqual([
      { start: 1, end: 9 },
      { start: 12, end: 12 },
    ]);
    expect(edgeSpacesToNbsp('  a b ')).toBe('  a b ');
    expect(edgeSpacesToNbsp('ab')).toBe('ab');
  });
});

describe('applyEdit: splice rung', () => {
  it('round-trips through dom-text on a Gmail-like DOM (execCommand and paste unavailable in jsdom)', async () => {
    const root = editor(GMAIL_HTML);
    const inputs: InputEvent[] = [];
    root.addEventListener('input', (ev) => inputs.push(ev as InputEvent));
    const a = adapterFor(root, gmail);
    const text = a.getText();
    const out = await settle(a.applyEdit(edit(text, 'the the report', 'the report')));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('splice');
    expect(out.text).toBe('Hi team,\n\nI just wanted to touch base and see if you could send me the report.');
    expect(a.getText()).toBe(out.text);
    expect(root.querySelectorAll('div').length).toBe(3); // structure preserved
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.inputType).toBe('insertReplacementText');
    expect(inputs[0]!.data).toBe('the report');
  });

  function draftRoot(): HTMLElement {
    return editor(
      '<div data-contents="true"><div data-block="true" data-offset-key="a-0-0"><div data-offset-key="a-0-0"><span data-offset-key="a-0-0"><span data-text="true">Their going to the store.</span></span></div></div></div>',
      { class: 'public-DraftEditor-content', role: 'textbox' },
    );
  }

  it('round-trips on a Draft.js-like DOM (execCommand and paste unavailable in jsdom)', async () => {
    const root = draftRoot();
    const a = adapterFor(root, twitter);
    const text = a.getText();
    expect(text).toBe('Their going to the store.');
    const out = await settle(a.applyEdit(edit(text, 'Their', "They're")));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('splice');
    expect(root.querySelector('[data-text="true"]')!.textContent).toBe("They're going to the store.");
    expect(a.getText()).toBe("They're going to the store.");
  });

  it('nudges Draft.js with a synthetic selectionchange before a selection-based rung, and only Draft.js', async () => {
    const synthetic: Event[] = [];
    const onChange = (ev: Event) => {
      if (!ev.isTrusted) synthetic.push(ev);
    };
    document.addEventListener('selectionchange', onChange);
    try {
      const ladder = defineProfile({ id: 'd', matches: () => true, ladder: ['beforeinput', 'splice'] });
      const draft = adapterFor(draftRoot(), ladder);
      const out = await settle(draft.applyEdit(edit(draft.getText(), 'Their', "They're")));
      expect(out.status).toBe('applied');
      expect(out.rung).toBe('beforeinput');
      expect(synthetic).toHaveLength(1);
      const plain = adapterFor(editor('<p>Their going</p>'), ladder);
      const out2 = await settle(plain.applyEdit(edit(plain.getText(), 'Their', "They're")));
      expect(out2.rung).toBe('beforeinput');
      expect(synthetic).toHaveLength(1);
    } finally {
      document.removeEventListener('selectionchange', onChange);
    }
  });

  it('replaces across inline formatting boundaries and deletes without pasting', async () => {
    const root = editor('<div>te<b>eth</b> hurt</div>');
    const a = adapterFor(root, defineProfile({ id: 't', matches: () => true, ladder: ['splice'] }));
    const out = await settle(a.applyEdit(edit(a.getText(), 'teeth', 'tooth')));
    expect(out.status).toBe('applied');
    expect(a.getText()).toBe('tooth hurt');
    const del = await settle(a.applyEdit(edit(a.getText(), ' hurt', '')));
    expect(del.status).toBe('applied');
    expect(del.rung).toBe('splice');
    expect(a.getText()).toBe('tooth');
  });

  it('returns mismatch when the original is stale', async () => {
    const root = editor('<p>hello world</p>');
    const a = adapterFor(root);
    const out = await settle(a.applyEdit({ range: { start: 0, end: 5 }, original: 'jello', replacement: 'x' }));
    expect(out).toEqual({ status: 'mismatch', rung: null, text: 'hello world' });
  });
});

describe('applyEdit: beforeinput rung', () => {
  it('dispatches insertReplacementText with target ranges and lets the editor take over', async () => {
    const root = editor('<div data-slate-node="element"><span data-slate-string="true">Their going to the store.</span></div>', {
      'data-slate-editor': 'true',
      role: 'textbox',
    });
    const seen: { inputType: string; data: string | null; target: string }[] = [];
    root.addEventListener('beforeinput', (ev) => {
      const ie = ev as InputEvent;
      const [sr] = ie.getTargetRanges();
      if (!sr) return;
      const node = sr.startContainer as Text;
      seen.push({ inputType: ie.inputType, data: ie.data, target: node.data.slice(sr.startOffset, sr.endOffset) });
      // Slate-like: apply through the model and re-render asynchronously.
      ie.preventDefault();
      const next = node.data.slice(0, sr.startOffset) + (ie.data ?? '') + node.data.slice(sr.endOffset);
      queueMicrotask(() => {
        node.parentElement!.textContent = next;
      });
    });
    const a = adapterFor(root, discord);
    const text = a.getText();
    const out = await settle(a.applyEdit(edit(text, 'Their', "They're")));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('beforeinput');
    expect(seen).toEqual([{ inputType: 'insertReplacementText', data: "They're", target: 'Their' }]);
    expect(a.getText()).toBe("They're going to the store.");
  });

  it('writes the DOM itself when nobody claims the event, carrying the input event through', async () => {
    const root = editor('<p>hello world</p>');
    const beforeinputs: InputEvent[] = [];
    const inputs: InputEvent[] = [];
    root.addEventListener('beforeinput', (ev) => beforeinputs.push(ev as InputEvent));
    root.addEventListener('input', (ev) => inputs.push(ev as InputEvent));
    const a = adapterFor(root, generic); // execCommand unavailable → beforeinput → unclaimed → DOM write
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('beforeinput');
    expect(a.getText()).toBe('hello there');
    expect(beforeinputs).toHaveLength(1);
    expect(beforeinputs[0]!.cancelable).toBe(true);
    expect(beforeinputs[0]!.getTargetRanges()).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.inputType).toBe('insertReplacementText');
  });

  it('uses deleteContentBackward for deletions and never dispatches an empty paste', async () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
    const root = editor('<p>the the store</p>');
    const pastes = vi.fn();
    const beforeinputs: string[] = [];
    root.addEventListener('paste', pastes);
    root.addEventListener('beforeinput', (ev) => beforeinputs.push((ev as InputEvent).inputType));
    const pasteFirst = defineProfile({ id: 'p', matches: () => true, ladder: ['paste', 'beforeinput', 'splice'] });
    const a = adapterFor(root, pasteFirst);
    const out = await settle(a.applyEdit(edit('the the store', 'the ', '')));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('beforeinput');
    expect(pastes).not.toHaveBeenCalled();
    expect(beforeinputs).toEqual(['deleteContentBackward']);
    expect(a.getText()).toBe('the store');
    expect(deletionLadder(['execCommand', 'beforeinput', 'paste', 'splice'])).toEqual(['beforeinput', 'execCommand', 'splice']);
    expect(deletionLadder(['execCommand', 'paste', 'splice'])).toEqual(['execCommand', 'splice']);
    expect(deletionLadder(['paste'])).toEqual(['splice']);
  });
});

describe('applyEdit: paste rung', () => {
  it('builds a text/plain DataTransfer and reports the rung when a listener handles the paste', async () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
    const root = editor('<p>hello world</p>', { class: 'ProseMirror' });
    const pasted: string[] = [];
    root.addEventListener('paste', (ev) => {
      const ce = ev as unknown as FakeClipboardEvent;
      const text = ce.clipboardData!.getData('text/plain');
      pasted.push(text);
      const sel = document.getSelection()!;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      ev.preventDefault();
    });
    const a = adapterFor(root, prosemirror); // execCommand unavailable → paste
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')));
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('paste');
    expect(pasted).toEqual(['there']);
    expect(a.getText()).toBe('hello there');
  });

  it('falls through to splice when the paste is not handled', async () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
    const root = editor('<p>hello world</p>', { class: 'ProseMirror' });
    const pastes = vi.fn();
    root.addEventListener('paste', pastes);
    const a = adapterFor(root, prosemirror);
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')));
    expect(pastes).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('splice');
    expect(a.getText()).toBe('hello there');
  });
});

describe('applyEdit: verification and ladder progression', () => {
  /** A Lexical-like host: reverts foreign DOM writes, but applies beforeinput itself. */
  function revertingEditor(root: HTMLElement): { foreignWrites: number } {
    const stats = { foreignWrites: 0 };
    let expecting = false;
    const snapshot = root.innerHTML;
    const mo = new MutationObserver(() => {
      if (expecting) return;
      stats.foreignWrites++;
      setTimeout(() => {
        expecting = true;
        root.innerHTML = snapshot;
        mo.takeRecords();
        expecting = false;
      }, 30);
    });
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    root.addEventListener('beforeinput', (ev) => {
      const ie = ev as InputEvent;
      const [sr] = ie.getTargetRanges();
      if (!sr) return;
      ie.preventDefault();
      const node = sr.startContainer as Text;
      expecting = true;
      node.data = node.data.slice(0, sr.startOffset) + (ie.data ?? '') + node.data.slice(sr.endOffset);
      mo.takeRecords();
      expecting = false;
    });
    return stats;
  }

  it('reports reverted when the host undoes the only rung', async () => {
    const root = editor('<p>hello world</p>');
    const stats = revertingEditor(root);
    const a = adapterFor(root, defineProfile({ id: 's', matches: () => true, ladder: ['splice'] }));
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')));
    expect(out.status).toBe('reverted');
    expect(out.rung).toBe('splice');
    expect(out.text).toBe('hello world');
    expect(stats.foreignWrites).toBe(1);
  });

  it('moves to the next rung after a revert and succeeds through beforeinput', async () => {
    const root = editor('<p>hello world</p>');
    const stats = revertingEditor(root);
    const a = adapterFor(root, defineProfile({ id: 's', matches: () => true, ladder: ['splice', 'beforeinput'] }));
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')), 2000);
    expect(out.status).toBe('applied');
    expect(out.rung).toBe('beforeinput');
    expect(a.getText()).toBe('hello there');
    expect(stats.foreignWrites).toBe(1);
  });

  it('stops with mismatch (and does not try another rung) when the text diverges from both snapshots', async () => {
    const root = editor('<p>hello world</p>');
    root.addEventListener('input', () => {
      // A host that auto-converts the inserted text.
      setTimeout(() => {
        root.firstChild!.textContent = 'hello THERE!';
      }, 20);
    });
    const a = adapterFor(root, defineProfile({ id: 's', matches: () => true, ladder: ['splice', 'beforeinput'] }));
    const beforeinputs = vi.fn();
    root.addEventListener('beforeinput', beforeinputs);
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')));
    expect(out.status).toBe('mismatch');
    expect(out.rung).toBe('splice');
    expect(out.text).toBe('hello THERE!');
    expect(beforeinputs).not.toHaveBeenCalled();
  });

  it('returns composing while an IME composition is active', async () => {
    const root = editor('<p>hello world</p>');
    const a = adapterFor(root);
    root.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(a.isComposing()).toBe(true);
    const out = await settle(a.applyEdit(edit('hello world', 'world', 'there')));
    expect(out).toEqual({ status: 'composing', rung: null, text: 'hello world' });
    root.dispatchEvent(new CompositionEvent('compositionend'));
    expect(a.isComposing()).toBe(false);
  });
});

describe('applyEdits', () => {
  it('applies three edits right-to-left and aborts on mismatch', async () => {
    const root = editor('<div>aaa bbb</div><div>ccc ddd</div>');
    const a = adapterFor(root, defineProfile({ id: 's', matches: () => true, ladder: ['splice'] }));
    const text = a.getText();
    const out = await settle(a.applyEdits([edit(text, 'aaa', 'A'), edit(text, 'ddd', 'D'), edit(text, 'bbb', '')]), 3000);
    expect(a.getText()).toBe('A \nccc D');
    expect(out.applied.map((e) => e.original)).toEqual(['ddd', 'bbb', 'aaa']);
    expect(out.nativeUndoSteps).toBe(0);
    const t2 = a.getText();
    const bad: Edit = { range: { start: t2.indexOf('ccc'), end: t2.indexOf('ccc') + 3 }, original: 'xxx', replacement: 'C' };
    const out2 = await settle(a.applyEdits([edit(t2, 'A', 'AA'), bad, edit(t2, 'D', 'DD')]), 3000);
    expect(out2.applied.map((e) => e.original)).toEqual(['D']);
    expect(out2.skipped.map((s) => s.reason)).toEqual(['mismatch', 'mismatch']);
    expect(a.getText()).toBe('A \nccc DD');
  });
});

describe('subscriptions', () => {
  it('coalesces mutations per microtask and carries the inputType from the input event', async () => {
    const root = editor('<div>one</div><div>two</div>');
    const a = adapterFor(root);
    const cb = vi.fn();
    a.onChange(cb);
    root.firstChild!.textContent = 'ONE';
    root.lastChild!.textContent = 'TWO';
    root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
    await microtasks();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('ONE\nTWO', 'insertText');
    // A formatting-only mutation does not change the text: no change callback.
    root.firstChild!.firstChild!.textContent = 'ONE';
    await microtasks();
    expect(cb).toHaveBeenCalledTimes(1);
    // Mutations without an input event still notify (editor re-render), with a null inputType.
    root.lastChild!.textContent = 'three';
    await microtasks();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('ONE\nthree', null);
  });

  it('holds change notifications while composing and emits once on compositionend', async () => {
    const root = editor('<div>abc</div>');
    const a = adapterFor(root);
    const cb = vi.fn();
    a.onChange(cb);
    root.dispatchEvent(new CompositionEvent('compositionstart'));
    root.firstChild!.textContent = 'abcd';
    root.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    await microtasks();
    expect(cb).not.toHaveBeenCalled();
    root.dispatchEvent(new CompositionEvent('compositionend'));
    await microtasks();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('abcd', 'insertCompositionText');
  });

  it('reports layout on document scroll and window resize, and focus changes within the root', () => {
    const root = editor('<div>abc <button>x</button></div>', { tabindex: '0' });
    const a = adapterFor(root);
    const layout = vi.fn();
    a.onLayout(layout);
    document.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(layout).toHaveBeenCalledTimes(2);
    const focus = vi.fn();
    a.onFocusChange(focus);
    root.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(focus).toHaveBeenLastCalledWith(true);
    root.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: root.querySelector('button') }));
    expect(focus).toHaveBeenCalledTimes(1); // moved within the editor
    root.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(focus).toHaveBeenLastCalledWith(false);
  });

  it('dispose removes listeners and observers', async () => {
    const root = editor('<div>abc</div>');
    const removed = vi.spyOn(document, 'removeEventListener');
    const a = adapterFor(root);
    const change = vi.fn();
    const layout = vi.fn();
    a.onChange(change);
    a.onLayout(layout);
    a.dispose();
    root.firstChild!.textContent = 'xyz';
    root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    document.dispatchEvent(new Event('scroll'));
    await microtasks();
    expect(change).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function), expect.objectContaining({ capture: true }));
  });
});
