/**
 * The profile document: everything that is shared across a user's devices. Stored by the web app in
 * Vercel Blob (ETag CAS) and mirrored in chrome.storage.local on each device. Scalars are last-writer-wins
 * registers keyed by hybrid logical clocks; sets are add-wins observed-remove sets. The merge is
 * deterministic and runs identically on devices and the server (see ./merge.ts).
 */
import type { Dialect, StyleDecisions, SuggestionCategory, WritingContext, WritingGoals } from './types';

export const PROFILE_SCHEMA_VERSION = 1 as const;

/**
 * Hybrid logical clock "<13-digit wallMs>-<4-digit zero-padded counter>-<deviceId>". Fixed widths make plain
 * string comparison correct; compareHlc() in ./hlc.ts is the canonical comparison. The server rejects ops whose
 * wall time is more than 5 minutes ahead of its own clock (hlc_skew) and keeps its clock >= every value it sees.
 */
export type Hlc = string;

export interface Lww<T> {
  value: T;
  hlc: Hlc;
}

export interface OrSetElement<T> {
  value: T;
  addedHlc: Hlc;
  /** Present iff removed; element is live iff removedHlc is absent or addedHlc > removedHlc. */
  removedHlc?: Hlc;
}

export type VoiceContext = 'messages' | 'documents';

export interface VoiceTrait {
  id: string;
  label: string;
  description: string;
  dimension: 'register' | 'sentences' | 'punctuation' | 'vocabulary' | 'openings_closings' | 'tone' | 'stylistic_choices';
  evidenceCount: number;
  confidence: 'low' | 'medium' | 'high';
  locked: boolean;
}

export interface VoiceExamplePair {
  before: string;
  after: string;
}

export interface VoiceRejectedExample {
  before: string;
  proposed: string;
  keptOrFinal: string;
}

/** The synthesized voice profile for one context. Rendered into a cached system block by renderVoiceBlock(). */
export interface VoiceProfile {
  context: VoiceContext;
  version: number;
  generatedAt: string;
  generatedBy: string;
  confidence: 'provisional' | 'low' | 'medium' | 'high';
  summary: string;
  traits: VoiceTrait[];
  styleGuide: string;
  editorInstructions: string[];
  doNotFlagStyle: string[];
  keepPhrases: string[];
  avoidPhrases: string[];
  greetings: string[];
  signoffs: string[];
  acceptedPatterns: string[];
  rejectedPatterns: string[];
  examples: { accepted: VoiceExamplePair[]; rejected: VoiceRejectedExample[] };
  /** Deterministic facts computed from samples (sentence length, contraction rate, dash style...). */
  facts: Record<string, string>;
  changelog: string;
  /** Trait ids and phrases the user deleted; never re-introduced by synthesis. */
  removedByUser: string[];
}

export interface VoiceSettings {
  /** 0 = off, 1 = wording only, 2 = default, 3 = may propose voice-alignment rewrites. */
  strength: 0 | 1 | 2 | 3;
  /** Owner-written guidance appended to the voice block (max 2000 chars). */
  notes: string;
}

export interface PrivacySettings {
  storeSnippets: boolean;
  retentionDays: 30 | 90 | 365;
  learningEnabled: boolean;
  /** ISO time of the first-run "I agree" click; null until then (no text leaves the device before consent). */
  consentAt: string | null;
}

export interface SiteOverride {
  context?: WritingContext;
  /** Per-site goals ("For <host> only" in the Goals dialog); missing fields fall back to settings.goals. */
  goals?: Partial<WritingGoals>;
  categories?: Partial<Record<SuggestionCategory, boolean>>;
}

export interface RuleStats {
  shown: number;
  accepted: number;
  dismissed: number;
  ignored: number;
  reported: number;
  lastSeen: string;
}

/**
 * Visibility state resolved by the learner. Promotion is NOT a state: it is the orthogonal `eligibleForBulk` flag
 * (a rule can be active and promoted at once). Manual overrides live only in `rules.muted`.
 */
export type RuleState = 'active' | 'demoted' | 'suppressed' | 'probing';

export interface LearnedRuleState {
  state: RuleState;
  /** Correctness rules only, global scope: n >= 10 and Wilson lower bound >= 0.80. Promoted rules qualify for Tier A at confidence >= 0.70. */
  eligibleForBulk: boolean;
  scope: 'global' | 'ctx' | 'host';
  scopeKey: string;
  since: string;
  nextReprobe?: string;
  reprobeStage: number;
}

