/**
 * Small helpers shared by the controller modules: injectable timers (so vitest fake timers and tests can drive
 * everything deterministically), range arithmetic, NBSP-tolerant text comparison, a CSS-path-ish stable field
 * selector and the docKey derivation (ARCHITECTURE §3.6).
 */
import type { TextRange } from '@jammarly/shared/types';
import { hashText, splitSentences } from '@jammarly/shared/text';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Epoch milliseconds. */
  now(): number;
  /** Schedule `fn` for the next paint (or idle period); falls back to a short timeout. */
  requestFrame(fn: () => void): unknown;
  cancelFrame(handle: unknown): void;
}

type FrameHandle = { kind: 'raf' | 'ric' | 'timeout'; id: unknown };

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
  requestFrame: (fn): FrameHandle => {
    const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; requestAnimationFrame?: (cb: () => void) => number };
    if (typeof g.requestIdleCallback === 'function') return { kind: 'ric', id: g.requestIdleCallback(() => fn(), { timeout: 150 }) };
    if (typeof g.requestAnimationFrame === 'function') return { kind: 'raf', id: g.requestAnimationFrame(() => fn()) };
    return { kind: 'timeout', id: setTimeout(fn, 16) };
  },
  cancelFrame: (handle) => {
    const h = handle as FrameHandle | null | undefined;
    if (!h) return;
    const g = globalThis as { cancelIdleCallback?: (id: number) => void; cancelAnimationFrame?: (id: number) => void };
    if (h.kind === 'ric' && typeof g.cancelIdleCallback === 'function') g.cancelIdleCallback(h.id as number);
    else if (h.kind === 'raf' && typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(h.id as number);
    else if (h.kind === 'timeout') clearTimeout(h.id as ReturnType<typeof setTimeout>);
  },
};

/** Half-open intersection; a zero-width range strictly inside the other also intersects (an insertion point in the middle). */
export function rangesIntersect(a: TextRange, b: TextRange): boolean {
  if (a.start < b.end && b.start < a.end) return true;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return false;
}

/** `[inner]` lies inside `[outer]` (inclusive bounds). */
export function rangeContains(outer: TextRange, inner: TextRange): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function normalizeNbsp(s: string): string {
  return s.replace(/ /g, ' ');
}

/** NBSP-tolerant equality: editors turn preserved spaces into U+00A0 and back. */
export function sameText(a: string, b: string): boolean {
  return a === b || normalizeNbsp(a) === normalizeNbsp(b);
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** The sentence range containing `range.start` (or the last sentence before it), else null. */
export function sentenceContaining(text: string, range: TextRange): TextRange | null {
  const sentences = splitSentences(text);
  let best: TextRange | null = null;
  for (const s of sentences) {
    if (s.start > range.start) break;
    best = s;
    if (range.start < s.end || (range.start === s.end && range.end === s.end)) return s;
  }
  return best;
}

/** Random, URL-safe token (crypto when available). */
export function randomToken(bytes = 8): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  let out = '';
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    const arr = g.crypto.getRandomValues(new Uint8Array(bytes));
    for (const b of arr) out += b.toString(16).padStart(2, '0');
    return out;
  }
  for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

const RANDOM_ID_RE = /\d{4,}|[A-Za-z0-9]*[0-9][A-Za-z0-9]*[0-9][A-Za-z0-9]*[0-9]|^:/;

/** True for ids that look generated per page load (long digit runs, ember/react style ids) and therefore unstable. */
export function looksGeneratedId(id: string): boolean {
  return id.length === 0 || id.length > 40 || RANDOM_ID_RE.test(id);
}

/**
 * A CSS-path-ish selector for a field that stays the same across page loads: a stable `id` or `name` on the field
 * or its nearest ancestor, else tag + nth-of-type steps up to the body (at most 8 steps).
 */
export function fieldPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 8) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
      parts.unshift(tag);
      break;
    }
    const id = node.getAttribute('id') ?? '';
    if (id && !looksGeneratedId(id)) {
      parts.unshift(`${tag}#${id}`);
      break;
    }
    const name = node.getAttribute('name') ?? '';
    if (name && !looksGeneratedId(name) && depth === 0) {
      parts.unshift(`${tag}[name=${name}]`);
      break;
    }
    const parent: Element | null = node.parentElement;
    let step = tag;
    if (parent) {
      let index = 1;
      for (const sib of Array.from(parent.children)) {
        if (sib === node) break;
        if (sib.tagName === node.tagName) index++;
      }
      step = `${tag}:nth-of-type(${index})`;
    }
    parts.unshift(step);
    node = parent;
    depth++;
  }
  return parts.join('>');
}

/**
 * docKey = hash(userSalt ‖ origin ‖ fieldPath ‖ docHint), 16 lowercase hex chars (hashText applied twice, the
 * second pass over the first digest plus the input, as a cheap stand-in for sha256 in content scripts).
 */
export function computeDocKey(userSalt: string, origin: string, path: string, docHint: string): string {
  const input = `${userSalt}\u001f${origin}\u001f${path}\u001f${docHint}`;
  return hashText(hashText(input) + '\u001f' + input);
}

/** Extension version from the build define, else the manifest, else "0.0.0". Safe under vitest. */
export function extensionVersion(): string {
  try {
    if (typeof __JAMMARLY_VERSION__ === 'string' && __JAMMARLY_VERSION__.length > 0) return __JAMMARLY_VERSION__;
  } catch {
    // not defined
  }
  try {
    const g = globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: unknown } } } };
    const v = g.chrome?.runtime?.getManifest?.()?.version;
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    // no runtime
  }
  return '0.0.0';
}

export interface RuntimeLike {
  readonly id?: string;
  connect(info: { name: string }): PortLike;
  sendMessage?(msg: unknown): Promise<unknown> | void;
  getManifest?(): { version?: string };
}

export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void; removeListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void; removeListener(fn: () => void): void };
}

/** `chrome.runtime`, or undefined when the extension context is gone (reading it may throw). */
export function safeRuntime(): RuntimeLike | undefined {
  try {
    const g = globalThis as { chrome?: { runtime?: RuntimeLike } };
    const rt = g.chrome?.runtime;
    if (!rt || !rt.id) return undefined;
    return rt;
  } catch {
    return undefined;
  }
}

export function countWordsIn(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(token)) n++;
  return n;
}
