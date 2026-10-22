/**
 * The side panel's scratch document ("Check text"): request building and the local apply path. Pure functions over
 * text and suggestions so they can be unit-tested without a DOM.
 */
import type { CheckRequest, Edit, Suggestion } from '@jammarly/shared/types';
import { applyEdits, splitParagraphs } from '@jammarly/shared/text';
import { SCRATCH_FIELD_ID, SCRATCH_HOST, tierSet, type AcceptAllGroup, type AppliedItem } from './state';

/** Builds the CheckRequest for the scratch textarea: every block dirty, deep pass, doc context. */
export function buildScratchRequest(text: string, version: number): CheckRequest {
  return {
    fieldId: SCRATCH_FIELD_ID,
    version,
    text,
    blocks: splitParagraphs(text),
    dirtyBlockHashes: 'all',
    pass: 'deep',
    host: SCRATCH_HOST,
    context: 'doc',
    fieldKind: 'scratch',
    protectedRanges: [],
  };
}

/** Keeps only suggestions whose `original` still sits at `range` in `text`. */
export function validateAgainstText(text: string, suggestions: readonly Suggestion[]): Suggestion[] {
  return suggestions.filter((s) => {
    const { start, end } = s.range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return false;
    return text.slice(start, end) === s.original;
  });
}

export interface LocalApplyResult {
  text: string;
  /** Remaining suggestions, re-anchored to the new text. */
  suggestions: Suggestion[];
  appliedIds: string[];
  skippedIds: string[];
  applied: AppliedItem[];
}

function replacementFor(s: Suggestion, alternativeIndex: number | undefined): string {
  if (alternativeIndex === undefined || alternativeIndex <= 0) return s.replacement;
  return s.alternatives[alternativeIndex - 1] ?? s.replacement;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  // Half-open ranges; a zero-width insertion inside a replaced span counts as overlapping too.
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * Applies the given suggestions to `text` in one pass (applyEdits sorts and skips overlaps), then re-anchors the
 * rest: anything overlapping an applied edit is dropped, everything else is shifted with `mapOffset`.
 */
export function applyLocally(text: string, suggestions: readonly Suggestion[], ids: readonly string[], alternativeIndex?: number, now: () => string = () => new Date().toISOString()): LocalApplyResult {
  const wanted = new Set(ids);
  const targets = suggestions.filter((s) => wanted.has(s.id) && s.kind !== 'flag');
  const edits: Edit[] = targets.map((s) => ({ range: { ...s.range }, original: s.original, replacement: replacementFor(s, ids.length === 1 ? alternativeIndex : undefined) }));
  const result = applyEdits(text, edits);
  const appliedEdits = result.applied;
  const appliedIds: string[] = [];
  const applied: AppliedItem[] = [];
  const at = now();
  for (const s of targets) {
    const edit = appliedEdits.find((e) => e.range.start === s.range.start && e.range.end === s.range.end && e.original === s.original);
    if (!edit) continue;
    appliedIds.push(s.id);
    applied.push({ id: s.id, title: s.title, category: s.category, original: s.original, replacement: edit.replacement, at });
  }
  const skippedIds = targets.filter((s) => !appliedIds.includes(s.id)).map((s) => s.id);
  // mapOffset keeps an offset that sits exactly at an applied insertion *before* the inserted text (caret semantics).
  // A non-empty range starting there covers the text that moved right, so its start must land *after* the insertion.
  const mapRange = (range: { start: number; end: number }): { start: number; end: number } => {
    let start = result.mapOffset(range.start);
    const end = result.mapOffset(range.end);
    if (range.end > range.start) {
      for (const e of appliedEdits) {
        if (e.range.start === e.range.end && e.range.start === range.start) start += e.replacement.length;
      }
    }
    return { start, end: Math.max(start, end) };
  };
  const remaining: Suggestion[] = [];
  for (const s of suggestions) {
    if (appliedIds.includes(s.id)) continue;
    if (appliedEdits.some((e) => overlaps(s.range, e.range))) continue;
    const range = mapRange(s.range);
    const highlight = mapRange(s.highlight ?? s.range);
    if (result.text.slice(range.start, range.end) !== s.original) continue;
    remaining.push({ ...s, range, highlight, conflictsWith: s.conflictsWith.filter((id) => !appliedIds.includes(id)) });
  }
  // Newest first, matching FieldState.transactions.
  applied.reverse();
  return { text: result.text, suggestions: remaining, appliedIds, skippedIds, applied };
}

/** Applies a whole tier set (right-to-left order is handled by applyEdits). */
export function applyGroupLocally(text: string, suggestions: readonly Suggestion[], group: AcceptAllGroup, onlyIds?: readonly string[]): LocalApplyResult {
  let set = tierSet(suggestions, group);
  if (onlyIds) {
    const allow = new Set(onlyIds);
    set = set.filter((s) => allow.has(s.id));
  }
  return applyLocally(
    text,
    suggestions,
    set.map((s) => s.id),
  );
}

/** Removes one suggestion locally (dismiss) and anything that only existed as its alternative. */
export function removeLocally(suggestions: readonly Suggestion[], id: string): Suggestion[] {
  return suggestions.filter((s) => s.id !== id).map((s) => (s.conflictsWith.includes(id) ? { ...s, conflictsWith: s.conflictsWith.filter((c) => c !== id) } : s));
}

/** Copies text to the clipboard: async API first, then the textarea select + execCommand('copy') fallback. */
export async function copyText(text: string, fallbackTextarea?: HTMLTextAreaElement | null): Promise<boolean> {
  const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (s: string) => Promise<void> } } }).navigator?.clipboard;
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const area = fallbackTextarea ?? (typeof document !== 'undefined' ? document.createElement('textarea') : null);
  if (!area) return false;
  const temporary = area !== fallbackTextarea;
  if (temporary) {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
  }
  try {
    area.focus();
    area.select();
    const exec = (document as Document & { execCommand?: (cmd: string) => boolean }).execCommand;
    return typeof exec === 'function' ? exec.call(document, 'copy') === true : false;
  } catch {
    return false;
  } finally {
    if (temporary) area.remove();
  }
}
