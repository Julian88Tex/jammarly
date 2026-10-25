/**
 * Public contracts of the local rules engine. The engine runs in the content script on every input
 * event, so everything here is DOM-free, dependency-free and synchronous.
 */
import type {
  Dialect,
  Formality,
  StyleDecisions,
  SuggestionCategory,
  SuggestionKind,
  SuggestionSeverity,
  TextRange,
  WritingContext,
} from '../types';

export interface RuleOptions {
  dialect: Dialect;
  context: WritingContext;
  formality: Formality;
  /** Words never flagged (user dictionary + glossary); compared case-insensitively. */
  protectedTerms: string[];
  /**
   * Document-level choices the user made or that were learned. Keys read by the engine:
   * `double_space_after_period` ('keep'), `quotes` ('straight' | 'curly'),
   * `dash` ('em_closed' | 'em_spaced' | 'en_spaced' | 'hyphen_spaced' | 'double_hyphen'),
   * `serial_comma` ('oxford' | 'none').
   */
  styleDecisions: StyleDecisions;
  /** Ranges to never flag (URLs, code, emails, handles) from stripUrlsAndCode. */
  masked: TextRange[];
  /**
   * True while the user is typing: suppress any hit that touches the last word/char of the text so we
   * never flag a word in progress.
   */
  typing: boolean;
  /** Rule ids to skip (engine-contract ids such as "spacing" or "repeated_word"). */
  mutedRules: string[];
}

export interface RuleHit {
  /** Engine-contract rule id (see RULE_IDS). */
  rule: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  /** Absolute half-open range into the text passed to runRules. */
  range: TextRange;
  /** Exactly `text.slice(range.start, range.end)`; never empty. */
  original: string;
  /** Always differs from `original`. */
  replacement: string;
  /** Card title, always a value of RULE_TITLES. */
  title: string;
  /** Plain English, at most 140 characters. */
  explanation: string;
  /** 0..1 */
  confidence: number;
  autoApplySafe: boolean;
  meaningPreserving: boolean;
  /** Extra replacement options shown on the card (style rules only); absent when there are none. */
  alternatives?: string[];
}

/**
 * What a rule hands to the context; the context fills in `original`, `title` and `category` (from RULE_CATEGORIES,
 * correctness unless the rule id is a clarity, engagement or delivery id).
 */
export interface HitInput {
  rule: string;
  /** RULE_TITLES key (a rule id or a `rule.variant` sub-key). Defaults to `rule`. */
  key?: string;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  start: number;
  end: number;
  replacement: string;
  explanation: string;
  confidence: number;
  autoApplySafe: boolean;
  /** Defaults to true. */
  meaningPreserving?: boolean;
  /** Extra replacement options (style rules); omitted or empty for none. */
  alternatives?: string[];
}
