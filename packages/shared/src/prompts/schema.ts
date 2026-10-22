/**
 * JSON schemas for `output_config.format` (suggestion engine, voice synthesis, tone) and the tolerant parser
 * that turns a model response into an {@link EngineOutput}.
 *
 * Structured-output constraints (02 reviewer A2, 08 reviewer 16) that every schema here obeys and that
 * {@link validateStructuredOutputSchema} checks: every object carries `additionalProperties: false` and lists
 * every property in `required`; no `minimum`/`maximum`/`minLength`/`maxLength`/`multipleOf`/`minItems`/`$ref`;
 * no `anyOf`/`oneOf`/`allOf`; at most 24 optional and 16 union-typed properties; enum values are matched
 * case-insensitively by the API so none differ only in case; no property solicits the model's reasoning
 * (the field is `explanation`, never `reasoning`). Numeric ranges are clamped client-side instead.
 *
 * No side effects at import.
 */
import { z } from 'zod';
import type { ConsistencyNote, EngineBlockResult, EngineOutput, ToneLabel } from '../types';
import { CATEGORIES } from '../types';
import { stripControlChars } from './sanitize';
import { DO_NOT_FLAG_STYLE_VALUES, ENGINE_RULE_IDS, TONE_LABELS, VOICE_TRAIT_DIMENSIONS } from './vocabulary';

/** Bumped whenever the structure of any output schema changes (part of the cache key next to PROMPT_VERSION). */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// JSON schema objects
// ---------------------------------------------------------------------------

/** The subset of JSON Schema the structured-output API accepts and this module uses. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: string[];
}

function str(description?: string): JsonSchema {
  return description === undefined ? { type: 'string' } : { type: 'string', description };
}

function enumOf(values: readonly string[], description?: string): JsonSchema {
  const out: JsonSchema = { type: 'string', enum: [...values] };
  if (description !== undefined) out.description = description;
  return out;
}

/** An object whose `required` list is exactly its property keys and which forbids extra properties. */
function obj(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  const out: JsonSchema = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
  if (description !== undefined) out.description = description;
  return out;
}

function arr(items: JsonSchema, description?: string): JsonSchema {
  const out: JsonSchema = { type: 'array', items };
  if (description !== undefined) out.description = description;
  return out;
}

export const SEVERITY_VALUES = ['error', 'warning', 'suggestion'] as const;
export const KIND_VALUES = ['replace', 'delete', 'insert', 'flag', 'rewrite'] as const;
export const TONE_STRENGTH_VALUES = ['strong', 'moderate', 'slight'] as const;
export const VOICE_CONFIDENCE_VALUES = ['provisional', 'low', 'medium', 'high'] as const;
export const TRAIT_CONFIDENCE_VALUES = ['low', 'medium', 'high'] as const;

const TONE_LABEL_SCHEMA: JsonSchema = obj({
  label: enumOf(TONE_LABELS),
  strength: enumOf(TONE_STRENGTH_VALUES),
});

/**
 * Output schema of the suggestion call (02 §8.3), shaped exactly like {@link EngineOutput}: blocks of anchored
 * suggestions plus document-level tone, consistency notes and a free-text note.
 */
export const SUGGESTION_OUTPUT_SCHEMA: JsonSchema = obj({
  blocks: arr(
    obj({
      block_id: str(),
      suggestions: arr(
        obj({
          id: str(),
          category: enumOf(CATEGORIES),
          rule: enumOf(ENGINE_RULE_IDS),
          severity: enumOf(SEVERITY_VALUES),
          kind: enumOf(KIND_VALUES),
          original: str(),
          prefix: str(),
          suffix: str(),
          occurrence: { type: 'integer' },
          replacement: str(),
          alternatives: arr(str()),
          explanation: str(),
          confidence: { type: 'number' },
          meaning_preserving: { type: 'boolean' },
          auto_apply_safe: { type: 'boolean' },
        }),
      ),
    }),
  ),
  document: obj({
    tone: arr(TONE_LABEL_SCHEMA),
    consistency: arr(
      obj({
        variants: arr(str()),
        recommended: str(),
        explanation: str(),
      }),
    ),
    notes: str(),
  }),
});

/** Output schema of the separate tone call (02 §8.6). */
export const TONE_OUTPUT_SCHEMA: JsonSchema = obj({
  tone: arr(TONE_LABEL_SCHEMA),
  rationale: str('One sentence of at most 100 characters describing the impression the text makes on its reader.'),
});

