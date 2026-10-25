/**
 * Minimal DOM builder for the extension pages. Everything is built with createElement / textContent; this module
 * (and every page that uses it) never touches innerHTML, outerHTML, insertAdjacentHTML or document.write.
 *
 *   h('button', { class: 'btn', onclick: () => ..., 'aria-label': 'Close' }, icon('x'), 'Close')
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Listener = (ev: Event) => void;

export interface Attrs {
  class?: string | (string | false | null | undefined)[];
  /** Inline style as a CSS text string (kept rare: tokens live in the stylesheets). */
  style?: string;
  dataset?: Record<string, string | number | boolean | undefined>;
  [key: string]: unknown;
}

const BOOLEAN_PROPS = new Set(['disabled', 'checked', 'selected', 'hidden', 'readOnly', 'readonly', 'required', 'multiple', 'autofocus', 'open']);

/** Attributes that take a URL; values with a script-capable scheme are refused (see isSafeUrlValue). */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'cite', 'background']);
/** Attributes that are HTML or script sinks under any circumstances; never settable through h(). */
const FORBIDDEN_ATTRS = new Set(['srcdoc']);
const SCRIPT_SCHEME_RE = /^(javascript|vbscript|data|livescript|mocha):/i;

/** True unless the value starts with a scheme that can execute code or smuggle markup. Control characters and whitespace are ignored like browsers do. */
export function isSafeUrlValue(value: string): boolean {
  return !SCRIPT_SCHEME_RE.test(value.replace(/[\u0000- \u007f-\u009f]/g, ''));
}

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }
  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw === undefined || raw === null || raw === false) continue;
    if (key === 'class') {
      const value = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && c.length > 0).join(' ') : String(raw);
      if (value) el.className = value;
      continue;
    }
    if (key === 'style') {
      el.setAttribute('style', String(raw));
      continue;
    }
    if (key === 'dataset' && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v !== undefined && v !== null) el.dataset[k] = String(v);
      }
      continue;
    }
    if (key.startsWith('on')) {
      // Only real listeners: a string here would become an inline handler attribute (a script sink), so it is dropped.
      if (typeof raw === 'function') el.addEventListener(key.slice(2).toLowerCase(), raw as Listener);
      continue;
    }
    if (FORBIDDEN_ATTRS.has(key)) continue;
    if (URL_ATTRS.has(key) && !isSafeUrlValue(String(raw))) continue;
    if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(raw);
      continue;
    }
    if (key === 'for') {
      (el as HTMLLabelElement).htmlFor = String(raw);
      continue;
    }
    if (BOOLEAN_PROPS.has(key)) {
      const prop = key === 'readonly' ? 'readOnly' : key;
      if (raw === true) {
        (el as unknown as Record<string, unknown>)[prop] = true;
        if (!(prop in el)) el.setAttribute(key, '');
      }
      continue;
    }
    el.setAttribute(key, raw === true ? '' : String(raw));
  }
}

/** Creates an element with attributes, listeners (`onclick`, `oninput`, ...) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  for (const child of children) appendChild(el, child);
  return el;
}

/** Removes every child node. */
export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replaces the children of `el` with `children`. */
export function replaceChildren(el: Node, ...children: Child[]): void {
  clear(el);
  for (const child of children) appendChild(el, child);
}

/** A text node (handy inside arrays of children). */
export function text(value: string | number): Text {
  return document.createTextNode(String(value));
}

/** Document fragment from children. */
export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const child of children) appendChild(frag, child);
  return frag;
}

let idCounter = 0;
/** Unique-ish ids for label/control pairing. */
export function uid(prefix = 'jm'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Toggles a class name. */
export function setClass(el: Element, name: string, on: boolean): void {
  el.classList.toggle(name, on);
}

/**
 * Runs `render` while remembering which element had focus (by `data-focus-key`) and restores it afterwards, so a
 * full re-render keeps keyboard users where they were. Textarea/input selections are restored as well.
 */
export function preserveFocus(root: ParentNode, render: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active?.dataset?.focusKey;
  let selection: { start: number; end: number } | null = null;
  if (active && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && typeof active.selectionStart === 'number') {
    selection = { start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 };
  }
  render();
  if (!key) return;
  const next = root.querySelector<HTMLElement>(`[data-focus-key="${cssEscape(key)}"]`);
  if (!next || next === document.activeElement) return;
  try {
    next.focus({ preventScroll: true });
    if (selection && (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement)) {
      next.setSelectionRange(selection.start, selection.end);
    }
  } catch {
    // Element may not be focusable any more; nothing to restore.
  }
}

/** CSS.escape with a fallback for environments without it. */
export function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/["\\\]\[#.:>+~*^$|()=\s]/g, (c) => `\\${c}`);
}

/** True when the event target is a control that consumes typing (so page-level shortcuts stay out of the way). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
