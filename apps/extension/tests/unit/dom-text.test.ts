import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCK_TAGS,
  compareDomPositions,
  fromDomPosition,
  isBlockElement,
  mergeLineRects,
  offsetsFromSelection,
  rangeFromOffsets,
  rectsForOffsets,
  serializeEditable,
  toDomPosition,
  type DomPosition,
  type Segment,
  type SerializedText,
} from '../../src/content/dom-text';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mounted: HTMLElement[] = [];

/** Mount an editor with the given inner HTML (no formatting whitespace: text nodes are verbatim). */
function editor(html: string, opts?: Parameters<typeof serializeEditable>[1]): { root: HTMLElement; s: SerializedText } {
  const root = document.createElement('div');
  root.setAttribute('contenteditable', 'true');
  root.innerHTML = html;
  document.body.appendChild(root);
  mounted.push(root);
  return { root, s: serializeEditable(root, opts) };
}

function serialize(html: string): string {
  return editor(html).s.text;
}

function kinds(s: SerializedText): string[] {
  return s.segments.map((seg) => `${seg.kind}[${seg.start},${seg.end})${seg.kind === 'text' ? '' : ':' + seg.node.tagName}`);
}

function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

/** Asserts the invariants every serialization must satisfy. */
function checkInvariants(s: SerializedText): void {
  let cursor = 0;
  let textLen = 0;
  for (const seg of s.segments) {
    expect(seg.start).toBeGreaterThanOrEqual(cursor);
    expect(seg.end).toBeGreaterThanOrEqual(seg.start);
    if (seg.kind === 'text') {
      expect(seg.end - seg.start).toBe(seg.node.data.length);
      expect(s.text.slice(seg.start, seg.end)).toBe(seg.node.data.replace(/ /g, ' '));
      textLen += seg.end - seg.start;
    } else if (seg.kind === 'newline') {
      expect(seg.end - seg.start).toBe(1);
      expect(s.text[seg.start]).toBe('\n');
      textLen += 1;
    } else {
      expect(seg.end).toBe(seg.start);
      expect(seg.node.tagName).toBe('BR');
    }
    cursor = seg.end;
  }
  expect(textLen).toBe(s.text.length);
  for (let i = 1; i < s.atomic.length; i++) expect(s.atomic[i]!.start).toBeGreaterThanOrEqual(s.atomic[i - 1]!.start);
  for (const o of s.zeroWidth) expect('​‌‍﻿').toContain(s.text[o]!);
  // Every offset resolves inside the root, and resolves back to itself when it lands in a Text node.
  for (let o = 0; o <= s.text.length; o++) {
    for (const affinity of ['forward', 'backward'] as const) {
      const p = toDomPosition(s, o, affinity);
      expect(p.node === s.root || s.root.contains(p.node)).toBe(true);
      if (isText(p.node)) {
        expect(p.offset).toBeLessThanOrEqual(p.node.data.length);
        expect(fromDomPosition(s, p.node, p.offset)).toBe(o);
      }
    }
  }
}

/** For every span without a synthetic newline, the Range's text equals the slice (modulo NBSP). */
function checkRanges(s: SerializedText): void {
  const n = s.text.length;
  for (let a = 0; a <= n; a++) {
    for (let b = a; b <= n; b++) {
      const slice = s.text.slice(a, b);
      if (slice.includes('\n')) continue;
      const range = rangeFromOffsets(s, a, b);
      expect(range.toString().replace(/ /g, ' ')).toBe(slice);
    }
  }
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  window.getSelection()?.removeAllRanges();
});

// ---------------------------------------------------------------------------
// serializeEditable: text rules
// ---------------------------------------------------------------------------

