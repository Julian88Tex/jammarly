/**
 * Trusted-Types-safe DOM helpers for the overlay UI.
 *
 * Every element is built with `createElement` / `createElementNS` and text goes through `textContent`, so the
 * module never touches an HTML-string sink (Gmail and other Google properties enforce Trusted Types; the e2e and
 * unit suites grep this directory for the forbidden sinks). Icons are inline SVG paths (24 x 24 viewBox).
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export type AttrValue = string | number | boolean | null | undefined | ((ev: Event) => void) | Record<string, string>;

export type Attrs = Record<string, AttrValue>;

/**
 * h('button', { class: 'jm-accept', 'aria-label': 'Accept', onclick: fn }, 'Accept')
 *
 * Special keys: `class`/`className`, `style` (string or kebab-case property map), `dataset` (map), `text`
 * (textContent), and `on<event>` functions (added with addEventListener). Boolean `true` sets an empty attribute,
 * `false`/`null`/`undefined` skip it.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el: HTMLElement | SVGElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') {
      if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (key === 'class' || key === 'className') {
      el.setAttribute('class', String(value));
      continue;
    }
    if (key === 'style') {
      if (typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
      } else {
        el.style.cssText = String(value);
      }
      continue;
    }
    if (key === 'dataset' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) (el as HTMLElement).dataset[prop] = v;
      continue;
    }
    if (key === 'text') {
      el.textContent = String(value);
      continue;
    }
    if (typeof value === 'object') continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

/** Append children (strings become text nodes; nested arrays are flattened; null/false are skipped). */
export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else {
      parent.appendChild(child);
    }
  }
}

/** Remove every child of `el`. */
export function clear(el: Element): void {
  if (typeof el.replaceChildren === 'function') {
    el.replaceChildren();
    return;
  }
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace the children of `el` with `children`. */
export function setChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/**
 * Interactive overlay elements stop pointerdown/mousedown/click from reaching the page, so host dialogs
 * (Radix, Headless UI, Melt) do not treat them as outside clicks and close.
 */
export function isolatePointerEvents(el: HTMLElement): void {
  for (const type of ['pointerdown', 'mousedown', 'click', 'pointerup', 'mouseup', 'dblclick', 'contextmenu']) {
    el.addEventListener(type, (ev) => ev.stopPropagation());
  }
}

/**
 * Buttons that act on the host field keep its selection: preventing the default of mousedown stops the field from
 * blurring (the click still fires). Elements that need focus (the card root) do not use this.
 */
export function keepHostSelection(el: HTMLElement): void {
  el.addEventListener('mousedown', (ev) => ev.preventDefault());
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export type IconName =
  | 'close'
  | 'trash'
  | 'book'
  | 'more'
  | 'check'
  | 'key'
  | 'hourglass'
  | 'wallet'
  | 'wifi-off'
  | 'warning'
  | 'slash'
  | 'power'
  | 'undo'
  | 'spinner'
  | 'dot'
  | 'j';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Path data per icon (stroke-based, 24 x 24, inspired by the Lucide set's geometry). */
const ICON_PATHS: Record<IconName, string[]> = {
  close: ['M6 6 18 18', 'M18 6 6 18'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  check: ['M5 12.5 10 17.5 19 7'],
  key: ['M15.5 7.5 19 4', 'M21 2l-2 2', 'M8.5 15.5a5 5 0 1 0 7-7 5 5 0 0 0-7 7z', 'M7 17l-4 4', 'M8.5 15.5 7 17'],
  hourglass: ['M6 2h12', 'M6 22h12', 'M7 2v4l5 6-5 6v4', 'M17 2v4l-5 6 5 6v4'],
  wallet: ['M20 7H5a2 2 0 0 1 0-4h13v4', 'M3 5v14a2 2 0 0 0 2 2h15V7', 'M16 14h.01'],
  'wifi-off': ['M2 2l20 20', 'M8.5 16.5a5 5 0 0 1 7 0', 'M2 8.8a15 15 0 0 1 4.2-2.6', 'M10.7 5.1A15 15 0 0 1 22 8.8', 'M16.7 12.7A10 10 0 0 0 12 11.5', 'M5 12.9a10 10 0 0 1 2.7-1.8', 'M12 20h.01'],
  warning: ['M12 3 2 21h20L12 3z', 'M12 10v4', 'M12 18h.01'],
  slash: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M5.6 5.6 18.4 18.4'],
  power: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.8 0'],
  undo: ['M3 7v6h6', 'M3 13a9 9 0 1 0 3-7.3L3 13'],
  spinner: ['M12 3a9 9 0 0 1 9 9'],
  dot: ['M12 12h.01'],
  j: ['M14.5 5v9.5a3.5 3.5 0 0 1-7 0V13'],
};

/** Build a stroke icon as inline SVG (currentColor), sized in CSS pixels. */
export function svgIcon(name: IconName, size = 16, extraClass = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'dot' || name === 'more' ? '4' : '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `jm-icon jm-icon-${name}${extraClass ? ' ' + extraClass : ''}`);
  svg.dataset.icon = name;
  const paths = ICON_PATHS[name];
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** A category dot (filled circle in the category color via CSS). */
export function categoryDot(category: string): HTMLSpanElement {
  const dot = h('span', { class: 'jm-dot', 'aria-hidden': 'true' });
  dot.dataset.category = category;
  return dot;
}

/** Generates ids unique within the overlay for aria relationships. */
let idCounter = 0;
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

/** Visible, enabled, focusable descendants of `root` (ignores subtrees hidden with the `hidden` attribute). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]'));
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('tabindex') === '-1') return false;
    if (el.closest('[hidden]')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  });
}
