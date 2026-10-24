/**
 * Word tokens over the masked working copy, shared by the word- and phrase-level rules so the text is scanned once
 * per run. A token is a run of letters/digits with inner apostrophes ("don't", "it’s"); hyphens, punctuation,
 * whitespace and mask placeholders separate tokens. Everything is computed lazily and cached per RuleContext.
 */
import type { RuleContext } from './context';
import { isUpper } from './context';
import { articleFor } from './article';

export interface Token {
  start: number;
  end: number;
  /** Text as written (from the working copy). */
  text: string;
  /** Lower-cased, curly apostrophes folded to straight ones. */
  norm: string;
}

export interface TokenStream {
  list: Token[];
  /**
   * gap[i] describes the characters between token i-1 and token i: 1 = only spaces (no line break), 2 = exactly one
   * hyphen, 0 = anything else (punctuation, line break, mask, start of text).
   */
  gap: Uint8Array;
  /** Quoted ranges (inside "…" or “…” on one line), sorted. */
  quoted: { start: number; end: number }[];
}

/** Shared word-shape tests (compiled once; none is global, so sharing them is safe). */
export const LOWER_WORD_RE = /^\p{Ll}+$/u;
export const DIGITS_RE = /^\d+$/;
export const LY_RE = /ly$/;

export const GAP_OTHER = 0;
export const GAP_SPACE = 1;
export const GAP_HYPHEN = 2;

const LETTER_RE = /^\p{L}$/u;
const WORD_RE = /^[\p{L}\p{N}]$/u;

/** Length (0, 1 or 2 code units) of the letter or digit at i; ASCII fast path, Unicode classes otherwise. */
function wordLen(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0;
  if (c >= 0xd800 && c <= 0xdbff) return WORD_RE.test(s.slice(i, i + 2)) ? 2 : 0;
  return c === c && WORD_RE.test(s.charAt(i)) ? 1 : 0;
}
function letterLen(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 128) return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0;
  if (c >= 0xd800 && c <= 0xdbff) return LETTER_RE.test(s.slice(i, i + 2)) ? 2 : 0;
  return c === c && LETTER_RE.test(s.charAt(i)) ? 1 : 0;
}

const CURLY_APOS_RE = /’/g;
const SPACE_ONLY_RE = /^[   ]+$/;

const cache = new WeakMap<RuleContext, TokenStream>();