describe('serializeEditable: blocks and line breaks', () => {
  it('serializes plain inline text verbatim', () => {
    expect(serialize('Hello,  world')).toBe('Hello,  world');
  });

  it('puts one newline between consecutive blocks, none leading or trailing', () => {
    expect(serialize('<div>a</div><div>b</div><div>c</div>')).toBe('a\nb\nc');
    expect(serialize('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('does not double newlines for nested blocks', () => {
    expect(serialize('<div><div>a</div></div><div>b</div>')).toBe('a\nb');
    expect(serialize('<div><div><div>a</div></div></div><div><div>b</div></div>')).toBe('a\nb');
  });

  it('breaks between inline text and a following or preceding block', () => {
    expect(serialize('hello<div>world</div>')).toBe('hello\nworld');
    expect(serialize('<div>hello</div>world')).toBe('hello\nworld');
    expect(serialize('<div>a<div>b</div>c</div>')).toBe('a\nb\nc');
  });

  it('ignores empty blocks and <hr>', () => {
    expect(serialize('<div>a</div><div></div><div>b</div>')).toBe('a\nb');
    expect(serialize('<div>a</div><hr><div>b</div>')).toBe('a\nb');
    expect(serialize('<div></div><div>b</div>')).toBe('b');
    expect(serialize('<div>a</div><div></div>')).toBe('a');
  });

  it('serializes Gmail-style nested divs with dir="ltr"', () => {
    const html =
      '<div dir="ltr">Hi team,<div><br></div><div>I just wanted to touch base.</div><div><br></div><div>Thanks,<br>Sam</div></div>';
    const { s } = editor(html);
    expect(s.text).toBe('Hi team,\n\nI just wanted to touch base.\n\nThanks,\nSam');
    checkInvariants(s);
    checkRanges(s);
  });

  it('serializes a Gmail body where every line is its own dir="ltr" div', () => {
    const html = '<div dir="ltr">Hi</div><div dir="ltr"><br></div><div dir="ltr">Bye</div>';
    expect(serialize(html)).toBe('Hi\n\nBye');
  });

  it('treats <div><br></div> as an empty line', () => {
    const { s } = editor('<div>a</div><div><br></div><div>b</div>');
    expect(s.text).toBe('a\n\nb');
    expect(kinds(s)).toEqual(['text[0,1)', 'newline[1,2):DIV', 'empty[2,2):BR', 'newline[2,3):DIV', 'text[3,4)']);
    checkInvariants(s);
  });

  it('keeps leading and trailing empty lines made of <div><br></div>', () => {
    expect(serialize('<div><br></div><div>b</div>')).toBe('\nb');
    expect(serialize('<div>a</div><div><br></div>')).toBe('a\n');
    expect(serialize('<div>a</div><div><br></div><div><br></div>')).toBe('a\n\n');
  });

  it('treats a lone <br> wrapped in inline elements as an empty line', () => {
    expect(serialize('<div>a</div><div><span><br></span></div><div>b</div>')).toBe('a\n\nb');
    expect(serialize('<p>a</p><p><br class="ProseMirror-trailingBreak"></p><p>b</p>')).toBe('a\n\nb');
  });

  it('an empty editor serializes to "" whether or not it holds a placeholder <br>', () => {
    expect(serialize('')).toBe('');
    expect(serialize('<br>')).toBe('');
    expect(serialize('<div><br></div>')).toBe('');
    const { s } = editor('<div><br></div>');
    expect(kinds(s)).toEqual(['empty[0,0):BR']);
  });

  it('drops a trailing placeholder <br> in a block that already has text', () => {
    expect(serialize('<div>Hello<br></div><div>World</div>')).toBe('Hello\nWorld');
    expect(serialize('<div>Hello<br></div>')).toBe('Hello');
    expect(serialize('Hello<br>')).toBe('Hello');
    expect(serialize('<div>Hello<b>bold<br></b></div><div>World</div>')).toBe('Hellobold\nWorld');
  });

  it('keeps a <br> that is followed by content on the same line', () => {
    expect(serialize('<div>Kind regards,<br>Sam</div>')).toBe('Kind regards,\nSam');
    expect(serialize('a<br>b')).toBe('a\nb');
    expect(serialize('a<br><br>b')).toBe('a\n\nb');
    expect(serialize('<div>a<br><br></div><div>b</div>')).toBe('a\n\nb');
  });

  it('treats a <br> right before a nested block as a placeholder', () => {
    expect(serialize('<div>a<br><div>b</div></div>')).toBe('a\nb');
  });

  it('a <br> after a nested block starts a fresh empty line', () => {
    const { s } = editor('<div><div>a</div><br></div>');
    expect(s.text).toBe('a\n');
    expect(kinds(s)).toEqual(['text[0,1)', 'newline[1,2):DIV', 'empty[2,2):BR']);
  });

  it('a leading <br> followed by text is an empty first line', () => {
    expect(serialize('<div><br>b</div>')).toBe('\nb');
    expect(serialize('<div>a</div><div><br>b</div>')).toBe('a\n\nb');
  });

  it('separates list items, headings and table cells with newlines', () => {
    expect(serialize('<ul><li>one</li><li>two</li></ul><p>after</p>')).toBe('one\ntwo\nafter');
    expect(serialize('<ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol>')).toBe('one\ntwo\nnested');
    expect(serialize('<h1>Title</h1><p>Body</p>')).toBe('Title\nBody');
    expect(serialize('<table><tbody><tr><td>a</td><td>b</td></tr><tr><th>c</th></tr></tbody></table>')).toBe('a\nb\nc');
    expect(serialize('<blockquote><div>quoted</div></blockquote><div>reply</div>')).toBe('quoted\nreply');
  });

  it('honours computed display when the environment provides it', () => {
    expect(serialize('<span style="display:block">a</span><span style="display:block">b</span>')).toBe('a\nb');
    expect(serialize('<span style="display:flex">a</span><span style="display:grid">b</span>')).toBe('a\nb');
    expect(serialize('<span style="display:inline-block">a</span><span>b</span>')).toBe('ab');
  });

  it('honours the treatAsBlock option', () => {
    const html = '<span class="line">a</span><span class="line">b</span>';
    expect(serialize(html)).toBe('ab');
    const { s } = editor(html, { treatAsBlock: (el) => el.classList.contains('line') });
    expect(s.text).toBe('a\nb');
  });

  it('serializes a Draft.js-like structure', () => {
    const block = (inner: string) =>
      `<div data-block="true" data-editor="e" data-offset-key="k-0-0"><div data-offset-key="k-0-0" class="public-DraftStyleDefault-block"><span data-offset-key="k-0-0">${inner}</span></div></div>`;
    const html =
      '<div data-contents="true">' +
      block('<span data-text="true">Hello world</span>') +
      block('<br data-text="true">') +
      block('<span data-text="true">Second </span><span data-text="true">block</span>') +
      '</div>';
    const { s } = editor(html);
    expect(s.text).toBe('Hello world\n\nSecond block');
    checkInvariants(s);
    checkRanges(s);
    // The empty block's anchor sits inside the Draft span, where Draft keeps its caret.
    const anchor = s.segments.find((seg) => seg.kind === 'empty')!;
    expect(anchor.start).toBe(12);
    expect(anchor.node.getAttribute('data-text')).toBe('true');
  });
});

describe('serializeEditable: skipped and special content', () => {
  it('skips script, style, template, noscript, comments and hidden elements', () => {
    const html =
      '<div>a</div><script>s()</script><style>.x{}</style><template><div>t</div></template><noscript>n</noscript>' +
      '<!-- comment --><div hidden>h</div><div aria-hidden="true">ah</div><div style="display:none">dn</div><div>b</div>';
    const { s } = editor(html);
    expect(s.text).toBe('a\nb');
    checkInvariants(s);
  });

  it('skips elements hidden by a stylesheet when computed style is available', () => {
    const style = document.createElement('style');
    style.textContent = '.gone { display: none; }';
    document.head.appendChild(style);
    try {
      expect(serialize('<div>a</div><div class="gone">x</div><div>b</div>')).toBe('a\nb');
    } finally {
      style.remove();
    }
  });

  it('replaces NBSP with a space in the output but keeps offsets 1:1', () => {
    const { s } = editor('<div>Hello&nbsp;world&nbsp;&nbsp;!</div>');
    expect(s.text).toBe('Hello world  !');
    expect(s.text.length).toBe(14);
    expect(s.segments[0]!.kind === 'text' && s.segments[0]!.node.data).toBe('Hello world  !');
    // The live Range still yields the real characters.
    expect(rangeFromOffsets(s, 5, 6).toString()).toBe(' ');
    expect(rangeFromOffsets(s, 0, 14).toString()).toBe('Hello world  !');
    checkInvariants(s);
  });

  it('keeps zero-width characters in the text and reports their offsets', () => {
    const { s } = editor('<div>​a</div><div><span>​</span>b﻿c</div><div>‌d‍</div>');
    expect(s.text).toBe('​a\n​b﻿c\n‌d‍');
    expect(s.zeroWidth).toEqual([0, 3, 5, 8, 10]);
    checkInvariants(s);
    checkRanges(s);
  });

  it('counts emoji as UTF-16 code units', () => {
    const { s } = editor('<div>😀 hi 👨‍👩‍👧!</div>');
    const family = '👨‍👩‍👧';
    expect(family.length).toBe(8);
    expect(s.text).toBe(`😀 hi ${family}!`);
    expect(s.text.length).toBe(2 + 4 + 8 + 1);
    // ZWJs inside the family emoji are reported as zero-width.
    expect(s.zeroWidth).toEqual([8, 11]);
    // Offsets can land between surrogates; the DOM offset is the same code-unit offset.
    const mid = toDomPosition(s, 1);
    expect(isText(mid.node)).toBe(true);
    expect(mid.offset).toBe(1);
    expect(rangeFromOffsets(s, 0, 2).toString()).toBe('😀');
    checkInvariants(s);
    checkRanges(s);
  });

  it('includes contenteditable="false" chip text and records it as atomic', () => {
    const { s } = editor('<div>Hello <span contenteditable="false" class="chip">@Bob Smith</span>, how are you?</div>');
    expect(s.text).toBe('Hello @Bob Smith, how are you?');
    expect(s.atomic).toEqual([{ start: 6, end: 16 }]);
    expect(s.text.slice(6, 16)).toBe('@Bob Smith');
    checkInvariants(s);
    checkRanges(s);
  });

  it('records one atomic range per chip, including an uppercase FALSE and nested islands', () => {
    const { s } = editor(
      '<div><span contenteditable="FALSE">a<span contenteditable="true">b</span></span> x <span contenteditable="false">c</span></div>',
    );
    expect(s.text).toBe('ab x c');
    expect(s.atomic).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 6 },
    ]);
  });

  it('shifts an atomic chip that starts a new block past the block-boundary newline', () => {
    const { s } = editor('<div>a</div><div><span contenteditable="false">@Bob</span> hi</div>');
    expect(s.text).toBe('a\n@Bob hi');
    expect(s.atomic).toEqual([{ start: 2, end: 6 }]);
  });

  it('records replaced elements such as <img> as zero-length atomic ranges', () => {
    const { s } = editor('<div>Great <img alt=":smile:" src="x.png"> job</div>');
    expect(s.text).toBe('Great  job');
    expect(s.atomic).toEqual([{ start: 6, end: 6 }]);
    // An <img> that opens a new block lands after the newline, not before it.
    const { s: s2 } = editor('<div>a</div><div><img src="x.png">b</div>');
    expect(s2.text).toBe('a\nb');
    expect(s2.atomic).toEqual([{ start: 2, end: 2 }]);
    // An image alone in a block contributes nothing and no newline.
    expect(serialize('<div>a</div><div><img src="x.png"></div>')).toBe('a');
  });

  it('keeps empty Text nodes addressable without emitting characters', () => {
    const { root } = editor('<div>a</div><div>b</div>');
    const div2 = root.children[1]!;
    const empty = document.createTextNode('');
    div2.insertBefore(empty, div2.firstChild);
    const s = serializeEditable(root);
    expect(s.text).toBe('a\nb');
    expect(kinds(s)).toEqual(['text[0,1)', 'newline[1,2):DIV', 'text[2,2)', 'text[2,3)']);
    expect(fromDomPosition(s, empty, 0)).toBe(2);
    checkInvariants(s);
  });

  it('serializes the shipped contenteditable fixture shape', () => {
    const html =
      '<div>Their going to the the store tomorow.</div>' +
      '<div>I <b>definately</b> think that we should of went earlier, irregardless of the weather.</div>' +
      '<div><br></div>' +
      '<div>Kind regards,<br>Sam</div>';
    const { s } = editor(html);
    expect(s.text).toBe(
      'Their going to the the store tomorow.\n' +
        'I definately think that we should of went earlier, irregardless of the weather.\n' +
        '\n' +
        'Kind regards,\nSam',
    );
    checkInvariants(s);
  });
});

// ---------------------------------------------------------------------------
// isBlockElement
// ---------------------------------------------------------------------------

