/** Engine-contract rule ids implemented locally. */
export const RULE_IDS = [
  'spacing',
  'repeated_word',
  'capitalization',
  'article',
  'confusable_word',
  'terminal_punctuation',
  'consistency_quote_style',
  'consistency_hyphenation',
  'consistency_spelling_variant',
  'consistency_serial_comma',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/**
 * Card titles. Keys are rule ids (the generic title) and `rule.variant` sub-keys for the specific
 * check that fired; every hit's `title` is one of these values.
 */
export const RULE_TITLES: Record<string, string> = {
  spacing: 'Fix the spacing',
  'spacing.double_space': 'Remove the extra space',
  'spacing.before_punctuation': 'Remove the space before the punctuation',
  'spacing.missing_after_punctuation': 'Add a space after the punctuation',
  'spacing.trailing_whitespace': 'Remove the trailing whitespace',
  repeated_word: 'Remove the repeated word',
  capitalization: 'Capitalize the first word',
  'capitalization.sentence_start': 'Capitalize the first word',
  'capitalization.lone_i': "Capitalize 'I'",
  article: 'Fix the article',
  'article.a_to_an': "Use 'an' before a vowel sound",
  'article.an_to_a': "Use 'a' before a consonant sound",
  confusable_word: 'Use the right word',
  'confusable_word.of_have': "Use 'have' instead of 'of'",
  'confusable_word.alot': "Use 'a lot'",
  'confusable_word.apart_of': "Use 'a part of'",
  'confusable_word.your_welcome': "Use 'you're welcome'",
  'confusable_word.then_than': "Use 'than' instead of 'then'",
  terminal_punctuation: 'Remove the extra punctuation',
  consistency_quote_style: 'Make the quotes consistent',
  consistency_hyphenation: 'Make the dashes consistent',
  consistency_spelling_variant: 'Use one spelling variant',
  consistency_serial_comma: 'Make the serial commas consistent',
};
