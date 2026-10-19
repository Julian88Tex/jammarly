/**
 * The profile document: everything that is shared across a user's devices. Stored by the web app in
 * Vercel Blob (ETag CAS) and mirrored in chrome.storage.local on each device. Scalars are last-writer-wins
 * registers keyed by hybrid logical clocks; sets are add-wins observed-remove sets. The merge is
 * deterministic and runs identically on devices and the server (see ./merge.ts).
 */
import type { Dialect, StyleDecisions, SuggestionCategory, WritingContext, WritingGoals } from './types';

export const PROFILE_SCHEMA_VERSION = 1 as const;

/** "wallMs-counter-deviceId", string-comparable. */
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

export interface SiteOverride {
  context?: WritingContext;
  formality?: WritingGoals['formality'];
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

export type RuleState = 'active' | 'demoted' | 'suppressed' | 'promoted' | 'manual_off' | 'probing';

export interface LearnedRuleState {
  state: RuleState;
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
    /** AES-GCM ciphertext (base64) of the Anthropic API key, keyed by the account's encryption key; "" when unset. */
    apiKeyEncrypted: Lww<string>;
    mode: Lww<'hybrid' | 'quality' | 'economy'>;
    model: Lww<string>;
    fastModel: Lww<string>;
    /** Random 32-byte hex salt generated once per account; feeds docKey derivation. Never leaves the account. */
    userSalt: Lww<string>;
    /** Hosts where snippets are never stored (suffix match). */
    privateSites: Lww<string[]>;
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

/** A single mutation, applied with the merge rules on both device and server. */
export type ProfileOp =
  | { op: 'set'; path: string; value: unknown; hlc: Hlc }
  | { op: 'add'; path: string; value: unknown; hlc: Hlc }
  | { op: 'remove'; path: string; value: unknown; hlc: Hlc }
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

export const ZERO_HLC: Hlc = '0000000000000-0-init';

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
      apiKeyEncrypted: { value: '', hlc: z },
      mode: { value: 'hybrid', hlc: z },
      model: { value: 'claude-opus-5-5', hlc: z },
      fastModel: { value: 'claude-haiku-5-5', hlc: z },
      userSalt: { value: '', hlc: z },
      privateSites: { value: [], hlc: z },
    },
    dictionary: [],
    rules: { muted: [], weights: {} },
    sites: { disabled: [], overrides: {} },
    voice: { settings: { value: { strength: 2, notes: '' }, hlc: z }, profiles: {} },
    learning: { updatedHlc: z, stats: {}, ruleStates: {}, dictionaryCandidates: [], history: [], lastEventCursor: '' },
  };
}
