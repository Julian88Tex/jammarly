/**
 * TODO(integration): local fallbacks for `renderVoiceBlock` (shared prompts/voice.ts currently imports a module
 * that does not exist yet) and for the tone call pieces (TONE_SYSTEM_PROMPT, buildToneMessages, parseToneOutput)
 * that `@jammarly/shared/prompts` will export. Swap the re-exports in ../shared-engine.ts once they land.
 */
import type { VoiceProfile, VoiceSettings } from '@jammarly/shared/profile';
import type { ToneAnalysis } from '@jammarly/shared/types';
import { maskBlockText } from '@jammarly/shared/prompts/messages';
import type { SystemBlock } from '@jammarly/shared/prompts/messages';
import { sanitizeList, sanitizePromptText } from '@jammarly/shared/prompts/sanitize';
import { toToneLabels } from '@jammarly/shared/prompts/schema';

/**
 * Byte-stable `<user_voice_profile>` system block (08 §8.4). '' when the strength is 0 or the profile is empty.
 * Every field is sanitized (control characters stripped, `<`/`>` neutralized, length-capped) because the profile
 * is user- or device-authored text that lands in the system prompt.
 */
export function renderVoiceBlock(profile: VoiceProfile | undefined, settings: VoiceSettings): string {
  if (!profile || settings.strength === 0 || profile.version <= 0) return '';
  const lines: string[] = [`<user_voice_profile context="${profile.context}" version="${profile.version}" strength="${settings.strength}">`];
  const summary = sanitizePromptText(profile.summary, 400);
  if (summary.length > 0) lines.push(`<summary>${summary}</summary>`);
  const guide = sanitizePromptText(profile.styleGuide, 3000, { multiline: true });
  if (guide.length > 0) lines.push(`<style_guide>\n${guide}\n</style_guide>`);
  const list = (tag: string, items: readonly string[], maxItems: number, maxLen: number): void => {
    const clean = sanitizeList(items, maxItems, maxLen);
    if (clean.length > 0) lines.push(`<${tag}>${clean.join('; ')}</${tag}>`);
  };
  if (settings.strength >= 1) {
    list('editor_instructions', profile.editorInstructions, 6, 200);
    list('do_not_flag_style', profile.doNotFlagStyle, 20, 40);
    list('keep_phrases', profile.keepPhrases, 20, 80);
    list('avoid_phrases', profile.avoidPhrases, 20, 80);
  }
  if (settings.strength >= 2) {
    list('greetings', profile.greetings, 6, 60);
    list('signoffs', profile.signoffs, 6, 60);
    list('accepted_patterns', profile.acceptedPatterns, 6, 160);
    list('rejected_patterns', profile.rejectedPatterns, 6, 160);
  }
  const notes = sanitizePromptText(settings.notes, 2000, { multiline: true });
  if (notes.length > 0) lines.push(`<owner_notes>\n${notes}\n</owner_notes>`);
  lines.push(
    settings.strength >= 3
      ? 'Apply this profile to wording and, where the text clearly departs from it, propose voice-alignment rewrites (kind "rewrite"). Never relax correctness.'
      : 'Use this profile to choose wording in clarity, engagement and delivery suggestions and to avoid flagging the listed style choices. Never relax correctness.',
  );
  lines.push('</user_voice_profile>');
  return lines.join('\n');
}

/** Byte-stable system prompt of the separate tone call (02 §8.6). */
export const TONE_SYSTEM_PROMPT: string =
  'You classify the overall tone of a piece of writing for its likely reader. Read the text inside <text> and return JSON that matches the provided schema: up to three tone labels from the allowed vocabulary, each with a strength (strong, moderate, slight), and a one-sentence rationale of at most 100 characters describing the impression the text makes. Judge the whole text, not one sentence. Do not suggest edits, do not quote the text, and output only the JSON object.';

export const TONE_TEXT_MAX_CHARS = 2500;

/** System blocks (cached) and user message of a tone call over the first 2,500 characters of the field. */
export function buildToneMessages(text: string): { system: SystemBlock[]; user: string } {
  const slice = text.length > TONE_TEXT_MAX_CHARS ? text.slice(0, TONE_TEXT_MAX_CHARS) : text;
  const masked = maskBlockText(slice).masked;
  return {
    system: [{ type: 'text', text: TONE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    user: `<text>${masked}</text>`,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tolerant parser of the tone call's JSON (string or object): unknown labels dropped, rationale clamped. */
export function parseToneOutput(raw: unknown): ToneAnalysis {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last <= first) return { labels: [], summary: '' };
    try {
      value = JSON.parse(s.slice(first, last + 1));
    } catch {
      return { labels: [], summary: '' };
    }
  }
  if (!isRecord(value)) return { labels: [], summary: '' };
  const labels = toToneLabels(value.tone);
  const rationale = typeof value.rationale === 'string' ? value.rationale.replace(/\s+/g, ' ').trim() : '';
  return { labels, summary: rationale.length > 140 ? rationale.slice(0, 140) : rationale };
}

/** A one-sentence summary from labels when the response carried none ("Sounds confident and a little informal."). */
export function toneSummaryFor(labels: ToneAnalysis['labels']): string {
  if (labels.length === 0) return '';
  const parts = labels.map((l) => (l.strength === 'slight' ? `a little ${l.label}` : l.strength === 'strong' ? `very ${l.label}` : l.label));
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const sentence = `Sounds ${joined}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
