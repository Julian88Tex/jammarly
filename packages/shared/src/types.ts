/**
 * Core contracts shared by the extension (content script, service worker, side panel, options, popup),
 * the web app and the shared engine code. Dependency-free and DOM-free: this file must load in a service
 * worker, in Node and in jsdom. DOM-specific contracts (FieldAdapter) live in apps/extension.
 *
 * See docs/ARCHITECTURE.md for the design these types implement.
 */

// ---------------------------------------------------------------------------
// Suggestion model
// ---------------------------------------------------------------------------

/** Grammarly's four outcomes; each maps to an underline color. */
export type SuggestionCategory = 'correctness' | 'clarity' | 'engagement' | 'delivery';

export const CATEGORIES: readonly SuggestionCategory[] = ['correctness', 'clarity', 'engagement', 'delivery'];

/** The two "Accept all" buckets. Correctness is mechanical; everything else is a judgment call about voice. */
export type AcceptGroup = 'grammar' | 'style';

export const CATEGORY_TO_GROUP: Record<SuggestionCategory, AcceptGroup> = {
  correctness: 'grammar',
  clarity: 'style',
  engagement: 'style',
  delivery: 'style',
};

/**
 * Tier A: mechanical, unambiguous correctness fixes (auto-apply safe).
 * Tier B: style/clarity/delivery span edits that preserve meaning.
 * Tier C: sentence rewrites (kind 'rewrite') with alternatives; never bulk-applied.
 */
export type SuggestionTier = 'A' | 'B' | 'C';

export type SuggestionKind = 'replace' | 'delete' | 'insert' | 'rewrite' | 'flag';

export type SuggestionSeverity = 'error' | 'warning' | 'suggestion';

export type SuggestionSource = 'rules' | 'llm' | 'both';

/** Half-open range of UTF-16 code-unit offsets into the field's plain text. */
export interface TextRange {
  start: number;
  end: number;
}

/** Learned visibility state attached by the service worker after the deterministic learner runs. */
export type SuggestionLearnedState = 'active' | 'demoted' | 'probe';

export interface Suggestion {
  /** Stable id for the suggestion's lifetime in a field session. */
  id: string;
  category: SuggestionCategory;
  /** Controlled vocabulary from the engine contract, e.g. "spelling", "subject_verb_agreement", "wordy_phrase", "hedging". */
  rule: string;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  source: SuggestionSource;
  tier: SuggestionTier;
  /** Absolute offsets into the field text at `version`. Edits replace exactly this range. */
  range: TextRange;
  /** Hover target. Equals `range` except for pure insertions, where it covers the adjacent word. */
  highlight: TextRange;
  /** Exact text at `range`. Re-validated before every apply. */
  original: string;
  /** Replacement text; "" for deletions; identical to `original` for kind "flag". */
  replacement: string;
  /** Extra options (rewrites only). */
  alternatives: string[];
  /** Short card title, e.g. "Correct the spelling". */
  title: string;
  /** One or two plain sentences, at most 140 characters from the model. */
  explanation: string;
  /** 0..1. Rules emit 1 for mechanical fixes. */
  confidence: number;
  meaningPreserving: boolean;
  autoApplySafe: boolean;
  /** Block (paragraph) the suggestion came from and the hash of its text at request time. */
  blockId: string;
  blockHash: string;
  /** Engine provenance. */
  model?: string;
  promptVersion: string;
  /** hash(rule, normalized original, normalized replacement): dismissal memory key. */
  fingerprint: string;
  learnedState: SuggestionLearnedState;
}

export type ToneStrength = 'slight' | 'moderate' | 'strong';

export interface ToneLabel {
  /** e.g. "confident", "friendly", "formal", "worried", "direct" (engine vocabulary, lowercase). */
  label: string;
  strength: ToneStrength;
}

export interface ToneAnalysis {
  labels: ToneLabel[];
  /** One sentence for the UI, e.g. "Sounds confident and a little informal." */
  summary: string;
}

export interface ConsistencyNote {
  /** Observed variants, e.g. ["US", "U.S."] */
  variants: string[];
  recommended: string;
  explanation: string;
}

export interface WritingScore {
  /** 0..100. */
  overall: number;
  wordCount: number;
  readingTimeSeconds: number;
  /** Flesch-Kincaid grade approximation. */
  readability?: number;
}

// ---------------------------------------------------------------------------
// Goals, dialect, context
// ---------------------------------------------------------------------------

