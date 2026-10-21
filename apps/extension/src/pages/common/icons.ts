/**
 * Inline SVG icons (24x24 stroke paths) built with createElementNS, so no HTML strings are ever parsed.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'check'
  | 'x'
  | 'trash'
  | 'chevron-down'
  | 'chevron-right'
  | 'undo'
  | 'settings'
  | 'copy'
  | 'target'
  | 'refresh'
  | 'more'
  | 'book'
  | 'info'
  | 'alert'
  | 'spinner'
  | 'external'
  | 'plus'
  | 'power'
  | 'panel'
  | 'sparkle'
  | 'download'
  | 'upload';

const PATHS: Record<IconName, string[]> = {
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  target: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  more: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  spinner: ['M21 12a9 9 0 1 1-6.2-8.6'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'],
  plus: ['M12 5v14', 'M5 12h14'],
  power: ['M18.4 6.6a9 9 0 1 1-12.8 0', 'M12 2v10'],
  panel: ['M3 3h18v18H3z', 'M15 3v18'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
};

/** Builds an icon element. Decorative by default (`aria-hidden`); pass `label` to expose it. */
export function icon(name: IconName, opts: { size?: number; label?: string; class?: string } = {}): SVGSVGElement {
  const size = opts.size ?? 16;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `jm-icon jm-icon-${name}${opts.class ? ` ${opts.class}` : ''}`);
  if (opts.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** The brand mark: a rounded square with the brand color and a white "J" built from strokes. */
export function brandMark(size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'jm-brand-mark');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '1');
  rect.setAttribute('y', '1');
  rect.setAttribute('width', '22');
  rect.setAttribute('height', '22');
  rect.setAttribute('rx', '6');
  rect.setAttribute('fill', 'var(--jm-brand)');
  svg.appendChild(rect);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M14.5 6v8.2a3.3 3.3 0 0 1-6.5.8');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '2.4');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

/** Score ring: a circular progress indicator with the number in the middle (SVG + text node). */
export function scoreRing(value: number | null, size = 44): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'jm-score-ring';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', value === null ? 'No score yet' : `Score ${value} out of 100`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const r = 15.5;
  const circumference = 2 * Math.PI * r;
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', '18');
  track.setAttribute('cy', '18');
  track.setAttribute('r', String(r));
  track.setAttribute('class', 'jm-score-track');
  svg.appendChild(track);
  if (value !== null) {
    const bar = document.createElementNS(SVG_NS, 'circle');
    bar.setAttribute('cx', '18');
    bar.setAttribute('cy', '18');
    bar.setAttribute('r', String(r));
    bar.setAttribute('class', `jm-score-bar ${value >= 90 ? 'is-good' : value >= 70 ? 'is-ok' : 'is-low'}`);
    bar.setAttribute('stroke-dasharray', `${(Math.max(0, Math.min(100, value)) / 100) * circumference} ${circumference}`);
    bar.setAttribute('transform', 'rotate(-90 18 18)');
    svg.appendChild(bar);
  }
  wrap.appendChild(svg);
  const label = document.createElement('span');
  label.className = 'jm-score-value';
  label.textContent = value === null ? '–' : String(value);
  wrap.appendChild(label);
  return wrap;
}
