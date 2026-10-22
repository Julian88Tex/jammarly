/**
 * The ONE place the service worker imports engine pieces from `@jammarly/shared`. Every other background module
 * imports from here, so a renamed or still-missing shared export is fixed on one line.
 *
 * Modules that exist today are re-exported from their stable deep paths. Modules other agents are still finishing
 * (`@jammarly/shared/prompts` entry, `merge`, `learner`, `mock-engine`) are served by local fallbacks under
 * ./fallbacks, each marked TODO(integration); switch the re-export to the shared module once it lands.
 */

// --- prompts (deep paths that exist) ------------------------------------------------------------------------
export { buildCheckMessages, maskRequestBlocks, maskBlockText, blockIdFor, parseBlockIndex, DEFAULT_GOALS, DEFAULT_MAX_BLOCKS_PER_REQUEST } from '@jammarly/shared/prompts/messages';
export type { CheckMessages, CheckPromptOptions, MaskedBlock, SystemBlock } from '@jammarly/shared/prompts/messages';
export { anchorSuggestions, fingerprintFor, tierFor } from '@jammarly/shared/prompts/anchor';
export type { AnchorOptions, AnchorResult, DroppedSuggestion } from '@jammarly/shared/prompts/anchor';
export { parseEngineOutput, parseEngineOutputDetailed, EngineOutputError, SUGGESTION_OUTPUT_SCHEMA, TONE_OUTPUT_SCHEMA, SCHEMA_VERSION, toToneLabels } from '@jammarly/shared/prompts/schema';
export { PROMPT_VERSION, SUGGESTION_SYSTEM_PROMPT } from '@jammarly/shared/prompts/prompt-text';
export { estimateCostUsd, effortFor, thinkingFor, priceForModel, MODEL_PRICES } from '@jammarly/shared/prompts/cost';
export type { Effort, ThinkingConfig } from '@jammarly/shared/prompts/cost';
export { titleForRule, categoryForRule, TONE_LABELS, ENGINE_RULE_IDS, CORRECTNESS_RULES } from '@jammarly/shared/prompts/vocabulary';

// --- text, rules, hlc, redact, profile ------------------------------------------------------------------------
export { hashText, splitParagraphs, computeScore, countWords, stripUrlsAndCode, normalizeForMatch, locateSpan, splitSentences } from '@jammarly/shared/text';
export { runRules, hitsToSuggestions } from '@jammarly/shared/rules';
export { createClock, compareHlc, parseHlc, isHlc, maxHlc } from '@jammarly/shared/hlc';
export type { HlcClock } from '@jammarly/shared/hlc';
export { redactSnippet, redactSentence, isSensitiveHost, normalizeHost } from '@jammarly/shared/redact';
export { defaultProfile, emptyVoiceProfile, ZERO_HLC, PROFILE_SCHEMA_VERSION } from '@jammarly/shared/profile';

// --- TODO(integration): `@jammarly/shared/prompts` voice/tone exports ----------------------------------------
// renderVoiceBlock, TONE_SYSTEM_PROMPT, buildToneMessages, parseToneOutput come from ./fallbacks/voice-tone until
// the shared entry exports them (shared prompts/voice.ts currently imports a module that does not exist yet).
export { renderVoiceBlock, TONE_SYSTEM_PROMPT, buildToneMessages, parseToneOutput, toneSummaryFor } from './fallbacks/voice-tone';

// --- TODO(integration): `@jammarly/shared/mock-engine` --------------------------------------------------------
export { mockCheck, mockVoiceProfile, mockTone } from './fallbacks/mock-engine';

// --- TODO(integration): `@jammarly/shared/learner` ------------------------------------------------------------
export { foldEvents, resolveRuleStates, promotedRules, applyLearnedState, dictionaryCandidates, buildLearningSummary, LEARNER_CONSTANTS, learnedStateApplies, wilson, statsKey } from './fallbacks/learner';
export type { LearnedStateView, ApplyLearnedOptions } from './fallbacks/learner';

// --- TODO(integration): `@jammarly/shared/merge` --------------------------------------------------------------
export { applyOps, mergeDocuments, migrateProfile } from './fallbacks/merge';
export type { ApplyOpsResult } from './fallbacks/merge';

// --- OR-set helpers (tiny, local) -----------------------------------------------------------------------------
import type { OrSetElement } from '@jammarly/shared/profile';
import { compareHlc as cmp } from '@jammarly/shared/hlc';

/** Live elements of an add-wins OR-set: removedHlc absent or addedHlc > removedHlc. */
export function liveValues(set: readonly OrSetElement<string>[]): string[] {
  const out: string[] = [];
  for (const el of set) {
    if (el.removedHlc === undefined || cmp(el.addedHlc, el.removedHlc) > 0) out.push(el.value);
  }
  return out;
}

export function isLive(set: readonly OrSetElement<string>[], value: string): boolean {
  const el = set.find((e) => e.value === value);
  return el !== undefined && (el.removedHlc === undefined || cmp(el.addedHlc, el.removedHlc) > 0);
}
