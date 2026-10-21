/**
 * Controlled vocabularies of the v3 engine contract: rule ids per category, tone labels, the style-only
 * "do not flag" values a voice profile may use, and the hover-card titles per rule. Pure data, no side
 * effects at import. The names avoid colliding with the local rules engine's RULE_IDS / RULE_TITLES.
 */
import type { SuggestionCategory } from '../types';

export const CORRECTNESS_RULES = [
  'spelling', 'spelling_dialect', 'capitalization', 'subject_verb_agreement', 'verb_form', 'tense', 'article',
  'preposition', 'pronoun_case', 'noun_number', 'missing_word', 'extra_word', 'word_order', 'comma', 'comma_splice',
  'apostrophe', 'quotation_mark', 'hyphen_dash', 'terminal_punctuation', 'sentence_fragment', 'confusable_word',
  'repeated_word', 'spacing', 'numeral_format', 'consistency_spelling_variant', 'consistency_capitalization',
  'consistency_hyphenation', 'consistency_acronym', 'consistency_date_time', 'consistency_quote_style',
  'consistency_serial_comma',
] as const;

export const CLARITY_RULES = [
  'wordy_phrase', 'redundancy', 'passive_voice', 'unclear_antecedent', 'hard_to_read', 'long_sentence', 'run_on',
  'dangling_modifier', 'misplaced_modifier', 'double_negative', 'nominalization', 'rewrite_for_clarity',
] as const;

export const ENGAGEMENT_RULES = ['bland_word_choice', 'overused_word', 'intensifier', 'monotonous_sentences', 'cliche'] as const;

export const DELIVERY_RULES = [
  'hedging', 'overconfident', 'politeness', 'formality_mismatch', 'inclusive_language', 'sensitive_language',
  'tone_rewrite_positive', 'tone_rewrite_confident', 'tone_rewrite_personable',
] as const;

/** Every rule id the system prompt allows, plus the escape hatch `other`. */
export const ENGINE_RULE_IDS = [...CORRECTNESS_RULES, ...CLARITY_RULES, ...ENGAGEMENT_RULES, ...DELIVERY_RULES, 'other'] as const;

export type EngineRuleId = (typeof ENGINE_RULE_IDS)[number];

/** Category a rule id belongs to; `undefined` for `other` and unknown ids (the model's `category` field decides). */
export function categoryForRule(rule: string): SuggestionCategory | undefined {
  if ((CORRECTNESS_RULES as readonly string[]).includes(rule)) return 'correctness';
  if ((CLARITY_RULES as readonly string[]).includes(rule)) return 'clarity';
  if ((ENGAGEMENT_RULES as readonly string[]).includes(rule)) return 'engagement';
  if ((DELIVERY_RULES as readonly string[]).includes(rule)) return 'delivery';
  return undefined;
}

/**
 * Rules whose span legitimately covers more than one sentence (02 §4.1 step 3 and prompt rule 6). Together
 * with kind "rewrite" they are exempt from the one-sentence anchoring constraint.
 */
export const SENTENCE_SPANNING_RULES: readonly string[] = [
  'run_on', 'comma_splice', 'monotonous_sentences', 'rewrite_for_clarity',
  'tone_rewrite_positive', 'tone_rewrite_confident', 'tone_rewrite_personable',
];

/** Tone labels the schema accepts (02 §8.3; informed by Grammarly's documented labels). Keep <= 25. */
export const TONE_LABELS = [
  'formal', 'informal', 'confident', 'uncertain', 'appreciative', 'joyful', 'encouraging', 'friendly', 'optimistic',
  'neutral', 'direct', 'assertive', 'urgent', 'apologetic', 'worried', 'sad', 'frustrated', 'disapproving', 'curious',
  'analytical', 'excited', 'respectful', 'sarcastic',
] as const;

export type ToneLabelName = (typeof TONE_LABELS)[number];

