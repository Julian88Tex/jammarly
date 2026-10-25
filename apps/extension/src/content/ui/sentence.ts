/**
 * Sentence grouping for Grammarly's sentence-level card.
 *
 * When the sentence under a hovered underline holds two or more pending span suggestions that "Accept all" could
 * apply together, the overlay shows ONE card for the whole sentence and its Accept applies them as one transaction
 * (`onAcceptAll(fieldId, { group: 'all', suggestionIds })`). The group is computed here, in the UI, from the
 * UnderlineItems the controller handed over plus `adapter.getText()`, so no controller state is needed.
 *
 * Membership mirrors the controller's `selectAcceptAll` so every grouped id is one the controller will really apply:
 * bulkGroupOf (a span edit with a replacement that is not stale, in any category); overlapping
 * candidates are resolved with the same `resolveOverlaps` priority (losers are left out). On top of that a member
 * must lie inside the sentence (a range crossing a sentence boundary is never grouped) and its `original` must still
 * match the text at its range (stale offsets never group).
 */
import { resolveOverlaps, splitSentences } from '@jammarly/shared/text';
import type { Suggestion, TextRange } from '@jammarly/shared/types';
import type { UnderlineItem } from './overlay-api';
import { bulkGroupOf } from '../controller/store';

export interface SentenceGroup {
  /** The sentence range in the field text. */
  sentence: TextRange;
  /** The sentence text (`text.slice(sentence.start, sentence.end)`). */
  text: string;
  /** Grouped suggestions in reading order (at least two, the hovered one among them). */
  members: Suggestion[];
  /** The suggestion the pointer is on ("Show one at a time" and the ⋯ menu act on it). */
  hovered: Suggestion;
}

/** Same eligibility as the controller's selectAcceptAll for scope { group: 'all' }. */
export function isGroupable(s: Suggestion): boolean {
  return bulkGroupOf(s) !== null;
}

/** The range still holds the suggestion's original text (offsets are current). */
export function matchesText(s: Suggestion, text: string): boolean {
  const { start, end } = s.range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return false;
  const at = text.slice(start, end);
  // Same tolerance as the controller's validateEdit (sameText): NBSP and a plain space are interchangeable.
  return at === s.original || at.replace(/\u00a0/g, ' ') === s.original.replace(/\u00a0/g, ' ');
}

/** The sentence that fully contains `range`, or null when it crosses a boundary or sits between sentences. */
export function sentenceContaining(sentences: readonly TextRange[], range: TextRange): TextRange | null {
  for (const s of sentences) {
    if (s.start <= range.start && range.end <= s.end) return s;
  }
  return null;
}

/**
 * The sentence group around `hoveredId`, or null when the single-suggestion card should be shown instead (the
 * hovered suggestion is not groupable, crosses a sentence boundary, loses an overlap, or is alone in its sentence).
 */
export function sentenceGroupFor(items: readonly UnderlineItem[], text: string, hoveredId: string): SentenceGroup | null {
  const hoveredItem = items.find((i) => i.suggestion.id === hoveredId);
  if (!hoveredItem) return null;
  const hovered = hoveredItem.suggestion;
  if (!isGroupable(hovered) || !matchesText(hovered, text)) return null;
  const sentence = sentenceContaining(splitSentences(text), hovered.range);
  if (!sentence) return null;
  const candidates: Suggestion[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    const s = i.suggestion;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    if (!isGroupable(s) || !matchesText(s, text)) continue;
    if (s.range.start < sentence.start || s.range.end > sentence.end) continue;
    candidates.push(s);
  }
  if (candidates.length < 2) return null;
  const keptIds = new Set(resolveOverlaps(candidates).map((s) => s.id));
  if (!keptIds.has(hovered.id)) return null;
  const members = candidates.filter((s) => keptIds.has(s.id)).sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
  if (members.length < 2) return null;
  return { sentence, text: text.slice(sentence.start, sentence.end), members, hovered };
}

export type SentencePiece =
  | { type: 'text'; text: string }
  | { type: 'change'; suggestion: Suggestion; original: string; replacement: string };

/**
 * The sentence split into plain text and changes, in reading order: each change carries the struck original (empty
 * for an insertion) and the bold replacement (empty for a deletion).
 */
export function sentencePieces(group: Pick<SentenceGroup, 'sentence' | 'text' | 'members'>): SentencePiece[] {
  const out: SentencePiece[] = [];
  const base = group.sentence.start;
  let cursor = 0;
  for (const s of group.members) {
    const start = s.range.start - base;
    const end = s.range.end - base;
    if (start < cursor || end > group.text.length) continue; // defensive: members never overlap
    if (start > cursor) out.push({ type: 'text', text: group.text.slice(cursor, start) });
    out.push({ type: 'change', suggestion: s, original: group.text.slice(start, end), replacement: s.replacement });
    cursor = end;
  }
  if (cursor < group.text.length) out.push({ type: 'text', text: group.text.slice(cursor) });
  return out;
}

/** "Correct the sentence" when every member is a correctness fix, else "Improve the sentence". */
export function sentenceTitle(members: readonly Suggestion[]): string {
  return members.every((s) => s.category === 'correctness') ? 'Correct the sentence' : 'Improve the sentence';
}
