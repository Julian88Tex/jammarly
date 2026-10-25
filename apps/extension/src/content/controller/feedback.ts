/**
 * Feedback events and voice samples (ARCHITECTURE §3.7, research 08 §8.1). The tracker turns UI and text events into
 * FeedbackEventInput records: `shown` once per suggestion id, `ignore` when the card closes without a decision after
 * ≥ 1.5 s, `accept` / `dismiss` / `add_to_dictionary` / `report_incorrect` with dwell time, `invalidated` for shown
 * suggestions the user typed over, `accepted_by_typing` / `self_corrected` when the span's context shows what the
 * user did within 60 s, and `edit_after_accept` (carrying `final`) when an applied span is edited within 60 s.
 * Snippets are redacted and capped and only attached when snippet storage is on and the field is not sensitive.
 * Events are batched: every 5 s or 20 events. Voice samples take only fully typed, completed sentences.
 */
import type { DismissReason, FeedbackEventInput, Suggestion, TextRange, VoiceContext, VoiceSample, WritingContext } from '@jammarly/shared/types';
import type { FeedbackKind, FeedbackVia } from '@jammarly/shared/learning';
import { countWords, hashText, splitSentences } from '@jammarly/shared/text';
import { redactSentence, redactSnippet, SENTENCE_MAX } from '@jammarly/shared/redact';
import type { TextModel } from './text-model';
import { rangesIntersect, realTimers, sameText, sentenceContaining, type Timers } from './util';

export const FLUSH_INTERVAL_MS = 5000;
export const FLUSH_BATCH = 20;
export const IGNORE_DWELL_MS = 1500;
export const TYPING_WINDOW_MS = 60_000;
export const VOICE_MIN_WORDS = 6;
export const VOICE_MAX_CHARS = SENTENCE_MAX;
export const CONTEXT_CHARS = 24;
const CONTEXT_SEARCH_SPAN = 120;

export function voiceContextFor(ctx: WritingContext): VoiceContext | null {
  switch (ctx) {
    case 'email':
    case 'chat':
    case 'social':
      return 'messages';
    case 'doc':
    case 'other':
      return 'documents';
    default:
      return null;
  }
}

/**
 * Finds what now sits between `prefix` and `suffix` (the text around a span before the user edited it). Returns the
 * range of the text between them, or null when the context is gone.
 */
/**
 * locateByContext with progressively shorter context: an edit that spills into the neighbouring words ("report" ->
 * "reports") must not hide the span, so the suffix is shortened first, then the prefix.
 */
export function locateRelaxed(text: string, prefix: string, suffix: string): TextRange | null {
  const lengths = (full: number): number[] => [...new Set([full, 12, 6, 3, 1].filter((n) => n > 0 && n <= full))];
  for (const pl of lengths(prefix.length)) {
    for (const sl of lengths(suffix.length)) {
      const found = locateByContext(text, prefix.slice(prefix.length - pl), suffix.slice(0, sl));
      if (found) return found;
    }
  }
  return null;
}

export function locateByContext(text: string, prefix: string, suffix: string): TextRange | null {
  if (prefix.length === 0 && suffix.length === 0) return null;
  const candidates: number[] = [];
  if (prefix.length > 0) {
    let from = 0;
    while (from <= text.length) {
      const i = text.indexOf(prefix, from);
      if (i === -1) break;
      candidates.push(i + prefix.length);
      from = i + 1;
    }
  } else candidates.push(0);
  let best: TextRange | null = null;
  for (const start of candidates) {
    let end: number;
    if (suffix.length > 0) {
      const j = text.indexOf(suffix, start);
      if (j === -1 || j - start > CONTEXT_SEARCH_SPAN) continue;
      end = j;
    } else end = Math.min(text.length, start + CONTEXT_SEARCH_SPAN);
    if (best === null || end - start < best.end - best.start) best = { start, end };
  }
  return best;
}

export interface FeedbackDeps {
  fieldId: string;
  host: string;
  ctx: () => WritingContext;
  docKey: () => string;
  snippetsAllowed: () => boolean;
  send: (events: FeedbackEventInput[]) => void;
  sendVoice: (samples: VoiceSample[]) => void;
  timers?: Timers;
}

interface EmitExtra {
  via?: FeedbackVia;
  reason?: DismissReason;
  dwellMs?: number;
  wordCountTyped?: number;
  replacement?: string;
  final?: string;
  /** Where the span is in `text` when it differs from `s.range` (events emitted against a later text). */
  range?: TextRange;
}

interface DropCandidate {
  s: Suggestion;
  prefix: string;
  suffix: string;
  at: number;
}

interface AcceptedSpan {
  s: Suggestion;
  replacement: string;
  version: number;
  range: TextRange;
  prefix: string;
  suffix: string;
  at: number;
  dirty: boolean;
}

export class FeedbackTracker {
  private readonly timers: Timers;
  private readonly buffer: FeedbackEventInput[] = [];
  private flushTimer: unknown = null;
  private readonly shownAt = new Map<string, number>();
  private openCard: { id: string; openedAt: number } | null = null;
  private readonly decided = new Set<string>();
  private readonly drops: DropCandidate[] = [];
  private readonly accepted: AcceptedSpan[] = [];
  private readonly voiceSeen = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: FeedbackDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  get pending(): readonly FeedbackEventInput[] {
    return this.buffer;
  }

