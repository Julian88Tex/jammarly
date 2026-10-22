/**
 * Local rules engine entry point (`@jammarly/shared/rules`). Implementation lives in ./rules/.
 */
export { runRules, hitsToSuggestions, RULE_IDS, RULE_TITLES, RULE_CATEGORIES } from './rules/engine';
export type { RuleId } from './rules/engine';
export type { RuleOptions, RuleHit } from './rules/types';
export { spellingVariants, expectsUkSpelling } from './rules/spelling-variant';
export type { SpellingVariant } from './rules/spelling-variant';
export { articleFor } from './rules/article';
