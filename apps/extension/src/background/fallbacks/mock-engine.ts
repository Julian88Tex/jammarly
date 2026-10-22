/**
 * TODO(integration): local fallback for `@jammarly/shared/mock-engine` (mockCheck, mockVoiceProfile), which
 * another agent is finishing. Deterministic, zero-cost suggestions for tests and demos, shaped exactly like a
 * model response (EngineOutput with verbatim anchors) so they run through the same anchoring as real output.
 * Swap the re-export in ../shared-engine.ts once the shared module lands.
 */
import type { CheckRequest, EngineOutput, EngineSuggestion, SuggestionCategory, SuggestionKind, SuggestionSeverity, ToneLabel } from '@jammarly/shared/types';
import type { VoiceContext, VoiceProfile } from '@jammarly/shared/profile';
import { emptyVoiceProfile } from '@jammarly/shared/profile';

interface Pattern {
  re: RegExp;
  rule: string;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  kind: SuggestionKind;
  /** Replacement for the whole match; may use $1 etc. */
  replacement: string;
  explanation: string;
  confidence: number;
  meaningPreserving: boolean;
  autoApplySafe: boolean;
}

const PATTERNS: Pattern[] = [
  { re: /\b(\w+) \1\b/gi, rule: 'repeated_word', category: 'correctness', severity: 'error', kind: 'delete', replacement: '$1', explanation: 'Repeated word.', confidence: 0.98, meaningPreserving: true, autoApplySafe: true },
  { re: /\b(could|should|would|must|might) of\b/gi, rule: 'confusable_word', category: 'correctness', severity: 'error', kind: 'replace', replacement: '$1 have', explanation: "'$1 of' is a mishearing of '$1 have'.", confidence: 0.97, meaningPreserving: true, autoApplySafe: true },
  { re: /\bteh\b/g, rule: 'spelling', category: 'correctness', severity: 'error', kind: 'replace', replacement: 'the', explanation: 'Misspelling.', confidence: 0.99, meaningPreserving: true, autoApplySafe: true },
  { re: /\brecieve\b/gi, rule: 'spelling', category: 'correctness', severity: 'error', kind: 'replace', replacement: 'receive', explanation: "'i' before 'e' except after 'c'.", confidence: 0.99, meaningPreserving: true, autoApplySafe: true },
  { re: /\balot\b/gi, rule: 'spelling', category: 'correctness', severity: 'error', kind: 'replace', replacement: 'a lot', explanation: "'A lot' is two words.", confidence: 0.98, meaningPreserving: true, autoApplySafe: true },
  { re: /\bdefinately\b/gi, rule: 'spelling', category: 'correctness', severity: 'error', kind: 'replace', replacement: 'definitely', explanation: 'Misspelling.', confidence: 0.99, meaningPreserving: true, autoApplySafe: true },
  { re: /\bdue to the fact that\b/gi, rule: 'wordy_phrase', category: 'clarity', severity: 'suggestion', kind: 'replace', replacement: 'because', explanation: "'Because' says the same thing in one word.", confidence: 0.85, meaningPreserving: true, autoApplySafe: false },
  { re: /\bin order to\b/gi, rule: 'wordy_phrase', category: 'clarity', severity: 'suggestion', kind: 'replace', replacement: 'to', explanation: "'To' is enough here.", confidence: 0.8, meaningPreserving: true, autoApplySafe: false },
  { re: /\bat this point in time\b/gi, rule: 'wordy_phrase', category: 'clarity', severity: 'suggestion', kind: 'replace', replacement: 'now', explanation: 'Shorter phrasing with the same meaning.', confidence: 0.85, meaningPreserving: true, autoApplySafe: false },
  { re: /\bkind of (?=\w)/gi, rule: 'wordy_phrase', category: 'clarity', severity: 'suggestion', kind: 'delete', replacement: '', explanation: "'Kind of' adds nothing here.", confidence: 0.75, meaningPreserving: true, autoApplySafe: false },
  { re: /\btouch base\b/gi, rule: 'cliche', category: 'engagement', severity: 'suggestion', kind: 'replace', replacement: 'connect', explanation: "'Touch base' is a worn phrase.", confidence: 0.7, meaningPreserving: true, autoApplySafe: false },
  { re: /\bjust (?=\w)/gi, rule: 'intensifier', category: 'engagement', severity: 'suggestion', kind: 'delete', replacement: '', explanation: "'Just' weakens the sentence.", confidence: 0.6, meaningPreserving: false, autoApplySafe: false },
  { re: /\b(?:possibly|probably|maybe) (?=\w)/gi, rule: 'hedging', category: 'delivery', severity: 'suggestion', kind: 'delete', replacement: '', explanation: 'This hedge softens the request; drop it to sound sure.', confidence: 0.6, meaningPreserving: false, autoApplySafe: false },
  { re: /\bvery (?=\w)/gi, rule: 'intensifier', category: 'engagement', severity: 'suggestion', kind: 'delete', replacement: '', explanation: "'Very' rarely adds meaning.", confidence: 0.55, meaningPreserving: true, autoApplySafe: false },
];

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

