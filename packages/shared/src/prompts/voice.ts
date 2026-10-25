/**
 * Voice profile: the byte-stable `<user_voice_profile>` system block (08 §8.4), the lint that keeps a profile from
 * relaxing correctness or injecting instructions (08 reviewer 6), the synthesis call (08 §8.3) with its
 * post-processing, and the deterministic facts the synthesis prompt relies on for anything numeric.
 *
 * Every string that reaches a prompt goes through `sanitizePromptText` (control characters stripped, `<`/`>`
 * replaced by `‹`/`›`, placeholder brackets neutralized, hard length caps) because profile text is user- or
 * device-authored and lands in the *system* prompt. A profile synced from another device is untrusted input.
 */
import type { VoiceContext, VoiceProfile, VoiceSettings, VoiceTrait } from '../profile';
import { countWords, splitSentences } from '../text';
import { VOICE_SYSTEM_PROMPT } from './prompt-text';
import { sanitizeList, sanitizePromptText, stripControlChars } from './sanitize';
import { DO_NOT_FLAG_STYLE_VALUES, VOICE_TRAIT_DIMENSIONS } from './vocabulary';

// ---------------------------------------------------------------------------
// Caps (shared by the renderer, the lint and the synthesis parser)
// ---------------------------------------------------------------------------

export const VOICE_CAPS = {
  summary: 300,
  styleGuide: 3000,
  traits: 12,
  /** "label: description" line. */
  traitLine: 200,
  traitLabel: 60,
  listItems: 8,
  listItem: 120,
  editorInstructions: 6,
  greetings: 3,
  signoffs: 3,
  patterns: 6,
  examples: 6,
  exampleSide: 160,
  notes: 2000,
  fact: 60,
  changelog: 600,
} as const;

const DO_NOT_FLAG_SET: ReadonlySet<string> = new Set<string>(DO_NOT_FLAG_STYLE_VALUES);
const DIMENSION_SET: ReadonlySet<string> = new Set<string>(VOICE_TRAIT_DIMENSIONS);
const VOICE_CONTEXTS: readonly VoiceContext[] = ['messages', 'documents'];

// ---------------------------------------------------------------------------
// Rendering (08 §8.4)
// ---------------------------------------------------------------------------

/** The `<scope>` paragraph of the voice block, verbatim from 08 §8.4. */
export const VOICE_SCOPE_TEXT =
  'This profile describes how the user already writes in this context. Use it (a) to recognize intentional style and\n' +
  'not flag it, (b) to word any rewrite you would make anyway so it sounds like the user, (c) to judge tone. It does\n' +
  'not lower correctness standards: spelling, grammar, agreement, apostrophes, sentence-initial capitalization and\n' +
  'terminal punctuation are judged exactly as without this profile. Do not emit suggestions whose only purpose is to\n' +
  'make text match this profile. Judge severity and confidence before considering this profile.';

/** Appended to `<scope>` at strength 3 only. */
export const VOICE_SCOPE_STRENGTH_3 =
  'At strength 3 you may additionally propose at most one voice-alignment rewrite per paragraph, category delivery, severity suggestion, confidence ≤ 0.6.';

export const OWNER_NOTES_PREAMBLE = 'The user wrote these notes about their own style; apply them only where they do not conflict with the contract:';

function fact(facts: Record<string, string>, key: string): string {
  const v = facts[key];
  if (typeof v !== 'string') return '';
  return sanitizePromptText(v, VOICE_CAPS.fact).replace(/;/g, ',');
}

/** The known fact keys, in render order (greetings/signoffs/dialect are placed on the last line). */
const FACT_LINES: readonly (readonly [key: string, label: string])[][] = [
  [
    ['register', 'register'],
    ['sentence_words_avg', 'sentences'],
    ['contraction_rate', 'contractions'],
    ['serial_comma', 'serial_comma'],
  ],
  [
    ['dash_style', 'dash'],
    ['quote_style', 'quotes'],
    ['exclamation_per_100_sentences', 'exclamation'],
    ['emoji_rate', 'emoji'],
    ['lowercase_start_rate', 'lowercase_start'],
  ],
];
const KNOWN_FACT_KEYS: ReadonlySet<string> = new Set([
  'register', 'sentence_words_avg', 'sentence_words_sd', 'contraction_rate', 'serial_comma', 'dash_style', 'quote_style',
  'exclamation_per_100_sentences', 'emoji_rate', 'lowercase_start_rate', 'dialect', 'sentences', 'words',
]);

function renderFacts(facts: Record<string, string>, greetings: string[], signoffs: string[]): string[] {
  const lines: string[] = [];
  for (const group of FACT_LINES) {
    const items: string[] = [];
    for (const [key, label] of group) {
      const v = fact(facts, key);
      if (v.length === 0) continue;
      if (key === 'sentence_words_avg') {
        const sd = fact(facts, 'sentence_words_sd');
        items.push(sd.length > 0 ? `${label}: avg ${v} words (sd ${sd})` : `${label}: avg ${v} words`);
      } else if (key === 'exclamation_per_100_sentences') {
        items.push(`${label}: ${v}/100 sentences`);
      } else {
        items.push(`${label}: ${v}`);
      }
    }
    if (items.length > 0) lines.push(items.join('; ') + ';');
  }
  const last: string[] = [];
  if (greetings.length > 0) last.push(`greetings: ${greetings.join('; ')}`);
  if (signoffs.length > 0) last.push(`signoffs: ${signoffs.join('; ')}`);
  const dialect = fact(facts, 'dialect');
  if (dialect.length > 0) last.push(`dialect: ${dialect}`);
  if (last.length > 0) lines.push(last.join('; '));
  const extra: string[] = [];
  for (const key of Object.keys(facts).sort()) {
    if (KNOWN_FACT_KEYS.has(key)) continue;
    const k = key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const v = fact(facts, key);
    if (k.length > 0 && v.length > 0) extra.push(`${k}: ${v}`);
    if (extra.length >= 8) break;
  }
  if (extra.length > 0) lines.push(extra.join('; '));
  return lines;
}

