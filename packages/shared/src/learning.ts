/**
 * Learning contracts: feedback events emitted by the content script, folded into the profile document's
 * learning section by the deterministic learner (see ./learner.ts), and the summary the dashboards render.
 */
import type { Dialect, SuggestionCategory, SuggestionSeverity, SuggestionSource, WritingContext, WritingGoals } from './types';
import type { RuleState, VoiceContext } from './profile';

export type FeedbackKind =
  | 'shown'
  | 'accept'
  | 'dismiss'
  | 'ignore'
  | 'accepted_by_typing'
  | 'self_corrected'
  | 'edit_after_accept'
  | 'invalidated'
  | 'add_to_dictionary'
  | 'report_incorrect';

export type DismissReason = 'not_error' | 'meant_this' | 'dislike_rewrite' | 'not_here' | 'not_this_site' | 'never';

export type FeedbackVia = 'card' | 'panel' | 'bulk' | 'keyboard' | 'typing';

/** What the content script knows; the worker adds device/time/model fields to make a FeedbackEvent. */
export interface FeedbackEventInput {
  kind: FeedbackKind;
  suggestionId: string;
  fieldId: string;
  /** Stable document identity: sha256(userSalt + origin + fieldPath + docHint) truncated to 16 hex chars. */
  docKey: string;
  host: string;
  ctx: WritingContext;
  rule: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  confidence: number;
  source: SuggestionSource;
  via?: FeedbackVia;
  reason?: DismissReason;
  probe?: boolean;
  dwellMs?: number;
  /** Redacted snippets, <=200 chars; absent when snippet storage is off. */
  original?: string;
  replacement?: string;
  final?: string;
  /** <=280 chars, redacted. */
  sentence?: string;
  spanLen: number;
  sentenceLen: number;
  wordCountTyped?: number;
}

export interface FeedbackEvent extends FeedbackEventInput {
  v: 1;
  eventId: string;
  t: string;
  deviceId: string;
  model?: string;
  promptVersion: string;
  profileVersion?: number;
  profileStrength: 0 | 1 | 2 | 3;
  goals: WritingGoals;
  dialect: Dialect;
}

/** A typed sentence sampled for voice synthesis (never pasted, never Jammarly-applied). */
export interface VoiceSample {
  t: string;
  host: string;
  ctx: WritingContext;
  voiceContext: VoiceContext;
  /** Redacted, <=280 chars. */
  sentence: string;
}

export interface RateBlock {
  shown: number;
  accepted: number;
  dismissed: number;
  ignored: number;
  acceptance: TrendValue;
  dismissRate: TrendValue;
  ignoreRate: TrendValue;
}

export interface TrendValue {
  value: number;
  ciLow: number;
  ciHigh: number;
  prev: number;
  delta: number;
  n: number;
}

export interface LearningSummary {
  window: { days: 7 | 14 | 28; from: string; to: string };
  overall: RateBlock;
  byCategory: Record<SuggestionCategory, RateBlock & { per100Words: TrendValue }>;
  byContext: Partial<Record<WritingContext, RateBlock>>;
  byHost: ({ host: string } & RateBlock)[];
  byRule: {
    rule: string;
    category: SuggestionCategory;
    scope: 'global' | 'ctx' | 'host';
    scopeKey: string;
    accepted: number;
    dismissed: number;
    shown: number;
    ignored: number;
    wilsonLB: number;
    wilsonUB: number;
    state: RuleState;
    eligibleForBulk: boolean;
    /** In rules.muted (globally or for this scopeKey). */
    manualOff: boolean;
    since?: string;
    nextReprobe?: string;
  }[];
  learnedState: {
    suppressed: number;
    demoted: number;
    promoted: number;
    manualOff: number;
    dictionaryLearned: number;
    dictionaryManual: number;
    dialectInferred?: Dialect;
  };
  voice: Partial<Record<VoiceContext, { version: number; generatedAt: string; traits: number; confidence: string; strength: number; samples30d: number; decisions30d: number }>>;
  history: { at: string; eventsSeen: number; changelog: string; model: string; version: number }[];
  privacy: { storeSnippets: boolean; rawEvents: number; oldestEvent?: string };
}