function lastWords(s: string, n: number): string {
  return words(s).slice(-n).join(' ');
}

function firstWords(s: string, n: number): string {
  return words(s).slice(0, n).join(' ');
}

function countOccurrences(hay: string, needle: string, before: number): number {
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1 && idx < before) {
    count++;
    idx = hay.indexOf(needle, idx + 1);
  }
  return count;
}

function expand(template: string, m: RegExpExecArray): string {
  return template.replace(/\$(\d)/g, (_s, d: string) => m[Number(d)] ?? '');
}

/** Tone derived from surface cues so demos show a chip; empty when the text has fewer than two sentences. */
export function mockTone(text: string): ToneLabel[] {
  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  if (sentences.length < 2) return [];
  const out: ToneLabel[] = [];
  const lower = text.toLowerCase();
  if (/\bthank|appreciate/.test(lower)) out.push({ label: 'appreciative', strength: 'moderate' });
  if (/!/.test(text)) out.push({ label: 'excited', strength: 'slight' });
  if (/\b(please|would you|could you)\b/.test(lower)) out.push({ label: 'respectful', strength: 'moderate' });
  if (/\b(kind of|maybe|possibly|probably|i think)\b/.test(lower)) out.push({ label: 'uncertain', strength: 'moderate' });
  if (/\b(must|immediately|asap|urgent)\b/.test(lower)) out.push({ label: 'urgent', strength: 'moderate' });
  if (out.length === 0) out.push({ label: 'neutral', strength: 'moderate' });
  return out.slice(0, 3);
}

/**
 * Deterministic engine output for a request: pattern-based suggestions per block ("b<index>") with verbatim
 * anchors (original, 1-3 words of prefix/suffix, 1-based occurrence). Whitespace-only blocks are skipped.
 */
export function mockCheck(request: CheckRequest, blockIds?: readonly string[]): EngineOutput {
  const wanted = blockIds ? new Set(blockIds) : null;
  const blocks: EngineOutput['blocks'] = [];
  for (const p of [...request.blocks].sort((a, b) => a.index - b.index)) {
    const id = `b${p.index}`;
    if (wanted && !wanted.has(id)) continue;
    if (p.text.trim().length === 0) continue;
    const suggestions: EngineSuggestion[] = [];
    let n = 0;
    for (const pat of PATTERNS) {
      pat.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.re.exec(p.text)) !== null) {
        const original = m[0];
        if (original.length === 0) {
          pat.re.lastIndex++;
          continue;
        }
        const start = m.index;
        const end = start + original.length;
        n++;
        suggestions.push({
          id: `m${p.index}_${n}`,
          category: pat.category,
          rule: pat.rule,
          severity: pat.severity,
          kind: pat.kind,
          original,
          prefix: lastWords(p.text.slice(0, start), 2),
          suffix: firstWords(p.text.slice(end), 2),
          occurrence: countOccurrences(p.text, original, start) + 1,
          replacement: expand(pat.replacement, m),
          alternatives: [],
          explanation: expand(pat.explanation, m),
          confidence: pat.confidence,
          meaning_preserving: pat.meaningPreserving,
          auto_apply_safe: pat.autoApplySafe,
        });
      }
    }
    blocks.push({ block_id: id, suggestions });
  }
  return { blocks, document: { tone: mockTone(request.text), consistency: [], notes: '' } };
}

/** A small, plausible voice profile for demos of the voice block. */
export function mockVoiceProfile(context: VoiceContext): VoiceProfile {
  return {
    ...emptyVoiceProfile(context),
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    generatedBy: 'mock',
    confidence: 'low',
    summary: context === 'messages' ? 'Writes short, friendly messages with contractions and a direct ask.' : 'Writes structured documents in plain, measured prose.',
    traits: [
      { id: 'contractions', label: 'Uses contractions', description: 'Nearly every sentence uses a contraction.', dimension: 'register', evidenceCount: 12, confidence: 'medium', locked: false },
      { id: 'short_sentences', label: 'Short sentences', description: 'Sentences average twelve words.', dimension: 'sentences', evidenceCount: 20, confidence: 'high', locked: false },
    ],
    styleGuide: 'Register: casual and warm. Sentences: short, one idea each. Punctuation: few exclamation marks.',
    editorInstructions: ['Keep contractions.', 'Do not lengthen sentences when rephrasing.'],
    doNotFlagStyle: ['contractions', 'conjunction_at_start'],
    keepPhrases: ['happy to help'],
    avoidPhrases: ['per my last email'],
    greetings: ['Hi', 'Hey'],
    signoffs: ['Thanks,', 'Cheers,'],
    facts: { avg_sentence_words: '12', contraction_rate: '0.8' },
  };
}
