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
 * Tier A: mechanical, unambiguous correctness fixes: category correctness, kind replace|delete|insert,
 *         severity error, confidence >= 0.85, meaningPreserving, autoApplySafe, anchor exact, within one sentence.
 * Tier B: clarity/engagement/delivery span edits with confidence >= 0.7 and meaningPreserving.
 * Tier C: rewrites (kind 'rewrite'), flags, and anything with meaningPreserving === false; never bulk-applied.
 * "Accept all grammar" applies A; "Accept all style" applies B; "Accept everything" applies A ∪ B and leaves C pending.
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

/** How the model's verbatim anchor was located: exact string match, or a length-preserving normalized match. */
export type AnchorQuality = 'exact' | 'normalized';

export interface Suggestion {
  /** Stable across passes and re-checks: hash(fieldId, blockHash, fingerprint, ordinalInBlock). */
  id: string;
  category: SuggestionCategory;
  /** Controlled vocabulary from the engine contract, e.g. "spelling", "subject_verb_agreement", "wordy_phrase", "hedging". */
  rule: string;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  source: SuggestionSource;
  tier: SuggestionTier;
  anchor: AnchorQuality;
  /** Absolute offsets into the field text at the version the suggestion is currently rebased to. */
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
  /** Block (paragraph) the suggestion came from ("b<index>") and the hash of its text at request time. */
  blockId: string;
  blockHash: string;
  /** Ids of span suggestions inside this rewrite's sentence, or of the rewrite a span sits inside. */
  conflictsWith: string[];
  /** A rewrite whose sentence was edited underneath it; the card says "sentence changed" until re-checked. */
  stale: boolean;
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

/** 'scratch' is the side panel's own text area (paste -> check -> accept all -> copy), used for canvas apps. */
export type FieldKind = 'textarea' | 'input' | 'contenteditable' | 'gdocs' | 'scratch';

export interface Paragraph {
  /** Index within the document, 0-based. */
  index: number;
  /** Offset of the paragraph's first character in the full plain text. */
  start: number;
  text: string;
  /** Hash of `text` only. The engine combines it with the prompt configuration into a cache key. */
  hash: string;
}

export type CheckPass = 'rules' | 'fast' | 'deep';

/** Ranks passes so the worker keeps the best result per block (deep > fast > rules). */
export const PASS_RANK: Record<CheckPass, number> = { rules: 0, fast: 1, deep: 2 };

/**
 * Field facts only. The service worker merges device settings, the profile document and learned state into
 * the prompt; the content script never carries profile-derived inputs.
 */
export interface CheckRequest {
  /** Unique per field instance; assigned by the content script (or "panel:<n>" for scratch checks). */
  fieldId: string;
  /** Monotonic text version; results for an older version are rebased stepwise or discarded. */
  version: number;
  /** Full plain text of the field. */
  text: string;
  /** Paragraph split of `text` (see splitParagraphs). */
  blocks: Paragraph[];
  /** Block hashes that changed since the last check, or 'all'. */
  dirtyBlockHashes: string[] | 'all';
  pass: CheckPass;
  host: string;
  context: WritingContext;
  fieldKind: FieldKind;
  /** DOM-derived ranges that must never be flagged or edited (mentions, chips, quoted replies, signatures, zero-width). */
  protectedRanges: TextRange[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface CheckedBlock {
  hash: string;
  /** Best pass available for this block after supersession. */
  pass: CheckPass;
  model?: string;
  fromCache: boolean;
}

export interface CheckResult {
  fieldId: string;
  version: number;
  pass: CheckPass;
  /** Merged best-per-block suggestions for the whole field, anchored to `version`, dismissal-filtered. */
  suggestions: Suggestion[];
  /** Only present when the request covered every block (so the tone describes the whole field). */
  tone?: ToneAnalysis;
  consistency?: ConsistencyNote[];
  score?: WritingScore;
  /** True when every block was served from cache (no network). */
  fromCache: boolean;
  usage?: TokenUsage;
  model?: string;
  error?: CheckError;
  blocks: CheckedBlock[];
}

export type CheckErrorCode =
  | 'no-api-key'
  /** First-run consent not recorded yet (settings.privacy.consentAt is null); local rules still run. */
  | 'consent-required'
  /** The device's daily budget is exhausted and even the fast model would exceed it. */
  | 'budget'
  | 'auth'
  | 'rate-limit'
  | 'spend-cap'
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
  /** 1-based index of this exact `original` string counting from the block start (locateSpan takes occurrence - 1). */
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

/**
 * What the worker caches per (cache key, block hash): block-relative, so a paragraph that moves in the field
 * still serves correct offsets. Absolute `range`/`highlight`, `blockId` and `id` are derived at serve time.
 */
export type CachedSuggestion = Omit<Suggestion, 'id' | 'range' | 'highlight' | 'blockId' | 'conflictsWith' | 'stale' | 'learnedState'> & {
  rel: TextRange;
  relHighlight: TextRange;
  ordinalInBlock: number;
};

// ---------------------------------------------------------------------------
// Edits (applying suggestions)
// ---------------------------------------------------------------------------

export interface Edit {
  range: TextRange;
  original: string;
  replacement: string;
}

export type EditRung = 'native' | 'execCommand' | 'beforeinput' | 'paste' | 'splice' | 'gdocs';

export interface EditOutcome {
  status: 'applied' | 'reverted' | 'mismatch' | 'unsupported' | 'composing';
  rung: EditRung | null;
  /** Field text after the attempt (verified immediately, at the next frame and at +150 ms). */
  text: string;
}

export interface BatchEditOutcome {
  applied: Edit[];
  skipped: { edit: Edit; reason: EditOutcome['status'] }[];
  text: string;
  /** How many native undo steps the host editor recorded (execCommand: one per edit; splice: 0). */
  nativeUndoSteps: number;
}

export interface AcceptAllScope {
  group: AcceptGroup | 'all';
  /** Optional explicit subset chosen in the preview. */
  suggestionIds?: string[];
}

/** One undoable transaction. Undo applies the inverse edits through the same adapter ladder. */
export interface ApplyTransaction {
  id: string;
  fieldId: string;
  at: string;
  /** Edits as applied, with post-apply ranges (replacement now sits at `range`). */
  edits: Edit[];
  /** What was applied, for the "Recently applied" list (one row per suggestion, same order as appliedIds). */
  items: { id: string; title: string; category: SuggestionCategory; original: string; replacement: string }[];
  appliedIds: string[];
  /** Ids reverted individually or by a native undo since. */
  revertedIds: string[];
}

export interface ApplyReport {
  fieldId: string;
  appliedIds: string[];
  skippedIds: string[];
  /** Tier-C rewrites left pending by "Accept everything" (marked stale and re-checked). */
  pendingRewriteIds: string[];
  transactionId: string;
}

// ---------------------------------------------------------------------------
// Device-local settings (chrome.storage.local, never synced)
// ---------------------------------------------------------------------------

export type EngineProvider = 'anthropic' | 'mock';

/** hybrid: Haiku while typing, Opus when idle. quality: Opus only. economy: Haiku only. */
export type EngineMode = 'hybrid' | 'quality' | 'economy';

/**
 * Per-device state. The Anthropic API key is entered on every device and never synced or distributed
 * by the web app. Engine mode and model ids here apply only while unpaired; once paired the profile's
 * settings are authoritative and overwrite them on first sync.
 */
export interface DeviceSettings {
  enabled: boolean;
  provider: EngineProvider;
  mode: EngineMode;
  /** Deep-pass model id. */
  model: string;
  /** Fast-pass model id. */
  fastModel: string;
  /** Anthropic API key for this device. Stored with setAccessLevel('TRUSTED_CONTEXTS') when available. */
  apiKey: string;
  debounceMs: number;
  showFloatingButton: boolean;
  showUnderlines: boolean;
  colorblindMode: boolean;
  /** Google Docs inline mode: 'auto' enables the bridge only when Docs exposes the annotated-text API for our id. */
  gdocsInline: 'auto' | 'off';
  /**
   * Daily spend cap in USD for this device (0 = no limit). When today's cost reaches it the worker skips deep passes
   * (behaves as 'economy'); when even the fast model would exceed it, checks answer error.code 'budget'.
   */
  dailyBudgetUsd: number;
  /** Pairing with the web app; null when unpaired. */
  pairing: DevicePairing | null;
}

export interface DevicePairing {
  /** Compiled production origin of the web app; the worker verifies sender.origin against this value. */
  appOrigin: string;
  deviceId: string;
  /** Bearer token "jm1.<deviceId>.<secret>". */
  token: string;
  pairedAt: string;
}

/** Sync bookkeeping persisted next to the profile in chrome.storage.local. */
export interface SyncState {
  etag: string;
  version: number;
  lastPollAt: string;
  lastPushAt: string;
  lastEventUploadAt: string;
  pendingOps: ProfileOp[];
  /** 'paused' when the server reported quota exhaustion; the UI shows "sync paused". */
  status: 'ok' | 'offline' | 'paused' | 'revoked';
  eventUploadsToday: number;
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
  gdocsInline: 'auto',
  dailyBudgetUsd: 2,
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
  mode: EngineMode;
  goals: WritingGoals;
  dialect: Dialect;
  categories: Record<SuggestionCategory, boolean>;
  debounceMs: number;
  /** Multipliers from the site profile (Superhuman/Slashy slow the cadence). */
  fastPassIdleMs: number;
  deepPassIdleMs: number;
  showFloatingButton: boolean;
  showUnderlines: boolean;
  colorblindMode: boolean;
  /** Shortcut-heavy hosts (Superhuman, Slashy, Gmail): the card never claims single-letter shortcuts. */
  shortcutSafeMode: boolean;
  /** Honour the field even when the site set an opt-out attribute (Slack sets data-gramm="false"). */
  ignoreSiteOptOut: boolean;
  /** Also check fields that sites opted out (global user setting). */
  checkOptedOutFields: boolean;
  mutedRules: string[];
  demotedRules: string[];
  dictionary: string[];
  styleDecisions: StyleDecisions;
  storeSnippets: boolean;
  /** The engine is usable (key present or mock provider). */
  engineReady: boolean;
  /** First-run consent recorded (settings.privacy.consentAt). Until then the button shows 'setup' and no text leaves the device. */
  consented: boolean;
  /** Today's spend reached dailyBudgetUsd: deep passes are skipped; the button shows a budget chip. */
  budgetExhausted: boolean;
  /** Google Docs: our own id, used by the isolated-world adapter to call the annotated-text API. */
  gdocsAnnounceId: string;
  gdocsInline: 'auto' | 'off';
  /** Random per-account salt used to derive stable, unlinkable document keys (docKey). */
  userSalt: string;
}

// ---------------------------------------------------------------------------
// Field state (what the side panel and popup render)
// ---------------------------------------------------------------------------

/** 'setup' = first-run consent or API key missing (click opens the options page). Error sub-kinds travel in CheckError.code. */
export type FieldStatus = 'setup' | 'idle' | 'checking' | 'clean' | 'suggestions' | 'error' | 'off' | 'unsupported';

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
  /** Highest pass that has covered every block ('rules' until the engine answers). */
  checkedBy: CheckPass;
  error?: CheckError;
  /** The focused field in its tab. */
  active: boolean;
  usage?: TokenUsage;
  /** Undo transactions available (= transactions.length). */
  undoAvailable: number;
  /** Recent apply transactions, newest first, at most 20, for the panel's "Recently applied" list and per-item revert. */
  transactions: ApplyTransaction[];
}

// ---------------------------------------------------------------------------
// Port messaging (content script <-> service worker <-> side panel)
// ---------------------------------------------------------------------------

export type PortRole = 'content' | 'sidepanel';

/** Sent by content scripts to the worker over a long-lived port. */
export type ContentToWorker =
  | { type: 'hello'; role: 'content'; host: string; href: string; frameToken: string; extVersion: string }
  | { type: 'field-attached'; fieldId: string; fieldKind: FieldKind; label: string; docKey: string }
  | { type: 'field-detached'; fieldId: string }
  | { type: 'check'; request: CheckRequest }
  | { type: 'cancel'; fieldId: string }
  | { type: 'field-state'; state: Omit<FieldState, 'tabId' | 'frameId'> }
  | { type: 'feedback'; events: FeedbackEventInput[] }
  | { type: 'voice-samples'; samples: VoiceSample[] }
  | { type: 'dismiss'; fieldId: string; suggestionId: string; fingerprint: string; rule: string; docKey: string; reason?: DismissReason }
  | { type: 'add-to-dictionary'; word: string }
  | { type: 'mute-rule'; rule: string; scope: 'host' | 'global' }
  | { type: 'toggle-host'; enabled: boolean }
  | { type: 'apply-report'; report: ApplyReport }
  /** Sent every 20 s while a request is outstanding to keep the worker alive. */
  | { type: 'ping' };

/** Sent by the worker to content scripts. */
export type WorkerToContent =
  | { type: 'config'; config: EffectiveConfig }
  | { type: 'check-progress'; fieldId: string; version: number; pass: CheckPass; stage: 'queued' | 'sent' | 'streaming' | 'deep-scheduled' }
  | { type: 'check-result'; result: CheckResult }
  /** Separate whole-field tone call (>= 150 chars, 1.5 s idle, text-hash cached). */
  | { type: 'tone'; fieldId: string; version: number; tone: ToneAnalysis }
  | { type: 'panel-action'; action: PanelAction }
  | { type: 'ping' };

/** Sent by the side panel to the worker. */
export type PanelToWorker =
  | { type: 'hello'; role: 'sidepanel'; windowId?: number }
  | { type: 'panel-action'; action: PanelAction }
  | { type: 'check'; request: CheckRequest }
  | { type: 'cancel'; fieldId: string }
  /** scope 'host' writes sites.overrides[host].goals; 'global' writes settings.goals. Re-checks open fields. */
  | { type: 'set-goals'; goals: WritingGoals; scope: 'host' | 'global'; host?: string }
  | { type: 'set-categories'; categories: Record<SuggestionCategory, boolean> }
  | { type: 'dismiss'; fieldId: string; suggestionId: string; fingerprint: string; rule: string; docKey: string; reason?: DismissReason }
  | { type: 'add-to-dictionary'; word: string }
  | { type: 'mute-rule'; rule: string; scope: 'host' | 'global'; host?: string };

/** Sent by the worker to the side panel. Never carries secrets. */
export type WorkerToPanel =
  | { type: 'fields'; fields: FieldState[] }
  | { type: 'field-state'; state: FieldState }
  | { type: 'field-removed'; fieldId: string }
  | { type: 'check-progress'; fieldId: string; version: number; pass: CheckPass; stage: 'queued' | 'sent' | 'streaming' | 'deep-scheduled' }
  | { type: 'check-result'; result: CheckResult }
  | { type: 'tone'; fieldId: string; version: number; tone: ToneAnalysis }
  | { type: 'config'; config: EffectiveConfig; settings: PublicDeviceSettings; sync: SyncState | null };

/** Device settings minus secrets, safe for pages other than the worker. */
export type PublicDeviceSettings = Omit<DeviceSettings, 'apiKey' | 'pairing'> & { hasApiKey: boolean; paired: boolean; appOrigin: string | null };

export type PortMessage = ContentToWorker | WorkerToContent | PanelToWorker | WorkerToPanel;

/** Actions the panel (or a command) asks a content script to perform on a field. */
export type PanelAction =
  | { type: 'accept'; fieldId: string; suggestionId: string; alternativeIndex?: number }
  | { type: 'dismiss'; fieldId: string; suggestionId: string; reason?: DismissReason }
  | { type: 'accept-all'; fieldId: string; scope: AcceptAllScope }
  | { type: 'focus'; fieldId: string; suggestionId: string }
  | { type: 'recheck'; fieldId: string }
  | { type: 'undo'; fieldId: string; transactionId?: string }
  | { type: 'revert'; fieldId: string; suggestionId: string }
  /** Grammarly's per-category trash: dismiss every pending suggestion of one category in the field. */
  | { type: 'dismiss-all'; fieldId: string; category: SuggestionCategory };

// ---------------------------------------------------------------------------
// Request/response messaging (options, popup, content click handlers -> worker) via chrome.runtime.sendMessage.
// 'open-side-panel' must travel this way from a click handler so the user gesture reaches sidePanel.open().
// ---------------------------------------------------------------------------

export type RuntimeRequest =
  | { type: 'get-settings' }
  | { type: 'set-settings'; patch: Partial<DeviceSettings> }
  | { type: 'get-profile' }
  /** Pages send ops with hlc '' and the worker stamps them with its clock before applying and queueing. */
  | { type: 'profile-ops'; ops: ProfileOp[] }
  | { type: 'test-api-key'; apiKey: string }
  | { type: 'pair'; pairingId: string; code: string }
  | { type: 'unpair' }
  | { type: 'sync-now' }
  | { type: 'learn-voice-now'; context: VoiceContext }
  | { type: 'get-learning-summary' }
  | { type: 'get-usage' }
  | { type: 'get-host-status'; host: string }
  | { type: 'set-host-enabled'; host: string; enabled: boolean }
  | { type: 'open-side-panel' }
  | { type: 'get-sync-state' }
  | { type: 'ping' };

export type RuntimeResponse =
  | { ok: true; type: 'settings'; settings: PublicDeviceSettings }
  | { ok: true; type: 'profile'; profile: ProfileDocument }
  | { ok: true; type: 'api-key-test'; valid: boolean; model?: string; message?: string }
  | { ok: true; type: 'paired'; deviceId: string; appOrigin: string }
  | { ok: true; type: 'learning-summary'; summary: LearningSummary }
  | { ok: true; type: 'usage'; usage: UsageTotals }
  | { ok: true; type: 'host-status'; host: string; enabled: boolean }
  | { ok: true; type: 'voice'; profile: VoiceProfile }
  | { ok: true; type: 'sync-state'; sync: SyncState | null }
  | { ok: true; type: 'ok' }
  | { ok: false; error: { code: string; message: string } };

export interface UsageTotals {
  today: TokenUsage & { requests: number };
  month: TokenUsage & { requests: number };
}

/** Emoji for the tone chip (Grammarly's seed map plus neutral fallbacks); unknown labels use TONE_EMOJI_FALLBACK. */
export const TONE_EMOJI: Record<string, string> = {
  formal: '👔',
  informal: '😎',
  confident: '🤝',
  uncertain: '🤔',
  appreciative: '🙌',
  joyful: '🙂',
  encouraging: '💪',
  friendly: '😊',
  optimistic: '🌤️',
  neutral: '😐',
  direct: '🎯',
  assertive: '💼',
  urgent: '⏰',
  apologetic: '🙏',
  worried: '😟',
  sad: '😔',
  frustrated: '😤',
  disapproving: '😒',
  curious: '🧐',
  analytical: '📊',
  excited: '🤩',
  respectful: '🤲',
  sarcastic: '🙃',
};
export const TONE_EMOJI_FALLBACK = '💬';

// Re-exported so this file remains the single import for message contracts.
import type { ProfileDocument, ProfileOp, VoiceContext, VoiceProfile } from './profile';
import type { DismissReason, FeedbackEventInput, LearningSummary, VoiceSample } from './learning';
export type { ProfileDocument, ProfileOp, VoiceContext, VoiceProfile, DismissReason, FeedbackEventInput, LearningSummary, VoiceSample };