export interface ProfileDocument {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  /** Server-incremented on every accepted write; 0 for a fresh local document. */
  version: number;
  updatedAt: string;
  updatedBy: string;
  settings: {
    goals: Lww<WritingGoals>;
    dialect: Lww<Dialect>;
    categories: Lww<Record<SuggestionCategory, boolean>>;
    customInstructions: Lww<string>;
    styleDecisions: Lww<StyleDecisions>;
    mode: Lww<'hybrid' | 'quality' | 'economy'>;
    model: Lww<string>;
    fastModel: Lww<string>;
    /** Random 32-byte hex salt generated once per account; feeds docKey derivation. Never leaves the account. */
    userSalt: Lww<string>;
    /** Hosts where snippets are never stored (suffix match). */
    privateSites: Lww<string[]>;
    /** Consent, synced and enforced server-side: snippets are stripped on upload when storeSnippets is false. */
    privacy: Lww<PrivacySettings>;
    /** Per-site "check here anyway" overrides of a site's opt-out attribute. */
    ignoreOptOutHosts: Lww<string[]>;
    checkOptedOutFields: Lww<boolean>;
  };
  dictionary: OrSetElement<string>[];
  rules: {
    muted: OrSetElement<string>[];
    /** rule id -> weight 0..2 used when ranking. */
    weights: Record<string, Lww<number>>;
  };
  sites: {
    disabled: OrSetElement<string>[];
    overrides: Record<string, Lww<SiteOverride>>;
  };
  voice: {
    settings: Lww<VoiceSettings>;
    profiles: Partial<Record<VoiceContext, VoiceProfile>>;
  };
  learning: {
    /**
     * The whole learning section is replaced wholesale by whichever side carries the newer updatedHlc.
     * When paired, the web app folds uploaded events and is authoritative; an unpaired device folds locally.
     * This avoids double counting the same events on both sides.
     */
    updatedHlc: Hlc;
    /** "<scope>|<scopeKey>|<rule>" -> stats */
    stats: Record<string, RuleStats>;
    /** rule id -> learned state (resolved across scopes by the learner). */
    ruleStates: Record<string, LearnedRuleState>;
    dictionaryCandidates: string[];
    dialectInferred?: Dialect;
    history: { at: string; eventsSeen: number; changelog: string; model: string; version: number }[];
    lastEventCursor: string;
  };
}

/** LWW register paths a device may set. */
export type LwwPath =
  | 'settings.goals'
  | 'settings.dialect'
  | 'settings.categories'
  | 'settings.customInstructions'
  | 'settings.styleDecisions'
  | 'settings.mode'
  | 'settings.model'
  | 'settings.fastModel'
  | 'settings.userSalt'
  | 'settings.privateSites'
  | 'settings.privacy'
  | 'settings.ignoreOptOutHosts'
  | 'settings.checkOptedOutFields'
  | 'voice.settings'
  | `rules.weights.${string}`
  | `sites.overrides.${string}`;

/** OR-set paths a device may add to / remove from. */
export type SetPath = 'dictionary' | 'rules.muted' | 'sites.disabled';

/**
 * A single mutation, applied with the merge rules on both device and server.
 * 'voice' and 'learning' ops are accepted only from the owner session or the cron (the ops route rejects them
 * from device tokens); devices receive those sections through GET /api/profile. An unpaired device applies
 * them to its local copy only.
 */
export type ProfileOp =
  | { op: 'set'; path: LwwPath; value: unknown; hlc: Hlc }
  | { op: 'add'; path: SetPath; value: string; hlc: Hlc }
  | { op: 'remove'; path: SetPath; value: string; hlc: Hlc }
  | { op: 'voice'; context: VoiceContext; profile: VoiceProfile; hlc: Hlc }
  | { op: 'learning'; patch: Partial<ProfileDocument['learning']>; hlc: Hlc };

export function emptyVoiceProfile(context: VoiceContext): VoiceProfile {
  return {
    context,
    version: 0,
    generatedAt: '',
    generatedBy: '',
    confidence: 'provisional',
    summary: '',
    traits: [],
    styleGuide: '',
    editorInstructions: [],
    doNotFlagStyle: [],
    keepPhrases: [],
    avoidPhrases: [],
    greetings: [],
    signoffs: [],
    acceptedPatterns: [],
    rejectedPatterns: [],
    examples: { accepted: [], rejected: [] },
    facts: {},
    changelog: '',
    removedByUser: [],
  };
}

export const ZERO_HLC: Hlc = '0000000000000-0000-init';

export function defaultProfile(now = '1970-01-01T00:00:00.000Z'): ProfileDocument {
  const z = ZERO_HLC;
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    version: 0,
    updatedAt: now,
    updatedBy: 'init',
    settings: {
      goals: { value: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' }, hlc: z },
      dialect: { value: 'en-US', hlc: z },
      categories: { value: { correctness: true, clarity: true, engagement: true, delivery: true }, hlc: z },
      customInstructions: { value: '', hlc: z },
      styleDecisions: { value: {}, hlc: z },
      mode: { value: 'hybrid', hlc: z },
      model: { value: 'claude-sonnet-5-5', hlc: z },
      fastModel: { value: 'claude-haiku-5-5', hlc: z },
      userSalt: { value: '', hlc: z },
      privateSites: { value: [], hlc: z },
      privacy: { value: { storeSnippets: true, retentionDays: 90, learningEnabled: true, consentAt: null }, hlc: z },
      ignoreOptOutHosts: { value: [], hlc: z },
      checkOptedOutFields: { value: false, hlc: z },
    },
    dictionary: [],
    rules: { muted: [], weights: {} },
    sites: { disabled: [], overrides: {} },
    voice: { settings: { value: { strength: 2, notes: '' }, hlc: z }, profiles: {} },
    learning: { updatedHlc: z, stats: {}, ruleStates: {}, dictionaryCandidates: [], history: [], lastEventCursor: '' },
  };
}