export type Formality = 'informal' | 'neutral' | 'formal';
export type Audience = 'general' | 'knowledgeable' | 'expert';
export type Domain = 'general' | 'academic' | 'business' | 'email' | 'casual' | 'creative' | 'technical';
export type Intent = 'inform' | 'describe' | 'convince' | 'tell_a_story';
export type Dialect = 'en-US' | 'en-GB' | 'en-CA' | 'en-AU' | 'en-IN';

export interface WritingGoals {
  audience: Audience;
  formality: Formality;
  domain: Domain;
  intent: Intent;
}

/** Writing context inferred from the host (overridable per site). Drives defaults and learning scopes. */
export type WritingContext = 'email' | 'chat' | 'doc' | 'social' | 'code' | 'other';

/** Document-level style decisions the user has made or that were learned (feature -> chosen value). */
export type StyleDecisions = Record<string, string>;

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export type FieldKind = 'textarea' | 'input' | 'contenteditable' | 'gdocs';

export interface Paragraph {
  /** Index within the document, 0-based. */
  index: number;
  /** Offset of the paragraph's first character in the full plain text. */
  start: number;
  text: string;
  /** Hash of `text` only. The engine combines it with prompt/model/goals into a cache key. */
  hash: string;
}

export type CheckPass = 'rules' | 'fast' | 'deep';