describe('isBlockElement', () => {
  it('recognises block tags, table cells and computed block displays', () => {
    const { root } = editor(
      '<div></div><p></p><ul><li></li></ul><table><tbody><tr><td></td><th></th></tr></tbody></table>' +
        '<span></span><b></b><span style="display:block"></span><span style="display:inline-block"></span><span style="display:list-item"></span>',
    );
    const q = (sel: string) => root.querySelector(sel)!;
    expect(isBlockElement(q('div'))).toBe(true);
    expect(isBlockElement(q('p'))).toBe(true);
    expect(isBlockElement(q('ul'))).toBe(true);
    expect(isBlockElement(q('li'))).toBe(true);
    expect(isBlockElement(q('table'))).toBe(true);
    expect(isBlockElement(q('tr'))).toBe(true);
    expect(isBlockElement(q('td'))).toBe(true);
    expect(isBlockElement(q('th'))).toBe(true);
    expect(isBlockElement(q('span'))).toBe(false);
    expect(isBlockElement(q('b'))).toBe(false);
    expect(isBlockElement(q('span[style="display:block"]'))).toBe(true);
    expect(isBlockElement(q('span[style="display:inline-block"]'))).toBe(false);
    expect(isBlockElement(q('span[style="display:list-item"]'))).toBe(true);
  });

  it('falls back to the tag list for detached elements with no computed style', () => {
    expect(isBlockElement(document.createElement('div'))).toBe(true);
    expect(isBlockElement(document.createElement('span'))).toBe(false);
    for (const tag of ['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'FIGURE', 'H6', 'PRE', 'SECTION', 'TR', 'UL']) {
      expect(BLOCK_TAGS.has(tag)).toBe(true);
      expect(isBlockElement(document.createElement(tag.toLowerCase()))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// toDomPosition / fromDomPosition
// ---------------------------------------------------------------------------

describe('toDomPosition', () => {
  it('maps offsets inside a run into its Text node', () => {
    const { s, root } = editor('<div>hello</div>');
    const text = root.firstChild!.firstChild as Text;
    expect(toDomPosition(s, 0)).toEqual({ node: text, offset: 0 });
    expect(toDomPosition(s, 3)).toEqual({ node: text, offset: 3 });
    expect(toDomPosition(s, 5)).toEqual({ node: text, offset: 5 });
  });

  it('clamps out-of-range and non-finite offsets', () => {
    const { s, root } = editor('<div>hello</div>');
    const text = root.firstChild!.firstChild as Text;
    expect(toDomPosition(s, -5)).toEqual({ node: text, offset: 0 });
    expect(toDomPosition(s, 99)).toEqual({ node: text, offset: 5 });
    expect(toDomPosition(s, Number.NaN)).toEqual({ node: text, offset: 0 });
  });

  it('maps the end of the text to the end of the last Text node, or the root for an empty editor', () => {
    const { s, root } = editor('<div>ab</div><div>cd</div>');
    const cd = root.children[1]!.firstChild as Text;
    expect(toDomPosition(s, 5)).toEqual({ node: cd, offset: 2 });
    expect(toDomPosition(s, 5, 'backward')).toEqual({ node: cd, offset: 2 });
    const empty = editor('');
    expect(toDomPosition(empty.s, 0)).toEqual({ node: empty.root, offset: 0 });
  });

  it('uses affinity at the boundary between two Text nodes', () => {
    const { s, root } = editor('<div><b>foo</b>bar</div>');
    const foo = root.firstChild!.firstChild!.firstChild as Text;
    const bar = root.firstChild!.lastChild as Text;
    expect(toDomPosition(s, 3)).toEqual({ node: bar, offset: 0 });
    expect(toDomPosition(s, 3, 'forward')).toEqual({ node: bar, offset: 0 });
    expect(toDomPosition(s, 3, 'backward')).toEqual({ node: foo, offset: 3 });
  });

  it('maps offsets next to a block-boundary newline to the adjacent Text nodes', () => {
    const { s, root } = editor('<div>a</div><div>b</div>');
    const a = root.children[0]!.firstChild as Text;
    const b = root.children[1]!.firstChild as Text;
    for (const affinity of ['forward', 'backward'] as const) {
      expect(toDomPosition(s, 1, affinity)).toEqual({ node: a, offset: 1 });
      expect(toDomPosition(s, 2, affinity)).toEqual({ node: b, offset: 0 });
    }
  });

  it('maps offsets around a <br> newline', () => {
    const { s, root } = editor('<div>a<br>b</div>');
    const div = root.firstChild as HTMLElement;
    const a = div.childNodes[0] as Text;
    const b = div.childNodes[2] as Text;
    // Before the newline: the Text node wins over the element position before the <br>.
    expect(toDomPosition(s, 1, 'forward')).toEqual({ node: a, offset: 1 });
    expect(toDomPosition(s, 1, 'backward')).toEqual({ node: a, offset: 1 });
    // After the newline: forward attaches to "b"; backward attaches to the <br> it follows.
    expect(toDomPosition(s, 2, 'forward')).toEqual({ node: b, offset: 0 });
    expect(toDomPosition(s, 2, 'backward')).toEqual({ node: div, offset: 2 });
  });

  it('maps an offset between two <br>s to the element position between them', () => {
    const { s, root } = editor('a<br><br>b');
    expect(s.text).toBe('a\n\nb');
    expect(toDomPosition(s, 2, 'forward')).toEqual({ node: root, offset: 2 });
    expect(toDomPosition(s, 2, 'backward')).toEqual({ node: root, offset: 2 });
    // Trailing: "a\n" from a<br><br>; the end maps just after the first <br>.
    const t = editor('a<br><br>');
    expect(t.s.text).toBe('a\n');
    expect(toDomPosition(t.s, 2)).toEqual({ node: t.root, offset: 2 });
  });

  it('maps an empty line to the position before its <br>', () => {
    const { s, root } = editor('<div>a</div><div><br></div><div>b</div>');
    const div2 = root.children[1]!;
    const b = root.children[2]!.firstChild as Text;
    expect(toDomPosition(s, 2, 'forward')).toEqual({ node: div2, offset: 0 });
    expect(toDomPosition(s, 2, 'backward')).toEqual({ node: div2, offset: 0 });
    expect(toDomPosition(s, 3)).toEqual({ node: b, offset: 0 });
    const lead = editor('<div><br></div><div>b</div>');
    expect(toDomPosition(lead.s, 0)).toEqual({ node: lead.root.children[0]!, offset: 0 });
    const only = editor('<div><br></div>');
    expect(toDomPosition(only.s, 0)).toEqual({ node: only.root.children[0]!, offset: 0 });
    const trail = editor('<div>a</div><div><br></div>');
    expect(toDomPosition(trail.s, 2)).toEqual({ node: trail.root.children[1]!, offset: 0 });
  });
});

describe('fromDomPosition', () => {
  it('maps Text node positions, clamping the offset to the node length', () => {
    const { s, root } = editor('<div>ab</div><div>cd</div>');
    const ab = root.children[0]!.firstChild as Text;
    const cd = root.children[1]!.firstChild as Text;
    expect(fromDomPosition(s, ab, 0)).toBe(0);
    expect(fromDomPosition(s, ab, 2)).toBe(2);
    expect(fromDomPosition(s, cd, 0)).toBe(3);
    expect(fromDomPosition(s, cd, 1)).toBe(4);
    expect(fromDomPosition(s, cd, 50)).toBe(5);
    expect(fromDomPosition(s, cd, -1)).toBe(3);
  });

  it('returns null for nodes outside the root or in skipped content', () => {
    const { s, root } = editor('<div>a</div><div hidden>h</div>');
    const outside = document.createTextNode('x');
    document.body.appendChild(outside);
    try {
      expect(fromDomPosition(s, outside, 0)).toBeNull();
      expect(fromDomPosition(s, document.body, 0)).toBeNull();
    } finally {
      outside.remove();
    }
    const hiddenText = root.children[1]!.firstChild as Text;
    expect(fromDomPosition(s, hiddenText, 0)).toBeNull();
  });

  it('maps element positions to the start of the following content', () => {
    const { s, root } = editor('<div>ab</div><div><br></div><div>cd</div>');
    expect(s.text).toBe('ab\n\ncd');
    const [div1, div2, div3] = Array.from(root.children);
    expect(fromDomPosition(s, root, 0)).toBe(0);
    expect(fromDomPosition(s, div1!, 0)).toBe(0);
    expect(fromDomPosition(s, div1!, 1)).toBe(2); // after "ab" but still inside its block: the end of that line
    expect(fromDomPosition(s, div2!, 0)).toBe(3); // caret on the empty line
    expect(fromDomPosition(s, div2!, 1)).toBe(3); // just after its <br>: still the empty line
    expect(fromDomPosition(s, div2!.firstChild!, 0)).toBe(3); // Chrome sometimes reports (br, 0)
    expect(fromDomPosition(s, div3!, 0)).toBe(4);
    expect(fromDomPosition(s, div3!, 1)).toBe(6);
    expect(fromDomPosition(s, root, 3)).toBe(6);
  });

  it('maps positions around an inline <br>', () => {
    const { s, root } = editor('a<br>b');
    expect(fromDomPosition(s, root, 0)).toBe(0);
    expect(fromDomPosition(s, root, 1)).toBe(1); // before <br>
    expect(fromDomPosition(s, root, 2)).toBe(2); // after <br>
    expect(fromDomPosition(s, root, 3)).toBe(3);
  });

  it('maps positions in an empty editor', () => {
    const empty = editor('');
    expect(fromDomPosition(empty.s, empty.root, 0)).toBe(0);
    const ph = editor('<div><br></div>');
    expect(fromDomPosition(ph.s, ph.root.firstChild!, 0)).toBe(0);
    expect(fromDomPosition(ph.s, ph.root.firstChild!, 1)).toBe(0);
    expect(fromDomPosition(ph.s, ph.root, 1)).toBe(0);
  });

  it('maps positions inside and around an atomic chip', () => {
    const { s, root } = editor('<div>Hi <span contenteditable="false">@Bob</span> there</div>');
    const div = root.firstChild as HTMLElement;
    const chipText = div.childNodes[1]!.firstChild as Text;
    expect(fromDomPosition(s, chipText, 2)).toBe(5);
    expect(fromDomPosition(s, div, 1)).toBe(3);
    expect(fromDomPosition(s, div, 2)).toBe(7);
  });
});

describe('compareDomPositions', () => {
  it('orders boundary points in tree order', () => {
    const { root } = editor('<div>ab</div><div>cd</div>');
    const [div1, div2] = Array.from(root.children);
    const ab = div1!.firstChild as Text;
    const cd = div2!.firstChild as Text;
    const before = (a: Node, ao: number, b: Node, bo: number) => Math.sign(compareDomPositions({ node: a, offset: ao }, { node: b, offset: bo }));
    expect(before(ab, 0, ab, 1)).toBe(-1);
    expect(before(ab, 1, ab, 1)).toBe(0);
    expect(before(ab, 2, cd, 0)).toBe(-1);
    expect(before(cd, 0, ab, 2)).toBe(1);
    expect(before(root, 0, ab, 0)).toBe(-1);
    expect(before(root, 1, ab, 2)).toBe(1);
    expect(before(root, 1, cd, 0)).toBe(-1);
    expect(before(div1!, 1, root, 1)).toBe(-1);
    expect(before(root, 2, cd, 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe('round trips', () => {
  const fixtures: Record<string, string> = {
    gmail: '<div dir="ltr">Hi team,<div><br></div><div>I just wanted to <b>touch</b> base.</div><div><br></div><div>Thanks,<br>Sam</div></div>',
    paragraphs: '<p>One.</p><p>Two <i>italic</i> words.</p><p><br></p><p>Four.</p>',
    lists: '<ul><li>alpha</li><li>beta <b>bold</b></li></ul><div>after</div>',
    boldSplit: '<div>I <b>definately</b> think that we should of went.</div>',
    chip: '<div>Hey <span contenteditable="false">@Bob</span>, see <span contenteditable="false">#general</span></div>',
    nbsp: '<div>Hello&nbsp;world&nbsp;</div><div>&nbsp;next</div>',
    zeroWidth: '<div>​foo</div><div><span>​</span>bar</div>',
    emoji: '<div>😀 hi 👨‍👩‍👧</div><div>🎉</div>',
    brs: 'a<br>b<br><br>c<br>',
    emptyLines: '<div><br></div><div>a</div><div><br></div><div><br></div><div>b</div><div><br></div>',
    nested: '<div><div><div>deep</div></div><div>b<br>c</div></div>end',
    table: '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c<br>d</td></tr></tbody></table>',
    draft:
      '<div data-contents="true"><div data-block="true"><div><span data-offset-key="a"><span data-text="true">Hello</span></span></div></div>' +
      '<div data-block="true"><div><span data-offset-key="b"><br data-text="true"></span></div></div>' +
      '<div data-block="true"><div><span data-offset-key="c"><span data-text="true">World</span></span></div></div></div>',
    inlineBlocks: '<span style="display:block">line 1</span><span style="display:block">line 2</span>',
  };

  for (const [name, html] of Object.entries(fixtures)) {
    it(`fromDomPosition(toDomPosition(o)) === o for Text positions, and Range text matches slices (${name})`, () => {
      const { s } = editor(html);
      checkInvariants(s);
      checkRanges(s);
    });
  }

  it('every Text node position maps back into [0, text.length] and forward again (gmail)', () => {
    const { s, root } = editor(fixtures['gmail']!);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let count = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      for (let i = 0; i <= t.data.length; i++) {
        const o = fromDomPosition(s, t, i);
        expect(o).not.toBeNull();
        expect(o!).toBeGreaterThanOrEqual(0);
        expect(o!).toBeLessThanOrEqual(s.text.length);
        // Mapping forward lands on the same text position or an equivalent one with the same offset.
        const back = toDomPosition(s, o!, i === 0 ? 'forward' : 'backward');
        expect(fromDomPosition(s, back.node, back.offset)).toBe(o);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// rangeFromOffsets
// ---------------------------------------------------------------------------

describe('rangeFromOffsets', () => {
  it('builds a Range whose text matches the slice when no synthetic newline is inside', () => {
    const { s } = editor('<div>I <b>definately</b> think</div>');
    expect(s.text).toBe('I definately think');
    const r = rangeFromOffsets(s, 2, 12);
    expect(r.toString()).toBe('definately');
    expect(isText(r.startContainer) && r.startContainer.parentElement!.tagName).toBe('B');
    expect(isText(r.endContainer) && r.endContainer.parentElement!.tagName).toBe('B');
    expect(rangeFromOffsets(s, 0, 18).toString()).toBe('I definately think');
    expect(rangeFromOffsets(s, 12, 18).toString()).toBe(' think');
  });

  it('spans Text nodes across a <b> boundary with tight endpoints', () => {
    const { s, root } = editor('<div>ab<b>cd</b>ef</div>');
    const div = root.firstChild as HTMLElement;
    const r = rangeFromOffsets(s, 1, 5);
    expect(r.toString()).toBe('bcde');
    expect(r.startContainer).toBe(div.childNodes[0]);
    expect(r.endContainer).toBe(div.childNodes[2]);
    // A range that ends exactly at the end of <b> stays inside <b>.
    const r2 = rangeFromOffsets(s, 2, 4);
    expect(r2.startContainer).toBe(div.childNodes[1]!.firstChild);
    expect(r2.endContainer).toBe(div.childNodes[1]!.firstChild);
    expect(r2.toString()).toBe('cd');
  });

  it('builds collapsed ranges and ranges over synthetic newlines', () => {
    const { s, root } = editor('<div>a</div><div>b</div>');
    const collapsed = rangeFromOffsets(s, 1, 1);
    expect(collapsed.collapsed).toBe(true);
    expect(collapsed.startContainer).toBe(root.children[0]!.firstChild);
    const across = rangeFromOffsets(s, 0, 3);
    expect(across.toString()).toBe('ab'); // the "\n" is synthetic: no character in the DOM
    expect(across.startContainer).toBe(root.children[0]!.firstChild);
    expect(across.endContainer).toBe(root.children[1]!.firstChild);
    const nl = rangeFromOffsets(s, 1, 2);
    expect(nl.startContainer).toBe(root.children[0]!.firstChild);
    expect(nl.endContainer).toBe(root.children[1]!.firstChild);
  });

  it('covers the <br> (and nothing else) for its newline offsets, so deleting the range deletes the line break', () => {
    const { s, root } = editor('a<br>b');
    const r = rangeFromOffsets(s, 1, 2);
    expect(r.startContainer).toBe(root.childNodes[0]);
    expect(r.startOffset).toBe(1);
    expect(r.endContainer).toBe(root);
    expect(r.endOffset).toBe(2);
    expect(r.toString()).toBe('');
    const copy = r.cloneContents();
    expect(copy.querySelector('br')).not.toBeNull();
    expect(copy.textContent).toBe('');
    r.deleteContents();
    expect(root.innerHTML).toBe('ab');
  });

  it('throws on invalid offsets', () => {
    const { s } = editor('<div>abc</div>');
    expect(() => rangeFromOffsets(s, -1, 2)).toThrow(RangeError);
    expect(() => rangeFromOffsets(s, 2, 1)).toThrow(RangeError);
    expect(() => rangeFromOffsets(s, 0, 4)).toThrow(RangeError);
    expect(() => rangeFromOffsets(s, 0.5, 2)).toThrow(RangeError);
  });

  it('works in an empty editor', () => {
    const { s, root } = editor('<div><br></div>');
    const r = rangeFromOffsets(s, 0, 0);
    expect(r.startContainer).toBe(root.firstChild);
    expect(r.startOffset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// offsetsFromSelection
// ---------------------------------------------------------------------------

describe('offsetsFromSelection', () => {
  function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
  }

  it('returns offsets for a selection inside the editor', () => {
    const { s, root } = editor('<div>Hello</div><div>World</div>');
    const hello = root.children[0]!.firstChild as Text;
    const world = root.children[1]!.firstChild as Text;
    expect(offsetsFromSelection(s, select(hello, 1, world, 3))).toEqual({ start: 1, end: 9 });
    expect(offsetsFromSelection(s, select(world, 2, world, 2))).toEqual({ start: 8, end: 8 });
    expect(offsetsFromSelection(s, select(root.children[1]!, 0, root.children[1]!, 0))).toEqual({ start: 6, end: 6 });
  });

  it('returns null when there is no range or the selection is elsewhere', () => {
    const { s } = editor('<div>Hello</div>');
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    expect(offsetsFromSelection(s, sel)).toBeNull();
    const other = document.createElement('p');
    other.textContent = 'outside';
    document.body.appendChild(other);
    try {
      expect(offsetsFromSelection(s, select(other.firstChild!, 0, other.firstChild!, 3))).toBeNull();
    } finally {
      other.remove();
    }
  });

  it('clamps a selection that reaches outside the editor on one side', () => {
    const { s, root } = editor('<div>Hello</div>');
    const other = document.createElement('p');
    other.textContent = 'outside';
    document.body.appendChild(other);
    try {
      const hello = root.firstChild!.firstChild as Text;
      // root comes before `other` in the body.
      expect(offsetsFromSelection(s, select(hello, 2, other.firstChild!, 3))).toEqual({ start: 2, end: 5 });
      const index = Array.from(document.body.childNodes).indexOf(root);
      expect(offsetsFromSelection(s, select(document.body, index, hello, 2))).toEqual({ start: 0, end: 2 });
    } finally {
      other.remove();
    }
  });

  it('maps a selection that surrounds the whole editor to the full text', () => {
    const { s, root } = editor('<div>Hello</div>');
    const index = Array.from(document.body.childNodes).indexOf(root);
    expect(offsetsFromSelection(s, select(document.body, index, document.body, index + 1))).toEqual({ start: 0, end: 5 });
    // A selection entirely before the editor is not a selection of it.
    const before = document.createElement('p');
    before.textContent = 'x';
    document.body.insertBefore(before, root);
    try {
      expect(offsetsFromSelection(s, select(before.firstChild!, 0, before.firstChild!, 1))).toBeNull();
    } finally {
      before.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// Rects
// ---------------------------------------------------------------------------

describe('rects', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });

  it('mergeLineRects drops zero-size rects and merges rects on the same line', () => {
    const out = mergeLineRects([
      rect(10, 100, 50, 18), // line 1, normal text
      rect(60, 98, 30, 22), // line 1, taller bold run
      rect(90, 100, 0, 18), // zero width (trailing newline fragment)
      rect(10, 130, 70, 18), // line 2
      rect(80, 130, 0, 0), // zero size
      rect(0, 130, 10, 18), // line 2, to the left
    ]);
    expect(out).toHaveLength(2);
    expect([out[0]!.left, out[0]!.top, out[0]!.right, out[0]!.bottom]).toEqual([10, 98, 90, 120]);
    expect([out[1]!.left, out[1]!.top, out[1]!.right, out[1]!.bottom]).toEqual([0, 130, 80, 148]);
    expect(out[0]).toBeInstanceOf(DOMRect);
  });

  it('mergeLineRects keeps rects on different lines apart even when they touch', () => {
    const out = mergeLineRects([rect(0, 0, 10, 20), rect(0, 20, 10, 20), rect(0, 41, 10, 20)]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.top)).toEqual([0, 20, 41]);
    expect(mergeLineRects([])).toEqual([]);
  });

  it('rectsForOffsets returns [] where Range.getClientRects is unavailable (jsdom)', () => {
    const { s } = editor('<div>Hello</div>');
    expect(rectsForOffsets(s, 0, 5)).toEqual([]);
  });

  it('rectsForOffsets merges the rects the Range reports', () => {
    const { s } = editor('<div>Hello <b>big</b> world</div>');
    const proto = Range.prototype as unknown as { getClientRects?: () => unknown };
    const original = proto.getClientRects;
    proto.getClientRects = function (this: Range) {
      // Pretend "Hello " and "big" are on one line and " world" wrapped to the next.
      return [rect(0, 0, 40, 16), rect(40, -1, 30, 18), rect(0, 20, 50, 16), rect(50, 20, 0, 16)];
    };
    try {
      const rects = rectsForOffsets(s, 0, 15);
      expect(rects).toHaveLength(2);
      expect([rects[0]!.left, rects[0]!.top, rects[0]!.width, rects[0]!.height]).toEqual([0, -1, 70, 18]);
      expect([rects[1]!.left, rects[1]!.top, rects[1]!.width, rects[1]!.height]).toEqual([0, 20, 50, 16]);
    } finally {
      if (original) proto.getClientRects = original;
      else delete proto.getClientRects;
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: edge cases and the module's documented guarantees stated as properties
// ---------------------------------------------------------------------------

describe('adversarial', () => {
  const NBSP_RE = / /g;
  const ZW = '​‌‍﻿';

  /** Max valid boundary offset for a DOM node. */
  function maxOffset(node: Node): number {
    return isText(node) ? node.data.length : node.childNodes.length;
  }

  /**
   * Stronger than checkInvariants: EVERY offset (not only those landing in Text nodes) must be a valid
   * boundary point inside the root that maps back to itself under both affinities.
   */
  function checkFullRoundTrip(s: SerializedText): void {
    for (let o = 0; o <= s.text.length; o++) {
      for (const affinity of ['forward', 'backward'] as const) {
        const p = toDomPosition(s, o, affinity);
        expect(p.node === s.root || s.root.contains(p.node)).toBe(true);
        expect(p.offset).toBeGreaterThanOrEqual(0);
        expect(p.offset).toBeLessThanOrEqual(maxOffset(p.node));
        expect(fromDomPosition(s, p.node, p.offset)).toBe(o);
      }
    }
  }

  /** backward <= forward at every offset, and both are non-decreasing in the offset. */
  function checkMonotonic(s: SerializedText): void {
    let prevF: DomPosition | null = null;
    let prevB: DomPosition | null = null;
    for (let o = 0; o <= s.text.length; o++) {
      const f = toDomPosition(s, o, 'forward');
      const b = toDomPosition(s, o, 'backward');
      expect(compareDomPositions(b, f)).toBeLessThanOrEqual(0);
      if (prevF) expect(compareDomPositions(prevF, f)).toBeLessThanOrEqual(0);
      if (prevB) expect(compareDomPositions(prevB, b)).toBeLessThanOrEqual(0);
      prevF = f;
      prevB = b;
    }
  }

  /**
   * For a DOM with no literal "\n" in Text nodes and no hidden/replaced text: the Range for EVERY
   * [a, b) (including ranges that span synthetic newlines) yields exactly the slice minus the
   * synthetic newlines, modulo NBSP. This is the "a live Range covering text.slice(start, end)" guarantee.
   */
  function checkAllRanges(s: SerializedText): void {
    const n = s.text.length;
    for (let a = 0; a <= n; a++) {
      for (let b = a; b <= n; b++) {
        const r = rangeFromOffsets(s, a, b);
        expect(r.toString().replace(NBSP_RE, ' ')).toBe(s.text.slice(a, b).replace(/\n/g, ''));
        expect(r.collapsed).toBe(a === b);
      }
    }
  }

  /** zeroWidth lists exactly the offsets of zero-width code units, ascending. */
  function checkZeroWidth(s: SerializedText): void {
    const expected: number[] = [];
    for (let i = 0; i < s.text.length; i++) if (ZW.includes(s.text[i]!)) expected.push(i);
    expect(s.zeroWidth).toEqual(expected);
  }

  /**
   * No text is lost or duplicated: text minus synthetic newlines == textContent (for DOMs without
   * hidden/replaced text or literal newlines). Block-boundary newlines never lead or trail: a
   * leading/trailing "\n" can only come from a <br> (newline or empty-line anchor).
   */
  function checkTextComplete(s: SerializedText): void {
    expect(s.text.replace(/\n/g, '')).toBe((s.root.textContent ?? '').replace(NBSP_RE, ' '));
    const isBlockNewline = (seg: Segment | undefined) => seg?.kind === 'newline' && seg.node.tagName !== 'BR';
    expect(isBlockNewline(s.segments[0])).toBe(false);
    expect(isBlockNewline(s.segments[s.segments.length - 1])).toBe(false);
    // Block-boundary newlines never touch: two consecutive synthetic newlines need a <br> for one of them.
    for (let i = 1; i < s.segments.length; i++) {
      expect(isBlockNewline(s.segments[i]) && isBlockNewline(s.segments[i - 1])).toBe(false);
    }
  }

  function checkEverything(s: SerializedText): void {
    checkInvariants(s);
    checkFullRoundTrip(s);
    checkMonotonic(s);
    checkAllRanges(s);
    checkZeroWidth(s);
  }

  // -------------------------------------------------------------------------
  // Empty and degenerate inputs
  // -------------------------------------------------------------------------

  it('handles roots with no text at all: empty blocks, comments, imgs, inline wrappers, whitespace-free', () => {
    for (const html of ['', '<div></div>', '<span></span>', '<!-- c -->', '<div><span><b></b></span></div>', '<hr>', '<div><hr></div>']) {
      const { s, root } = editor(html);
      expect(s.text).toBe('');
      expect(s.segments).toEqual([]);
      expect(s.atomic).toEqual([]);
      expect(s.zeroWidth).toEqual([]);
      const p = toDomPosition(s, 0);
      expect(p.node).toBe(root);
      expect(p.offset).toBe(root.childNodes.length);
      expect(fromDomPosition(s, root, 0)).toBe(0);
      expect(fromDomPosition(s, root, root.childNodes.length)).toBe(0);
      const r = rangeFromOffsets(s, 0, 0);
      expect(r.collapsed).toBe(true);
      expect(r.startContainer).toBe(root);
      expect(() => rangeFromOffsets(s, 0, 1)).toThrow(RangeError);
    }
    // An editor holding only an emoji <img>: no text, one zero-length atomic, and offset 0 still resolves inside the root.
    const { s, root } = editor('<img src="e.png">');
    expect(s.text).toBe('');
    expect(s.atomic).toEqual([{ start: 0, end: 0 }]);
    const p = toDomPosition(s, 0);
    expect(p.node).toBe(root);
    expect(fromDomPosition(s, root, 0)).toBe(0);
    expect(fromDomPosition(s, root, 1)).toBe(0);
  });

  it('a root holding only empty Text nodes has zero-length segments that all resolve to offset 0', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mounted.push(root);
    const t1 = document.createTextNode('');
    const t2 = document.createTextNode('');
    root.append(t1, t2);
    const s = serializeEditable(root);
    expect(s.text).toBe('');
    expect(kinds(s)).toEqual(['text[0,0)', 'text[0,0)']);
    expect(toDomPosition(s, 0, 'forward')).toEqual({ node: t1, offset: 0 });
    expect(toDomPosition(s, 0, 'backward')).toEqual({ node: t1, offset: 0 });
    expect(fromDomPosition(s, t1, 0)).toBe(0);
    expect(fromDomPosition(s, t2, 0)).toBe(0);
    expect(fromDomPosition(s, t2, 5)).toBe(0); // clamped to the (empty) node
    checkEverything(s);
  });

  it('whitespace-only text is kept verbatim (editors use white-space: pre-wrap)', () => {
    const { s } = editor('<div> </div><div>\t</div><div>  a  </div>   ');
    expect(s.text).toBe(' \n\t\n  a  \n   ');
    checkEverything(s);
    checkTextComplete(s);
    expect(serialize('   ')).toBe('   ');
    expect(serialize('<div>&nbsp;</div>')).toBe(' ');
  });

  // -------------------------------------------------------------------------
  // Unicode: surrogate pairs, zero-width characters, NBSP, CRLF, literal newlines
  // -------------------------------------------------------------------------

  it('maps every offset of surrogate pairs that straddle Text node boundaries, including lone-surrogate slices', () => {
    const { s, root } = editor('<div><b>😀</b>😀<i>x</i>😀</div>');
    expect(s.text).toBe('😀😀x😀');
    expect(s.text.length).toBe(7);
    const div = root.firstChild as HTMLElement;
    const first = div.childNodes[0]!.firstChild as Text;
    const second = div.childNodes[1] as Text;
    // Offset 2 is the boundary between the two emoji Text nodes.
    expect(toDomPosition(s, 2, 'forward')).toEqual({ node: second, offset: 0 });
    expect(toDomPosition(s, 2, 'backward')).toEqual({ node: first, offset: 2 });
    // Offsets 1 and 3 are between surrogates; they map into the owning node at the same code-unit offset.
    expect(toDomPosition(s, 1)).toEqual({ node: first, offset: 1 });
    expect(toDomPosition(s, 3)).toEqual({ node: second, offset: 1 });
    // A range over a lone low surrogate + lone high surrogate still yields exactly those two code units.
    expect(rangeFromOffsets(s, 1, 3).toString()).toBe(s.text.slice(1, 3));
    expect(rangeFromOffsets(s, 1, 3).toString().length).toBe(2);
    // A pair split across two Text nodes by splitText() still serializes as one valid code point.
    const third = div.childNodes[3] as Text;
    third.splitText(1);
    const s2 = serializeEditable(root);
    expect(s2.text).toBe('😀😀x😀');
    expect(s2.segments.filter((seg) => seg.kind === 'text')).toHaveLength(5);
    expect(rangeFromOffsets(s2, 5, 7).toString()).toBe('😀');
    checkEverything(s2);
    checkTextComplete(s2);
  });

  it('reports zero-width characters at every position: alone, leading, trailing, adjacent, inside chips, inside emoji', () => {
    const cases: [string, string, number[]][] = [
      ['<div>​</div>', '​', [0]],
      ['<div>​​</div>', '​​', [0, 1]],
      ['<div>a​</div><div>​b</div>', 'a​\n​b', [1, 3]],
      ['<div><span contenteditable="false">﻿@Bob​</span></div>', '﻿@Bob​', [0, 5]],
      ['<div>‌‍﻿​</div>', '‌‍﻿​', [0, 1, 2, 3]],
      ['<div>👨‍👩</div>', '👨‍👩', [2]],
      ['<p><span>​</span></p><p>x</p>', '​\nx', [0]],
    ];
    for (const [html, text, zw] of cases) {
      const { s } = editor(html);
      expect(s.text).toBe(text);
      expect(s.zeroWidth).toEqual(zw);
      checkEverything(s);
      checkTextComplete(s);
    }
    // A ZWSP-only editor: offset 1 === text.length resolves to the end of the ZWSP node.
    const { s, root } = editor('<div>​</div>');
    expect(toDomPosition(s, 1)).toEqual({ node: root.firstChild!.firstChild, offset: 1 });
  });

  it('NBSP everywhere: alone, runs, mixed with zero-width, at both ends; offsets stay 1:1 and Range.toString keeps the real NBSP', () => {
    const { s } = editor('<div> </div><div> ​ </div><div>a   b</div><div> c </div>');
    expect(s.text).toBe(' \n ​ \na   b\n c ');
    expect(s.zeroWidth).toEqual([3]);
    // The DOM still holds NBSP; the module never rewrites the DOM.
    expect(s.root.textContent).toContain(' ');
    expect(rangeFromOffsets(s, 2, 5).toString()).toBe(' ​ ');
    expect(rangeFromOffsets(s, 2, 5).toString().replace(NBSP_RE, ' ')).toBe(s.text.slice(2, 5));
    checkEverything(s);
    checkTextComplete(s);
  });

  it('keeps CRLF and literal newlines in Text nodes verbatim, never as newline segments', () => {
    // The HTML parser normalises CRLF, so the CR must be put in the DOM directly (paste handlers do this).
    const { root } = editor('<div></div><div>c\nd</div><pre>x\n\ny</pre>');
    root.children[0]!.appendChild(document.createTextNode('a\r\nb'));
    const s = serializeEditable(root);
    expect(s.text).toBe('a\r\nb\nc\nd\nx\n\ny');
    // Only the two block boundaries are synthetic newlines.
    expect(s.segments.filter((seg) => seg.kind === 'newline')).toHaveLength(2);
    expect(kinds(s)).toEqual(['text[0,4)', 'newline[4,5):DIV', 'text[5,8)', 'newline[8,9):DIV', 'text[9,13)']);
    const t1 = root.children[0]!.firstChild as Text;
    // Offsets around the CR and LF stay inside the Text node; the Range yields the real characters.
    expect(toDomPosition(s, 1)).toEqual({ node: t1, offset: 1 });
    expect(toDomPosition(s, 2)).toEqual({ node: t1, offset: 2 });
    expect(toDomPosition(s, 3, 'backward')).toEqual({ node: t1, offset: 3 });
    expect(rangeFromOffsets(s, 1, 3).toString()).toBe('\r\n');
    expect(rangeFromOffsets(s, 6, 7).toString()).toBe('\n');
    expect(rangeFromOffsets(s, 10, 11).toString()).toBe('\n');
    // A literal "\n" at the end of a block abuts a synthetic one: both offsets are distinct and addressable.
    const { s: s2, root: r2 } = editor('<div>a\n</div><div>b</div>');
    expect(s2.text).toBe('a\n\nb');
    expect(toDomPosition(s2, 2, 'backward')).toEqual({ node: r2.children[0]!.firstChild, offset: 2 });
    expect(toDomPosition(s2, 3)).toEqual({ node: r2.children[1]!.firstChild, offset: 0 });
    checkInvariants(s);
    checkFullRoundTrip(s);
    checkMonotonic(s);
    checkInvariants(s2);
    checkFullRoundTrip(s2);
  });

  // -------------------------------------------------------------------------
  // Offsets at exactly text.length and other boundary offsets
  // -------------------------------------------------------------------------

  it('offset === text.length resolves correctly for every trailing shape', () => {
    const cases: [string, (root: HTMLElement) => DomPosition][] = [
      ['<div>ab</div>', (r) => ({ node: r.firstChild!.firstChild!, offset: 2 })], // end of last Text
      ['<div>ab<br></div>', (r) => ({ node: r.firstChild!.firstChild!, offset: 2 })], // placeholder <br> is invisible
      ['<div>ab</div><div><br></div>', (r) => ({ node: r.children[1]!, offset: 0 })], // trailing empty line anchor
      ['ab<br><br>', (r) => ({ node: r, offset: 2 })], // after the first <br>: "ab\n"
      ['<div>ab</div><br>', (r) => ({ node: r, offset: 1 })], // empty line after a block
      ['<div>ab<img src="x.png"></div>', (r) => ({ node: r.firstChild!.firstChild!, offset: 2 })], // trailing image is zero-length
      ['<div>ab<span contenteditable="false">@c</span></div>', (r) => ({ node: r.firstChild!.lastChild!.firstChild!, offset: 2 })],
      ['<div>ab</div><div></div><div></div>', (r) => ({ node: r.firstChild!.firstChild!, offset: 2 })], // trailing empty blocks
      ['<div>ab</div><div>​</div>', (r) => ({ node: r.children[1]!.firstChild!, offset: 1 })], // trailing ZWSP line is real text
    ];
    for (const [html, expected] of cases) {
      const { s, root } = editor(html);
      const n = s.text.length;
      for (const affinity of ['forward', 'backward'] as const) {
        expect(toDomPosition(s, n, affinity), html).toEqual(expected(root));
        expect(toDomPosition(s, n + 1000, affinity), html).toEqual(expected(root));
        expect(toDomPosition(s, Number.POSITIVE_INFINITY, affinity), html).toEqual(expected(root));
      }
      const r = rangeFromOffsets(s, n, n);
      expect(r.collapsed).toBe(true);
      expect(fromDomPosition(s, r.startContainer, r.startOffset)).toBe(n);
      expect(() => rangeFromOffsets(s, n, n + 1)).toThrow(RangeError);
      expect(() => rangeFromOffsets(s, n + 1, n + 1)).toThrow(RangeError);
      checkEverything(s);
    }
  });

  it('rejects every malformed offset pair for rangeFromOffsets and rectsForOffsets', () => {
    const { s } = editor('<div>abc</div>');
    const bad: [number, number][] = [
      [-1, 0], [0, 4], [2, 1], [0.5, 1], [0, 1.5], [Number.NaN, 1], [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 3], [0, Number.POSITIVE_INFINITY], [-0.0001, 1], [4, 4],
    ];
    for (const [a, b] of bad) {
      expect(() => rangeFromOffsets(s, a, b), `[${a}, ${b})`).toThrow(RangeError);
      expect(() => rectsForOffsets(s, a, b), `[${a}, ${b})`).toThrow(RangeError);
    }
    // -0 is an integer >= 0 and must be accepted.
    expect(rangeFromOffsets(s, -0, 3).toString()).toBe('abc');
    expect(rangeFromOffsets(s, 3, 3).collapsed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Element positions at block ends (caret fidelity)
  // -------------------------------------------------------------------------

  it('an element position at the end of a block (before/after a placeholder <br>) is the END of that line, not the start of the next', () => {
    // Chrome produces <div>text<br></div> lines; a caret reported as (div, 1) or (div, 2) sits at the end of "ab".
    const { s, root } = editor('<div>ab<br></div><div>cd</div>');
    expect(s.text).toBe('ab\ncd');
    const [div1, div2] = Array.from(root.children);
    expect(fromDomPosition(s, div1!, 1)).toBe(2); // before the placeholder <br>
    expect(fromDomPosition(s, div1!, 2)).toBe(2); // after the placeholder <br>
    expect(fromDomPosition(s, div1!.lastChild!, 0)).toBe(2); // (br, 0)
    expect(fromDomPosition(s, div2!, 0)).toBe(3);
    expect(fromDomPosition(s, root, 1)).toBe(3); // between the blocks: the next line
    // The same without the <br>, and with a trailing zero-length image.
    const { s: s2, root: r2 } = editor('<div>ab</div><div>cd</div>');
    expect(fromDomPosition(s2, r2.children[0]!, 1)).toBe(2);
    expect(fromDomPosition(s2, r2, 1)).toBe(3);
    expect(fromDomPosition(s2, r2.children[1]!, 0)).toBe(3);
    const { s: s3, root: r3 } = editor('<div>ab<img src="x.png"></div><div>cd</div>');
    expect(fromDomPosition(s3, r3.children[0]!, 1)).toBe(2);
    expect(fromDomPosition(s3, r3.children[0]!, 2)).toBe(2);
    // A block that OPENS after inline text: the point before the block is the end of the inline text.
    const { s: s4, root: r4 } = editor('hello<div>world</div>');
    expect(s4.text).toBe('hello\nworld');
    expect(fromDomPosition(s4, r4, 1)).toBe(5);
    expect(fromDomPosition(s4, r4.children[0]!, 0)).toBe(6);
    // Nested: <div>a<div>b</div>c</div>
    const { s: s5, root: r5 } = editor('<div>a<div>b</div>c</div>');
    const outer = r5.firstChild as HTMLElement;
    const inner = outer.children[0]!;
    expect(s5.text).toBe('a\nb\nc');
    expect(fromDomPosition(s5, outer, 1)).toBe(1); // between "a" and the inner block
    expect(fromDomPosition(s5, inner, 0)).toBe(2);
    expect(fromDomPosition(s5, inner, 1)).toBe(3); // end of "b", still inside the inner block
    expect(fromDomPosition(s5, outer, 2)).toBe(4); // after the inner block closed: start of "c"
    // A selection whose focus is such an element point reports the end of the line.
    const range = document.createRange();
    range.setStart(div1!.firstChild!, 0);
    range.setEnd(div1!, 2);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(offsetsFromSelection(s, sel)).toEqual({ start: 0, end: 2 });
  });

  // -------------------------------------------------------------------------
  // Atomic ranges: adjacent, duplicate, zero-length, nested, at boundaries
  // -------------------------------------------------------------------------

  it('records adjacent and duplicate atomic ranges without merging them, and keeps them sorted', () => {
    const { s } = editor(
      '<div><img src="1"><img src="2"><span contenteditable="false">a</span><span contenteditable="false">a</span>' +
        '<span contenteditable="false"></span><img src="3"></div>',
    );
    expect(s.text).toBe('aa');
    expect(s.atomic).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 0 },
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 2 }, // an empty chip is a zero-length object, like an image
      { start: 2, end: 2 },
    ]);
    checkEverything(s);
  });

  it('atomic ranges across block boundaries: chips that are blocks, chips starting lines, zero-length objects on their own line', () => {
    const { s } = editor('<div>a</div><div contenteditable="false"><div>x</div><div>y</div></div><div><img src="e"></div><div><span contenteditable="false"></span>b</div>');
    expect(s.text).toBe('a\nx\ny\nb');
    expect(s.atomic).toEqual([
      { start: 2, end: 5 }, // "x\ny" (the chip's own inner block boundary is inside the island)
      { start: 6, end: 6 }, // the image: no text, shifted past the newline it followed
      { start: 6, end: 6 }, // the empty chip opening the last line
    ]);
    expect(s.text.slice(2, 5)).toBe('x\ny');
    checkEverything(s);
  });

  it('ranges that merely touch a zero-length object leave it in the DOM; a range that strictly contains it removes it', () => {
    const make = () => editor('<div>Great <img src="x.png" alt=":smile:"> job</div>');
    const { s } = make();
    expect(s.text).toBe('Great  job');
    expect(s.atomic).toEqual([{ start: 6, end: 6 }]);
    // [0, 6) ends exactly at the object: the image is not inside the Range.
    const left = rangeFromOffsets(s, 0, 6);
    expect(left.cloneContents().querySelector('img')).toBeNull();
    expect(left.toString()).toBe('Great ');
    // [6, 10) starts exactly at the object: the image is not inside the Range.
    const right = rangeFromOffsets(s, 6, 10);
    expect(right.cloneContents().querySelector('img')).toBeNull();
    expect(right.toString()).toBe(' job');
    // [5, 7) strictly contains offset 6: the image IS inside and would be deleted.
    const across = rangeFromOffsets(s, 5, 7);
    expect(across.cloneContents().querySelector('img')).not.toBeNull();
    across.deleteContents();
    expect(s.root.querySelector('img')).toBeNull();
    expect(s.root.textContent).toBe('Greatjob');
    // Collapsed at the object: a caret, nothing selected.
    const { s: s2 } = make();
    const at = rangeFromOffsets(s2, 6, 6);
    expect(at.collapsed).toBe(true);
    expect(at.cloneContents().querySelector('img')).toBeNull();
  });

  it('a range covering exactly a chip stays inside the chip boundaries, so deleting it removes only the chip text', () => {
    const { s, root } = editor('<div>Hi <span contenteditable="false">@Bob</span> there</div>');
    expect(s.atomic).toEqual([{ start: 3, end: 7 }]);
    const r = rangeFromOffsets(s, 3, 7);
    expect(r.toString()).toBe('@Bob');
    const chipText = root.querySelector('span')!.firstChild!;
    expect(r.startContainer).toBe(chipText);
    expect(r.endContainer).toBe(chipText);
    // Touching ranges on either side do not enter the chip.
    expect(rangeFromOffsets(s, 0, 3).endContainer).toBe(root.firstChild!.firstChild);
    expect(rangeFromOffsets(s, 7, 13).startContainer).toBe(root.firstChild!.lastChild);
    checkEverything(s);
  });

  // -------------------------------------------------------------------------
  // Nested and empty blocks, odd <br> placements
  // -------------------------------------------------------------------------

  it('deeply nested empty blocks and inline wrappers never emit newlines, and 300-deep nesting does not blow the stack', () => {
    expect(serialize('<div><div><div></div></div><div><span><div></div></span></div></div>')).toBe('');
    expect(serialize('<div>a</div><div><div><div></div></div></div><div>b</div>')).toBe('a\nb');
    expect(serialize('<div><div><div><br></div></div></div>')).toBe('');
    expect(serialize('<ul><li><ul><li><ul><li>deep</li></ul></li></ul></li></ul>')).toBe('deep');
    let html = 'x';
    for (let i = 0; i < 300; i++) html = i % 2 ? `<div>${html}</div>` : `<span>${html}</span>`;
    const { s } = editor(html);
    expect(s.text).toBe('x');
    checkEverything(s);
    checkTextComplete(s);
  });

  it('handles <br> runs at block edges, around nested blocks and inside inline wrappers consistently', () => {
    const cases: [string, string][] = [
      ['<div><br><br></div>', '\n'], // two empty lines
      ['<div><br><br><br></div>', '\n\n'],
      ['<div><br></div><div><br></div><div><br></div>', '\n\n'],
      ['<div><br>a<br></div>', '\na'], // leading empty line, trailing placeholder
      ['<div>a<br><br>b</div>', 'a\n\nb'],
      ['<div><span><br></span>a</div>', '\na'],
      ['<div>a<span><br></span></div>', 'a'], // placeholder wrapped in a span
      ['<div>a<span><br></span>b</div>', 'a\nb'],
      ['<div><div>a</div><br><div>b</div></div>', 'a\n\nb'], // empty line between nested blocks
      ['<div>a<div>b</div><br></div>', 'a\nb\n'], // empty line after a nested block
      ['<br><div>a</div>', '\na'], // empty first line then a block
      ['<br>a', '\na'],
      ['<div>a</div><br>b', 'a\n\nb'], // <br> between a block and inline text is a real line
      ['a<br><div>b</div>', 'a\nb'], // placeholder before a block
      ['<div><br></div>a', '\na'],
    ];
    for (const [html, text] of cases) {
      const { s } = editor(html);
      expect(s.text, html).toBe(text);
      checkEverything(s);
    }
  });

  it('treatAsBlock applies to inline wrappers holding a lone <br> and to nested host blocks', () => {
    const opts = { treatAsBlock: (el: Element) => el.classList.contains('line') };
    const { s } = editor('<span class="line">a</span><span class="line"><br></span><span class="line"><span class="line">b</span></span>', opts);
    expect(s.text).toBe('a\n\nb');
    expect(kinds(s)).toEqual(['text[0,1)', 'newline[1,2):SPAN', 'empty[2,2):BR', 'newline[2,3):SPAN', 'text[3,4)']);
    checkEverything(s);
  });

  // -------------------------------------------------------------------------
  // Selection edge cases
  // -------------------------------------------------------------------------

  it('offsetsFromSelection orders a backwards (anchor after focus) selection and handles (br, 0) focus points', () => {
    const { s, root } = editor('<div>Hello</div><div><br></div><div>World</div>');
    const hello = root.children[0]!.firstChild as Text;
    const world = root.children[2]!.firstChild as Text;
    const sel = window.getSelection()!;
    sel.setBaseAndExtent(world, 3, hello, 1);
    expect(offsetsFromSelection(s, sel)).toEqual({ start: 1, end: 10 });
    // Focus on the empty line's <br> itself (Chrome sometimes reports this).
    sel.setBaseAndExtent(hello, 5, root.children[1]!.firstChild!, 0);
    expect(offsetsFromSelection(s, sel)).toEqual({ start: 5, end: 6 });
    // Whole-editor selection via element points on the root.
    sel.setBaseAndExtent(root, 0, root, root.childNodes.length);
    expect(offsetsFromSelection(s, sel)).toEqual({ start: 0, end: s.text.length });
    expect(s.text.length).toBe(12); // "Hello\n\nWorld"
    // A selection inside hidden content within the root is not a text selection.
    const { s: sh, root: rh } = editor('<div>a</div><div hidden>h</div>');
    const hiddenText = rh.children[1]!.firstChild!;
    sel.setBaseAndExtent(hiddenText, 0, hiddenText, 1);
    expect(offsetsFromSelection(sh, sel)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Performance
  // -------------------------------------------------------------------------

  it('serializes a 50KB Gmail-like document and resolves every offset in under 200ms each', () => {
    const parts: string[] = [];
    let textSize = 0;
    for (let i = 0; textSize < 50 * 1024; i++) {
      const line =
        `<div dir="ltr">Paragraph ${i}: the quick <b>brown</b> fox&nbsp;jumps over the ` +
        `<span contenteditable="false" class="chip">@lazy${i}</span> dog <img src="e.png" alt=":smile:"> again, ` +
        `${'lorem ipsum dolor sit amet '.repeat(3)}<i>fin</i><br></div>`;
      parts.push(line);
      textSize += line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').length;
      if (i % 5 === 0) parts.push('<div dir="ltr"><br></div>');
    }
    const root = document.createElement('div');
    root.setAttribute('contenteditable', 'true');
    root.innerHTML = parts.join('');
    document.body.appendChild(root);
    mounted.push(root);
    expect(root.textContent!.length).toBeGreaterThanOrEqual(50 * 1024);

    // First pass: jsdom computes every element's cascaded style from scratch on first access
    // (~0.4ms each, ~2000 elements), a cost a browser pays while rendering, not in this module.
    // Count the style reads instead: exactly one per element, none repeated.
    const originalGcs = window.getComputedStyle;
    let styleReads = 0;
    window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      styleReads++;
      return originalGcs.call(window, el, pseudo);
    }) as typeof window.getComputedStyle;
    let s: SerializedText;
    try {
      s = serializeEditable(root);
    } finally {
      window.getComputedStyle = originalGcs;
    }
    expect(s.text.length).toBeGreaterThanOrEqual(50 * 1024);
    expect(styleReads).toBe(root.querySelectorAll('*').length);

    // Warm pass: the module's own work on 50KB (what every input event costs).
    const t0 = performance.now();
    const again = serializeEditable(root);
    const t1 = performance.now();
    expect(again.text).toBe(s.text);
    expect(t1 - t0).toBeLessThan(200);

    const t2 = performance.now();
    for (let o = 0; o <= s.text.length; o++) toDomPosition(s, o, o % 2 ? 'forward' : 'backward');
    for (let o = 0; o + 12 <= s.text.length; o += 101) rangeFromOffsets(s, o, o + 12);
    const t3 = performance.now();
    expect(t3 - t2).toBeLessThan(200);

    // Mapping back from every Text node start and a few element points.
    const t4 = performance.now();
    for (const seg of s.segments) if (seg.kind === 'text') fromDomPosition(s, seg.node, 0);
    for (let i = 0; i < root.childNodes.length; i += 50) fromDomPosition(s, root, i);
    const t5 = performance.now();
    expect(t5 - t4).toBeLessThan(200);
    // Spot-check correctness on the big document.
    expect(fromDomPosition(s, root, root.childNodes.length)).toBe(s.text.length);
    expect(s.atomic.filter((a) => a.start === a.end).length).toBe(root.querySelectorAll('img').length);
    expect(s.atomic.filter((a) => a.start < a.end).length).toBe(root.querySelectorAll('.chip').length);
  });

  // -------------------------------------------------------------------------
  // Seeded fuzz: random DOM shapes vs the documented guarantees
  // -------------------------------------------------------------------------

  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }

  function randomHtml(rand: () => number, depth: number): string {
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const leaves = ['a', 'bc', ' ', 'x y', '😀', ' ', '​', 'q‍z', 'Hi,', '👨‍👩‍👧', '﻿'];
    const n = 1 + Math.floor(rand() * 4);
    let out = '';
    for (let i = 0; i < n; i++) {
      const r = rand();
      if (r < 0.3) out += pick(leaves);
      else if (r < 0.42) out += '<br>';
      else if (r < 0.5) out += '<img src="e.png">';
      else if (r < 0.58) out += `<span contenteditable="false">@${pick(['Bob', 'x', '😀'])}</span>`;
      else if (depth > 0 && r < 0.78) out += `<div>${randomHtml(rand, depth - 1)}</div>`;
      else if (depth > 0 && r < 0.92) {
        const tag = pick(['span', 'b', 'i']);
        out += `<${tag}>${randomHtml(rand, depth - 1)}</${tag}>`;
      } else if (depth > 0) out += `<ul><li>${randomHtml(rand, depth - 1)}</li></ul>`;
    }
    return out;
  }

  /** Sprinkle empty Text nodes and split some Text nodes, shapes innerHTML cannot express. */
  function roughen(root: HTMLElement, rand: () => number): void {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    for (const t of texts) {
      if (t.data.length > 1 && rand() < 0.4) t.splitText(1 + Math.floor(rand() * (t.data.length - 1)));
    }
    const elements = [root, ...Array.from(root.querySelectorAll('*'))];
    for (const el of elements) {
      if (rand() < 0.3) el.insertBefore(document.createTextNode(''), el.childNodes[Math.floor(rand() * (el.childNodes.length + 1))] ?? null);
    }
  }

  it('fuzz: 200 seeded random DOM shapes satisfy every documented guarantee', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = lcg(seed);
      const html = randomHtml(rand, 3);
      const root = document.createElement('div');
      root.setAttribute('contenteditable', 'true');
      root.innerHTML = html;
      document.body.appendChild(root);
      mounted.push(root);
      roughen(root, rand);
      const s = serializeEditable(root);
      const label = `seed ${seed}: ${root.innerHTML}`;
      try {
        checkEverything(s);
        checkTextComplete(s);
        // Atomic entries correspond 1:1, in order, to objects and chips.
        const objects = root.querySelectorAll('img').length;
        expect(s.atomic.filter((a) => a.start === a.end).length).toBe(objects);
        const chips = Array.from(root.querySelectorAll('[contenteditable="false"]'));
        const chipRanges = s.atomic.filter((a) => a.start < a.end);
        expect(chipRanges.length).toBe(chips.length);
        chipRanges.forEach((a, i) => expect(s.text.slice(a.start, a.end).replace(/\n/g, '')).toBe(chips[i]!.textContent!.replace(NBSP_RE, ' ')));
        // No run of three newlines can come from two adjacent empty lines... but CAN from <br><br><br>; just check no text was lost.
        expect(s.text.replace(/\n/g, '').length).toBe(root.textContent!.length);
      } catch (e) {
        throw new Error(`${label}\n${(e as Error).message}`);
      }
      root.remove();
    }
  });
});
