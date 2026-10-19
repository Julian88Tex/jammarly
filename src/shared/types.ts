/**
 * Shared contracts for Jammarly. Every module (service worker, content script, side panel,
 * options, popup, engines, adapters) codes against these types. Keep this file dependency-free.
 *
 * DRAFT v0 — to be refined by the architecture design phase.
 */

// ---------------------------------------------------------------------------
// Suggestion model
// ---------------------------------------------------------------------------

/** Grammarly's four top-level categories, kept verbatim so the UI maps 1:1 to familiar colors. */
export type SuggestionCategory = 'correctness' | 'clarity' | 'engagement' | 'delivery';

/**
 * The two "Accept all" buckets the user asked for. Correctness suggestions are mechanical and safe
 * to mass-apply; everything else is a judgment call about voice and is grouped as "style & tone".
 */
export type AcceptGroup = 'grammar' | 'style';

export const CATEGORY_TO_GROUP: Record<SuggestionCategory, AcceptGroup> = {
  correctness: 'grammar',
  clarity: 'style',
  engagement: 'style',
  delivery: 'style',
};

export type SuggestionSeverity = 'error' | 'warning' | 'hint';

export type SuggestionSource = 'rules' | 'llm';

/** Half-open range of UTF-16 code-unit offsets into the field's plain text. */
export interface TextRange {
  start: number;
  end: number;
}

export interface Suggestion {
  /** Stable id for the lifetime of the field session (dedupe key is derived from rule+range+replacement). */
  id: string;
  category: SuggestionCategory;
  /** Machine-readable rule name, e.g. "spelling", "subject-verb-agreement", "wordiness", "hedging". */
  rule: string;
  severity: SuggestionSeverity;
  source: SuggestionSource;
  /** Offsets into the plain text the suggestion was computed against (see FieldSnapshot.version). */
  range: TextRange;
  /** Exact text currently at `range`. Used to re-validate before applying. */
  original: string;
  /** Replacement text; empty string means delete. */
  replacement: string;
  /** Optional alternative replacements shown as secondary choices. */
  alternatives?: string[];
  /** Short card title, e.g. "Correct the spelling" or "Remove the repeated word". */
  title: string;
  /** One or two plain sentences explaining why. */
  explanation: string;
  /** 0..1; rules engine emits 1, the LLM is asked for calibrated confidence. */
  confidence: number;
  /** Content hash of the paragraph this came from, for cache invalidation. */
  paragraphHash?: string;
}

export interface ToneLabel {
  /** e.g. "Confident", "Friendly", "Formal", "Worried", "Direct" */
  label: string;
  emoji: string;
  /** 0..1 relative strength */
  score: number;
}

export interface ToneAnalysis {
  labels: ToneLabel[];
  /** One sentence, e.g. "Sounds confident and a little informal." */
  summary: string;
}

