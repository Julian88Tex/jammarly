/**
 * Masking and the per-request user message of the suggestion call (02 §3.3, §8.2).
 *
 * Block text is never escaped. Anchoring locates the model's verbatim `original` in the REAL block text by
 * string search, so an escaped copy would make the model quote entities (`&lt;`) that do not exist in the field.
 * Instead the prompt copy of a block is *masked*: URLs, inline/fenced code, email addresses and @handles
 * (found with `stripUrlsAndCode`) and DOM-derived protected ranges are replaced by `⟦URL_n⟧`, `⟦CODE_n⟧`,
 * `⟦EMAIL_n⟧`, `⟦HANDLE_n⟧` and `⟦PROTECTED_n⟧` placeholders, C0 control characters (except tab, LF, CR) are
 * stripped, and any literal occurrence of a template tag such as `<block` or `</block>` is replaced by a
 * `⟦TAG_n⟧` placeholder so field text can never open or close one of our tags. The brackets ⟦ ⟧ are never
 * produced by keyboards; a suggestion whose `original` contains one is dropped by the anchoring step, and
 * `maskedRanges` (real-text coordinates, block-relative) lets it drop anything overlapping a masked span.
 *
 * Everything that is *not* block text (preferences, protected terms, muted rules) is data, is sanitized with
 * `sanitizePromptText` (control characters stripped, `<`/`>` replaced, length-capped) and is introduced as
 * preferences, never as instructions.
 */
import type { Audience, CheckRequest, Dialect, Domain, Formality, Intent, Paragraph, StyleDecisions, TextRange, WritingGoals } from '../types';
import { splitSentences, stripUrlsAndCode } from '../text';
import { SUGGESTION_SYSTEM_PROMPT } from './prompt-text';
import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN, sanitizeList, sanitizePromptText, stripControlChars } from './sanitize';

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------

/** Block id of a paragraph: "b<index>". */
export function blockIdFor(index: number): string {
  return `b${index}`;
}

/** Paragraph index of a block id, or undefined for anything that is not "b<non-negative integer>". */
export function parseBlockIndex(blockId: string): number | undefined {
  const m = /^b(\d{1,9})$/.exec(blockId);
  if (m === null || m[1] === undefined) return undefined;
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

export type MaskKind = 'URL' | 'CODE' | 'EMAIL' | 'HANDLE' | 'PROTECTED' | 'TAG';

export interface MaskedBlock {
  blockId: string;
  /** The real block text (what anchoring searches). */
  text: string;
  /** The prompt copy: placeholders instead of URLs/code/emails/handles/protected spans, control characters stripped. */
  masked: string;
  /** Spans of `text` that were replaced by placeholders, block-relative, ascending, non-overlapping. */
  maskedRanges: TextRange[];
}

export interface MaskResult {
  masked: string;
  maskedRanges: TextRange[];
}

interface Span extends TextRange {
  kind: MaskKind;
}

/** Template tag names whose literal appearance in field text is replaced by a ⟦TAG_n⟧ placeholder. */
const TAG_RE = /<\/?(?:block|document|context_before|context_after|style_decisions|protected_terms|custom_instructions|do_not_flag|user_voice_profile|text|example)\b/gi;

function classify(s: string): MaskKind {
  if (s.startsWith('`')) return 'CODE';
  if (s.startsWith('@')) return 'HANDLE';
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return 'EMAIL';
  return 'URL';
}

function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (s.kind === 'PROTECTED') last.kind = 'PROTECTED';
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * Builds the prompt copy of a piece of field text. `protectedRanges` are relative to `text`; ranges outside it
 * are clamped and empty ones ignored. Placeholders are numbered per kind in order of appearance.
 */
export function maskBlockText(text: string, protectedRanges: readonly TextRange[] = []): MaskResult {
  const spans: Span[] = [];
  for (const r of stripUrlsAndCode(text).masked) spans.push({ start: r.start, end: r.end, kind: classify(text.slice(r.start, r.end)) });
  for (const r of protectedRanges) {
    const start = Math.max(0, Math.min(text.length, Math.floor(r.start)));
    const end = Math.max(0, Math.min(text.length, Math.floor(r.end)));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) spans.push({ start, end, kind: 'PROTECTED' });
  }
  let merged = mergeSpans(spans);
  let tagged = false;
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (merged.some((s) => s.start < end && start < s.end)) continue;
    merged.push({ start, end, kind: 'TAG' });
    tagged = true;
  }
  if (tagged) merged = mergeSpans(merged);

  const counters: Record<MaskKind, number> = { URL: 0, CODE: 0, EMAIL: 0, HANDLE: 0, PROTECTED: 0, TAG: 0 };
  const parts: string[] = [];
  let cursor = 0;
  for (const s of merged) {
    parts.push(stripControlChars(text.slice(cursor, s.start)));
    counters[s.kind]++;
    parts.push(`${PLACEHOLDER_OPEN}${s.kind}_${counters[s.kind]}${PLACEHOLDER_CLOSE}`);
    cursor = s.end;
  }
  parts.push(stripControlChars(text.slice(cursor)));
  return { masked: parts.join(''), maskedRanges: merged.map((s) => ({ start: s.start, end: s.end })) };
}

