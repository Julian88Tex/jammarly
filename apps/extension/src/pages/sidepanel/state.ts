/**
 * Side panel state: what the worker told us (fields, config, progress), the scratch document, and transient UI
 * state (dialogs, previews, collapsed groups). Pure data plus selectors; no DOM.
 */
import type {
  AcceptGroup,
  CheckError,
  CheckPass,
  EffectiveConfig,
  FieldState,
  PublicDeviceSettings,
  Suggestion,
  SuggestionCategory,
  SyncState,
  ToneAnalysis,
  UsageTotals,
  WritingGoals,
  WritingScore,
} from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import type { PortStatus } from '../common/port';

export const SCRATCH_FIELD_ID = 'panel:scratch';
export const SCRATCH_HOST = 'sidepanel';
/** Tone chip threshold (Grammarly's extension threshold; ARCHITECTURE 3.3). */
export const TONE_MIN_CHARS = 150;
export const PREVIEW_ROWS = 8;
export const SCRATCH_HISTORY_LIMIT = 50;

export type CheckStage = 'queued' | 'sent' | 'streaming' | 'deep-scheduled';
export type AcceptAllGroup = AcceptGroup | 'all';
export type GroupKey = SuggestionCategory | 'applied';

export interface Progress {
  pass: CheckPass;
  stage: CheckStage;
}

export interface AppliedItem {
  id: string;
  title: string;
  category: SuggestionCategory;
  original: string;
  replacement: string;
  at: string;
  /** Field transactions only: reverted individually or by a native undo. */
  reverted?: boolean;
  transactionId?: string;
}

export interface ScratchSnapshot {
  text: string;
  suggestions: Suggestion[];
  applied: AppliedItem[];
}

export interface ScratchState {
  text: string;
  version: number;
  suggestions: Suggestion[];
  score: WritingScore | null;
  tone: ToneAnalysis | null;
  checking: boolean;
  error: CheckError | null;
  /** Undo stack, newest last. */
  history: ScratchSnapshot[];
  /** Local "Recently applied" items, newest first. */
  applied: AppliedItem[];
  checkedOnce: boolean;
}

export interface PreviewState {
  group: AcceptAllGroup;
  /** Checklist mode. */
  choose: boolean;
  /** Ids ticked in checklist mode. */
  selected: string[];
  /** Opened by click (stays open until closed) rather than hover/focus. */
  pinned: boolean;
}

export interface MenuState {
  kind: 'dismiss' | 'more';
  suggestionId: string;
}

export interface GoalsDialogState {
  kind: 'goals';
  goals: WritingGoals;
  scope: 'host' | 'global';
}

export interface PanelUiState {
  dialog: GoalsDialogState | null;
  preview: PreviewState | null;
  menu: MenuState | null;
  confirmDismissAll: SuggestionCategory | null;
  focusedId: string | null;
  expanded: string[];
}

export interface PanelState {
  portStatus: PortStatus;
  fields: Record<string, FieldState>;
  fieldOrder: string[];
  /** A field the user picked in the switcher (or SCRATCH_FIELD_ID); null follows the active field. */
  selectedFieldId: string | null;
  progress: Record<string, Progress>;
  config: EffectiveConfig | null;
  settings: PublicDeviceSettings | null;
  sync: SyncState | null;
  /** Category filter chips; seeded from config.categories and updated optimistically. */
  categories: Record<SuggestionCategory, boolean>;
  collapsed: Partial<Record<GroupKey, boolean>>;
  usage: UsageTotals | null;
  scratch: ScratchState;
  ui: PanelUiState;
}

export const ALL_CATEGORIES_ON: Record<SuggestionCategory, boolean> = { correctness: true, clarity: true, engagement: true, delivery: true };

export function initialScratch(): ScratchState {
  return { text: '', version: 0, suggestions: [], score: null, tone: null, checking: false, error: null, history: [], applied: [], checkedOnce: false };
}

export function initialState(): PanelState {
  return {
    portStatus: 'connecting',
    fields: {},
    fieldOrder: [],
    selectedFieldId: null,
    progress: {},
    config: null,
    settings: null,
    sync: null,
    categories: { ...ALL_CATEGORIES_ON },
    collapsed: {},
    usage: null,
    scratch: initialScratch(),
    ui: { dialog: null, preview: null, menu: null, confirmDismissAll: null, focusedId: null, expanded: [] },
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function orderedFields(state: PanelState): FieldState[] {
  const list: FieldState[] = [];
  for (const id of state.fieldOrder) {
    const f = state.fields[id];
    if (f) list.push(f);
  }
  // Active field first, then by label for a stable switcher.
  return list.sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label));
}

/** The field the panel shows: the user's pick when it still exists, else the active field, else the first one. */
export function currentField(state: PanelState): FieldState | null {
  if (state.selectedFieldId === SCRATCH_FIELD_ID) return null;
  if (state.selectedFieldId) {
    const picked = state.fields[state.selectedFieldId];
    if (picked) return picked;
  }
  const fields = orderedFields(state);
  return fields.find((f) => f.active) ?? fields[0] ?? null;
}