  wasShown(id: string): boolean {
    return this.shownAt.has(id);
  }

  /** Oldest model version an accepted span still watched for edit_after_accept is anchored to (for TextModel.prune). */
  get oldestNeededVersion(): number | null {
    let oldest: number | null = null;
    for (const a of this.accepted) if (oldest === null || a.version < oldest) oldest = a.version;
    return oldest;
  }

  /** The card opened for `s`: `shown` once per id per field session; dwell starts now. */
  cardShown(s: Suggestion, text: string): void {
    const now = this.timers.now();
    if (!this.shownAt.has(s.id)) {
      this.shownAt.set(s.id, now);
      this.emit('shown', s, text, { wordCountTyped: countWords(text) });
    }
    this.openCard = { id: s.id, openedAt: now };
  }

  /** The card closed. Without a decision after ≥ 1.5 s of dwell this is an `ignore`. */
  cardHidden(s: Suggestion | undefined, id: string, text: string): void {
    if (!this.openCard || this.openCard.id !== id) return;
    const dwell = this.timers.now() - this.openCard.openedAt;
    this.openCard = null;
    if (this.decided.has(id) || !s) return;
    if (dwell >= IGNORE_DWELL_MS) this.emit('ignore', s, text, { dwellMs: dwell });
  }

  accept(s: Suggestion, via: FeedbackVia, textAfter: string, replacement: string, post: { version: number; range: TextRange }): void {
    this.decided.add(s.id);
    this.emit('accept', s, textAfter, { via, dwellMs: this.dwell(s.id), replacement, range: post.range });
    this.accepted.push({
      s,
      replacement,
      version: post.version,
      range: { ...post.range },
      prefix: textAfter.slice(Math.max(0, post.range.start - CONTEXT_CHARS), post.range.start),
      suffix: textAfter.slice(post.range.end, post.range.end + CONTEXT_CHARS),
      at: this.timers.now(),
      dirty: false,
    });
  }

  dismiss(s: Suggestion, reason: DismissReason | undefined, via: FeedbackVia, text: string): void {
    this.decided.add(s.id);
    this.emit('dismiss', s, text, { via, reason, dwellMs: this.dwell(s.id) });
  }

  addToDictionary(s: Suggestion, text: string): void {
    this.decided.add(s.id);
    this.emit('add_to_dictionary', s, text, { via: 'card', dwellMs: this.dwell(s.id) });
  }

  reportIncorrect(s: Suggestion, text: string): void {
    this.decided.add(s.id);
    this.emit('report_incorrect', s, text, { via: 'card', dwellMs: this.dwell(s.id) });
  }

  /** The user edited the span (rebase dropped it). Emits `invalidated` when the card had been shown. */
  invalidated(s: Suggestion, textBefore: string): void {
    if (!this.shownAt.has(s.id) || this.decided.has(s.id)) return;
    this.emit('invalidated', s, textBefore, {});
  }

  /** Remember a dropped suggestion so idle can tell accepted_by_typing from self_corrected. */
  trackDropped(s: Suggestion, textBefore: string): void {
    if (this.decided.has(s.id)) return;
    this.drops.push({
      s,
      prefix: textBefore.slice(Math.max(0, s.range.start - CONTEXT_CHARS), s.range.start),
      suffix: textBefore.slice(s.range.end, s.range.end + CONTEXT_CHARS),
      at: this.timers.now(),
    });
  }

  /** A user edit happened: mark accepted spans that were touched (evaluated on idle). */
  // (see boundariesIntact below: an edit glued to either edge of the span counts as editing it)
  onTextChanged(model: TextModel): void {
    const now = this.timers.now();
    for (let i = this.accepted.length - 1; i >= 0; i--) {
      const a = this.accepted[i]!;
      if (now - a.at > TYPING_WINDOW_MS) {
        this.accepted.splice(i, 1);
        continue;
      }
      const mapped = model.shiftThrough(a.version, a.range);
      if (mapped && sameText(model.text.slice(mapped.start, mapped.end), a.replacement) && boundariesIntact(model.text, mapped, a)) continue;
      a.dirty = true;
    }
  }