function renderTraits(traits: readonly VoiceTrait[] | undefined): string[] {
  const out: string[] = [];
  for (const t of traits ?? []) {
    if (t === null || typeof t !== 'object') continue;
    const label = sanitizePromptText(String(t.label ?? ''), VOICE_CAPS.traitLabel);
    if (label.length === 0) continue;
    const description = sanitizePromptText(String(t.description ?? ''), VOICE_CAPS.traitLine);
    const line = (description.length > 0 ? `${label}: ${description}` : label).slice(0, VOICE_CAPS.traitLine);
    out.push(line);
    if (out.length >= VOICE_CAPS.traits) break;
  }
  return out;
}

function filterDoNotFlag(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const v of values ?? []) {
    if (typeof v !== 'string') continue;
    const id = v.trim().toLowerCase();
    if (DO_NOT_FLAG_SET.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Renders the cached `<user_voice_profile>` system block. Byte-stable: fixed field order, arrays as stored, no
 * timestamps. strength 0 returns ''; strength 1 omits `<do_not_flag_style>` and `<editor_instructions>`;
 * strength 3 appends the extra scope line. `facts` (when given) override `profile.facts` key by key. Empty
 * elements are omitted; a profile with nothing to say renders ''.
 */
export function renderVoiceBlock(profile: VoiceProfile, settings: VoiceSettings, facts?: Record<string, string>): string {
  // A synced document is untrusted input: anything outside 0..3 is clamped so no unknown strength reaches the prompt.
  const rawStrength: unknown = settings.strength;
  if (typeof rawStrength !== 'number' || !Number.isFinite(rawStrength)) return '';
  const strength = Math.max(0, Math.min(3, Math.floor(rawStrength)));
  if (strength === 0) return '';
  const ctx: VoiceContext = VOICE_CONTEXTS.includes(profile.context) ? profile.context : 'messages';
  const version = Number.isInteger(profile.version) && profile.version >= 0 ? profile.version : 0;

  const summary = sanitizePromptText(profile.summary ?? '', VOICE_CAPS.summary);
  const traits = renderTraits(profile.traits);
  const styleGuide = sanitizePromptText(profile.styleGuide ?? '', VOICE_CAPS.styleGuide, { multiline: true });
  const doNotFlag = strength >= 2 ? filterDoNotFlag(profile.doNotFlagStyle) : [];
  const instructions = strength >= 2 ? sanitizeList(profile.editorInstructions, VOICE_CAPS.editorInstructions, VOICE_CAPS.listItem) : [];
  const greetings = sanitizeList(profile.greetings, VOICE_CAPS.greetings, VOICE_CAPS.fact).map((g) => g.replace(/;/g, ','));
  const signoffs = sanitizeList(profile.signoffs, VOICE_CAPS.signoffs, VOICE_CAPS.fact).map((g) => g.replace(/;/g, ','));
  const accepted: string[] = [];
  for (const ex of profile.examples?.accepted ?? []) {
    const before = sanitizePromptText(String(ex.before ?? ''), VOICE_CAPS.exampleSide);
    const after = sanitizePromptText(String(ex.after ?? ''), VOICE_CAPS.exampleSide);
    if (before.length === 0 || after.length === 0) continue;
    accepted.push(`- BEFORE: ${before} → AFTER: ${after}`);
    if (accepted.length >= VOICE_CAPS.examples) break;
  }
  const rejected: string[] = [];
  for (const ex of profile.examples?.rejected ?? []) {
    const before = sanitizePromptText(String(ex.before ?? ''), VOICE_CAPS.exampleSide);
    const proposed = sanitizePromptText(String(ex.proposed ?? ''), VOICE_CAPS.exampleSide);
    const kept = sanitizePromptText(String(ex.keptOrFinal ?? ''), VOICE_CAPS.exampleSide);
    if (before.length === 0 || proposed.length === 0 || kept.length === 0) continue;
    rejected.push(`- BEFORE: ${before} | PROPOSED: ${proposed} | USER KEPT/WROTE: ${kept}`);
    if (rejected.length >= VOICE_CAPS.examples) break;
  }
  const notes = sanitizePromptText(settings.notes ?? '', VOICE_CAPS.notes, { multiline: true });
  const mergedFacts: Record<string, string> = { ...(profile.facts ?? {}), ...(facts ?? {}) };
  const factLines = renderFacts(mergedFacts, greetings, signoffs);

  const empty =
    summary.length === 0 &&
    traits.length === 0 &&
    styleGuide.length === 0 &&
    doNotFlag.length === 0 &&
    instructions.length === 0 &&
    accepted.length === 0 &&
    rejected.length === 0 &&
    notes.length === 0;
  if (empty) return '';

  const lines: string[] = [`<user_voice_profile ctx="${ctx}" v="${version}" strength="${strength}">`, '<scope>', VOICE_SCOPE_TEXT];
  if (strength === 3) lines.push(VOICE_SCOPE_STRENGTH_3);
  lines.push('</scope>');
  if (summary.length > 0) lines.push(`<summary>${summary}</summary>`);
  if (factLines.length > 0) lines.push('<style_facts>', ...factLines, '</style_facts>');
  if (traits.length > 0) lines.push('<traits>', ...traits.map((t) => `- ${t}`), '</traits>');
  if (styleGuide.length > 0) lines.push('<style_guide>', styleGuide, '</style_guide>');
  if (doNotFlag.length > 0) lines.push(`<do_not_flag_style>${doNotFlag.join(', ')}</do_not_flag_style>`);
  if (instructions.length > 0) lines.push('<editor_instructions>', ...instructions.map((i) => `- ${i}`), '</editor_instructions>');
  if (accepted.length > 0) lines.push('<examples_this_user_accepted>', ...accepted, '</examples_this_user_accepted>');
  if (rejected.length > 0) lines.push('<examples_this_user_rejected>', ...rejected, '</examples_this_user_rejected>');
  if (notes.length > 0) lines.push('<owner_notes>', OWNER_NOTES_PREAMBLE, notes, '</owner_notes>');
  lines.push('</user_voice_profile>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export interface VoiceLintResult {
  ok: boolean;
  problems: string[];
}

/** Correctness areas a profile must never relax ("error messages"/"error codes" are vocabulary, not errors). */
const TARGET =
  "(?:spellings?|misspell\\w*|spell[- ]?check\\w*|grammar[- ]?check\\w*|typos?|grammar|grammatical|agreement|apostrophes?|capitali[sz]\\w*|capital letters?|punctuation|punctuat\\w*|commas?|periods?|full[- ]stops?|sentence[- ]initial\\s+\\w+|terminal punctuation|its\\/it's|their\\/there|errors?(?! (?:messages?|codes?|logs?|handling|pages?|rates?|bars?|states?))|mistakes?)";
/** Verbs that relax a target outright; the gap to the target may hold a short object phrase. */
const RELAX_VERB =
  "(?:ignore|ignoring|ignores|skip|skips|skipping|overlook|overlooks|suppress|suppresses|disable|disables|relax|relaxes|relaxing|lower|loosen|waive|exempt|turn off|switch off|stop (?:flagging|correcting|fixing|checking|marking|suggesting)|never (?:flag|correct|fix|check|mark|suggest)|(?:don'?t|do not|doesn'?t|does not|shouldn'?t|should not|must not|mustn'?t|no need to|needn'?t|not necessary to|unnecessary to) (?:flag|correct|fix|check|mark|suggest|worry about|bother with|touch|mind|care about|enforce|police|nitpick|point out))";
/**
 * Verbs that relax a target only when it is their direct object ("allows minor typos"), so that "allows a
 * colleague to proofread grammar" and "accepts clarity rewrites but keeps apostrophes curly" pass.
 */
const WEAK_RELAX_VERB = '(?:allow|allows|allowing|accept|accepts|accepting|permit|permits|tolerate|tolerates|tolerating|forgive|forgives|forgiving|excuse|excuses)';
const OBJECT_GAP = '(?:(?:a|an|the|some|all|any|minor|small|occasional|a few|their|my|his|her|most|every|many|frequent|common|casual|informal|sloppy|rough|little|bad)\\s+){0,3}';
const OK_WORDS =
  "(?:fine|ok|okay|acceptable|intentional|deliberate|allowed|permitted|welcome|optional|flexible|loose|relaxed|lax|negotiable|unimportant|irrelevant|expected|tolerated|not (?:an? )?(?:issue|problem|error|mistake|concern|priority)|not (?:enforced|checked|corrected|flagged|policed|required|needed|important|necessary)|not errors|not mistakes|part of (?:my|the|their|his|her) (?:voice|style|brand)|a feature|(?:a |an )?(?:stylistic|style|deliberate|conscious|personal|creative) (?:choice|decision|preference|matter)|(?:their|his|her|my|the (?:user|writer|author)'?s?) (?:thing|choice|style|habit|preference|voice|call|business)|on purpose|by design|intentionally|deliberately|up to (?:the user|them|the writer))";
const SILENCE_VERB = '(?:flagged|corrected|fixed|checked|marked|touched|enforced|policed|changed|altered|suggested|questioned)';

const CORRECTNESS_RELAX_RES: readonly RegExp[] = [
  new RegExp(`\\b${RELAX_VERB}\\b[^.;\\n]{0,60}?\\b${TARGET}\\b`, 'i'),
  new RegExp(`\\b${WEAK_RELAX_VERB}\\b\\s+${OBJECT_GAP}${TARGET}\\b`, 'i'),
  new RegExp(`\\b${TARGET}\\b[^.;\\n]{0,40}?\\b(?:is|are|was|were|being|be)\\s+(?:\\w+\\s+){0,2}?${OK_WORDS}\\b`, 'i'),
  new RegExp(`\\b(?:leave|let)\\b[^.;\\n]{0,40}?\\b${TARGET}\\b[^.;\\n]{0,24}?\\b(?:alone|as is|as they are|as it is|be|untouched|uncorrected)\\b`, 'i'),
  new RegExp(`\\b${TARGET}\\b[^.;\\n]{0,30}?\\b(?:should|can|may|must|could) (?:be )?(?:left|stay|remain|kept)\\b[^.;\\n]{0,20}?\\b(?:alone|as is|uncorrected|untouched|unchanged)\\b`, 'i'),
  new RegExp(`\\btreat\\b[^.;\\n]{0,40}?\\b${TARGET}\\b[^.;\\n]{0,40}?\\b(?:as|like) (?:an? )?(?:style|stylistic|correct|intentional|deliberate|choice|feature)`, 'i'),
  new RegExp(`\\b(?:no|without|zero|fewer|less|minimal)\\s+${TARGET}\\s+(?:checks?|checking|corrections?|suggestions?|fixes|flags?|nitpick\\w*|policing|enforcement)`, 'i'),
  new RegExp(`\\b${TARGET}\\b[^.;\\n]{0,40}?\\b(?:correct|right|fine|good) as (?:written|is|typed|they are)\\b`, 'i'),
  new RegExp(`\\b(?:lowercase|uncapitali[sz]ed|unpunctuated|misspelled|ungrammatical)\\b[^.;\\n]{0,40}?\\b(?:is|are) (?:\\w+\\s+){0,2}?${OK_WORDS}\\b`, 'i'),
  // "Spelling doesn't matter", "Grammar rules do not apply".
  new RegExp(`\\b${TARGET}\\b[^.;\\n]{0,40}?\\b(?:doesn'?t|does not|don'?t|do not|won'?t|will not|need not|needn'?t|shouldn'?t|should not) (?:really |ever )?(?:matter|count|apply|need (?:to be )?(?:fixed|corrected|flagged|checked)|get (?:flagged|corrected|checked)|have to be (?:fixed|corrected|flagged|checked|right|perfect))\\b`, 'i'),
  // "Spelling and grammar are not to be flagged", "should never be corrected".
  new RegExp(`\\b${TARGET}\\b[^.;\\n]{0,50}?\\b(?:not|never) (?:to )?be ${SILENCE_VERB}\\b`, 'i'),
  // "Do not correct anything in this user's text", "Never mark anything as an error".
  new RegExp("\\b(?:do not|don'?t|never) (?:ever )?(?:correct|fix|flag|change|touch|edit|suggest|mark|alter|propose) (?:anything|everything|any (?:text|thing|word|sentence|of it)|a thing|(?:this|the) (?:user|person|writer|author)'?s? (?:text|writing|prose|words?)|the text)\\b", 'i'),
  // "Everything this user writes is correct".
  new RegExp("\\b(?:everything|all|anything|whatever) (?:that )?(?:this |the )?(?:user|person|writer|author|they|he|she)?\\s*(?:writes?|types?|says?|produces?|sends?) is (?:already )?(?:correct|right|fine|acceptable|error[- ]free|perfect|flawless)\\b", 'i'),
  // "Only suggest tone changes, never grammar".
  new RegExp(`\\b(?:only|just|solely|exclusively|merely) (?:ever )?(?:suggest|flag|propose|offer|emit|return|give|make|check|comment on)\\b[^.;\\n]{0,50}?\\b(?:never|not|no|skip|ignore|leave)\\b[^.;\\n]{0,12}?\\b${TARGET}`, 'i'),
];

const INJECTION_RES: readonly [RegExp, string][] = [
  [/\b(?:respond|reply|answer|return|output|emit|produce|give|send|come back)\b(?: back| only| always)?(?: with)? (?:an? |the )?(?:empty|blank) (?:suggestions?|list|array|object|json|response|result|blocks?)\b/i, 'tells the editor to answer empty'],
  [/\b(?:report|return|emit|produce|output|find|show|give) (?:zero|no) (?:errors?|issues?|problems?|suggestions?|corrections?|findings?)\b/i, 'tells the editor to report nothing'],
  [/\b(?:prefers|wants|needs|requires|expects|asks for|demands|requests) (?:absolutely )?(?:no|zero) (?:corrections?|suggestions?|edits?|flags?|feedback|changes)\b/i, 'asks for no corrections'],
  [/\b(?:auto_apply_safe|meaning_preserving|verified_in_samples|block_id)\b/, 'references the output schema'],
  [/["']?\b(?:blocks|suggestions|document)\b["']?\s*:\s*[[{]/, 'JSON that mimics the output contract'],
  [/\b(?:set|force|cap|clamp|assign|override|pin) (?:every |all |each |the |a |any )?(?:confidence|severity|tier|auto[- ]?apply|meaning[- ]preserving)\b/i, 'manipulates confidence or severity'],
  [/\b(?:downgrade|demote|reclassify|relabel|recategori[sz]e) (?:every |all |each |any )?(?:correctness |grammar |spelling )?(?:suggestions?|errors?|corrections?|severity|issues?)\b/i, 'manipulates severity'],
  [/\bignore (?:all |any |the |every )?(?:previous|prior|above|earlier|preceding|other) (?:instructions?|rules?|prompts?|messages?|guidance|context|contract)/i, 'instruction override ("ignore previous ...")'],
  [/\bdisregard\b[^.;\n]{0,40}\b(?:instructions?|rules?|contract|prompt|above|previous)/i, 'instruction override ("disregard ...")'],
  [/\b(?:system|assistant|human|user|developer)\s*:/i, 'role marker ("system:")'],
  [/<\/?\s*(?:user_voice_profile|block|document|context_before|context_after|style_decisions|protected_terms|custom_instructions|do_not_flag|scope|style_guide|editor_instructions|example|text)\b/i, 'prompt tag'],
  [/\byou are now\b|\bfrom now on,? (?:you|ignore|act|respond)\b|\bnew (?:instructions?|rules?|persona|system prompt)\b/i, 'persona or instruction switch'],
  [/\b(?:pretend|act|behave) (?:as|like) (?:an? |the )?(?:assistant|ai|model|system|developer)\b/i, 'persona switch'],
  [/\b(?:emit|return|give|make|output|produce) (?:no|zero|empty|an empty list of|only empty) (?:suggestions?|corrections?|edits?|json)\b/i, 'tells the editor to stay silent'],
  [/\b(?:jailbreak|prompt injection|DAN mode)\b/i, 'injection vocabulary'],
  [/\boutput only\b|\brespond only with\b|\breply only with\b/i, 'output-format override'],
  [/https?:\/\/|\bwww\.|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/i, 'URL or email address'],
];

/** Zero-width and soft-hyphen characters an obfuscated instruction can hide inside words. */
const INVISIBLE_RE = /[­​-‏⁠-⁤﻿]/g;

/** The text the lint patterns see: diacritics and invisible characters removed ("ÍGNORE" -> "IGNORE"). */
function lintProbe(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(INVISIBLE_RE, '');
}

function lintText(field: string, text: string | undefined, problems: string[], maxLen: number): void {
  if (text === undefined || text === null) return;
  if (typeof text !== 'string') {
    problems.push(`${field}: not a string`);
    return;
  }
  if (text.length > maxLen) problems.push(`${field}: ${text.length} characters exceed the cap of ${maxLen}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) problems.push(`${field}: contains control characters`);
  const probe = lintProbe(text);
  for (const re of CORRECTNESS_RELAX_RES) {
    if (re.test(probe)) {
      problems.push(`${field}: relaxes correctness ("${text.slice(0, 80)}")`);
      break;
    }
  }
  for (const [re, what] of INJECTION_RES) {
    if (re.test(probe)) {
      problems.push(`${field}: ${what} ("${text.slice(0, 80)}")`);
      break;
    }
  }
}

function lintList(field: string, items: readonly unknown[] | undefined, problems: string[], maxItems: number, maxLen: number): void {
  if (items === undefined || items === null) return;
  if (!Array.isArray(items)) {
    problems.push(`${field}: not a list`);
    return;
  }
  if (items.length > maxItems) problems.push(`${field}: ${items.length} items exceed the cap of ${maxItems}`);
  items.forEach((item, i) => {
    if (typeof item !== 'string') problems.push(`${field}[${i}]: not a string`);
    else lintText(`${field}[${i}]`, item, problems, maxLen);
  });
}

/**
 * Checks a profile (and optionally the owner's notes) for text that would relax correctness (spelling, grammar,
 * agreement, apostrophes, capitalization, punctuation), for prompt-injection markers (instruction overrides, role
 * markers, prompt tags, silence directives, schema-field manipulation), for URLs/emails, for `doNotFlagStyle`
 * values outside the enum, and for over-length fields. Patterns run on a copy with diacritics and zero-width
 * characters removed. This is the regex half of the lint (08 §4.4); the Haiku classifier is the other half, so
 * paraphrases the patterns miss are expected. A failing profile is never rendered.
 */
export function lintVoiceProfile(profile: VoiceProfile, notes?: string): VoiceLintResult {
  const problems: string[] = [];
  lintText('summary', profile.summary, problems, VOICE_CAPS.summary);
  lintText('styleGuide', profile.styleGuide, problems, VOICE_CAPS.styleGuide);
  lintText('changelog', profile.changelog, problems, VOICE_CAPS.changelog);
  if (Array.isArray(profile.traits)) {
    if (profile.traits.length > VOICE_CAPS.traits) problems.push(`traits: ${profile.traits.length} traits exceed the cap of ${VOICE_CAPS.traits}`);
    profile.traits.forEach((t, i) => {
      if (t === null || typeof t !== 'object') {
        problems.push(`traits[${i}]: not an object`);
        return;
      }
      lintText(`traits[${i}].label`, t.label, problems, VOICE_CAPS.traitLabel);
      lintText(`traits[${i}].description`, t.description, problems, VOICE_CAPS.traitLine);
      if (!DIMENSION_SET.has(t.dimension)) problems.push(`traits[${i}].dimension: "${String(t.dimension)}" is not a known dimension`);
    });
  } else if (profile.traits !== undefined) {
    problems.push('traits: not a list');
  }
  lintList('editorInstructions', profile.editorInstructions, problems, VOICE_CAPS.editorInstructions, VOICE_CAPS.listItem);
  if (Array.isArray(profile.doNotFlagStyle)) {
    profile.doNotFlagStyle.forEach((v, i) => {
      if (typeof v !== 'string' || !DO_NOT_FLAG_SET.has(v)) problems.push(`doNotFlagStyle[${i}]: "${String(v)}" is not an allowed style relaxation`);
    });
  }
  lintList('keepPhrases', profile.keepPhrases, problems, VOICE_CAPS.listItems, VOICE_CAPS.listItem);
  lintList('avoidPhrases', profile.avoidPhrases, problems, VOICE_CAPS.listItems, VOICE_CAPS.listItem);
  lintList('greetings', profile.greetings, problems, VOICE_CAPS.listItems, VOICE_CAPS.listItem);
  lintList('signoffs', profile.signoffs, problems, VOICE_CAPS.listItems, VOICE_CAPS.listItem);
  lintList('acceptedPatterns', profile.acceptedPatterns, problems, VOICE_CAPS.listItems, VOICE_CAPS.listItem);
  lintList('rejectedPatterns', profile.rejectedPatterns, problems, VOICE_CAPS.listItems, VOICE_CAPS.listItem);
  const accepted = profile.examples?.accepted;
  if (Array.isArray(accepted)) {
    if (accepted.length > VOICE_CAPS.examples) problems.push(`examples.accepted: ${accepted.length} examples exceed the cap of ${VOICE_CAPS.examples}`);
    accepted.forEach((ex, i) => {
      lintText(`examples.accepted[${i}].before`, ex?.before, problems, VOICE_CAPS.exampleSide);
      lintText(`examples.accepted[${i}].after`, ex?.after, problems, VOICE_CAPS.exampleSide);
    });
  }
  const rejected = profile.examples?.rejected;
  if (Array.isArray(rejected)) {
    if (rejected.length > VOICE_CAPS.examples) problems.push(`examples.rejected: ${rejected.length} examples exceed the cap of ${VOICE_CAPS.examples}`);
    rejected.forEach((ex, i) => {
      lintText(`examples.rejected[${i}].before`, ex?.before, problems, VOICE_CAPS.exampleSide);
      lintText(`examples.rejected[${i}].proposed`, ex?.proposed, problems, VOICE_CAPS.exampleSide);
      lintText(`examples.rejected[${i}].keptOrFinal`, ex?.keptOrFinal, problems, VOICE_CAPS.exampleSide);
    });
  }
  if (notes !== undefined) lintText('notes', notes, problems, VOICE_CAPS.notes);
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Synthesis call (08 §8.3)
// ---------------------------------------------------------------------------

export interface VoiceDecisionInput {
  rule: string;
  original: string;
  replacement: string;
  final?: string;
  sentence: string;
  host: string;
  kind: 'accept' | 'dismiss' | 'edit_after_accept';
}

export interface VoiceSynthesisInput {
  context: VoiceContext;
  previous?: VoiceProfile;
  /** Trait ids (or phrases) the user locked. */
  locked: string[];
  /** Trait ids and phrases the user removed; never re-introduced. */
  removedByUser: string[];
  facts: Record<string, string>;
  /** Role, audiences, self-description, chosen decisions from onboarding. */
  onboarding?: string;
  decisions: VoiceDecisionInput[];
  samples: { host: string; sentence: string }[];
  budget: { styleGuideMaxTokens: number; traitsMax: number };
}

export const VOICE_SYNTHESIS_LIMITS = { accepted: 25, dismissed: 25, editAfterAccept: 10, samples: 400, onboarding: 2000, sentence: 280, snippet: 200, host: 80 } as const;

/** Sanitizes every string inside a JSON-able value (for the previous profile and the facts). */
function sanitizeDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (typeof value === 'string') return sanitizePromptText(value, 3000, { multiline: true });
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
      if (key.length === 0) continue;
      const sv = sanitizeDeep(v, depth + 1);
      if (sv !== undefined) out[key] = sv;
    }
    return out;
  }
  return undefined;
}

/** The previous profile in the output-schema's field names, so the model can refine rather than restart. */
function previousProfileJson(p: VoiceProfile): string {
  const shaped = {
    context: p.context,
    summary: p.summary,
    traits: (p.traits ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      dimension: t.dimension,
      evidence_count: t.evidenceCount,
      confidence: t.confidence,
      verified_in_samples: true,
      locked: t.locked === true,
    })),
    style_guide: p.styleGuide,
    editor_instructions: p.editorInstructions,
    do_not_flag_style: p.doNotFlagStyle,
    keep_phrases: p.keepPhrases,
    avoid_phrases: p.avoidPhrases,
    greetings: p.greetings,
    signoffs: p.signoffs,
    accepted_patterns: p.acceptedPatterns,
    rejected_patterns: p.rejectedPatterns,
    examples: {
      accepted: p.examples?.accepted ?? [],
      rejected: (p.examples?.rejected ?? []).map((r) => ({ before: r.before, proposed: r.proposed, kept_or_final: r.keptOrFinal })),
    },
    confidence: p.confidence,
    changelog: p.changelog,
  };
  return JSON.stringify(sanitizeDeep(shaped));
}

function decisionLine(d: VoiceDecisionInput): string {
  const row: Record<string, string> = {
    kind: d.kind,
    rule: sanitizePromptText(d.rule, 60),
    original: sanitizePromptText(d.original, VOICE_SYNTHESIS_LIMITS.snippet),
    replacement: sanitizePromptText(d.replacement, VOICE_SYNTHESIS_LIMITS.snippet),
  };
  if (typeof d.final === 'string' && d.final.length > 0) row.final = sanitizePromptText(d.final, VOICE_SYNTHESIS_LIMITS.snippet);
  row.sentence = sanitizePromptText(d.sentence, VOICE_SYNTHESIS_LIMITS.sentence);
  row.host = sanitizePromptText(d.host, VOICE_SYNTHESIS_LIMITS.host);
  return JSON.stringify(row);
}

/**
 * Builds the synthesis call: the cached system prompt and the volatile user turn assembled from tags in the
 * order of 08 §8.3 (`<context>`, `<previous_profile>`, `<locked>`, `<removed_by_user>`, `<facts>`, `<onboarding>`,
 * `<decisions>`, `<samples>`, `<budget>`). Decisions are capped at 25 accepted, 25 dismissed and 10
 * edit-after-accept; samples at 400 lines. Everything is sanitized as data.
 */
export function buildVoiceSynthesisMessages(input: VoiceSynthesisInput): { system: string; user: string } {
  const ctx: VoiceContext = VOICE_CONTEXTS.includes(input.context) ? input.context : 'messages';
  const lines: string[] = [`<context>${ctx}</context>`];
  lines.push(`<previous_profile>${input.previous === undefined ? 'none' : previousProfileJson(input.previous)}</previous_profile>`);
  const locked = sanitizeList(input.locked, 40, VOICE_CAPS.listItem);
  lines.push(locked.length > 0 ? `<locked>\n${locked.join('\n')}\n</locked>` : '<locked></locked>');
  const removed = sanitizeList(input.removedByUser, 80, VOICE_CAPS.listItem);
  lines.push(removed.length > 0 ? `<removed_by_user>\n${removed.join('\n')}\n</removed_by_user>` : '<removed_by_user></removed_by_user>');
  lines.push(`<facts>${JSON.stringify(sanitizeDeep(input.facts ?? {}))}</facts>`);
  const onboarding = sanitizePromptText(input.onboarding ?? '', VOICE_SYNTHESIS_LIMITS.onboarding, { multiline: true });
  if (onboarding.length > 0) lines.push(`<onboarding>\n${onboarding}\n</onboarding>`);

  const accepted = input.decisions.filter((d) => d.kind === 'accept').slice(0, VOICE_SYNTHESIS_LIMITS.accepted);
  const dismissed = input.decisions.filter((d) => d.kind === 'dismiss').slice(0, VOICE_SYNTHESIS_LIMITS.dismissed);
  const edited = input.decisions.filter((d) => d.kind === 'edit_after_accept').slice(0, VOICE_SYNTHESIS_LIMITS.editAfterAccept);
  const decisionLines = [...accepted, ...dismissed, ...edited].map(decisionLine);
  lines.push(decisionLines.length > 0 ? `<decisions>\n${decisionLines.join('\n')}\n</decisions>` : '<decisions></decisions>');

  const sampleLines: string[] = [];
  for (const s of input.samples) {
    const sentence = sanitizePromptText(s.sentence ?? '', VOICE_SYNTHESIS_LIMITS.sentence);
    if (sentence.length === 0) continue;
    const host = sanitizePromptText(s.host ?? '', VOICE_SYNTHESIS_LIMITS.host) || 'unknown';
    sampleLines.push(`[${host}] ${sentence}`);
    if (sampleLines.length >= VOICE_SYNTHESIS_LIMITS.samples) break;
  }
  lines.push(sampleLines.length > 0 ? `<samples>\n${sampleLines.join('\n')}\n</samples>` : '<samples></samples>');

  const styleGuideMax = clampInt(input.budget?.styleGuideMaxTokens, 100, 1500, 600);
  const traitsMax = clampInt(input.budget?.traitsMax, 1, VOICE_CAPS.traits, VOICE_CAPS.traits);
  lines.push(`<budget>style_guide_max_tokens: ${styleGuideMax}; traits_max: ${traitsMax}</budget>`);
  return { system: VOICE_SYSTEM_PROMPT, user: lines.join('\n') };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

// ---------------------------------------------------------------------------
// Synthesis output post-processing
// ---------------------------------------------------------------------------

/** Thrown when the synthesis response is not a JSON object at all. */
export class VoiceOutputError extends Error {
  override readonly name = 'VoiceOutputError';
  constructor(message: string, readonly raw?: unknown) {
    super(message);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanStr(v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') return '';
  let s = stripControlChars(v).replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanList(v: unknown, maxItems: number, maxLen: number, tombstones: ReadonlySet<string>): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = cleanStr(item, maxLen);
    const key = s.toLowerCase();
    if (s.length === 0 || seen.has(key) || tombstones.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function unwrap(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) throw new VoiceOutputError('response contains no JSON object', raw);
  try {
    return JSON.parse(s.slice(first, last + 1)) as unknown;
  } catch (e) {
    throw new VoiceOutputError(`response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, raw);
  }
}

const TRAIT_CONFIDENCES: readonly VoiceTrait['confidence'][] = ['low', 'medium', 'high'];
const PROFILE_CONFIDENCES: readonly VoiceProfile['confidence'][] = ['provisional', 'low', 'medium', 'high'];

/**
 * Turns the synthesis response into the next VoiceProfile version (08 §8.3 post-processing): traits with
 * `evidence_count` below 3 or `verified_in_samples` false are dropped, caps are enforced (12 traits, 8/8 phrases,
 * 3/3 greetings and sign-offs, 6/6 patterns and examples), the previous profile's locks are re-applied (locked
 * traits are kept exactly as stored even if the model changed or dropped them), `removedByUser` tombstones are
 * honoured for trait ids and list items, `facts` and `removedByUser` carry over, and `version` is bumped.
 * The context is always the previous profile's (or the response's when there is no previous profile).
 * Throws {@link VoiceOutputError} when the response is not an object; the caller keeps the previous version.
 */
export function parseVoiceSynthesis(raw: unknown, previous: VoiceProfile | undefined, now: string, model: string): VoiceProfile {
  const value = unwrap(raw);
  if (!isRecord(value)) throw new VoiceOutputError('top-level value is not an object', raw);

  const ctxValue = previous?.context ?? (typeof value.context === 'string' ? value.context.trim().toLowerCase() : '');
  if (!(VOICE_CONTEXTS as readonly string[]).includes(ctxValue)) throw new VoiceOutputError('voice context missing', raw);
  const context = ctxValue as VoiceContext;

  const removedByUser = [...(previous?.removedByUser ?? [])].filter((s): s is string => typeof s === 'string');
  const tombstones = new Set(removedByUser.map((s) => s.trim().toLowerCase()));

  // Traits.
  const lockedById = new Map<string, VoiceTrait>();
  for (const t of previous?.traits ?? []) if (t.locked) lockedById.set(t.id, t);
  const traits: VoiceTrait[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(value.traits)) {
    for (const item of value.traits) {
      if (!isRecord(item)) continue;
      const id = cleanStr(item.id, 60).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      const evidence = typeof item.evidence_count === 'number' && Number.isFinite(item.evidence_count) ? Math.floor(item.evidence_count) : 0;
      const verified = item.verified_in_samples === true;
      if (id.length === 0 || seenIds.has(id) || tombstones.has(id)) continue;
      const locked = lockedById.get(id);
      if (locked !== undefined) {
        traits.push({ ...locked, locked: true });
        seenIds.add(id);
        continue;
      }
      if (evidence < 3 || !verified) continue;
      const label = cleanStr(item.label, VOICE_CAPS.traitLabel);
      const description = cleanStr(item.description, VOICE_CAPS.traitLine);
      if (label.length === 0) continue;
      const dimension = typeof item.dimension === 'string' && DIMENSION_SET.has(item.dimension) ? (item.dimension as VoiceTrait['dimension']) : 'stylistic_choices';
      const confidence = typeof item.confidence === 'string' && (TRAIT_CONFIDENCES as readonly string[]).includes(item.confidence.toLowerCase()) ? (item.confidence.toLowerCase() as VoiceTrait['confidence']) : 'low';
      traits.push({ id, label, description, dimension, evidenceCount: evidence, confidence, locked: false });
      seenIds.add(id);
    }
  }
  for (const [id, t] of lockedById) {
    if (!seenIds.has(id)) {
      traits.push({ ...t, locked: true });
      seenIds.add(id);
    }
  }
  // Locked traits survive the cap.
  const lockedTraits = traits.filter((t) => t.locked);
  const unlockedTraits = traits.filter((t) => !t.locked);
  const cappedTraits = [...lockedTraits, ...unlockedTraits].slice(0, Math.max(VOICE_CAPS.traits, lockedTraits.length));

  const examplesRaw = isRecord(value.examples) ? value.examples : {};
  const accepted: VoiceProfile['examples']['accepted'] = [];
  if (Array.isArray(examplesRaw.accepted)) {
    for (const ex of examplesRaw.accepted) {
      if (!isRecord(ex)) continue;
      const before = cleanStr(ex.before, VOICE_CAPS.exampleSide);
      const after = cleanStr(ex.after, VOICE_CAPS.exampleSide);
      if (before.length === 0 || after.length === 0) continue;
      accepted.push({ before, after });
      if (accepted.length >= VOICE_CAPS.examples) break;
    }
  }
  const rejected: VoiceProfile['examples']['rejected'] = [];
  if (Array.isArray(examplesRaw.rejected)) {
    for (const ex of examplesRaw.rejected) {
      if (!isRecord(ex)) continue;
      const before = cleanStr(ex.before, VOICE_CAPS.exampleSide);
      const proposed = cleanStr(ex.proposed, VOICE_CAPS.exampleSide);
      const keptOrFinal = cleanStr(ex.kept_or_final ?? ex.keptOrFinal, VOICE_CAPS.exampleSide);
      if (before.length === 0 || proposed.length === 0 || keptOrFinal.length === 0) continue;
      rejected.push({ before, proposed, keptOrFinal });
      if (rejected.length >= VOICE_CAPS.examples) break;
    }
  }

  const confidenceRaw = typeof value.confidence === 'string' ? value.confidence.trim().toLowerCase() : '';
  const confidence = (PROFILE_CONFIDENCES as readonly string[]).includes(confidenceRaw) ? (confidenceRaw as VoiceProfile['confidence']) : 'provisional';

  return {
    context,
    version: (Number.isInteger(previous?.version) && (previous?.version ?? 0) >= 0 ? (previous?.version ?? 0) : 0) + 1,
    generatedAt: now,
    generatedBy: model,
    confidence,
    summary: cleanStr(value.summary, VOICE_CAPS.summary),
    traits: cappedTraits,
    styleGuide: cleanStr(value.style_guide, VOICE_CAPS.styleGuide, true),
    editorInstructions: cleanList(value.editor_instructions, VOICE_CAPS.editorInstructions, VOICE_CAPS.listItem, tombstones),
    doNotFlagStyle: filterDoNotFlag(Array.isArray(value.do_not_flag_style) ? value.do_not_flag_style.filter((v): v is string => typeof v === 'string') : []),
    keepPhrases: cleanList(value.keep_phrases, VOICE_CAPS.listItems, VOICE_CAPS.listItem, tombstones),
    avoidPhrases: cleanList(value.avoid_phrases, VOICE_CAPS.listItems, VOICE_CAPS.listItem, tombstones),
    greetings: cleanList(value.greetings, VOICE_CAPS.greetings, VOICE_CAPS.listItem, tombstones),
    signoffs: cleanList(value.signoffs, VOICE_CAPS.signoffs, VOICE_CAPS.listItem, tombstones),
    acceptedPatterns: cleanList(value.accepted_patterns, VOICE_CAPS.patterns, VOICE_CAPS.listItem, tombstones),
    rejectedPatterns: cleanList(value.rejected_patterns, VOICE_CAPS.patterns, VOICE_CAPS.listItem, tombstones),
    examples: { accepted, rejected },
    facts: { ...(previous?.facts ?? {}) },
    changelog: cleanStr(value.changelog, VOICE_CAPS.changelog, true),
    removedByUser,
  };
}

// ---------------------------------------------------------------------------
// Deterministic facts
// ---------------------------------------------------------------------------

const CONTRACTION_RE = /\b(?:\w+n['’]t|\w+['’](?:s|re|ve|ll|d|m)|let['’]s|y['’]all|o['’]clock)\b/i;
const OXFORD_RE = /,\s+\S+(?:\s+\S+)?,\s+(?:and|or|nor)\s/gi;
const NO_OXFORD_RE = /,\s+\S+(?:\s+\S+)?\s+(?:and|or|nor)\s/gi;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LEADING_OPENERS_RE = /^[\s"'“‘(\[{«]+/;

function count(text: string, re: RegExp): number {
  let n = 0;
  for (const _ of text.matchAll(re)) n++;
  return n;
}

function pct(k: number, n: number): string {
  return `${Math.round((100 * k) / n)}%`;
}

function fmt1(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1);
}

function majority(entries: readonly [string, number][], mixedThreshold = 0.25): string {
  let best = '';
  let bestN = 0;
  let total = 0;
  for (const [name, n] of entries) {
    total += n;
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  if (total === 0) return 'unknown';
  return total - bestN >= Math.ceil(total * mixedThreshold) && total - bestN > 0 ? 'mixed' : best;
}

/**
 * Deterministic style statistics over typed samples (08 §8.3 rule 5): average sentence length and its standard
 * deviation, contraction rate, serial-comma habit, dash style, quote style, exclamation marks per 100 sentences,
 * emoji rate and lowercase-start rate, plus sentence and word counts. Values are strings ready for the prompt;
 * an empty sample set yields an empty object.
 */
export function computeVoiceFacts(samples: readonly string[]): Record<string, string> {
  const sentences: string[] = [];
  for (const s of samples) {
    if (typeof s !== 'string') continue;
    for (const r of splitSentences(s)) sentences.push(s.slice(r.start, r.end));
  }
  const n = sentences.length;
  if (n === 0) return {};
  const words = sentences.map(countWords);
  const totalWords = words.reduce((a, b) => a + b, 0);
  const avg = totalWords / n;
  const variance = words.reduce((acc, w) => acc + (w - avg) * (w - avg), 0) / n;
  const all = samples.filter((s): s is string => typeof s === 'string').join('\n');

  let contractions = 0;
  let exclamations = 0;
  let emoji = 0;
  let lowercase = 0;
  for (const s of sentences) {
    if (CONTRACTION_RE.test(s)) contractions++;
    if (/!+["'”’)\]]*$/.test(s)) exclamations++;
    if (EMOJI_RE.test(s)) emoji++;
    const first = s.replace(LEADING_OPENERS_RE, '').charAt(0);
    if (first.length > 0 && /\p{Ll}/u.test(first)) lowercase++;
  }

  const oxford = count(all, OXFORD_RE);
  const noOxford = count(all, NO_OXFORD_RE) - oxford;
  const serialComma = majority([
    ['oxford', oxford],
    ['no_oxford', Math.max(0, noOxford)],
  ]);
  const dash = majority([
    ['em_closed', count(all, /\S—\S/g)],
    ['em_spaced', count(all, /\s—\s/g)],
    ['en_spaced', count(all, /\s–\s/g)],
    ['hyphen_spaced', count(all, /\s-\s/g)],
    ['double_hyphen', count(all, /--/g)],
  ]);
  const quotes = majority([
    ['curly', count(all, /[“”]/g)],
    ['straight', count(all, /"/g)],
  ]);

  return {
    sentences: String(n),
    words: String(totalWords),
    sentence_words_avg: fmt1(avg),
    sentence_words_sd: fmt1(Math.sqrt(variance)),
    contraction_rate: `${pct(contractions, n)} of sentences`,
    serial_comma: serialComma,
    dash_style: dash,
    quote_style: quotes,
    exclamation_per_100_sentences: String(Math.round((100 * exclamations) / n)),
    emoji_rate: `${pct(emoji, n)} of sentences`,
    lowercase_start_rate: `${pct(lowercase, n)} of sentences`,
  };
}
