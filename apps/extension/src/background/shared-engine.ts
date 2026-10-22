/**
 * The ONE place the service worker imports engine pieces from `@jammarly/shared`. Every other background module
 * imports from here, so a renamed shared export is fixed on one line. Every export below is a re-export from a
 * stable deep path of the shared package: the worker keeps no local stand-ins (the integration-era fallbacks under
 * ./fallbacks are gone), so the engine, the learner and the merge are the tested, spec-complete versions.
 */

// --- prompts ----------------------------------------------------------------------------------------------------
export { buildCheckMessages, maskRequestBlocks, maskBlockText, blockIdFor, parseBlockIndex, DEFAULT_GOALS, DEFAULT_MAX_BLOCKS_PER_REQUEST } from '@jammarly/shared/prompts/messages';
export type { CheckMessages, CheckPromptOptions, MaskedBlock, SystemBlock } from '@jammarly/shared/prompts/messages';
export { anchorSuggestions, fingerprintFor, tierFor } from '@jammarly/shared/prompts/anchor';
export type { AnchorOptions, AnchorResult, DroppedSuggestion } from '@jammarly/shared/prompts/anchor';
export { parseEngineOutput, parseEngineOutputDetailed, EngineOutputError, SUGGESTION_OUTPUT_SCHEMA, TONE_OUTPUT_SCHEMA, SCHEMA_VERSION, toToneLabels } from '@jammarly/shared/prompts/schema';
export { PROMPT_VERSION, SUGGESTION_SYSTEM_PROMPT } from '@jammarly/shared/prompts/prompt-text';
export { estimateCostUsd, effortFor, thinkingFor, priceForModel, MODEL_PRICES } from '@jammarly/shared/prompts/cost';
export type { Effort, ThinkingConfig } from '@jammarly/shared/prompts/cost';
export { titleForRule, categoryForRule, TONE_LABELS, ENGINE_RULE_IDS, CORRECTNESS_RULES } from '@jammarly/shared/prompts/vocabulary';
export { renderVoiceBlock, lintVoiceProfile } from '@jammarly/shared/prompts/voice';
export type { VoiceLintResult } from '@jammarly/shared/prompts/voice';
export { TONE_SYSTEM_PROMPT, TONE_TEXT_LIMIT, TONE_MIN_CHARS, TONE_MAX_TOKENS, toneCacheKey, buildToneMessages, parseToneOutput } from '@jammarly/shared/prompts/tone';

// --- text, rules, hlc, redact, profile --------------------------------------------------------------------------
export { hashText, splitParagraphs, computeScore, countWords, stripUrlsAndCode, normalizeForMatch, locateSpan, splitSentences } from '@jammarly/shared/text';
export { runRules, hitsToSuggestions } from '@jammarly/shared/rules';
export { createClock, compareHlc, parseHlc, isHlc, maxHlc } from '@jammarly/shared/hlc';
export type { HlcClock } from '@jammarly/shared/hlc';
export { redactSnippet, redactSentence, isSensitiveHost, normalizeHost } from '@jammarly/shared/redact';
export { defaultProfile, emptyVoiceProfile, ZERO_HLC, PROFILE_SCHEMA_VERSION } from '@jammarly/shared/profile';

// --- mock engine (provider: 'mock') -----------------------------------------------------------------------------
export { mockCheck, mockVoiceProfile, MOCK_MODEL } from '@jammarly/shared/mock-engine';
export type { MockCheckResult } from '@jammarly/shared/mock-engine';

// --- learner (ARCHITECTURE §3.7) --------------------------------------------------------------------------------
export {
  LEARNER_CONSTANTS,
  PROMOTED_TIER_A_CONFIDENCE,
  wilson,
  statsKey,
  probeKey,
  parseStatsKey,
  foldEvents,
  resolveLearning,
  resolveRuleStates,
  lookupRuleState,
  promotedRules,
  applyLearnedState,
  dictionaryCandidates,
  buildLearningSummary,
  encodeMute,
  decodeMute,
  mutedRulesForHost,
  inferDialect,
} from '@jammarly/shared/learner';
export type { ApplyLearnedInput, ApplyLearnedResult, FoldOptions, FoldResult, ManualOff, ResolveOptions, ResolveResult, RuleCategories, StatsScope, SummaryOptions } from '@jammarly/shared/learner';

// --- merge (ARCHITECTURE §3.6) ----------------------------------------------------------------------------------
export { applyOps, mergeDocuments, migrateProfile, orSetLive, orSetHas } from '@jammarly/shared/merge';
export type { ApplyOpsOptions, ApplyOpsResult, OpRejectReason } from '@jammarly/shared/merge';