/** Output schema of the voice-profile synthesis call (08 §8.3). */
export const VOICE_OUTPUT_SCHEMA: JsonSchema = obj({
  context: enumOf(['messages', 'documents']),
  summary: str('One sentence, <= 30 words, how this person writes in this context.'),
  traits: arr(
    obj({
      id: str('snake_case stable id, reuse ids from previous_profile when the trait persists'),
      label: str("<= 4 words, e.g. 'Short sentences'"),
      description: str('<= 25 words, descriptive, present tense'),
      dimension: enumOf(VOICE_TRAIT_DIMENSIONS),
      evidence_count: { type: 'integer' },
      confidence: enumOf(TRAIT_CONFIDENCE_VALUES),
      verified_in_samples: { type: 'boolean' },
    }),
  ),
  style_guide: str('<= 600 tokens; headed paragraphs; prose the editor model reads.'),
  editor_instructions: arr(str(), '<= 6 imperative sentences for the editor about phrasing rewrites; style only.'),
  do_not_flag_style: arr(enumOf(DO_NOT_FLAG_STYLE_VALUES)),
  keep_phrases: arr(str()),
  avoid_phrases: arr(str()),
  greetings: arr(str()),
  signoffs: arr(str()),
  accepted_patterns: arr(str(), '<= 6, each <= 20 words, what kinds of rewrites this person accepts'),
  rejected_patterns: arr(str(), '<= 6, what kinds of rewrites this person dismisses or undoes'),
  examples: obj({
    accepted: arr(obj({ before: str(), after: str() }), '<= 6 pairs, <= 160 chars each side, copied from decisions'),
    rejected: arr(obj({ before: str(), proposed: str(), kept_or_final: str() }), '<= 6 triples'),
  }),
  confidence: enumOf(VOICE_CONFIDENCE_VALUES, 'overall; provisional when samples < 600 words'),
  changelog: str('<= 80 words: what changed vs previous_profile and why'),
});

// ---------------------------------------------------------------------------
// Structured-output constraint checker
// ---------------------------------------------------------------------------

export const STRUCTURED_OUTPUT_LIMITS = { optionalProperties: 24, unionProperties: 16 } as const;

/** Keywords the structured-output compiler rejects (or that we never want to depend on). */
const FORBIDDEN_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'multipleOf', 'minItems',
  'maxItems', 'uniqueItems', 'pattern', 'format', '$ref', '$defs', 'definitions', 'anyOf', 'oneOf', 'allOf', 'not',
  'if', 'then', 'else', 'patternProperties', 'additionalItems', 'dependencies', 'dependentRequired',
] as const;

/** Property names that read as a request for the model's reasoning (a `reasoning_extraction` refusal risk). */
const REASONING_NAME_RE = /^(?:reasoning|reason|reasons|thinking|think|thought|thoughts|chain_of_thought|cot|scratchpad|internal_monologue|deliberation)$/i;
/** Descriptions that solicit step-by-step reasoning. */
const REASONING_DESCRIPTION_RE = /step[- ]by[- ]step|chain of thought|your reasoning|think(?:ing)? (?:aloud|out loud|through)|show your work|explain your thinking/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walks a JSON schema and returns every violation of the structured-output constraints (empty when the schema
 * is acceptable). Used by the unit tests and available to the worker as a startup assertion.
 */