/** Protected ranges of the request that intersect a paragraph, made paragraph-relative. */
function protectedWithin(req: CheckRequest, start: number, end: number): TextRange[] {
  const out: TextRange[] = [];
  for (const r of req.protectedRanges) {
    const s = Math.max(r.start, start);
    const e = Math.min(r.end, end);
    if (e > s) out.push({ start: s - start, end: e - start });
  }
  return out;
}

function maskParagraph(req: CheckRequest, p: Paragraph): MaskedBlock {
  const { masked, maskedRanges } = maskBlockText(p.text, protectedWithin(req, p.start, p.start + p.text.length));
  return { blockId: blockIdFor(p.index), text: p.text, masked, maskedRanges };
}

/**
 * Masks the requested blocks (ids "b<index>") of a request, in paragraph order, skipping ids that do not exist
 * and paragraphs that are whitespace-only. No cap on the count (see {@link buildCheckMessages} for sharding).
 */
export function maskRequestBlocks(req: CheckRequest, blockIds: readonly string[]): MaskedBlock[] {
  const wanted = new Set<number>();
  for (const id of blockIds) {
    const idx = parseBlockIndex(id);
    if (idx !== undefined) wanted.add(idx);
  }
  const paragraphs = [...req.blocks].sort((a, b) => a.index - b.index);
  const out: MaskedBlock[] = [];
  for (const p of paragraphs) {
    if (!wanted.has(p.index) || p.text.trim().length === 0) continue;
    out.push(maskParagraph(req, p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The user message
// ---------------------------------------------------------------------------

export const DEFAULT_GOALS: WritingGoals = { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' };
export const DEFAULT_DIALECT: Dialect = 'en-US';
/** Blocks per call by default: a whole email in one call (the worker shards longer fields by words). */
export const DEFAULT_MAX_BLOCKS_PER_REQUEST = 40;
export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 2000;
export const CUSTOM_INSTRUCTIONS_PREAMBLE = "The writer's own style profile. Make suggestions sound like this writer, never flag text for matching it, and apply it only where it does not conflict with the contract:";

const AUDIENCES: readonly Audience[] = ['general', 'knowledgeable', 'expert'];
const FORMALITIES: readonly Formality[] = ['informal', 'neutral', 'formal'];
const DOMAINS: readonly Domain[] = ['general', 'academic', 'business', 'email', 'casual', 'creative', 'technical'];
const INTENTS: readonly Intent[] = ['inform', 'describe', 'convince', 'tell_a_story'];
const DIALECTS: readonly Dialect[] = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'];

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
}

export interface CheckPromptOptions {
  /** Rendered `<user_voice_profile>` block (see renderVoiceBlock); omitted when empty. */
  voiceBlock?: string;
  /** Blocks per call (default 40); extra requested ids are left out so the caller can shard. */
  maxBlocksPerRequest?: number;
  goals?: WritingGoals;
  dialect?: Dialect;
  styleDecisions?: StyleDecisions;
  /** Dictionary and glossary terms that are spelled correctly by definition. */
  protectedTerms?: readonly string[];
  /** Owner-written preferences; embedded as data, <= 2000 characters. */
  customInstructions?: string;
  /** Rule ids the model should not emit (muted/suppressed for this host or context). */
  mutedRules?: readonly string[];
}

export interface CheckMessages {
  /** system[0] is the contract, system[1] the voice block when present; both carry cache_control. */
  system: SystemBlock[];
  user: string;
  /** The blocks that were actually included, in paragraph order. */
  blocks: MaskedBlock[];
}

function styleDecisionsText(decisions: StyleDecisions | undefined): string {
  if (decisions === undefined) return '';
  const items: string[] = [];
  for (const key of Object.keys(decisions).sort()) {
    const k = key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const v = sanitizePromptText(String(decisions[key] ?? ''), 60).replace(/[;=]/g, '');
    if (k.length === 0 || v.length === 0) continue;
    items.push(`${k}=${v}`);
    if (items.length >= 40) break;
  }
  return items.join('; ');
}

/** Code-point order, so the rendered list does not depend on the (set-valued, unordered) input order. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ruleIdList(rules: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rules ?? []) {
    if (typeof r !== 'string') continue;
    const id = r.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 64) break;
  }
  return out.sort(byCodePoint);
}

/** Masks the sentence of a paragraph at `range` (paragraph-relative) with the request's protected ranges. */
function maskSentence(req: CheckRequest, p: Paragraph, range: TextRange): string {
  const absStart = p.start + range.start;
  const absEnd = p.start + range.end;
  return maskBlockText(p.text.slice(range.start, range.end), protectedWithin(req, absStart, absEnd)).masked;
}

function nearestParagraph(paragraphs: readonly Paragraph[], from: number, direction: -1 | 1): Paragraph | undefined {
  for (let i = from + direction; i >= 0 && i < paragraphs.length; i += direction) {
    const p = paragraphs[i];
    if (p !== undefined && p.text.trim().length > 0) return p;
  }
  return undefined;
}

/**
 * Builds the system blocks and the user message for one suggestion call (02 §8.2 template plus the
 * `<custom_instructions>` and `<do_not_flag>` elements). `blockIds` names the dirty blocks to send ("b<index>");
 * at most `maxBlocksPerRequest` (default 40) of them, in paragraph order, are included and returned in `blocks`.
 * One read-only sentence of context precedes the first and follows the last included block. The user turn is
 * deterministic: style decisions, protected terms and muted rules are rendered in sorted order.
 */
export function buildCheckMessages(req: CheckRequest, blockIds: readonly string[], opts: CheckPromptOptions = {}): CheckMessages {
  const max = Math.max(1, Math.floor(opts.maxBlocksPerRequest ?? DEFAULT_MAX_BLOCKS_PER_REQUEST));
  const blocks = maskRequestBlocks(req, blockIds).slice(0, max);

  const system: SystemBlock[] = [{ type: 'text', text: SUGGESTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (opts.voiceBlock !== undefined && opts.voiceBlock.length > 0) {
    system.push({ type: 'text', text: opts.voiceBlock, cache_control: { type: 'ephemeral' } });
  }

  const goals = opts.goals ?? DEFAULT_GOALS;
  const attrs = [
    `dialect="${pickEnum(opts.dialect, DIALECTS, DEFAULT_DIALECT)}"`,
    `audience="${pickEnum(goals.audience, AUDIENCES, DEFAULT_GOALS.audience)}"`,
    `formality="${pickEnum(goals.formality, FORMALITIES, DEFAULT_GOALS.formality)}"`,
    `domain="${pickEnum(goals.domain, DOMAINS, DEFAULT_GOALS.domain)}"`,
    `intent="${pickEnum(goals.intent, INTENTS, DEFAULT_GOALS.intent)}"`,
  ].join(' ');

  const lines: string[] = [`<document ${attrs}>`];
  lines.push(`<style_decisions>${styleDecisionsText(opts.styleDecisions)}</style_decisions>`);
  // Dictionary and muted rules are sets (no canonical order); sorting keeps the user turn byte-identical across
  // devices for the same cache key, which hashes the sorted protected terms (ARCHITECTURE §3.2).
  lines.push(`<protected_terms>${sanitizeList(opts.protectedTerms, 200, 60).sort(byCodePoint).join(', ')}</protected_terms>`);

  const custom = sanitizePromptText(opts.customInstructions ?? '', CUSTOM_INSTRUCTIONS_MAX_CHARS, { multiline: true });
  if (custom.length > 0) lines.push(`<custom_instructions>${CUSTOM_INSTRUCTIONS_PREAMBLE}\n${custom}</custom_instructions>`);

  const muted = ruleIdList(opts.mutedRules);
  if (muted.length > 0) lines.push(`<do_not_flag>${muted.join(', ')}</do_not_flag>`);

  const paragraphs = [...req.blocks].sort((a, b) => a.index - b.index);
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first !== undefined && last !== undefined) {
    const firstPos = paragraphs.findIndex((p) => blockIdFor(p.index) === first.blockId);
    const lastPos = paragraphs.findIndex((p) => blockIdFor(p.index) === last.blockId);
    const before = nearestParagraph(paragraphs, firstPos, -1);
    if (before !== undefined) {
      const sentences = splitSentences(before.text);
      const sentence = sentences[sentences.length - 1];
      if (sentence !== undefined) lines.push(`<context_before readonly="true">${maskSentence(req, before, sentence)}</context_before>`);
    }
    for (const b of blocks) lines.push(`<block id="${b.blockId}">${b.masked}</block>`);
    const after = nearestParagraph(paragraphs, lastPos, 1);
    if (after !== undefined) {
      const sentence = splitSentences(after.text)[0];
      if (sentence !== undefined) lines.push(`<context_after readonly="true">${maskSentence(req, after, sentence)}</context_after>`);
    }
  }
  lines.push('</document>');

  return { system, user: lines.join('\n'), blocks };
}
