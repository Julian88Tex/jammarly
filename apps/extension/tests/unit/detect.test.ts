import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_FIELD_HEIGHT,
  MIN_FIELD_WIDTH,
  classify,
  classifyLabelText,
  deepActiveElement,
  editableFromEvent,
  editingHost,
  fieldLabel,
  findEditable,
  isEligibleKind,
  isSmallField,
  kindOf,
  optOutState,
  type ClassifyOptions,
} from '../../src/content/detect';
import { gmail } from '../../src/content/sites/gmail';

const OPTS: ClassifyOptions = { checkOptedOutFields: false, ignoreSiteOptOut: false };

const mounted: Element[] = [];

function mount<T extends Element>(el: T, parent: Element = document.body): T {
  parent.appendChild(el);
  mounted.push(el);
  return el;
}

/** jsdom has no layout: mock the client box. */
function sized<T extends Element>(el: T, width = 400, height = 120): T {
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  return el;
}

function textarea(attrs: Record<string, string> = {}): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return sized(el);
}

function input(type: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.setAttribute('type', type);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return sized(el);
}

function editable(attrs: Record<string, string> = { contenteditable: 'true' }): HTMLDivElement {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return sized(el);
}

function reason(el: HTMLElement, opts: ClassifyOptions = OPTS): string {
  const c = classify(el, opts);
  return c.ok ? `ok:${c.kind}` : c.reason;
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  document.documentElement.removeAttribute('data-jammarly');
  document.body.innerHTML = '';
});