export function validateStructuredOutputSchema(schema: unknown): string[] {
  const problems: string[] = [];
  let optional = 0;
  let unions = 0;

  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) {
      problems.push(`${path}: schema node is not an object`);
      return;
    }
    for (const key of FORBIDDEN_KEYWORDS) {
      if (key in node) problems.push(`${path}: forbidden keyword "${key}"`);
    }
    const type = node.type;
    if (Array.isArray(type)) {
      unions++;
      problems.push(`${path}: union type arrays are not used in Jammarly schemas`);
      return;
    }
    if (typeof type !== 'string') {
      problems.push(`${path}: missing "type"`);
      return;
    }
    if (typeof node.description === 'string' && REASONING_DESCRIPTION_RE.test(node.description)) {
      problems.push(`${path}: description solicits reasoning`);
    }
    if (Array.isArray(node.enum)) {
      const seen = new Set<string>();
      for (const v of node.enum) {
        if (typeof v !== 'string') {
          problems.push(`${path}: non-string enum value`);
          continue;
        }
        const folded = v.toLowerCase();
        if (seen.has(folded)) problems.push(`${path}: enum values "${v}" differ only in case`);
        seen.add(folded);
      }
    }
    if (type === 'object') {
      if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
      const props = node.properties;
      if (!isRecord(props)) {
        problems.push(`${path}: object without "properties"`);
        return;
      }
      const keys = Object.keys(props);
      const required = Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === 'string') : [];
      const requiredSet = new Set(required);
      for (const r of required) if (!(r in props)) problems.push(`${path}: required lists unknown property "${r}"`);
      for (const k of keys) {
        if (!requiredSet.has(k)) {
          optional++;
          problems.push(`${path}.${k}: property is optional (every property must be required)`);
        }
        if (REASONING_NAME_RE.test(k)) problems.push(`${path}.${k}: property name solicits reasoning`);
        walk(props[k], `${path}.${k}`);
      }
    } else if (type === 'array') {
      if (!isRecord(node.items)) problems.push(`${path}: array without "items"`);
      else walk(node.items, `${path}[]`);
    } else if (!['string', 'number', 'integer', 'boolean'].includes(type)) {
      problems.push(`${path}: unsupported type "${type}"`);
    }
  };

  walk(schema, '$');
  if (optional > STRUCTURED_OUTPUT_LIMITS.optionalProperties) problems.push(`$: ${optional} optional properties exceed ${STRUCTURED_OUTPUT_LIMITS.optionalProperties}`);
  if (unions > STRUCTURED_OUTPUT_LIMITS.unionProperties) problems.push(`$: ${unions} union-typed properties exceed ${STRUCTURED_OUTPUT_LIMITS.unionProperties}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Tolerant zod schemas
// ---------------------------------------------------------------------------

const lowerTrim = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toLowerCase() : v);

/** Case-insensitive enum (the API matches enum values case-insensitively, so the parser does too). */
function ciEnum<const T extends readonly string[]>(values: T) {
  return z.preprocess(lowerTrim, z.enum(values));
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
  return fallback;
}

/**
 * Coerces a confidence to [0, 1]: a value in [10, 100] is read as a percentage ("95" -> 0.95), any other value
 * above 1 saturates at 1, negatives become 0.
 */
export function coerceConfidence(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return n >= 10 && n <= 100 ? n / 100 : 1;
  return n;
}

export const EXPLANATION_MAX_CHARS = 200;

function cleanExplanation(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = stripControlChars(v).replace(/\s+/g, ' ').trim();
  return s.length > EXPLANATION_MAX_CHARS ? s.slice(0, EXPLANATION_MAX_CHARS) : s;
}

function cleanShortText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = stripControlChars(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function stringList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = stripControlChars(item).trim();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s.length > maxLen ? s.slice(0, maxLen) : s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** One suggestion as the model emitted it; tolerant of string booleans/numbers and sloppy casing. */
/** A key that may be missing or of the wrong type; `fn` turns whatever arrived into the field's value. */
function lenient<T>(fn: (v: unknown) => T) {
  return z.unknown().optional().transform(fn);
}

export const EngineSuggestionSchema = z.object({
  id: lenient((v) => (typeof v === 'string' ? v.trim() : '')),
  category: ciEnum(CATEGORIES),
  rule: z
    .string()
    // Tolerate "Subject-Verb Agreement" for subject_verb_agreement; anything else that is not a snake_case id fails.
    .transform((s) => s.trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .refine((s) => /^[a-z][a-z0-9_]*$/.test(s), { message: 'rule is not a snake_case id' }),
  severity: ciEnum(SEVERITY_VALUES),
  kind: ciEnum(KIND_VALUES),
  original: z.string().min(1, { message: 'original is empty' }),
  prefix: lenient((v) => (typeof v === 'string' ? v : '')),
  suffix: lenient((v) => (typeof v === 'string' ? v : '')),
  occurrence: lenient((v) => {
    const n = toFiniteNumber(v);
    return n === undefined ? 1 : Math.max(1, Math.floor(n));
  }),
  replacement: z.string(),
  alternatives: lenient((v) => stringList(v, 3, 1000)),
  explanation: lenient(cleanExplanation),
  confidence: z
    .unknown()
    .optional()
    .transform((v, ctx) => {
      const n = toFiniteNumber(v);
      if (n === undefined) {
        ctx.addIssue({ code: 'custom', message: 'confidence is not a number' });
        return z.NEVER;
      }
      return coerceConfidence(n);
    }),
  meaning_preserving: lenient((v) => toBool(v, false)),
  auto_apply_safe: lenient((v) => toBool(v, false)),
});

const TONE_LABEL_SET: ReadonlySet<string> = new Set<string>(TONE_LABELS);
const STRENGTH_SET: ReadonlySet<string> = new Set<string>(TONE_STRENGTH_VALUES);

/** Lowercases labels, drops unknown labels and invalid strengths, de-duplicates, keeps at most `max`. */
export function toToneLabels(v: unknown, max = 3): ToneLabel[] {
  if (!Array.isArray(v)) return [];
  const out: ToneLabel[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRecord(item)) continue;
    const label = typeof item.label === 'string' ? item.label.trim().toLowerCase() : '';
    const strength = typeof item.strength === 'string' ? item.strength.trim().toLowerCase() : '';
    if (!TONE_LABEL_SET.has(label) || !STRENGTH_SET.has(strength) || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, strength: strength as ToneLabel['strength'] });
    if (out.length >= max) break;
  }
  return out;
}

function toConsistency(v: unknown): ConsistencyNote[] {
  if (!Array.isArray(v)) return [];
  const out: ConsistencyNote[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const variants = stringList(item.variants, 8, 80);
    const recommended = cleanShortText(item.recommended, 80);
    if (variants.length < 2 || recommended.length === 0) continue;
    out.push({ variants, recommended, explanation: cleanShortText(item.explanation, EXPLANATION_MAX_CHARS) });
    if (out.length >= 12) break;
  }
  return out;
}

export const EngineDocumentSchema = z.preprocess(
  (v) => (isRecord(v) ? v : {}),
  z.object({
    tone: lenient((v) => toToneLabels(v)),
    consistency: lenient(toConsistency),
    notes: lenient((v) => cleanShortText(v, 500)),
  }),
);

export const EngineBlockSchema = z.object({
  block_id: z.string().trim().min(1),
  suggestions: z.array(EngineSuggestionSchema),
});

/**
 * The full response as zod. Strict in one sense: a malformed suggestion fails the whole parse. Use
 * {@link parseEngineOutput} for the tolerant path the worker takes.
 */
export const EngineOutputSchema: z.ZodType<EngineOutput, unknown> = z.object({
  blocks: z.array(EngineBlockSchema),
  document: EngineDocumentSchema,
});

// ---------------------------------------------------------------------------
// Tolerant parser
// ---------------------------------------------------------------------------

/** Thrown only when the top-level response cannot be used at all (not JSON, not an object, no `blocks` array). */
export class EngineOutputError extends Error {
  override readonly name = 'EngineOutputError';
  constructor(message: string, readonly raw?: unknown) {
    super(message);
  }
}

export interface ParsedEngineOutput {
  output: EngineOutput;
  /** Blocks and suggestions that were dropped, with the reason, for logging. */
  dropped: { path: string; reason: string }[];
}

/** Accepts a parsed value or a JSON string (markdown fences and prose around the object are tolerated). */
function unwrapRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last <= first) throw new EngineOutputError('response contains no JSON object', raw);
  try {
    return JSON.parse(s.slice(first, last + 1)) as unknown;
  } catch (e) {
    throw new EngineOutputError(`response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, raw);
  }
}

