/**
 * The merged suggestion set for one field (ARCHITECTURE §3.2): rules ∪ LLM, rebased stepwise on every text change,
 * overlaps resolved among span edits only, rewrites and flags linked to the spans they overlap via `conflictsWith`,
 * dismissed fingerprints and inverse-of-applied edits filtered out, ids kept stable. Also the Accept-all selection
 * (§3.2 tiers, research 02 §5) and the counts the floating button shows.
 */
import type { AcceptAllScope, AcceptGroup, Edit, Suggestion, SuggestionCategory, TextRange } from '@jammarly/shared/types';
import { diffShift, normalizeForMatch, resolveOverlaps } from '@jammarly/shared/text';
import type { AcceptAllCounts } from '../ui/overlay-api';
import { shiftRangeThrough } from './text-model';
import { rangeContains, rangesIntersect } from './util';

export interface StoreFilters {
  mutedRules: ReadonlySet<string>;
  categories: Record<SuggestionCategory, boolean>;
  /** Lower-cased dictionary words: never flagged. */
  dictionary: ReadonlySet<string>;
}

export const DEFAULT_FILTERS: StoreFilters = {
  mutedRules: new Set(),
  categories: { correctness: true, clarity: true, engagement: true, delivery: true },
  dictionary: new Set(),
};

export function isSpanEdit(s: Pick<Suggestion, 'kind'>): boolean {
  return s.kind === 'replace' || s.kind === 'delete' || s.kind === 'insert';
}

/**
 * The Accept-all group a suggestion belongs to. Every span edit with a concrete replacement counts: correctness is
 * 'grammar'; clarity, engagement and delivery are 'style' (style and tone). Rewrites (the user picks a version of the
 * sentence), flags (nothing to apply) and stale suggestions belong to no group and stay for the user to review.
 * This is the single rule behind every Accept-all count and action (popup, floating menu, side panel, sentence card),
 * so the numbers always add up: grammar + style (+ overlaps) + needs-review = every suggestion.
 */
export function bulkGroupOf(s: Pick<Suggestion, 'kind' | 'stale' | 'category'>): AcceptGroup | null {
  if (!isSpanEdit(s) || s.stale) return null;
  return s.category === 'correctness' ? 'grammar' : 'style';
}

/** Key of an edit direction, normalized: used to suppress a suggestion that would revert an edit the user accepted. */
export function editKey(original: string, replacement: string): string {
  return `${normalizeForMatch(original).toLowerCase()}→${normalizeForMatch(replacement).toLowerCase()}`;
}

function spanKey(s: Suggestion): string {
  return `${s.range.start}:${s.range.end}:${s.replacement}`;
}

function byPosition(a: Suggestion, b: Suggestion): number {
  return a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id);
}

function copy(s: Suggestion): Suggestion {
  return {
    ...s,
    range: { start: s.range.start, end: s.range.end },
    highlight: { start: s.highlight.start, end: s.highlight.end },
    alternatives: [...s.alternatives],
    conflictsWith: [],
  };
}