describe('findEditable', () => {
  it('returns a textarea or input itself', () => {
    const ta = mount(textarea());
    const inp = mount(input('text'));
    expect(findEditable(ta)).toBe(ta);
    expect(findEditable(inp)).toBe(inp);
  });

  it('climbs from a text node inside nested inline elements to the contenteditable root', () => {
    const root = mount(editable());
    root.innerHTML = '<div><b><i>hello</i></b></div>';
    const text = root.querySelector('i')!.firstChild!;
    expect(findEditable(text)).toBe(root);
    expect(findEditable(root.querySelector('b'))).toBe(root);
    expect(findEditable(root)).toBe(root);
  });

  it('does not climb past the editing host into a non-editable parent', () => {
    const wrapper = mount(document.createElement('section'));
    const root = editable();
    wrapper.appendChild(root);
    root.innerHTML = '<p>text</p>';
    expect(findEditable(root.firstChild!.firstChild)).toBe(root);
    expect(editingHost(root)).toBe(root);
  });

  it('resolves a click inside a contenteditable="false" chip to the surrounding editor', () => {
    const root = mount(editable());
    root.innerHTML = 'Hi <span contenteditable="false" class="chip"><button>@bob</button></span> there';
    expect(findEditable(root.querySelector('button'))).toBe(root);
  });

  it('treats a nested editable island inside a chip as its own host', () => {
    const root = mount(editable());
    root.innerHTML = 'Hi <span contenteditable="false"><span contenteditable="true" id="inner">x</span></span>';
    const inner = root.querySelector('#inner')!;
    expect(findEditable(inner.firstChild)).toBe(inner);
  });

  it('returns null for non-editable targets and null', () => {
    const div = mount(document.createElement('div'));
    div.textContent = 'static';
    expect(findEditable(div)).toBeNull();
    expect(findEditable(div.firstChild)).toBeNull();
    expect(findEditable(null)).toBeNull();
  });

  it('resolves a Document or Window target through the active element', () => {
    const ta = mount(textarea());
    ta.focus();
    expect(document.activeElement).toBe(ta);
    expect(findEditable(document)).toBe(ta);
    expect(findEditable(window)).toBe(ta);
  });

  it('descends open shadow roots from the retargeted host and from the shadow root itself', () => {
    const host = mount(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('textarea');
    shadow.appendChild(inner);
    inner.focus();
    expect(document.activeElement).toBe(host);
    expect(deepActiveElement(document)).toBe(inner);
    expect(findEditable(host)).toBe(inner);
    expect(findEditable(shadow)).toBe(inner);
    expect(findEditable(document)).toBe(inner);
  });

  it('editableFromEvent uses the composed path to see inside shadow roots', () => {
    const host = mount(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.setAttribute('contenteditable', 'true');
    inner.textContent = 'shadow text';
    shadow.appendChild(inner);
    let found: HTMLElement | null = null;
    const onFocusIn = (ev: Event) => {
      found = editableFromEvent(ev);
    };
    document.addEventListener('focusin', onFocusIn);
    inner.firstChild!.parentElement!.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    document.removeEventListener('focusin', onFocusIn);
    expect(found).toBe(inner);
  });
});

describe('kindOf / isEligibleKind', () => {
  it('names the kind for textarea, input and contenteditable', () => {
    expect(kindOf(textarea())).toBe('textarea');
    expect(kindOf(input('text'))).toBe('input');
    expect(kindOf(input('password'))).toBe('input');
    expect(kindOf(editable())).toBe('contenteditable');
    expect(kindOf(editable({ contenteditable: '' }))).toBe('contenteditable');
    expect(kindOf(editable({ contenteditable: 'plaintext-only' }))).toBe('contenteditable');
    expect(kindOf(editable({ contenteditable: 'false' }))).toBeNull();
    expect(kindOf(document.createElement('div'))).toBeNull();
    expect(isEligibleKind(editable())).toBe(true);
    expect(isEligibleKind(document.createElement('p'))).toBe(false);
  });
});

describe('classify: kinds and inputs', () => {
  it('accepts sized textareas, text-like inputs and contenteditable roots', () => {
    expect(reason(mount(textarea()))).toBe('ok:textarea');
    expect(reason(mount(input('text')))).toBe('ok:input');
    expect(reason(mount(input('search')))).toBe('ok:input');
    expect(reason(mount(input('url')))).toBe('ok:input');
    expect(reason(mount(editable()))).toBe('ok:contenteditable');
    expect(reason(mount(editable({ contenteditable: '' })))).toBe('ok:contenteditable');
    expect(reason(mount(editable({ contenteditable: 'plaintext-only' })))).toBe('ok:contenteditable');
    const noType = mount(sized(document.createElement('input')));
    expect(reason(noType)).toBe('ok:input');
  });

  it('rejects non-editable elements and non-text inputs', () => {
    expect(reason(mount(sized(document.createElement('div'))))).toBe('not-editable');
    expect(reason(mount(editable({ contenteditable: 'false' })))).toBe('not-editable');
    expect(reason(mount(input('checkbox')))).toBe('not-editable');
    expect(reason(mount(input('date')))).toBe('not-editable');
    expect(reason(mount(input('hidden')))).toBe('not-editable');
    expect(reason(mount(input('range')))).toBe('not-editable');
  });

  it('skips password fields, including revealed ones', () => {
    expect(reason(mount(input('password')))).toBe('password');
    expect(reason(mount(input('text', { autocomplete: 'current-password' })))).toBe('password');
    expect(reason(mount(input('text', { autocomplete: 'new-password' })))).toBe('password');
  });

  it('skips sensitive inputs: email, tel, number, payment and one-time-code autocomplete, numeric inputmode', () => {
    expect(reason(mount(input('email')))).toBe('sensitive-input');
    expect(reason(mount(input('tel')))).toBe('sensitive-input');
    expect(reason(mount(input('number')))).toBe('sensitive-input');
    expect(reason(mount(input('text', { autocomplete: 'cc-number' })))).toBe('sensitive-input');
    expect(reason(mount(input('text', { autocomplete: 'section-blue shipping cc-name' })))).toBe('sensitive-input');
    expect(reason(mount(input('text', { autocomplete: 'one-time-code' })))).toBe('sensitive-input');
    expect(reason(mount(input('text', { inputmode: 'numeric' })))).toBe('sensitive-input');
    expect(reason(mount(input('text', { inputmode: 'decimal' })))).toBe('sensitive-input');
    expect(reason(mount(input('text', { autocomplete: 'name' })))).toBe('ok:input');
    expect(reason(mount(input('text', { inputmode: 'text' })))).toBe('ok:input');
  });

  it('skips inputs with a small maxlength (codes), not ones with room for prose', () => {
    expect(reason(mount(input('text', { maxlength: '8' })))).toBe('too-small');
    expect(reason(mount(input('text', { maxlength: '4' })))).toBe('too-small');
    expect(reason(mount(input('text', { maxlength: '9' })))).toBe('ok:input');
    expect(reason(mount(input('text', { maxlength: '280' })))).toBe('ok:input');
  });

  it('skips readonly and disabled fields', () => {
    expect(reason(mount(textarea({ readonly: '' })))).toBe('readonly');
    expect(reason(mount(textarea({ disabled: '' })))).toBe('readonly');
    expect(reason(mount(input('text', { readonly: '' })))).toBe('readonly');
    expect(reason(mount(editable({ contenteditable: 'true', 'aria-readonly': 'true' })))).toBe('readonly');
  });
});

describe('classify: size and visibility gates', () => {
  it(`requires clientWidth >= ${MIN_FIELD_WIDTH} and clientHeight >= ${MIN_FIELD_HEIGHT} for every kind`, () => {
    expect(reason(mount(sized(textarea(), MIN_FIELD_WIDTH - 1, 100)))).toBe('too-small');
    expect(reason(mount(sized(textarea(), 400, MIN_FIELD_HEIGHT - 1)))).toBe('too-small');
    expect(reason(mount(sized(textarea(), MIN_FIELD_WIDTH, MIN_FIELD_HEIGHT)))).toBe('ok:textarea');
    expect(reason(mount(sized(editable(), 300, 30)))).toBe('ok:contenteditable');
    expect(reason(mount(sized(editable(), 300, 23)))).toBe('too-small');
    expect(reason(mount(sized(input('text'), 100, 30)))).toBe('too-small');
    // A 38 px gate is NOT applied: 24–36 px chat prompt boxes are eligible.
    expect(reason(mount(sized(editable(), 600, 28)))).toBe('ok:contenteditable');
  });

  it('reports hidden fields: zero box, display none, visibility hidden, hidden attribute', () => {
    expect(reason(mount(sized(textarea(), 0, 0)))).toBe('hidden');
    const none = mount(textarea());
    none.style.display = 'none';
    expect(reason(none)).toBe('hidden');
    const invisible = mount(textarea());
    invisible.style.visibility = 'hidden';
    expect(reason(invisible)).toBe('hidden');
    expect(reason(mount(textarea({ hidden: '' })))).toBe('hidden');
  });

  it('isSmallField anchors the button outside fields under 40 px', () => {
    expect(isSmallField({ height: 39 })).toBe(true);
    expect(isSmallField({ height: 24 })).toBe(true);
    expect(isSmallField({ height: 40 })).toBe(false);
    expect(isSmallField({ height: 180 })).toBe(false);
  });
});

describe('classify: code editors and the Google Docs sink', () => {
  it('rejects fields inside known code editors, before the size gate', () => {
    for (const cls of ['cm-editor', 'CodeMirror', 'monaco-editor', 'ace_editor']) {
      const wrap = mount(document.createElement('div'));
      wrap.className = cls;
      const ta = textarea();
      wrap.appendChild(ta);
      expect(reason(ta)).toBe('code-editor');
    }
    const cmContent = mount(editable({ contenteditable: 'true', class: 'cm-content' }));
    expect(reason(cmContent)).toBe('code-editor');
    const monaco = mount(sized(textarea({ class: 'inputarea' }), 1, 1));
    expect(reason(monaco)).toBe('code-editor');
    const aceInput = mount(sized(textarea({ class: 'ace_text-input' }), 1, 1));
    expect(reason(aceInput)).toBe('code-editor');
    const roleDesc = mount(textarea({ 'aria-roledescription': 'editor' }));
    expect(reason(roleDesc)).toBe('code-editor');
    const pre = mount(sized(document.createElement('pre')));
    pre.setAttribute('contenteditable', 'true');
    expect(reason(pre)).toBe('code-editor');
  });

  it('treats an element bound to an EditContext as a code editor', () => {
    const el = mount(editable());
    (el as HTMLElement & { editContext?: unknown }).editContext = {};
    expect(reason(el)).toBe('code-editor');
  });

  it('rejects contenteditables inside Docs kix containers and the hidden text-event iframe', () => {
    const kix = mount(document.createElement('div'));
    kix.className = 'kix-appview-editor';
    const inner = editable();
    kix.appendChild(inner);
    expect(reason(inner)).toBe('gdocs-input-sink');

    const wrap = mount(document.createElement('div'));
    wrap.className = 'docs-texteventtarget-iframe';
    const inner2 = editable();
    wrap.appendChild(inner2);
    expect(reason(inner2)).toBe('gdocs-input-sink');

    const iframe = mount(document.createElement('iframe'));
    iframe.className = 'docs-texteventtarget-iframe';
    const idoc = iframe.contentDocument;
    if (idoc && idoc.body) {
      idoc.body.setAttribute('contenteditable', 'true');
      sized(idoc.body);
      expect(reason(idoc.body)).toBe('gdocs-input-sink');
    }
  });
});

describe('classify: opt-out union and opt-ins', () => {
  it('opts out on data-gramm / data-gramm_editor / data-jammarly with any value other than "true"', () => {
    expect(reason(mount(textarea({ 'data-gramm': 'false' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-gramm': '' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-gramm': 'anything' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-gramm_editor': 'false' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-jammarly': 'false' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-gramm': 'true' })))).toBe('ok:textarea');
    expect(reason(mount(textarea({ 'data-gramm_editor': 'TRUE' })))).toBe('ok:textarea');
  });

  it('opts out on data-enable-grammarly="false" and data-lt-active="false" only', () => {
    expect(reason(mount(textarea({ 'data-enable-grammarly': 'false' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-lt-active': 'false' })))).toBe('opted-out');
    expect(reason(mount(textarea({ 'data-lt-active': 'true' })))).toBe('ok:textarea');
    expect(reason(mount(textarea({ 'data-enable-grammarly': 'true' })))).toBe('ok:textarea');
  });

  it('never treats spellcheck="false" as an opt-out', () => {
    expect(reason(mount(textarea({ spellcheck: 'false' })))).toBe('ok:textarea');
    expect(reason(mount(editable({ contenteditable: 'true', spellcheck: 'false' })))).toBe('ok:contenteditable');
  });

  it('honours opt-out markers on ancestors', () => {
    const wrap = mount(document.createElement('div'));
    wrap.setAttribute('data-gramm', 'false');
    const ta = textarea();
    wrap.appendChild(document.createElement('div')).appendChild(ta);
    expect(reason(ta)).toBe('opted-out');
    expect(optOutState(ta)).toBe('opted-out');
  });

  it('lets a closer opt-in override an ancestor opt-out, and the closest marker wins', () => {
    const wrap = mount(document.createElement('div'));
    wrap.setAttribute('data-gramm', 'false');
    const ta = textarea({ 'data-enable-grammarly': 'true' });
    wrap.appendChild(ta);
    expect(reason(ta)).toBe('ok:textarea');

    const wrap2 = mount(document.createElement('div'));
    wrap2.setAttribute('data-gramm_editor', 'false');
    const mid = document.createElement('div');
    mid.setAttribute('data-jammarly', 'true');
    const ta2 = textarea();
    wrap2.appendChild(mid).appendChild(ta2);
    expect(reason(ta2)).toBe('ok:textarea');
    expect(optOutState(ta2)).toBe('opted-in');

    // Opt-in far away, opt-out closer: the closer marker decides.
    const wrap3 = mount(document.createElement('div'));
    wrap3.setAttribute('data-enable-grammarly', 'true');
    const mid3 = document.createElement('div');
    mid3.setAttribute('data-gramm', 'false');
    const ta3 = textarea();
    wrap3.appendChild(mid3).appendChild(ta3);
    expect(reason(ta3)).toBe('opted-out');
  });

  it('opt-in beats opt-out on the same element', () => {
    expect(reason(mount(textarea({ 'data-gramm': 'false', 'data-jammarly': 'true' })))).toBe('ok:textarea');
    expect(reason(mount(textarea({ 'data-gramm': 'false', 'data-enable-grammarly': 'true' })))).toBe('ok:textarea');
  });

  it('ignores markers on the <html> element (Jammarly stamps it itself)', () => {
    document.documentElement.setAttribute('data-jammarly', 'loaded');
    const ta = mount(textarea());
    expect(reason(ta)).toBe('ok:textarea');
    expect(optOutState(ta)).toBe('none');
  });

  it('checkOptedOutFields and ignoreSiteOptOut make opted-out fields eligible', () => {
    const ta = mount(textarea({ 'data-gramm': 'false' }));
    expect(reason(ta, { checkOptedOutFields: true, ignoreSiteOptOut: false })).toBe('ok:textarea');
    expect(reason(ta, { checkOptedOutFields: false, ignoreSiteOptOut: true })).toBe('ok:textarea');
  });

  it('reports permanent reasons before the size gate (opted-out and code-editor win over too-small)', () => {
    expect(reason(mount(sized(textarea({ 'data-gramm': 'false' }), 10, 10)))).toBe('opted-out');
    const wrap = mount(document.createElement('div'));
    wrap.className = 'cm-editor';
    const ta = sized(textarea({ 'data-gramm': 'false' }), 10, 10);
    wrap.appendChild(ta);
    expect(reason(ta)).toBe('code-editor');
  });
});

describe('fieldLabel', () => {
  it('labels the profile body selectors "Message body"', () => {
    const body = mount(editable({ contenteditable: 'true', g_editable: 'true', 'aria-label': 'Nachrichtentext' }));
    expect(fieldLabel(body, gmail)).toBe('Message body');
  });

  it('derives labels from aria-label, placeholder, name, role, type and <label>', () => {
    expect(fieldLabel(mount(input('text', { name: 'subjectbox' })), gmail)).toBe('Subject');
    expect(fieldLabel(mount(textarea({ 'aria-label': 'Add a comment' })))).toBe('Comment');
    expect(fieldLabel(mount(textarea({ name: 'comment[body]' })))).toBe('Comment');
    expect(fieldLabel(mount(textarea({ placeholder: 'Write a reply…' })))).toBe('Reply');
    expect(fieldLabel(mount(editable({ contenteditable: 'true', 'aria-placeholder': "What's happening?" })))).toBe('Post');
    expect(fieldLabel(mount(editable({ contenteditable: 'true', 'data-placeholder': 'Start a post' })))).toBe('Post');
    expect(fieldLabel(mount(input('search')))).toBe('Search');
    expect(fieldLabel(mount(editable({ contenteditable: 'true', role: 'searchbox' })))).toBe('Search');
    expect(fieldLabel(mount(input('text', { placeholder: 'Search people' })))).toBe('Search');
    expect(fieldLabel(mount(editable({ contenteditable: 'true', 'aria-label': 'Message #general' })))).toBe('Message body');
    expect(fieldLabel(mount(textarea({ 'aria-label': 'Message Body' })))).toBe('Message body');
    expect(fieldLabel(mount(textarea()))).toBe('Text field');
    expect(fieldLabel(mount(textarea()), null)).toBe('Text field');

    const label = mount(document.createElement('label'));
    label.setAttribute('for', 'c1');
    label.textContent = 'Your comment';
    const ta = mount(textarea({ id: 'c1' }));
    expect(fieldLabel(ta)).toBe('Comment');

    const heading = mount(document.createElement('h2'));
    heading.id = 'h1';
    heading.textContent = 'Reply to thread';
    expect(fieldLabel(mount(textarea({ 'aria-labelledby': 'h1' })))).toBe('Reply');
  });

  it('classifyLabelText prefers Subject over others and falls back to Text field', () => {
    expect(classifyLabelText('Subject')).toBe('Subject');
    expect(classifyLabelText('Reply to this comment')).toBe('Reply');
    expect(classifyLabelText('')).toBe('Text field');
    expect(classifyLabelText('anything', true)).toBe('Search');
  });
});
