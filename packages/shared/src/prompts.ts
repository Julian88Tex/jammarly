/**
 * Prompts, output schemas, anchoring and voice-profile rendering (`@jammarly/shared/prompts`).
 * Implementation lives in ./prompts/. Everything here is DOM-free, dependency-free apart from zod, and has no
 * side effects at import.
 */
export { PROMPT_VERSION, SUGGESTION_SYSTEM_PROMPT, VOICE_SYSTEM_PROMPT } from './prompts/prompt-text';
export {
  CORRECTNESS_RULES,
  CLARITY_RULES,
  ENGAGEMENT_RULES,
  DELIVERY_RULES,
  ENGINE_RULE_IDS,
  SENTENCE_SPANNING_RULES,
  TONE_LABELS,
  DO_NOT_FLAG_STYLE_VALUES,
  VOICE_TRAIT_DIMENSIONS,
  DEFAULT_RULE_TITLE,
  RULE_TITLE,
  categoryForRule,
  titleForRule,
} from './prompts/vocabulary';
export type { EngineRuleId, ToneLabelName } from './prompts/vocabulary';
export { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, stripControlChars, sanitizePromptText, sanitizeList, capLength } from './prompts/sanitize';
export {
  SCHEMA_VERSION,
  SUGGESTION_OUTPUT_SCHEMA,
  TONE_OUTPUT_SCHEMA,
  VOICE_OUTPUT_SCHEMA,
  SEVERITY_VALUES,
  KIND_VALUES,
  TONE_STRENGTH_VALUES,
  VOICE_CONFIDENCE_VALUES,
  TRAIT_CONFIDENCE_VALUES,
  STRUCTURED_OUTPUT_LIMITS,
  EXPLANATION_MAX_CHARS,
  validateStructuredOutputSchema,
  coerceConfidence,
  toToneLabels,
  EngineSuggestionSchema,
  EngineDocumentSchema,
  EngineBlockSchema,
  EngineOutputSchema,
  EngineOutputError,
  parseEngineOutput,
  parseEngineOutputDetailed,
} from './prompts/schema';
export type { JsonSchema, ParsedEngineOutput } from './prompts/schema';
export {
  blockIdFor,
  parseBlockIndex,
  maskBlockText,
  maskRequestBlocks,
  buildCheckMessages,
  DEFAULT_GOALS,
  DEFAULT_DIALECT,
  DEFAULT_MAX_BLOCKS_PER_REQUEST,
  CUSTOM_INSTRUCTIONS_MAX_CHARS,
  CUSTOM_INSTRUCTIONS_PREAMBLE,
} from './prompts/messages';
export type { MaskKind, MaskedBlock, MaskResult, SystemBlock, CheckPromptOptions, CheckMessages } from './prompts/messages';
export { anchorSuggestions, tierFor, fingerprintFor, trimCommonAffixes, alignReplacement, adjacentWord, MIN_CONFIDENCE } from './prompts/anchor';
export type { AnchorDropReason, AnchorOptions, AnchorResult, DroppedSuggestion, TrimmedEdit } from './prompts/anchor';
export {
  VOICE_CAPS,
  VOICE_SCOPE_TEXT,
  VOICE_SCOPE_STRENGTH_3,
  OWNER_NOTES_PREAMBLE,
  VOICE_SYNTHESIS_LIMITS,
  renderVoiceBlock,
  lintVoiceProfile,
  buildVoiceSynthesisMessages,
  parseVoiceSynthesis,
  computeVoiceFacts,
  VoiceOutputError,
} from './prompts/voice';
export type { VoiceLintResult, VoiceDecisionInput, VoiceSynthesisInput } from './prompts/voice';
export {
  TONE_SYSTEM_PROMPT,
  TONE_TEXT_LIMIT,
  TONE_MIN_CHARS,
  TONE_MAX_TOKENS,
  TONE_MAX_LABELS,
  TONE_SUMMARY_MAX_CHARS,
  toneCacheKey,
  buildToneMessages,
  parseToneOutput,
} from './prompts/tone';
export { MODEL_PRICES, priceForModel, estimateCostUsd, effortFor, thinkingFor } from './prompts/cost';
export type { ModelPrice, UsageTokens, Effort, ThinkingConfig } from './prompts/cost';