const WORD_RE = /^[\p{L}\p{N}'’-]+$/u;

function isDictionaryWord(s: Suggestion, dictionary: ReadonlySet<string>): boolean {
  if (dictionary.size === 0 || s.kind !== 'replace') return false;
  const word = s.original.trim();
  return WORD_RE.test(word) && dictionary.has(word.toLowerCase());
}

export interface MergeInput {
  rules: readonly Suggestion[];
  llm: readonly Suggestion[];
  filters: StoreFilters;
  /** Dismissed (id or fingerprint) or inverse of an applied edit. */
  isSuppressed(s: Suggestion): boolean;
}

/**
 * rules ∪ LLM → one non-overlapping set of span edits (resolveOverlaps) plus every rewrite/flag, linked both ways
 * through `conflictsWith`. A rules hit that duplicates an LLM span (same range, same replacement) is folded into the
 * LLM one as `source: 'both'` (keeping the worker's stable id). Pure: returns new objects.
 */
export function mergeSuggestions(input: MergeInput): Suggestion[] {
  const { filters } = input;
  const keep = (s: Suggestion): boolean =>
    filters.categories[s.category] !== false && !filters.mutedRules.has(s.rule) && !input.isSuppressed(s) && !isDictionaryWord(s, filters.dictionary);
  const rules = input.rules.filter(keep);
  const llm = input.llm.filter(keep);

  const llmSpans = llm.filter(isSpanEdit);
  const llmByKey = new Map<string, Suggestion>();
  for (const s of llmSpans) if (!llmByKey.has(spanKey(s))) llmByKey.set(spanKey(s), s);
  const bothConfidence = new Map<string, number>();
  const spans: Suggestion[] = [];
  for (const r of rules) {
    if (!isSpanEdit(r)) continue;
    const twin = llmByKey.get(spanKey(r));
    if (twin) {
      bothConfidence.set(twin.id, Math.max(bothConfidence.get(twin.id) ?? 0, r.confidence));
      continue;
    }
    spans.push(copy(r));
  }
  for (const s of llmSpans) {
    const c = copy(s);
    const both = bothConfidence.get(s.id);
    if (both !== undefined) {
      c.source = 'both';
      c.confidence = Math.max(c.confidence, both);
    }
    spans.push(c);
  }
  const resolved = resolveOverlaps(spans).map((s) => ({ ...s, conflictsWith: [] as string[] }));

  const others = llm.filter((s) => !isSpanEdit(s)).map(copy);
  for (const o of others) {
    for (const s of resolved) {
      if (rangesIntersect(o.range, s.range) || rangeContains(o.range, s.range)) {
        o.conflictsWith.push(s.id);
        s.conflictsWith.push(o.id);
      }
    }
  }
  return [...resolved, ...others].sort(byPosition);
}

export interface OwnEdit {
  /** Ids applied by this edit: removed, never transformed. */
  ids: ReadonlySet<string>;
}

export interface RebaseResult {
  kept: Suggestion[];
  /** Suggestions whose text changed under them (user edits) or that were applied/overlapped by our own edit. */
  dropped: Suggestion[];
  /** Rewrites/flags enclosing our own edit: `original` transformed, now `stale`. */
  transformed: Suggestion[];
}

function validRange(r: TextRange, length: number): boolean {
  return Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.start <= r.end && r.end <= length;
}

/**
 * Moves suggestions from `oldText` to `newText` across one change. User edits: shift before/after, drop overlapping
 * (research 02 §4.4). Our own edits (`own` set): the applied ids are dropped, span edits overlapping the region are
 * dropped (conflicting spans of an accepted rewrite), and a rewrite or flag whose range encloses the region keeps
 * living with its `original` rewritten and `stale: true` ("sentence changed", ARCHITECTURE §3.2).
 */
export function rebaseAcrossChange(suggestions: readonly Suggestion[], oldText: string, newText: string, own?: OwnEdit): RebaseResult {
  const region = diffShift(oldText, newText);
  const kept: Suggestion[] = [];
  const dropped: Suggestion[] = [];
  const transformed: Suggestion[] = [];
  if (region === null) return { kept: suggestions.map((s) => s), dropped, transformed };
  const delta = region.newEnd - region.oldEnd;
  for (const s of suggestions) {
    const range = shiftRangeThrough(s.range, region);
    const highlight = shiftRangeThrough(s.highlight, region);
    if (own && own.ids.has(s.id)) {
      // One of our own edits targeted this suggestion. A batch applies right-to-left and stops at the first
      // mismatch, so a targeted suggestion that still sits intact to the left of the change was NOT applied: keep it.
      if (range !== null && highlight !== null && validRange(range, newText.length) && newText.slice(range.start, range.end) === s.original) {
        kept.push({ ...s, range, highlight });
      } else {
        dropped.push(s);
      }
      continue;
    }
    if (range !== null && highlight !== null) {
      if (!validRange(range, newText.length) || !validRange(highlight, newText.length) || newText.slice(range.start, range.end) !== s.original) {
        dropped.push(s);
        continue;
      }
      kept.push({ ...s, range, highlight });
      continue;
    }
    if (own && !isSpanEdit(s) && region.start >= s.range.start && region.oldEnd <= s.range.end) {
      const newRange = { start: s.range.start, end: s.range.end + delta };
      const newHighlight = region.start >= s.highlight.start && region.oldEnd <= s.highlight.end ? { start: s.highlight.start, end: s.highlight.end + delta } : { ...newRange };
      if (validRange(newRange, newText.length) && validRange(newHighlight, newText.length)) {
        const next: Suggestion = { ...s, range: newRange, highlight: newHighlight, original: newText.slice(newRange.start, newRange.end), stale: true };
        kept.push(next);
        transformed.push(next);
        continue;
      }
    }
    dropped.push(s);
  }
  return { kept, dropped, transformed };
}

/** Reuses the previous id for a rules hit with the same fingerprint at the same (already rebased) range. */
export function stabilizeRuleIds(prev: readonly Suggestion[], next: readonly Suggestion[]): Suggestion[] {
  if (prev.length === 0) return [...next];
  const byKey = new Map<string, string>();
  for (const p of prev) byKey.set(`${p.fingerprint}|${p.range.start}|${p.range.end}`, p.id);
  return next.map((n) => {
    const id = byKey.get(`${n.fingerprint}|${n.range.start}|${n.range.end}`);
    return id === undefined || id === n.id ? n : { ...n, id };
  });
}

export interface AcceptAllSelection {
  /** Non-overlapping edits to apply, sorted by start descending. */
  selected: Suggestion[];
  /** Tier-C rewrites left pending (toast "k rewrites need your choice"). */
  pendingRewrites: Suggestion[];
  /** Eligible but excluded because they overlap a higher-priority selected edit. */
  excluded: Suggestion[];
}

/**
 * Everything bulk accept applies for a scope: the scope's group under bulkGroupOf ('all' = both groups), optionally
 * narrowed to explicit ids; overlapping candidates are resolved by priority so one edit per span is applied.
 */
export function selectAcceptAll(all: readonly Suggestion[], scope: AcceptAllScope): AcceptAllSelection {
  const only = scope.suggestionIds ? new Set(scope.suggestionIds) : null;
  const candidates = all.filter((s) => {
    const group = bulkGroupOf(s);
    if (group === null) return false;
    if (only && !only.has(s.id)) return false;
    return scope.group === 'all' || scope.group === group;
  });
  const picked = resolveOverlaps(candidates);
  const pickedIds = new Set(picked.map((p) => p.id));
  const excluded = candidates.filter((c) => !pickedIds.has(c.id));
  const pendingRewrites = scope.group === 'grammar' ? [] : all.filter((s) => s.kind === 'rewrite' && (!only || only.has(s.id)));
  return { selected: picked.sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end), pendingRewrites, excluded };
}