function quotedRanges(work: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open = -1;
  let straightOpen = -1;
  for (let i = 0; i < work.length; i++) {
    const ch = work.charCodeAt(i);
    if (ch === 10 || ch === 13) {
      open = -1;
      straightOpen = -1;
    } else if (ch === 0x201c) {
      open = i;
    } else if (ch === 0x201d) {
      if (open >= 0) out.push({ start: open, end: i + 1 });
      open = -1;
    } else if (ch === 34) {
      if (straightOpen >= 0) {
        out.push({ start: straightOpen, end: i + 1 });
        straightOpen = -1;
      } else {
        straightOpen = i;
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function tokensOf(ctx: RuleContext): TokenStream {
  const hit = cache.get(ctx);
  if (hit !== undefined) return hit;
  const { work } = ctx;
  const list: Token[] = [];
  const n = work.length;
  let i = 0;
  while (i < n) {
    let w = wordLen(work, i);
    if (w === 0) {
      i++;
      continue;
    }
    const start = i;
    while (w > 0) {
      i += w;
      w = wordLen(work, i);
    }
    // Inner apostrophes followed by letters continue the word ("don't", "it’s", "rock'n'roll").
    for (;;) {
      const c = work.charCodeAt(i);
      if (!(c === 39 || c === 0x2019)) break;
      let l = letterLen(work, i + 1);
      if (l === 0) break;
      i += 1;
      while (l > 0) {
        i += l;
        l = letterLen(work, i);
      }
    }
    const text = work.slice(start, i);
    const lower = text.toLowerCase();
    list.push({ start, end: i, text, norm: lower.includes('’') ? lower.replace(CURLY_APOS_RE, "'") : lower });
  }
  const gap = new Uint8Array(list.length);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1] as Token;
    const b = list[i] as Token;
    const between = b.start - a.end;
    if (between === 1) {
      const c = work.charCodeAt(a.end);
      gap[i] = c === 32 || c === 0xa0 || c === 0x202f ? GAP_SPACE : c === 45 ? GAP_HYPHEN : GAP_OTHER;
    } else if (between > 1 && between < 16 && SPACE_ONLY_RE.test(work.slice(a.end, b.start))) {
      gap[i] = GAP_SPACE;
    }
  }
  const stream: TokenStream = { list, gap, quoted: quotedRanges(work) };
  cache.set(ctx, stream);
  return stream;
}

/** True when [start, end) lies inside a quotation on one line. */
export function inQuotes(ts: TokenStream, start: number, end: number): boolean {
  const q = ts.quoted;
  let lo = 0;
  let hi = q.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const r = q[mid];
    if (r !== undefined && r.start < start) lo = mid + 1;
    else hi = mid;
  }
  const r = q[lo - 1];
  return r !== undefined && end <= r.end;
}

/** Token i+k when it is joined to token i+k-1 by spaces only (a phrase continues), else undefined. */
export function nextSpaced(ts: TokenStream, i: number): Token | undefined {
  return ts.gap[i + 1] === GAP_SPACE ? ts.list[i + 1] : undefined;
}

/** Token i-1 when it is joined to token i by spaces only, else undefined. */
export function prevSpaced(ts: TokenStream, i: number): Token | undefined {
  return ts.gap[i] === GAP_SPACE ? ts.list[i - 1] : undefined;
}

/** The character right after `end` and right before `start` in the working copy ('' at the edges). */
export function charAfter(ctx: RuleContext, end: number): string {
  return ctx.work.charAt(end);
}
export function charBefore(ctx: RuleContext, start: number): string {
  return start > 0 ? ctx.work.charAt(start - 1) : '';
}

const CODEY_NEIGHBOUR_RE = /[_@#$/\\=<>{}[\]|~^`*+]/;
const HAS_DIGIT_RE = /\p{N}/u;
const INNER_CAPITAL_RE = /.\p{Lu}/u;
const WORDISH_RE = /[\p{L}\p{N}]/u;

/**
 * True when the token reads as an identifier, path, tag or code fragment: an underscore, sigil, slash or operator
 * glued to it, a dot glued on both sides ("obj.recieve"), a digit inside it, or inner capitals (camelCase).
 */
export function looksLikeCode(ctx: RuleContext, t: Token): boolean {
  const before = charBefore(ctx, t.start);
  const after = charAfter(ctx, t.end);
  if (before !== '' && CODEY_NEIGHBOUR_RE.test(before)) return true;
  if (after !== '' && (CODEY_NEIGHBOUR_RE.test(after) || after === '(')) return true;
  if (before === '.' && t.start >= 2 && WORDISH_RE.test(ctx.work.charAt(t.start - 2))) return true;
  if (after === '.' && WORDISH_RE.test(ctx.work.charAt(t.end + 1))) return true;
  if (HAS_DIGIT_RE.test(t.text)) return true;
  return INNER_CAPITAL_RE.test(t.text) && !isAllCaps(t.text);
}

export function isAllCaps(s: string): boolean {
  return s.length > 1 && s === s.toUpperCase() && s !== s.toLowerCase();
}

/**
 * Applies the case shape of `like` to `replacement`: ALL CAPS stays all caps (for words of 2+ letters), a capital
 * first letter is kept, otherwise the replacement is returned as written (so "i'm" style fixes keep their capital).
 */
export function casePreserve(replacement: string, like: string): string {
  if (isAllCaps(like) && like.length > 1) return replacement.toUpperCase();
  if (isUpper(like.charAt(0))) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** The apostrophe this document uses: the style decision, else the majority in the text, else a straight one. */
export function apostropheOf(ctx: RuleContext): string {
  const decision = ctx.opts.styleDecisions['quotes'];
  if (decision === 'curly') return '’';
  if (decision === 'straight') return "'";
  let curly = 0;
  let straight = 0;
  const w = ctx.work;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (c === 0x2019) curly++;
    else if (c === 39) straight++;
  }
  return curly > straight ? '’' : "'";
}

/** Replaces straight apostrophes in `s` with the document's apostrophe. */
export function withApostrophe(s: string, apos: string): string {
  return apos === "'" ? s : s.replace(/'/g, apos);
}

/** True while typing when the decision depends on text that reaches into the word in progress. */
export function lookaheadUnfinished(ctx: RuleContext, end: number): boolean {
  return ctx.opts.typing && end > ctx.lastWordStart;
}

/**
 * When the phrase starting at token `i` is preceded by "a"/"an" and the replacement starts with a different sound,
 * returns the widened span and replacement ("a very easy" -> "an effortless"); otherwise the original span.
 */
export function withArticle(ts: TokenStream, i: number, start: number, replacement: string): { start: number; replacement: string } {
  const prev = prevSpaced(ts, i);
  if (prev === undefined || (prev.norm !== 'a' && prev.norm !== 'an')) return { start, replacement };
  const first = /^[\p{L}\p{N}]+/u.exec(replacement)?.[0] ?? '';
  if (first.length === 0) return { start, replacement };
  const want = articleFor(first);
  if (want === null || want === prev.norm) return { start, replacement };
  const article = isUpper(prev.text.charAt(0)) ? want.charAt(0).toUpperCase() + want.slice(1) : want;
  const rest = isUpper(prev.text.charAt(0)) && replacement.length > 0 ? replacement.charAt(0).toLowerCase() + replacement.slice(1) : replacement;
  return { start: prev.start, replacement: `${article} ${rest}` };
}