/**
 * Parses a model response into an EngineOutput, keeping everything usable: confidence is coerced to [0,1],
 * explanations are clamped to 200 characters, enums are matched case-insensitively, malformed suggestions and
 * blocks are dropped (reported in `dropped`) instead of failing the response, and missing document fields get
 * defaults. Throws {@link EngineOutputError} only when the top-level shape is unusable.
 */
export function parseEngineOutputDetailed(raw: unknown): ParsedEngineOutput {
  const value = unwrapRaw(raw);
  if (!isRecord(value)) throw new EngineOutputError('top-level value is not an object', raw);
  const blocksRaw = value.blocks;
  if (!Array.isArray(blocksRaw)) throw new EngineOutputError('"blocks" is not an array', raw);

  const dropped: ParsedEngineOutput['dropped'] = [];
  const blocks: EngineBlockResult[] = [];
  const seenIds = new Set<string>();
  let autoId = 0;

  blocksRaw.forEach((b, bi) => {
    const bpath = `blocks[${bi}]`;
    if (!isRecord(b)) {
      dropped.push({ path: bpath, reason: 'block is not an object' });
      return;
    }
    const blockId = typeof b.block_id === 'string' ? b.block_id.trim() : '';
    if (blockId.length === 0) {
      dropped.push({ path: bpath, reason: 'block_id missing' });
      return;
    }
    let list: unknown[] = [];
    if (Array.isArray(b.suggestions)) list = b.suggestions;
    else if (b.suggestions !== undefined && b.suggestions !== null) dropped.push({ path: `${bpath}.suggestions`, reason: 'suggestions is not an array' });

    const suggestions: EngineBlockResult['suggestions'] = [];
    list.forEach((s, si) => {
      const spath = `${bpath}.suggestions[${si}]`;
      const r = EngineSuggestionSchema.safeParse(s);
      if (!r.success) {
        dropped.push({ path: spath, reason: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }
      const sug = r.data;
      if (sug.id.length === 0 || seenIds.has(sug.id)) {
        do sug.id = `auto_${++autoId}`;
        while (seenIds.has(sug.id));
      }
      seenIds.add(sug.id);
      suggestions.push(sug);
    });
    blocks.push({ block_id: blockId, suggestions });
  });

  const document = EngineDocumentSchema.parse(value.document);
  return { output: { blocks, document }, dropped };
}

/** See {@link parseEngineOutputDetailed}; this variant returns only the output. */
export function parseEngineOutput(raw: unknown): EngineOutput {
  return parseEngineOutputDetailed(raw).output;
}