export interface CheckRequest {
  /** Unique per field instance; assigned by the content script. */
  fieldId: string;
  /** Monotonic text version; results for an older version are rebased or discarded. */
  version: number;
  /** Full plain text of the field. */
  text: string;
  /** Paragraph split of `text` (see splitParagraphs). */
  blocks: Paragraph[];
  /** Blocks that changed since the last check (hashes); empty means "all". */
  dirtyBlockHashes: string[];
  pass: CheckPass;
  goals: WritingGoals;
  dialect: Dialect;
  categories: SuggestionCategory[];
  host: string;
  context: WritingContext;
  fieldKind: FieldKind;
  styleDecisions: StyleDecisions;
  /** Words never flagged as misspelled (dictionary + protected terms). */
  protectedTerms: string[];
  /** Free-text instructions from the user's tuning page (max 2000 chars). */
  customInstructions: string;
  /** Rule ids the learner has muted for this host/context. */
  mutedRules: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface CheckResult {
  fieldId: string;
  version: number;
  pass: CheckPass;
  /** Suggestions for the whole field (cached blocks included), anchored to `version`. */
  suggestions: Suggestion[];
  tone?: ToneAnalysis;
  consistency?: ConsistencyNote[];
  score?: WritingScore;
  /** True when every block was served from cache (no network). */
  fromCache: boolean;
  usage?: TokenUsage;
  model?: string;
  error?: CheckError;
  /** Block hashes that were checked by this pass (cached or fresh). */
  blockHashes: string[];
}

export type CheckErrorCode =
  | 'no-api-key'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'refusal'
  | 'truncated'
  | 'invalid-response'
  | 'cancelled'
  | 'disabled'
  | 'unknown';

export interface CheckError {
  code: CheckErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Engine output contract (what the model returns, before anchoring). Mirrors the JSON schema in
// @jammarly/shared/prompts. Kept here so the worker, tests and the web app agree on the shape.
// ---------------------------------------------------------------------------

export interface EngineSuggestion {
  id: string;
  category: SuggestionCategory;
  rule: string;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  /** Verbatim text copied from exactly one block. Never empty. */
  original: string;
  /** 1-3 verbatim words before/after `original` ("" at a block edge). */
  prefix: string;
  suffix: string;
  /** 1-based index of this exact `original` string counting from the block start. */
  occurrence: number;
  replacement: string;
  alternatives: string[];
  explanation: string;
  confidence: number;
  meaning_preserving: boolean;
  auto_apply_safe: boolean;
}

export interface EngineBlockResult {
  block_id: string;
  suggestions: EngineSuggestion[];
}

export interface EngineOutput {
  blocks: EngineBlockResult[];
  document: {
    tone: ToneLabel[];
    consistency: ConsistencyNote[];
    notes: string;
  };
}

// ---------------------------------------------------------------------------
// Edits (applying suggestions)
// ---------------------------------------------------------------------------

export interface Edit {
  range: TextRange;
  original: string;
  replacement: string;
}

export interface AcceptAllScope {
  group: AcceptGroup | 'all';
  /** Optional explicit subset chosen in the preview. */
  suggestionIds?: string[];
}

export interface ApplyReport {
  fieldId: string;
  appliedIds: string[];
  skippedIds: string[];
  /** Tier-C rewrites left pending by "Accept everything". */
  pendingRewriteIds: string[];
  /** Undo token for the transaction. */
  transactionId: string;
}

// ---------------------------------------------------------------------------
// Device-local settings (chrome.storage.local, never synced)
// ---------------------------------------------------------------------------

export type EngineProvider = 'anthropic' | 'mock';

/** hybrid: Haiku while typing, Opus when idle. quality: Opus only. economy: Haiku only. */
export type EngineMode = 'hybrid' | 'quality' | 'economy';

export interface DeviceSettings {
  enabled: boolean;
  provider: EngineProvider;
  mode: EngineMode;
  /** Deep-pass model id. */
  model: string;
  /** Fast-pass model id. */
  fastModel: string;
  /** Used when the profile document carries no key (unpaired installs). */
  apiKey: string;
  debounceMs: number;
  showFloatingButton: boolean;
  showUnderlines: boolean;
  colorblindMode: boolean;
  /** Keep <=200-char redacted snippets in feedback events (needed for voice learning). */
  storeSnippets: boolean;
  /** Google Docs inline mode: 'auto' enables the bridge only when Docs exposes the annotated-text API for our id. */
  gdocsInline: 'auto' | 'off';
  /** Pairing with the web app; null when unpaired. */
  pairing: DevicePairing | null;
}

export interface DevicePairing {
  appOrigin: string;
  deviceId: string;
  /** Bearer token "jm1.<deviceId>.<secret>". */
  token: string;
  pairedAt: string;
  lastSyncAt?: string;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  enabled: true,
  provider: 'anthropic',
  mode: 'hybrid',
  model: 'claude-opus-5-5',
  fastModel: 'claude-haiku-5-5',
  apiKey: '',
  debounceMs: 700,
  showFloatingButton: true,
  showUnderlines: true,
  colorblindMode: false,
  storeSnippets: true,
  gdocsInline: 'auto',
  pairing: null,
};

/**
 * What a content script needs to behave on a given host. Computed by the service worker from
 * DeviceSettings + ProfileDocument + learned state, and pushed over the port.
 */
export interface EffectiveConfig {
  enabled: boolean;
  /** False when the user turned Jammarly off for this host. */
  enabledOnHost: boolean;
  host: string;
  context: WritingContext;
  goals: WritingGoals;
  dialect: Dialect;
  categories: Record<SuggestionCategory, boolean>;
  debounceMs: number;
  showFloatingButton: boolean;
  showUnderlines: boolean;
  colorblindMode: boolean;
  /** Shortcut-heavy hosts (Superhuman, Slashy, Gmail): the card never claims single-letter shortcuts. */
  shortcutSafeMode: boolean;
  mutedRules: string[];
  demotedRules: string[];
  dictionary: string[];
  styleDecisions: StyleDecisions;
  /** The engine is usable (key present or mock provider). */
  engineReady: boolean;
  /** Google Docs: id to announce to the annotated-canvas API (our own id; a dev build may override via env). */
  gdocsAnnounceId: string;
  gdocsInline: 'auto' | 'off';
  /** Random per-account salt used to derive stable, unlinkable document keys (docKey). */
  userSalt: string;
}

// ---------------------------------------------------------------------------
// Field state (what the side panel and popup render)
// ---------------------------------------------------------------------------

export type FieldStatus = 'idle' | 'checking' | 'clean' | 'suggestions' | 'error' | 'off' | 'unsupported';

export interface FieldState {
  fieldId: string;
  tabId: number;
  frameId: number;
  host: string;
  fieldKind: FieldKind;
  /** Short label for the panel, e.g. "Message body" or "Comment". */
  label: string;
  version: number;
  textPreview: string;
  wordCount: number;
  suggestions: Suggestion[];
  tone?: ToneAnalysis;
  score?: WritingScore;
  status: FieldStatus;
  error?: CheckError;
  /** The focused field in its tab. */
  active: boolean;
  usage?: TokenUsage;
  /** Undo transactions available, newest first. */
  undoAvailable: number;
}

// ---------------------------------------------------------------------------
// Port messaging (content script <-> service worker <-> side panel)
// ---------------------------------------------------------------------------

export type PortRole = 'content' | 'sidepanel';

/** Sent by content scripts to the worker. */
export type ContentToWorker =
  | { type: 'hello'; role: 'content'; host: string; href: string; frameToken: string }
  | { type: 'field-attached'; fieldId: string; fieldKind: FieldKind; label: string }
  | { type: 'field-detached'; fieldId: string }
  | { type: 'check'; request: CheckRequest }
  | { type: 'cancel'; fieldId: string }
  | { type: 'field-state'; state: Omit<FieldState, 'tabId' | 'frameId'> }
  | { type: 'feedback'; events: FeedbackEventInput[] }
  | { type: 'open-side-panel' }
  | { type: 'toggle-host'; enabled: boolean }
  | { type: 'apply-report'; report: ApplyReport };

/** Sent by the worker to content scripts. */
export type WorkerToContent =
  | { type: 'config'; config: EffectiveConfig }
  | { type: 'check-progress'; fieldId: string; version: number; pass: CheckPass; stage: 'queued' | 'sent' | 'streaming' }
  | { type: 'check-result'; result: CheckResult }
  | { type: 'panel-action'; action: PanelAction }
  | { type: 'ping' };

/** Sent by the side panel to the worker. */
export type PanelToWorker =
  | { type: 'hello'; role: 'sidepanel'; windowId?: number }
  | { type: 'panel-action'; action: PanelAction }
  | { type: 'set-goals'; goals: WritingGoals }
  | { type: 'set-categories'; categories: Record<SuggestionCategory, boolean> };

/** Sent by the worker to the side panel. */
export type WorkerToPanel =
  | { type: 'fields'; fields: FieldState[] }
  | { type: 'field-state'; state: FieldState }
  | { type: 'field-removed'; fieldId: string }
  | { type: 'config'; config: EffectiveConfig; settings: DeviceSettings };

export type PortMessage = ContentToWorker | WorkerToContent | PanelToWorker | WorkerToPanel;

/** Actions the panel (or a command) asks a content script to perform. */
export type PanelAction =
  | { type: 'accept'; fieldId: string; suggestionId: string; alternativeIndex?: number }
  | { type: 'dismiss'; fieldId: string; suggestionId: string; reason?: DismissReason }
  | { type: 'accept-all'; fieldId: string; scope: AcceptAllScope }
  | { type: 'focus'; fieldId: string; suggestionId: string }
  | { type: 'recheck'; fieldId: string }
  | { type: 'undo'; fieldId: string; transactionId?: string }
  | { type: 'add-to-dictionary'; fieldId: string; word: string }
  | { type: 'mute-rule'; fieldId: string; rule: string; scope: 'host' | 'global' };

// ---------------------------------------------------------------------------
// Request/response messaging (options, popup -> worker) via chrome.runtime.sendMessage
// ---------------------------------------------------------------------------

export type RuntimeRequest =
  | { type: 'get-settings' }
  | { type: 'set-settings'; patch: Partial<DeviceSettings> }
  | { type: 'get-profile' }
  | { type: 'profile-ops'; ops: ProfileOp[] }
  | { type: 'test-api-key'; apiKey: string }
  | { type: 'pair'; appOrigin: string; pairingId: string; code: string }
  | { type: 'unpair' }
  | { type: 'sync-now' }
  | { type: 'learn-voice-now'; context: VoiceContext }
  | { type: 'get-learning-summary' }
  | { type: 'get-usage' }
  | { type: 'get-host-status'; host: string }
  | { type: 'set-host-enabled'; host: string; enabled: boolean }
  | { type: 'open-side-panel'; tabId?: number }
  | { type: 'ping' };

export type RuntimeResponse =
  | { ok: true; type: 'settings'; settings: DeviceSettings }
  | { ok: true; type: 'profile'; profile: ProfileDocument }
  | { ok: true; type: 'api-key-test'; valid: boolean; model?: string; message?: string }
  | { ok: true; type: 'paired'; pairing: DevicePairing }
  | { ok: true; type: 'learning-summary'; summary: LearningSummary }
  | { ok: true; type: 'usage'; usage: UsageTotals }
  | { ok: true; type: 'host-status'; host: string; enabled: boolean }
  | { ok: true; type: 'voice'; profile: VoiceProfile }
  | { ok: true; type: 'ok' }
  | { ok: false; error: { code: string; message: string } };

export interface UsageTotals {
  today: TokenUsage & { requests: number };
  month: TokenUsage & { requests: number };
}

// Re-exported so this file remains the single import for message contracts.
import type { ProfileDocument, ProfileOp, VoiceContext, VoiceProfile } from './profile';
import type { DismissReason, FeedbackEventInput, LearningSummary } from './learning';
export type { ProfileDocument, ProfileOp, VoiceContext, VoiceProfile, DismissReason, FeedbackEventInput, LearningSummary };
