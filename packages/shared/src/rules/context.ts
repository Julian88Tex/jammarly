/**
 * Shared machinery for the rule functions: the masked working copy, character classes, the
 * sentence-start test, the typing guard and the hit collector.
 */
import type { TextRange } from '../types';
import { isLikelyCode, splitParagraphs } from '../text';
import type { HitInput, RuleHit, RuleOptions } from './types';
import { RULE_TITLES } from './titles';

/**
 * Character that replaces every masked code unit in the working copy. It is neither a letter, a
 * digit, whitespace nor punctuation, so no rule can be fooled into reading across a mask.
 */
export const PLACEHOLDER = '￼';

export const MAX_EXPLANATION = 140;

const WS_RE = /\s/;
const LETTER_RE = /\p{L}/u;
const UPPER_RE = /\p{Lu}/u;
const LOWER_RE = /\p{Ll}/u;
const DIGIT_RE = /\p{Nd}/u;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

export function isWs(ch: string): boolean {
  return ch !== '' && WS_RE.test(ch);
}
export function isLetter(ch: string): boolean {
  return ch !== '' && LETTER_RE.test(ch);
}
export function isUpper(ch: string): boolean {
  return ch !== '' && UPPER_RE.test(ch);
}
export function isLower(ch: string): boolean {
  return ch !== '' && LOWER_RE.test(ch);
}
export function isDigit(ch: string): boolean {
  return ch !== '' && DIGIT_RE.test(ch);
}
export function isWordChar(ch: string): boolean {
  return ch !== '' && WORD_CHAR_RE.test(ch);
}

/** Closing quotes and brackets that may sit between a terminator and the following whitespace. */
export const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»']);
export const OPENERS = new Set(['"', "'", '“', '‘', '(', '[', '{', '«']);

/**
 * Abbreviations after which a period does not end a sentence (lower-cased, without the period).
 * Mirrors the list in ../text.ts (not exported there) plus a few business/tech ones.
 */
export const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
  'approx', 'dept', 'est', 'gen', 'gov', 'govt', 'sen', 'rep', 'col', 'capt', 'lt', 'sgt', 'ave', 'blvd', 'rd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'al', 'cf', 'ca', 'misc', 'resp', 'tel', 'ext', 'min', 'max', 'avg', 'univ', 'assn', 'bros', 'mfg', 'intl',
  'eg', 'ie', 'am', 'pm',
  // AP-style US state and Canadian province abbreviations that are not ordinary English words.
  'ala', 'ariz', 'ark', 'calif', 'colo', 'conn', 'del', 'fla', 'ga', 'kan', 'ky', 'mass', 'md', 'mich', 'minn', 'mo',
  'mont', 'neb', 'nev', 'okla', 'pa', 'penn', 'tenn', 'tex', 'va', 'vt', 'wis', 'wyo', 'ont', 'que', 'sask', 'nfld',
]);
/** Abbreviations that only count when a number follows ("No. 5", "Fig. 2", "p. 12"). */
export const NUMERIC_ABBREVIATIONS = new Set(['no', 'nos', 'vol', 'vols', 'pp', 'p', 'ch', 'fig', 'figs', 'sec', 'art', 'para', 'ver', 'ed', 'eds']);

/**
 * True when the text ending at `periodIdx` (exclusive) is an abbreviation or initial, so a period
 * there does not end a sentence: single capital letters ("J. K."), dotted abbreviations whose
 * segments are 1–2 letters ("e.g.", "U.S."), the ABBREVIATIONS list, and bare numbers ("3.").
 */
export function isAbbreviationBefore(s: string, periodIdx: number, nextCh = ''): boolean {
  let k = periodIdx;
  while (k > 0) {
    const ch = s.charAt(k - 1);
    if (ch === '.' || isLetter(ch) || isDigit(ch)) k--;
    else break;
  }
  const word = s.slice(k, periodIdx);
  if (word.length === 0) return false;
  if (/^\p{N}+$/u.test(word)) return true;
  if (word.length === 1 && isUpper(word)) return true;
  if (word.includes('.')) {
    const segments = word.split('.');
    if (segments.every((seg) => seg.length >= 1 && seg.length <= 2)) return true;
  }
  const lower = word.toLowerCase();
  if (ABBREVIATIONS.has(lower)) return true;
  return NUMERIC_ABBREVIATIONS.has(lower) && isDigit(nextCh);
}