/** Style-only relaxations a voice profile may ask the editor not to flag (08 §8.3). Never correctness. */
export const DO_NOT_FLAG_STYLE_VALUES = [
  'sentence_fragment', 'conjunction_at_start', 'preposition_at_end', 'passive_voice', 'informal_register',
  'contractions', 'lowercase_in_chat', 'emoji', 'serial_comma_choice', 'dash_style', 'long_sentences',
  'short_sentences', 'hedging', 'boosters', 'exclamation_marks', 'parenthetical_asides', 'one_sentence_paragraphs',
] as const;

export const VOICE_TRAIT_DIMENSIONS = ['register', 'sentences', 'punctuation', 'vocabulary', 'openings_closings', 'tone', 'stylistic_choices'] as const;

/** Fallback hover-card title for `other` and unknown rule ids. */
export const DEFAULT_RULE_TITLE = 'Consider this change';

/** Hover-card title per engine rule id. Every id in {@link ENGINE_RULE_IDS} has an entry. */
export const RULE_TITLE: Record<string, string> = {
  spelling: 'Correct the spelling',
  spelling_dialect: 'Match the dialect spelling',
  capitalization: 'Fix the capitalization',
  subject_verb_agreement: 'Make the subject and verb agree',
  verb_form: 'Fix the verb form',
  tense: 'Fix the verb tense',
  article: 'Fix the article',
  preposition: 'Use the right preposition',
  pronoun_case: 'Fix the pronoun',
  noun_number: 'Fix the noun number',
  missing_word: 'Add the missing word',
  extra_word: 'Remove the extra word',
  word_order: 'Fix the word order',
  comma: 'Fix the comma',
  comma_splice: 'Fix the comma splice',
  apostrophe: 'Fix the apostrophe',
  quotation_mark: 'Fix the quotation marks',
  hyphen_dash: 'Fix the hyphen or dash',
  terminal_punctuation: 'Fix the end punctuation',
  sentence_fragment: 'Complete the sentence',
  confusable_word: 'Use the right word',
  repeated_word: 'Remove the repeated word',
  spacing: 'Fix the spacing',
  numeral_format: 'Fix the number format',
  consistency_spelling_variant: 'Use one spelling variant',
  consistency_capitalization: 'Make the capitalization consistent',
  consistency_hyphenation: 'Make the hyphenation consistent',
  consistency_acronym: 'Make the acronym consistent',
  consistency_date_time: 'Make the date and time format consistent',
  consistency_quote_style: 'Make the quotes consistent',
  consistency_serial_comma: 'Make the serial commas consistent',
  wordy_phrase: 'Shorten the wordy phrase',
  redundancy: 'Remove the redundancy',
  passive_voice: 'Use the active voice',
  unclear_antecedent: 'Clarify what this refers to',
  hard_to_read: 'Make this easier to read',
  long_sentence: 'Shorten the sentence',
  run_on: 'Split the run-on sentence',
  dangling_modifier: 'Fix the dangling modifier',
  misplaced_modifier: 'Move the modifier',
  double_negative: 'Remove the double negative',
  nominalization: 'Use a verb instead of a noun',
  rewrite_for_clarity: 'Rewrite for clarity',
  bland_word_choice: 'Choose a stronger word',
  overused_word: 'Vary the word choice',
  intensifier: 'Drop the intensifier',
  monotonous_sentences: 'Vary the sentence structure',
  cliche: 'Replace the cliché',
  hedging: 'Sound more confident',
  overconfident: 'Soften the claim',
  politeness: 'Adjust the politeness',
  formality_mismatch: 'Match the formality',
  inclusive_language: 'Use inclusive language',
  sensitive_language: 'Reconsider this wording',
  tone_rewrite_positive: 'Rewrite to sound more positive',
  tone_rewrite_confident: 'Rewrite to sound more confident',
  tone_rewrite_personable: 'Rewrite to sound more personable',
  other: DEFAULT_RULE_TITLE,
};

/** Title for a rule id, with the fallback for `other` and ids outside the contract. */
export function titleForRule(rule: string): string {
  return RULE_TITLE[rule] ?? DEFAULT_RULE_TITLE;
}