  /** The user paused: settle accepted_by_typing / self_corrected / edit_after_accept. */
  onIdle(text: string): void {
    const now = this.timers.now();
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i]!;
      if (now - d.at > TYPING_WINDOW_MS) {
        this.drops.splice(i, 1);
        continue;
      }
      const loc = locateRelaxed(text, d.prefix, d.suffix);
      if (!loc) {
        this.drops.splice(i, 1);
        continue;
      }
      const between = text.slice(loc.start, loc.end);
      this.drops.splice(i, 1);
      if (this.decided.has(d.s.id)) continue;
      if (sameText(between, d.s.replacement) || d.s.alternatives.some((alt) => sameText(between, alt))) {
        this.decided.add(d.s.id);
        this.emit('accepted_by_typing', d.s, text, { via: 'typing', dwellMs: this.dwell(d.s.id), replacement: between, range: loc });
      } else if (!sameText(between, d.s.original)) {
        this.decided.add(d.s.id);
        this.emit('self_corrected', d.s, text, { via: 'typing', final: between, range: loc });
      }
    }
    for (let i = this.accepted.length - 1; i >= 0; i--) {
      const a = this.accepted[i]!;
      if (!a.dirty) continue;
      this.accepted.splice(i, 1);
      const loc = locateRelaxed(text, a.prefix, a.suffix);
      const final = loc ? text.slice(loc.start, loc.end) : '';
      if (loc && sameText(final, a.replacement)) continue;
      this.emit('edit_after_accept', a.s, text, { final, replacement: a.replacement, range: loc ?? { start: 0, end: 0 } });
    }
  }

  /**
   * Voice samples: completed sentences whose every character was typed, outside protected/masked ranges, ≥ 6 words,
   * ≤ 280 chars, redacted, de-duplicated per session. `code` contexts never sample.
   */
  sampleVoice(text: string, model: TextModel, excluded: readonly TextRange[]): VoiceSample[] {
    if (this.disposed || !this.deps.snippetsAllowed()) return [];
    const voiceContext = voiceContextFor(this.deps.ctx());
    if (!voiceContext) return [];
    const out: VoiceSample[] = [];
    const t = new Date(this.timers.now()).toISOString();
    for (const r of splitSentences(text)) {
      if (r.end >= text.length && !/[.!?…。！？]["'”’)\]]*$/u.test(text.slice(r.start, r.end))) continue;
      if (!model.isTyped(r)) continue;
      if (excluded.some((x) => rangesIntersect(x, r))) continue;
      const sentence = text.slice(r.start, r.end);
      if (sentence.length > VOICE_MAX_CHARS || countWords(sentence) < VOICE_MIN_WORDS) continue;
      const redacted = redactSentence(sentence);
      const key = hashText(redacted);
      if (this.voiceSeen.has(key)) continue;
      this.voiceSeen.add(key);
      out.push({ t, host: this.deps.host, ctx: this.deps.ctx(), voiceContext, sentence: redacted });
    }
    if (out.length > 0) this.deps.sendVoice(out);
    return out;
  }

  flush(): void {
    if (this.flushTimer !== null) this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    this.deps.send(events);
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private dwell(id: string): number | undefined {
    const at = this.shownAt.get(id);
    return at === undefined ? undefined : Math.max(0, this.timers.now() - at);
  }

  private emit(kind: FeedbackKind, s: Suggestion, text: string, extra: EmitExtra): void {
    if (this.disposed) return;
    const range = extra.range ?? s.range;
    const sentence = sentenceContaining(text, range) ?? { start: 0, end: Math.min(text.length, SENTENCE_MAX) };
    const ev: FeedbackEventInput = {
      kind,
      suggestionId: s.id,
      fieldId: this.deps.fieldId,
      docKey: this.deps.docKey(),
      host: this.deps.host,
      ctx: this.deps.ctx(),
      rule: s.rule,
      category: s.category,
      severity: s.severity,
      confidence: Math.max(0, Math.min(1, s.confidence)),
      source: s.source,
      spanLen: s.original.length,
      sentenceLen: sentence.end - sentence.start,
    };
    if (extra.via !== undefined) ev.via = extra.via;
    if (extra.reason !== undefined) ev.reason = extra.reason;
    if (extra.dwellMs !== undefined) ev.dwellMs = extra.dwellMs;
    if (extra.wordCountTyped !== undefined) ev.wordCountTyped = extra.wordCountTyped;
    if (s.learnedState === 'probe') ev.probe = true;
    if (this.deps.snippetsAllowed()) {
      ev.original = redactSnippet(s.original);
      ev.replacement = redactSnippet(extra.replacement ?? s.replacement);
      if (extra.final !== undefined) ev.final = redactSnippet(extra.final);
      ev.sentence = redactSentence(text.slice(sentence.start, sentence.end));
    }
    this.buffer.push(ev);
    if (this.buffer.length >= FLUSH_BATCH) this.flush();
    else if (this.flushTimer === null) this.flushTimer = this.timers.setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }
}

/**
 * True unless the user extended the applied span into a different word (typed a letter right before or after it,
 * e.g. "the" -> "these"). Punctuation or whitespace typed next to the span leaves it intact.
 */
function boundariesIntact(text: string, mapped: TextRange, a: { prefix: string; suffix: string }): boolean {
  const before = a.prefix.slice(-1);
  const after = a.suffix.slice(0, 1);
  const nowBefore = text.slice(mapped.start - 1, mapped.start);
  const nowAfter = text.slice(mapped.end, mapped.end + 1);
  if (nowBefore !== before && WORD_CHAR_RE.test(nowBefore)) return false;
  if (nowAfter !== after && WORD_CHAR_RE.test(nowAfter)) return false;
  return true;
}
const WORD_CHAR_RE = /^[\p{L}\p{N}']$/u;