export function acceptAllCounts(all: readonly Suggestion[]): AcceptAllCounts {
  return {
    grammar: selectAcceptAll(all, { group: 'grammar' }).selected.length,
    style: selectAcceptAll(all, { group: 'style' }).selected.length,
    rewrites: all.filter((s) => s.kind === 'rewrite').length,
  };
}

export class SuggestionStore {
  private rules: Suggestion[] = [];
  private llm: Suggestion[] = [];
  private merged: Suggestion[] = [];
  private filters: StoreFilters = DEFAULT_FILTERS;
  private readonly dismissedIds = new Set<string>();
  private readonly dismissedFingerprints = new Set<string>();
  private readonly appliedInverse = new Set<string>();

  /** The merged, filtered, position-sorted set. */
  get all(): readonly Suggestion[] {
    return this.merged;
  }

  get llmSuggestions(): readonly Suggestion[] {
    return this.llm;
  }

  get rulesSuggestions(): readonly Suggestion[] {
    return this.rules;
  }

  get(id: string): Suggestion | undefined {
    return this.merged.find((s) => s.id === id);
  }

  setFilters(filters: StoreFilters): void {
    this.filters = filters;
    this.recompute();
  }

  /** Replaces the rules set (ids stabilized against the previous, already rebased, rules set). */
  setRules(next: readonly Suggestion[]): void {
    this.rules = stabilizeRuleIds(this.rules, next);
    this.recompute();
  }