/**
 * A one-line statement: keyword at the start, brace or semicolon at the end ("if (a == b) { return x; }").
 * Leading/trailing whitespace is matched with [ \t]*, never \s*: under the m flag "^\s*keyword" re-scans every
 * run of blank lines from each line start (quadratic on whitespace-heavy text, seconds on a 50 KB paste).
 */
const CODE_LINE_RE = /^[ \t]*(?:if|else|for|while|switch|case|const|let|var|function|return|import|export|def|class|try|catch|finally|async|await|public|private|static)\b[^\n]*[{};][ \t]*$/;
/** Code-ish markers that make a paragraph worth the (comparatively costly) isLikelyCode call. */
const CODE_HINT_RE = /[{}]|;[ \t]*$|=>|==|!=|\(\)|\[\]|<\/|\$\{|^[ \t]*(?:import|export|const|let|var|def|class|function|return|if|for|while)\b|\b(?:function|return|const|let)\b/m;

export interface RuleContext {
  /** The text exactly as passed to runRules. */
  readonly text: string;
  /** Same length as `text`; masked ranges and code paragraphs are PLACEHOLDER-filled. */
  readonly work: string;
  readonly opts: RuleOptions;
  /** Lower-cased protected terms. */
  readonly protectedTerms: ReadonlySet<string>;
  /** Start of the word in progress while typing; `text.length` when nothing is in progress. */
  readonly lastWordStart: number;
  /** Union of opts.masked and detected code paragraphs, sorted and non-overlapping. */
  readonly blocked: readonly TextRange[];
  /** True when the range [start, end) touches a blocked range. */
  isBlocked(start: number, end: number): boolean;
  /**
   * True when `idx` is the first non-whitespace position of a sentence: the text start, or after
   * `.`/`!`/`?` (optionally followed by closing quotes/brackets) and whitespace. An ellipsis or an
   * abbreviation before the period does not start a sentence. `afterNewline` says whether a line
   * break alone counts.
   */
  isSentenceStart(idx: number, afterNewline?: boolean): boolean;
  /** True while typing when [start, end) touches the word in progress. */
  touchesWordInProgress(start: number, end: number): boolean;
  emit(hit: HitInput): void;
  /** Hits collected so far (not yet filtered). */
  readonly hits: RuleHit[];
}

function clampRange(r: TextRange, n: number): TextRange | null {
  const start = Math.max(0, Math.floor(r.start));
  const end = Math.min(n, Math.floor(r.end));
  return end > start ? { start, end } : null;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TextRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last !== undefined && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/** Detects paragraphs that read as code so rules never run on them. */
function codeParagraphRanges(text: string): TextRange[] {
  const out: TextRange[] = [];
  if (!CODE_HINT_RE.test(text)) return out;
  for (const p of splitParagraphs(text)) {
    if (p.text.trim().length < 6) continue;
    if (!CODE_HINT_RE.test(p.text)) continue;
    if (CODE_LINE_RE.test(p.text) || isLikelyCode(p.text)) out.push({ start: p.start, end: p.start + p.text.length });
  }
  return out;
}

function maskText(text: string, blocked: readonly TextRange[]): string {
  if (blocked.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const r of blocked) {
    parts.push(text.slice(cursor, r.start), PLACEHOLDER.repeat(r.end - r.start));
    cursor = r.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

const TRAILING_COMPLETE_RE = /[\s\p{P}\p{S}]$/u;

/** Offset of the word in progress, or text.length when the text ends in whitespace/punctuation. */
export function wordInProgressStart(text: string, typing: boolean): number {
  const n = text.length;
  if (!typing || n === 0 || TRAILING_COMPLETE_RE.test(text)) return n;
  let k = n;
  while (k > 0 && !isWs(text.charAt(k - 1))) k--;
  return k;
}

export function createContext(text: string, opts: RuleOptions): RuleContext {
  const n = text.length;
  const ranges: TextRange[] = [];
  for (const r of opts.masked) {
    const c = clampRange(r, n);
    if (c !== null) ranges.push(c);
  }
  ranges.push(...codeParagraphRanges(text));
  const blocked = mergeRanges(ranges);
  const work = maskText(text, blocked);
  const protectedTerms = new Set(opts.protectedTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0));
  const lastWordStart = wordInProgressStart(text, opts.typing);
  const hits: RuleHit[] = [];

  const isBlocked = (start: number, end: number): boolean => {
    // blocked is sorted: binary search for the first range ending after start.
    let lo = 0;
    let hi = blocked.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const r = blocked[mid];
      if (r !== undefined && r.end <= start) lo = mid + 1;
      else hi = mid;
    }
    const r = blocked[lo];
    return r !== undefined && r.start < end;
  };

  const isSentenceStart = (idx: number, afterNewline = false): boolean => {
    let k = idx;
    while (k > 0 && isWs(work.charAt(k - 1)) && work.charAt(k - 1) !== '\n' && work.charAt(k - 1) !== '\r') k--;
    if (k === 0) return true;
    const prev = work.charAt(k - 1);
    if (prev === '\n' || prev === '\r') return afterNewline;
    // Require at least one whitespace between the terminator and idx.
    if (k === idx) return false;
    let j = k;
    while (j > 0 && CLOSERS.has(work.charAt(j - 1))) j--;
    const term = work.charAt(j - 1);
    if (term !== '.' && term !== '!' && term !== '?') return false;
    let runStart = j - 1;
    while (runStart > 0 && (work.charAt(runStart - 1) === '.' || work.charAt(runStart - 1) === '!' || work.charAt(runStart - 1) === '?')) runStart--;
    const run = work.slice(runStart, j);
    if (run.includes('.') && run.length >= 2) return false; // ellipsis
    if (run === '.' && isAbbreviationBefore(work, runStart, work.charAt(idx))) return false;
    return true;
  };

  const touchesWordInProgress = (start: number, end: number): boolean => end > lastWordStart && start < n;

  const emit = (h: HitInput): void => {
    const { start, end } = h;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= n)) return;
    const original = text.slice(start, end);
    if (h.replacement === original) return;
    const key = h.key ?? h.rule;
    const title = RULE_TITLES[key] ?? RULE_TITLES[h.rule];
    if (title === undefined) return;
    hits.push({
      rule: h.rule,
      category: 'correctness',
      severity: h.severity,
      kind: h.kind,
      range: { start, end },
      original,
      replacement: h.replacement,
      title,
      explanation: h.explanation.length > MAX_EXPLANATION ? h.explanation.slice(0, MAX_EXPLANATION - 1) + '…' : h.explanation,
      confidence: Math.max(0, Math.min(1, h.confidence)),
      autoApplySafe: h.autoApplySafe,
      meaningPreserving: h.meaningPreserving ?? true,
    });
  };

  return { text, work, opts, protectedTerms, lastWordStart, blocked, isBlocked, isSentenceStart, touchesWordInProgress, emit, hits };
}

/** Applies the global guards (blocked ranges, typing), dedupes and sorts. */
export function finalizeHits(ctx: RuleContext): RuleHit[] {
  const seen = new Set<string>();
  const out: RuleHit[] = [];
  for (const h of ctx.hits) {
    if (ctx.isBlocked(h.range.start, h.range.end)) continue;
    if (ctx.opts.typing && ctx.touchesWordInProgress(h.range.start, h.range.end)) continue;
    const k = `${h.rule}|${h.range.start}|${h.range.end}|${h.replacement}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  out.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return out;
}

/** Capitalizes the first letter when `like` starts with an uppercase letter; lower-cases otherwise. */
export function matchCase(replacement: string, like: string): string {
  const first = like.charAt(0);
  if (isUpper(first)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}