export interface WritingScore {
  /** 0..100, Grammarly-style overall score. */
  overall: number;
  wordCount: number;
  readingTimeSeconds: number;
  /** Flesch-Kincaid grade level or similar, if computed. */
  readability?: number;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export type Formality = 'informal' | 'neutral' | 'formal';
export type Audience = 'general' | 'knowledgeable' | 'expert';
export type Domain = 'general' | 'academic' | 'business' | 'email' | 'casual' | 'creative' | 'technical';
export type Intent = 'inform' | 'describe' | 'convince' | 'tell-a-story';
export type Dialect = 'american' | 'british' | 'canadian' | 'australian';

/** Grammarly's "Goals" dialog, which steers the model's judgment calls. */
export interface WritingGoals {
  audience: Audience;
  formality: Formality;
  domain: Domain;
  intent: Intent;
  dialect: Dialect;
}

export interface Paragraph {
  /** Index within the document, 0-based. */
  index: number;
  /** Offset of the paragraph's first character in the full plain text. */
  start: number;
  text: string;
  /** Hash of `text` (plus goals) used as the cache key. */
  hash: string;
}

export interface CheckRequest {
  /** Unique id per text field instance; used to route results and cancel stale checks. */
  fieldId: string;
  /** Monotonic version of the field text; results for an older version are discarded. */
  version: number;
  /** Full plain text of the field. */
  text: string;
  /** Paragraph split of `text`; the engine checks only paragraphs whose hash is not cached. */
  paragraphs: Paragraph[];
  goals: WritingGoals;
  /** Which categories the user has enabled. */
  categories: SuggestionCategory[];
  /** Host page origin, for per-site rules and prompts (e.g. email vs. chat). */
  origin: string;
  /** Hints from the adapter: e.g. the field is a single-line input or a chat box. */
  fieldKind: FieldKind;
}

export interface CheckResult {
  fieldId: string;
  version: number;
  suggestions: Suggestion[];
  tone?: ToneAnalysis;
  score?: WritingScore;
  /** True when every paragraph was served from cache (no network). */
  fromCache: boolean;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  error?: CheckError;
}

export interface CheckError {
  code: 'no-api-key' | 'auth' | 'rate-limit' | 'network' | 'refusal' | 'invalid-response' | 'unknown';
  message: string;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Field adapters (content script)
// ---------------------------------------------------------------------------

export type FieldKind = 'textarea' | 'input' | 'contenteditable';

export interface FieldSnapshot {
  fieldId: string;
  version: number;
  text: string;
  kind: FieldKind;
}

export interface Edit {
  range: TextRange;
  original: string;
  replacement: string;
}

/**
 * Abstracts a host text field. Implementations: TextareaAdapter (textarea + input), ContentEditableAdapter.
 * Offsets are always into getText()'s plain-text serialization.
 */
export interface FieldAdapter {
  readonly kind: FieldKind;
  readonly element: HTMLElement;
  getText(): string;
  /** Viewport-relative rects covering the text in `range` (one per line fragment). */
  getRangeRects(range: TextRange): DOMRect[];
  /** Apply a single edit; returns false if `original` no longer matches at `range`. Keeps the host's undo stack when possible. */
  applyEdit(edit: Edit): boolean;
  /** Apply many edits atomically (sorted and applied right-to-left); returns the number applied. */
  applyEdits(edits: Edit[]): number;
  getSelection(): TextRange | null;
  setSelection(range: TextRange): void;
  /** Subscribe to text changes; the callback receives the new text and a version number. */
  onChange(cb: (text: string, version: number) => void): () => void;
  /** Subscribe to layout changes that require re-drawing overlays (scroll, resize, reflow). */
  onLayout(cb: () => void): () => void;
  isFocused(): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Settings (chrome.storage)
// ---------------------------------------------------------------------------

export type EngineProvider = 'anthropic' | 'mock';

export interface Settings {
  enabled: boolean;
  /** Anthropic API key; stored in chrome.storage.local only, never synced. */
  apiKey: string;
  provider: EngineProvider;
  /** Primary model for full checks. */
  model: string;
  /** Cheaper model for the fast first pass while typing. */
  fastModel: string;
  goals: WritingGoals;
  categories: Record<SuggestionCategory, boolean>;
  /** Hostnames where the assistant is turned off. */
  disabledSites: string[];
  showFloatingButton: boolean;
  /** Milliseconds of idle typing before a check is sent. */
  debounceMs: number;
  /** Personal dictionary of words never flagged as misspelled. */
  dictionary: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  apiKey: '',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  fastModel: 'claude-haiku-5-5',
  goals: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform', dialect: 'american' },
  categories: { correctness: true, clarity: true, engagement: true, delivery: true },
  disabledSites: [],
  showFloatingButton: true,
  debounceMs: 900,
  dictionary: [],
};

// ---------------------------------------------------------------------------
// Messaging (content script <-> service worker <-> side panel / popup)
// ---------------------------------------------------------------------------

/** Messages sent TO the service worker. */
export type BackgroundRequest =
  | { type: 'check'; request: CheckRequest }
  | { type: 'cancel'; fieldId: string }
  | { type: 'get-settings' }
  | { type: 'set-settings'; patch: Partial<Settings> }
  | { type: 'test-api-key'; apiKey: string }
  | { type: 'open-side-panel' }
  | { type: 'field-state'; state: FieldState } // content -> background, for the panel
  | { type: 'panel-action'; action: PanelAction }; // panel -> background -> content

/** Replies FROM the service worker. */
export type BackgroundResponse =
  | { type: 'check-result'; result: CheckResult }
  | { type: 'settings'; settings: Settings }
  | { type: 'ok' }
  | { type: 'error'; error: CheckError };

/** Snapshot of a field's suggestions that the side panel renders. */
export interface FieldState {
  tabId?: number;
  fieldId: string;
  origin: string;
  version: number;
  text: string;
  suggestions: Suggestion[];
  tone?: ToneAnalysis;
  score?: WritingScore;
  status: 'idle' | 'checking' | 'error' | 'disabled';
  error?: CheckError;
  /** True for the field currently focused in the page. */
  active: boolean;
}

/** Actions the side panel can ask the content script to perform. */
export type PanelAction =
  | { type: 'accept'; fieldId: string; suggestionId: string }
  | { type: 'dismiss'; fieldId: string; suggestionId: string }
  | { type: 'accept-all'; fieldId: string; group: AcceptGroup | 'all' }
  | { type: 'focus'; fieldId: string; suggestionId: string }
  | { type: 'recheck'; fieldId: string }
  | { type: 'undo'; fieldId: string };

/** Messages broadcast from background to side panel pages. */
export type PanelEvent =
  | { type: 'field-state'; state: FieldState }
  | { type: 'field-removed'; fieldId: string }
  | { type: 'settings'; settings: Settings };