  /** Replaces the LLM set wholesale with a result already rebased to the current text. */
  replaceLlm(next: readonly Suggestion[]): void {
    this.llm = [...next];
    this.recompute();
  }

  /** Rebases both sets across one text change. */
  rebase(oldText: string, newText: string, own?: OwnEdit): RebaseResult {
    const a = rebaseAcrossChange(this.llm, oldText, newText, own);
    const b = rebaseAcrossChange(this.rules, oldText, newText, own);
    this.llm = a.kept;
    this.rules = b.kept;
    this.recompute();
    return { kept: [...a.kept, ...b.kept], dropped: [...a.dropped, ...b.dropped], transformed: [...a.transformed, ...b.transformed] };
  }

  remove(ids: Iterable<string>): void {
    const set = new Set(ids);
    this.llm = this.llm.filter((s) => !set.has(s.id));
    this.rules = this.rules.filter((s) => !set.has(s.id));
    this.recompute();
  }

  /** Puts a previously applied suggestion back (after undo/revert) at `range`, when its text is there again. */
  restore(s: Suggestion, range: TextRange, text: string): boolean {
    if (text.slice(range.start, range.end) !== s.original) return false;
    const offset = range.start - s.range.start;
    const highlight = { start: Math.max(0, s.highlight.start + offset), end: Math.min(text.length, s.highlight.end + offset) };
    const restored: Suggestion = { ...s, range: { ...range }, highlight, stale: false, conflictsWith: [] };
    const target = s.source === 'rules' ? this.rules : this.llm;
    if (target.some((x) => x.id === s.id)) return false;
    target.push(restored);
    this.appliedInverse.delete(editKey(s.replacement, s.original));
    this.recompute();
    return true;
  }

  dismiss(s: Suggestion): void {
    this.dismissedIds.add(s.id);
    this.dismissedFingerprints.add(s.fingerprint);
    this.recompute();
  }

  dismissFingerprints(fingerprints: Iterable<string>): void {
    for (const f of fingerprints) this.dismissedFingerprints.add(f);
    this.recompute();
  }

  /** Never re-suggest reverting an edit the user accepted (research 02 §4.5). */
  recordApplied(edits: readonly Edit[]): void {
    for (const e of edits) this.appliedInverse.add(editKey(e.replacement, e.original));
    this.recompute();
  }

  markStale(ids: Iterable<string>): void {
    const set = new Set(ids);
    this.llm = this.llm.map((s) => (set.has(s.id) && !isSpanEdit(s) ? { ...s, stale: true } : s));
    this.recompute();
  }

  isSuppressed(s: Suggestion): boolean {
    return this.dismissedIds.has(s.id) || this.dismissedFingerprints.has(s.fingerprint) || this.appliedInverse.has(editKey(s.original, s.replacement));
  }

  counts(): AcceptAllCounts {
    return acceptAllCounts(this.merged);
  }

  clear(): void {
    this.rules = [];
    this.llm = [];
    this.recompute();
  }

  private recompute(): void {
    this.merged = mergeSuggestions({ rules: this.rules, llm: this.llm, filters: this.filters, isSuppressed: (s) => this.isSuppressed(s) });
  }
}