/** True when the scratch section is what the user sees (explicitly selected, or no field attached). */
export function isScratchView(state: PanelState): boolean {
  if (state.selectedFieldId === SCRATCH_FIELD_ID) return true;
  return currentField(state) === null;
}

export function visibleSuggestions(suggestions: readonly Suggestion[], categories: Record<SuggestionCategory, boolean>): Suggestion[] {
  return suggestions.filter((s) => categories[s.category] !== false);
}

export interface TierCounts {
  grammar: number;
  style: number;
  all: number;
  rewrites: number;
}

/** Counts per Accept-all bucket: A = grammar, B = style, A ∪ B = everything; tier C needs a choice. */
export function tierCounts(suggestions: readonly Suggestion[]): TierCounts {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const s of suggestions) {
    if (s.tier === 'A') a += 1;
    else if (s.tier === 'B') b += 1;
    else c += 1;
  }
  return { grammar: a, style: b, all: a + b, rewrites: c };
}

/** The suggestions a bulk action would apply for a group. */
export function tierSet(suggestions: readonly Suggestion[], group: AcceptAllGroup): Suggestion[] {
  return suggestions.filter((s) => (group === 'grammar' ? s.tier === 'A' : group === 'style' ? s.tier === 'B' : s.tier === 'A' || s.tier === 'B'));
}

export function groupByCategory(suggestions: readonly Suggestion[]): { category: SuggestionCategory; items: Suggestion[] }[] {
  return CATEGORIES.map((category) => ({ category, items: suggestions.filter((s) => s.category === category).sort((x, y) => x.range.start - y.range.start) })).filter((g) => g.items.length > 0);
}

export function countByCategory(suggestions: readonly Suggestion[]): Record<SuggestionCategory, number> {
  const out: Record<SuggestionCategory, number> = { correctness: 0, clarity: 0, engagement: 0, delivery: 0 };
  for (const s of suggestions) out[s.category] += 1;
  return out;
}

/** Whether the tone chip should show for a field (>= 150 chars; textPreview may be truncated so word count backs it up). */
export function showTone(field: Pick<FieldState, 'tone' | 'textPreview' | 'wordCount'>): boolean {
  if (!field.tone || field.tone.labels.length === 0) return false;
  return field.textPreview.length >= TONE_MIN_CHARS || field.wordCount * 6 >= TONE_MIN_CHARS;
}

/** Pass copy for the status line. */
export function progressCopy(progress: Progress): string {
  if (progress.stage === 'deep-scheduled') return 'Deep check scheduled…';
  switch (progress.pass) {
    case 'rules':
      return 'Running local rules…';
    case 'fast':
      return 'Checking with the fast pass…';
    case 'deep':
      return 'Checking with the deep pass…';
  }
}

/** True for rules whose "Add to dictionary" makes sense (spelling family). */
export function isSpellingRule(rule: string): boolean {
  return rule === 'spelling' || rule.startsWith('spelling_') || rule.startsWith('spelling.');
}

/** The word to add to the dictionary for a spelling suggestion. */
export function dictionaryWord(s: Suggestion): string {
  return s.original.trim().replace(/^[^\p{L}\p{N}'’-]+|[^\p{L}\p{N}'’-]+$/gu, '');
}

export function upsertField(state: PanelState, field: FieldState): PanelState {
  const fields = { ...state.fields, [field.fieldId]: field };
  const fieldOrder = state.fieldOrder.includes(field.fieldId) ? state.fieldOrder : [...state.fieldOrder, field.fieldId];
  return { ...state, fields, fieldOrder };
}

export function removeField(state: PanelState, fieldId: string): PanelState {
  if (!state.fields[fieldId]) return state;
  const fields = { ...state.fields };
  delete fields[fieldId];
  const progress = { ...state.progress };
  delete progress[fieldId];
  return {
    ...state,
    fields,
    progress,
    fieldOrder: state.fieldOrder.filter((id) => id !== fieldId),
    selectedFieldId: state.selectedFieldId === fieldId ? null : state.selectedFieldId,
    ui: state.ui.focusedId && !fieldHasSuggestion(fields, state.ui.focusedId) ? { ...state.ui, focusedId: null } : state.ui,
  };
}

function fieldHasSuggestion(fields: Record<string, FieldState>, suggestionId: string): boolean {
  return Object.values(fields).some((f) => f.suggestions.some((s) => s.id === suggestionId));
}

export function replaceFields(state: PanelState, fields: FieldState[]): PanelState {
  const map: Record<string, FieldState> = {};
  const order: string[] = [];
  for (const f of fields) {
    // A duplicated id (worker bug, two frames racing) keeps the first entry's position and the last entry's data.
    if (!map[f.fieldId]) order.push(f.fieldId);
    map[f.fieldId] = f;
  }
  const progress: Record<string, Progress> = {};
  for (const [id, p] of Object.entries(state.progress)) if (map[id]) progress[id] = p;
  const selected = state.selectedFieldId && (state.selectedFieldId === SCRATCH_FIELD_ID || map[state.selectedFieldId]) ? state.selectedFieldId : null;
  return { ...state, fields: map, fieldOrder: order, progress, selectedFieldId: selected };
}
