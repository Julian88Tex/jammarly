/**
 * Merge semantics of the profile document (research 07 §6.2 / §9.2, architecture §3.6).
 *
 * - Scalars are last-writer-wins registers keyed by hybrid logical clocks ({@link lwwMerge}).
 * - Sets are add-wins observed-remove sets: an element is live iff `removedHlc` is absent or
 *   `addedHlc > removedHlc`; merging keeps the max `addedHlc` and the max `removedHlc` per value.
 * - Voice profiles are replaced wholesale by the greater `version` (then the newer `generatedAt`).
 * - The learning section is replaced wholesale by the newer `updatedHlc`.
 *
 * Every function here is pure (inputs are never mutated) and deterministic, so the same code runs on
 * devices and on the server and converges: {@link mergeDocuments} is commutative, associative and
 * idempotent. The zod schemas validate op values per path and whole documents uploaded to the web app.
 *
 * No DOM, no chrome.*, no side effects at import.
 */
import { z } from 'zod';
import type {
  Hlc,
  LearnedRuleState,
  Lww,
  LwwPath,
  OrSetElement,
  ProfileDocument,
  ProfileOp,
  RuleStats,
  SetPath,
  SiteOverride,
  VoiceContext,
  VoiceProfile,
} from './profile';
import { defaultProfile, PROFILE_SCHEMA_VERSION, ZERO_HLC } from './profile';
import { compareHlc, HLC_PATTERN, hlcWallMs, isHlc } from './hlc';

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** JSON with sorted object keys; used for tie-breaks so merges stay commutative when clocks collide. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Deep clone of plain JSON-like data (objects, arrays, primitives). */
export function cloneData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => cloneData(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = cloneData(v);
  }
  return out as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

// ---------------------------------------------------------------------------
// LWW registers
// ---------------------------------------------------------------------------

/**
 * The register with the greater clock. On an exact clock tie (same device, same tick: only possible
 * with duplicated or replayed ops) the value with the greater stable JSON wins so the result does not
 * depend on argument order.
 */
export function lwwMerge<T>(a: Lww<T>, b: Lww<T>): Lww<T> {
  const c = compareHlc(a.hlc, b.hlc);
  if (c > 0) return a;
  if (c < 0) return b;
  return stableStringify(a.value) >= stableStringify(b.value) ? a : b;
}

// ---------------------------------------------------------------------------
// OR-sets (add-wins observed-remove)
// ---------------------------------------------------------------------------

function elementKey(value: unknown): string {
  return typeof value === 'string' ? value : stableStringify(value);
}

/** Sort by value key so two equal sets are structurally equal regardless of operation order. */
function canonicalOrSet<T>(elements: OrSetElement<T>[]): OrSetElement<T>[] {
  return elements.sort((x, y) => {
    const kx = elementKey(x.value);
    const ky = elementKey(y.value);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
}

/** True when the element is present: never removed, or re-added after the removal. */
export function orSetElementLive<T>(el: OrSetElement<T>): boolean {
  return el.removedHlc === undefined || compareHlc(el.addedHlc, el.removedHlc) > 0;
}

/** Live values, in canonical (sorted) order. */
export function orSetLive<T>(set: readonly OrSetElement<T>[]): T[] {
  const out: OrSetElement<T>[] = [];
  const seen = new Set<string>();
  for (const el of set) {
    const k = elementKey(el.value);
    if (seen.has(k)) continue;
    seen.add(k);
    if (orSetElementLive(el)) out.push(el);
  }
  return canonicalOrSet(out).map((el) => el.value);
}

export function orSetHas<T>(set: readonly OrSetElement<T>[], value: T): boolean {
  const k = elementKey(value);
  const el = set.find((e) => elementKey(e.value) === k);
  return el !== undefined && orSetElementLive(el);
}

/** Merge two element records for the same value: max addedHlc, max removedHlc. */
function mergeElement<T>(a: OrSetElement<T>, b: OrSetElement<T>): OrSetElement<T> {
  const added = compareHlc(a.addedHlc, b.addedHlc) >= 0 ? a : b;
  const out: OrSetElement<T> = { value: cloneData(added.value), addedHlc: added.addedHlc };
  const removed =
    a.removedHlc !== undefined && b.removedHlc !== undefined
      ? compareHlc(a.removedHlc, b.removedHlc) >= 0
        ? a.removedHlc
        : b.removedHlc
      : (a.removedHlc ?? b.removedHlc);
  if (removed !== undefined) out.removedHlc = removed;
  return out;
}

/** Union by value, keeping the max addedHlc and the max removedHlc per value. Returns a new canonical array. */
export function orSetMerge<T>(a: readonly OrSetElement<T>[], b: readonly OrSetElement<T>[]): OrSetElement<T>[] {
  const byKey = new Map<string, OrSetElement<T>>();
  for (const el of [...a, ...b]) {
    const k = elementKey(el.value);
    const prev = byKey.get(k);
    byKey.set(k, prev === undefined ? mergeElement(el, el) : mergeElement(prev, el));
  }
  return canonicalOrSet([...byKey.values()]);
}

/** Add (or re-add) `value` at clock `hlc`. */
export function orSetAdd<T>(set: readonly OrSetElement<T>[], value: T, hlc: Hlc): OrSetElement<T>[] {
  return orSetMerge(set, [{ value, addedHlc: hlc }]);
}

/**
 * Remove `value` at clock `hlc`. Removing a value that was never observed records a tombstone with a zero
 * addedHlc, so the removal still wins against an older concurrent add and loses against a newer one.
 */
export function orSetRemove<T>(set: readonly OrSetElement<T>[], value: T, hlc: Hlc): OrSetElement<T>[] {
  return orSetMerge(set, [{ value, addedHlc: ZERO_HLC, removedHlc: hlc }]);
}

/**
 * Drop dead elements whose removal is older than `olderThanMs` (wall time of `removedHlc` compared to
 * `nowMs`). Live elements and recent tombstones are kept.
 */
export function compactTombstones<T>(set: readonly OrSetElement<T>[], olderThanMs: number, nowMs: number): OrSetElement<T>[] {
  const cutoff = nowMs - Math.max(0, olderThanMs);
  return canonicalOrSet(
    set.filter((el) => orSetElementLive(el) || el.removedHlc === undefined || hlcWallMs(el.removedHlc) >= cutoff).map((el) => cloneData(el)),
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const HlcSchema = z.string().regex(HLC_PATTERN, 'expected "<13-digit ms>-<counter>-<deviceId>"');
/** ISO-8601 date-time (non-empty). */
export const IsoDateSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'expected an ISO-8601 date-time');
/** ISO-8601 date-time or "" (fields that start empty, e.g. a never-generated voice profile). */
export const IsoOrEmptySchema = z
  .string()
  .max(40)
  .refine((s) => s === '' || !Number.isNaN(Date.parse(s)), 'expected an ISO-8601 date-time or ""');

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const RULE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MUTE_ENTRY_RE = /^[A-Za-z0-9_.-]{1,64}(@(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)?$/i;

/** Hostname (optionally `*.`-prefixed), no scheme, no path. */
export const HostSchema = z.string().min(1).max(253).regex(HOST_RE, 'expected a hostname');
/** Engine-contract rule id such as "passive_voice". */
export const RuleIdSchema = z.string().regex(RULE_ID_RE, 'expected a rule id');
/** rules.muted entry: "<rule>" (global) or "<rule>@<host>" (one site). See encodeMute in ./learner. */
export const MuteEntrySchema = z.string().regex(MUTE_ENTRY_RE, 'expected "<rule>" or "<rule>@<host>"');
/** Dictionary entry: 1-100 printable characters, no surrounding whitespace, no redaction tokens. */
export const DictionaryWordSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\p{C}‹›]+$/u, 'unexpected control character')
  .refine((s) => s.trim() === s, 'no surrounding whitespace');

export const DialectSchema = z.enum(['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN']);
export const WritingContextSchema = z.enum(['email', 'chat', 'doc', 'social', 'code', 'other']);
export const VoiceContextSchema = z.enum(['messages', 'documents']);
export const WritingGoalsSchema = z.object({
  audience: z.enum(['general', 'knowledgeable', 'expert']),
  formality: z.enum(['informal', 'neutral', 'formal']),
  domain: z.enum(['general', 'academic', 'business', 'email', 'casual', 'creative', 'technical']),
  intent: z.enum(['inform', 'describe', 'convince', 'tell_a_story']),
});
export const CategoriesSchema = z.object({
  correctness: z.boolean(),
  clarity: z.boolean(),
  engagement: z.boolean(),
  delivery: z.boolean(),
});
export const StyleDecisionsSchema = z
  .record(z.string().min(1).max(64), z.string().max(64))
  .refine((o) => Object.keys(o).length <= 100, 'at most 100 style decisions');
export const EngineModeSchema = z.enum(['hybrid', 'quality', 'economy']);
export const ModelIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'expected a model id');
export const UserSaltSchema = z.string().max(128).regex(/^[0-9a-fA-F]*$/, 'expected hex');
export const HostListSchema = z.array(HostSchema).max(500);
export const PrivacySettingsSchema = z.object({
  storeSnippets: z.boolean(),
  retentionDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
  learningEnabled: z.boolean(),
  consentAt: IsoDateSchema.nullable(),
});
export const SiteOverrideSchema = z.object({
  context: WritingContextSchema.optional(),
  goals: WritingGoalsSchema.partial().optional(),
  categories: CategoriesSchema.partial().optional(),
});
export const VoiceSettingsSchema = z.object({
  strength: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  notes: z.string().max(2000),
});
export const RuleWeightSchema = z.number().min(0).max(2);

const strList = (maxItems: number, maxLen = 300) => z.array(z.string().max(maxLen)).max(maxItems);

export const VoiceTraitSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(120),
  description: z.string().max(600),
  dimension: z.enum(['register', 'sentences', 'punctuation', 'vocabulary', 'openings_closings', 'tone', 'stylistic_choices']),
  evidenceCount: z.number().int().min(0),
  confidence: z.enum(['low', 'medium', 'high']),
  locked: z.boolean(),
});

export const VoiceProfileSchema = z.object({
  context: VoiceContextSchema,
  version: z.number().int().min(0),
  generatedAt: IsoOrEmptySchema,
  generatedBy: z.string().max(100),
  confidence: z.enum(['provisional', 'low', 'medium', 'high']),
  summary: z.string().max(2000),
  traits: z.array(VoiceTraitSchema).max(40),
  styleGuide: z.string().max(4000),
  editorInstructions: strList(40),
  doNotFlagStyle: strList(40, 64),
  keepPhrases: strList(100),
  avoidPhrases: strList(100),
  greetings: strList(20),
  signoffs: strList(20),
  acceptedPatterns: strList(60),
  rejectedPatterns: strList(60),
  examples: z.object({
    accepted: z.array(z.object({ before: z.string().max(600), after: z.string().max(600) })).max(40),
    rejected: z
      .array(z.object({ before: z.string().max(600), proposed: z.string().max(600), keptOrFinal: z.string().max(600) }))
      .max(40),
  }),
  facts: z.record(z.string().max(64), z.string().max(300)),
  changelog: z.string().max(2000),
  removedByUser: strList(200),
});

export const RuleStatsSchema = z.object({
  shown: z.number().min(0),
  accepted: z.number().min(0),
  dismissed: z.number().min(0),
  ignored: z.number().min(0),
  reported: z.number().min(0),
  lastSeen: IsoOrEmptySchema,
});

export const LearnedRuleStateSchema = z.object({
  state: z.enum(['active', 'demoted', 'suppressed', 'probing']),
  eligibleForBulk: z.boolean(),
  scope: z.enum(['global', 'ctx', 'host']),
  scopeKey: z.string().max(253),
  since: IsoOrEmptySchema,
  nextReprobe: IsoDateSchema.optional(),
  reprobeStage: z.number().int().min(0),
});

export const LearningHistoryEntrySchema = z.object({
  at: IsoOrEmptySchema,
  eventsSeen: z.number().int().min(0),
  changelog: z.string().max(2000),
  model: z.string().max(100),
  version: z.number().int().min(0),
});

export const LearningSectionSchema = z.object({
  updatedHlc: HlcSchema,
  stats: z.record(z.string().min(1).max(400), RuleStatsSchema),
  ruleStates: z.record(z.string().min(1).max(400), LearnedRuleStateSchema),
  dictionaryCandidates: z.array(DictionaryWordSchema).max(1000),
  dialectInferred: DialectSchema.optional(),
  history: z.array(LearningHistoryEntrySchema).max(100),
  lastEventCursor: z.string().max(200),
});

export function lwwSchema<T extends z.ZodType>(value: T) {
  return z.object({ value, hlc: HlcSchema });
}

export function orSetElementSchema<T extends z.ZodType>(value: T) {
  return z.object({ value, addedHlc: HlcSchema, removedHlc: HlcSchema.optional() });
}

const SettingsSchema = z.object({
  goals: lwwSchema(WritingGoalsSchema),
  dialect: lwwSchema(DialectSchema),
  categories: lwwSchema(CategoriesSchema),
  customInstructions: lwwSchema(z.string().max(4000)),
  styleDecisions: lwwSchema(StyleDecisionsSchema),
  mode: lwwSchema(EngineModeSchema),
  model: lwwSchema(ModelIdSchema),
  fastModel: lwwSchema(ModelIdSchema),
  userSalt: lwwSchema(UserSaltSchema),
  privateSites: lwwSchema(HostListSchema),
  privacy: lwwSchema(PrivacySettingsSchema),
  ignoreOptOutHosts: lwwSchema(HostListSchema),
  checkOptedOutFields: lwwSchema(z.boolean()),
});

/** The whole profile document. Unknown keys are stripped (forward compatibility), values are validated. */
export const ProfileDocumentSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  version: z.number().int().min(0),
  updatedAt: IsoOrEmptySchema,
  updatedBy: z.string().max(100),
  settings: SettingsSchema,
  dictionary: z.array(orSetElementSchema(DictionaryWordSchema)).max(5000),
  rules: z.object({
    muted: z.array(orSetElementSchema(MuteEntrySchema)).max(2000),
    weights: z.record(RuleIdSchema, lwwSchema(RuleWeightSchema)),
  }),
  sites: z.object({
    disabled: z.array(orSetElementSchema(HostSchema)).max(2000),
    overrides: z.record(HostSchema, lwwSchema(SiteOverrideSchema)),
  }),
  voice: z.object({
    settings: lwwSchema(VoiceSettingsSchema),
    profiles: z.object({ messages: VoiceProfileSchema.optional(), documents: VoiceProfileSchema.optional() }),
  }),
  learning: LearningSectionSchema,
}) satisfies z.ZodType<ProfileDocument>;

/** Structural validation of one op (value shapes are checked per path by applyOps). */
export const ProfileOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.string().min(1).max(400), value: z.unknown(), hlc: HlcSchema }),
  z.object({ op: z.literal('add'), path: z.string().min(1).max(400), value: z.string().max(400), hlc: HlcSchema }),
  z.object({ op: z.literal('remove'), path: z.string().min(1).max(400), value: z.string().max(400), hlc: HlcSchema }),
  z.object({ op: z.literal('voice'), context: VoiceContextSchema, profile: VoiceProfileSchema, hlc: HlcSchema }),
  z.object({ op: z.literal('learning'), patch: LearningSectionSchema.partial(), hlc: HlcSchema }),
]);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Static LWW paths (the two dynamic families are `rules.weights.<ruleId>` and `sites.overrides.<host>`). */
export const LWW_STATIC_PATHS = [
  'settings.goals',
  'settings.dialect',
  'settings.categories',
  'settings.customInstructions',
  'settings.styleDecisions',
  'settings.mode',
  'settings.model',
  'settings.fastModel',
  'settings.userSalt',
  'settings.privateSites',
  'settings.privacy',
  'settings.ignoreOptOutHosts',
  'settings.checkOptedOutFields',
  'voice.settings',
] as const satisfies readonly LwwPath[];

export const SET_PATHS = ['dictionary', 'rules.muted', 'sites.disabled'] as const satisfies readonly SetPath[];

const LWW_STATIC_SCHEMAS: Record<(typeof LWW_STATIC_PATHS)[number], z.ZodType> = {
  'settings.goals': WritingGoalsSchema,
  'settings.dialect': DialectSchema,
  'settings.categories': CategoriesSchema,
  'settings.customInstructions': z.string().max(4000),
  'settings.styleDecisions': StyleDecisionsSchema,
  'settings.mode': EngineModeSchema,
  'settings.model': ModelIdSchema,
  'settings.fastModel': ModelIdSchema,
  'settings.userSalt': UserSaltSchema,
  'settings.privateSites': HostListSchema,
  'settings.privacy': PrivacySettingsSchema,
  'settings.ignoreOptOutHosts': HostListSchema,
  'settings.checkOptedOutFields': z.boolean(),
  'voice.settings': VoiceSettingsSchema,
};

const SET_VALUE_SCHEMAS: Record<SetPath, z.ZodType<string>> = {
  dictionary: DictionaryWordSchema,
  'rules.muted': MuteEntrySchema,
  'sites.disabled': HostSchema,
};

const RULE_WEIGHT_PREFIX = 'rules.weights.';
const SITE_OVERRIDE_PREFIX = 'sites.overrides.';

export function isLwwPath(path: string): path is LwwPath {
  if ((LWW_STATIC_PATHS as readonly string[]).includes(path)) return true;
  if (path.startsWith(RULE_WEIGHT_PREFIX)) return RULE_ID_RE.test(path.slice(RULE_WEIGHT_PREFIX.length));
  if (path.startsWith(SITE_OVERRIDE_PREFIX)) return HOST_RE.test(path.slice(SITE_OVERRIDE_PREFIX.length));
  return false;
}

export function isSetPath(path: string): path is SetPath {
  return (SET_PATHS as readonly string[]).includes(path);
}

/** The zod schema an LWW op value must satisfy for `path`, or undefined when the path is not allowed. */
export function schemaForLwwPath(path: string): z.ZodType | undefined {
  if ((LWW_STATIC_PATHS as readonly string[]).includes(path)) return LWW_STATIC_SCHEMAS[path as (typeof LWW_STATIC_PATHS)[number]];
  if (!isLwwPath(path)) return undefined;
  if (path.startsWith(RULE_WEIGHT_PREFIX)) return RuleWeightSchema;
  if (path.startsWith(SITE_OVERRIDE_PREFIX)) return SiteOverrideSchema;
  return undefined;
}

/** The zod schema a set op value must satisfy for `path`, or undefined when the path is not a set. */
export function schemaForSetPath(path: string): z.ZodType<string> | undefined {
  return isSetPath(path) ? SET_VALUE_SCHEMAS[path] : undefined;
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export type OpRejectReason = 'hlc_invalid' | 'op_not_allowed' | 'schema_invalid';

export interface ApplyOpsResult {
  doc: ProfileDocument;
  /** Ops accepted and merged (including ops that lost LWW and changed nothing: redelivery is idempotent). */
  applied: number;
  rejected: { op: ProfileOp; reason: OpRejectReason; message?: string }[];
}

export interface ApplyOpsOptions {
  /** When given, `updatedAt` (max) and `updatedBy` are set on the document if anything was applied. */
  now?: string;
  by?: string;
}

interface LwwSlot {
  get(): Lww<unknown> | undefined;
  set(v: Lww<unknown>): void;
}

function lwwSlot(doc: ProfileDocument, path: LwwPath): LwwSlot {
  if (path === 'voice.settings') {
    return {
      get: () => doc.voice.settings,
      set: (v) => {
        doc.voice.settings = v as Lww<ProfileDocument['voice']['settings']['value']>;
      },
    };
  }
  if (path.startsWith(RULE_WEIGHT_PREFIX)) {
    const id = path.slice(RULE_WEIGHT_PREFIX.length);
    return {
      get: () => doc.rules.weights[id],
      set: (v) => {
        doc.rules.weights[id] = v as Lww<number>;
      },
    };
  }
  if (path.startsWith(SITE_OVERRIDE_PREFIX)) {
    const host = path.slice(SITE_OVERRIDE_PREFIX.length).toLowerCase();
    return {
      get: () => doc.sites.overrides[host],
      set: (v) => {
        doc.sites.overrides[host] = v as Lww<SiteOverride>;
      },
    };
  }
  const key = path.slice('settings.'.length);
  const settings = doc.settings as unknown as Record<string, Lww<unknown>>;
  return {
    get: () => settings[key],
    set: (v) => {
      settings[key] = v;
    },
  };
}

/** True when `incoming` should replace `current` (greater version, or equal version and newer generatedAt). */
export function voiceProfileIsNewer(incoming: VoiceProfile, current: VoiceProfile | undefined): boolean {
  if (current === undefined) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.generatedAt > current.generatedAt;
}

/**
 * Apply ops to a copy of `doc` with the merge rules. Invalid ops are reported in `rejected` with the
 * ApiErrorCode-compatible reason; valid ops that lose LWW are still counted as applied (no-op).
 */
export function applyOps(doc: ProfileDocument, ops: readonly ProfileOp[], opts: ApplyOpsOptions = {}): ApplyOpsResult {
  const next = cloneData(doc);
  const rejected: ApplyOpsResult['rejected'] = [];
  let applied = 0;

  for (const op of ops) {
    if (!isRecord(op) || typeof (op as { op?: unknown }).op !== 'string') {
      rejected.push({ op, reason: 'op_not_allowed', message: 'not an op' });
      continue;
    }
    if (!isHlc((op as { hlc?: unknown }).hlc)) {
      rejected.push({ op, reason: 'hlc_invalid' });
      continue;
    }
    const parsed = ProfileOpSchema.safeParse(op);
    if (!parsed.success) {
      const kind = (op as { op: string }).op;
      const known = kind === 'set' || kind === 'add' || kind === 'remove' || kind === 'voice' || kind === 'learning';
      rejected.push({ op, reason: known ? 'schema_invalid' : 'op_not_allowed', message: parsed.error.issues[0]?.message });
      continue;
    }
    const p = parsed.data;
    switch (p.op) {
      case 'set': {
        const schema = schemaForLwwPath(p.path);
        if (schema === undefined) {
          rejected.push({ op, reason: 'op_not_allowed', message: `path not allowed: ${p.path}` });
          break;
        }
        const value = schema.safeParse(p.value);
        if (!value.success) {
          rejected.push({ op, reason: 'schema_invalid', message: value.error.issues[0]?.message });
          break;
        }
        const slot = lwwSlot(next, p.path as LwwPath);
        const incoming: Lww<unknown> = { value: value.data, hlc: p.hlc };
        const current = slot.get();
        slot.set(current === undefined ? incoming : cloneData(lwwMerge(current, incoming)));
        applied += 1;
        break;
      }
      case 'add':
      case 'remove': {
        const schema = schemaForSetPath(p.path);
        if (schema === undefined) {
          rejected.push({ op, reason: 'op_not_allowed', message: `path not allowed: ${p.path}` });
          break;
        }
        const value = schema.safeParse(p.value);
        if (!value.success) {
          rejected.push({ op, reason: 'schema_invalid', message: value.error.issues[0]?.message });
          break;
        }
        const path = p.path as SetPath;
        const current = path === 'dictionary' ? next.dictionary : path === 'rules.muted' ? next.rules.muted : next.sites.disabled;
        const updated = p.op === 'add' ? orSetAdd(current, value.data, p.hlc) : orSetRemove(current, value.data, p.hlc);
        if (path === 'dictionary') next.dictionary = updated;
        else if (path === 'rules.muted') next.rules.muted = updated;
        else next.sites.disabled = updated;
        applied += 1;
        break;
      }
      case 'voice': {
        if (p.profile.context !== p.context) {
          rejected.push({ op, reason: 'schema_invalid', message: 'profile.context does not match op.context' });
          break;
        }
        if (voiceProfileIsNewer(p.profile, next.voice.profiles[p.context])) {
          next.voice.profiles[p.context] = cloneData(p.profile);
        }
        applied += 1;
        break;
      }
      case 'learning': {
        const incomingHlc = p.patch.updatedHlc;
        if (incomingHlc === undefined) {
          rejected.push({ op, reason: 'schema_invalid', message: 'patch.updatedHlc is required' });
          break;
        }
        if (compareHlc(incomingHlc, next.learning.updatedHlc) > 0) {
          next.learning = { ...next.learning, ...cloneData(p.patch), updatedHlc: incomingHlc } as ProfileDocument['learning'];
        }
        applied += 1;
        break;
      }
    }
  }

  if (applied > 0) {
    if (opts.now !== undefined) next.updatedAt = maxIso(next.updatedAt, opts.now);
    if (opts.by !== undefined) next.updatedBy = opts.by;
  }
  return { doc: next, applied, rejected };
}

// ---------------------------------------------------------------------------
// Whole-document merge
// ---------------------------------------------------------------------------

function pickVoiceProfile(a: VoiceProfile | undefined, b: VoiceProfile | undefined): VoiceProfile | undefined {
  if (a === undefined) return b === undefined ? undefined : cloneData(b);
  if (b === undefined) return cloneData(a);
  if (a.version !== b.version) return cloneData(a.version > b.version ? a : b);
  if (a.generatedAt !== b.generatedAt) return cloneData(a.generatedAt > b.generatedAt ? a : b);
  return cloneData(stableStringify(a) >= stableStringify(b) ? a : b);
}

function mergeLwwRecord<T>(a: Record<string, Lww<T>>, b: Record<string, Lww<T>>): Record<string, Lww<T>> {
  const out: Record<string, Lww<T>> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[key];
    const y = b[key];
    const chosen = x === undefined ? y : y === undefined ? x : lwwMerge(x, y);
    if (chosen !== undefined) out[key] = cloneData(chosen);
  }
  return out;
}

/**
 * Field-wise merge: LWW per register, OR-set union per set, voice profiles by version, learning by
 * updatedHlc, version = max, updatedAt = max. Commutative, associative and idempotent.
 */
export function mergeDocuments(a: ProfileDocument, b: ProfileDocument): ProfileDocument {
  const settingsA = a.settings as unknown as Record<string, Lww<unknown>>;
  const settingsB = b.settings as unknown as Record<string, Lww<unknown>>;
  const settings: Record<string, Lww<unknown>> = {};
  for (const key of Object.keys(defaultProfile().settings)) {
    const x = settingsA[key];
    const y = settingsB[key];
    const chosen = x === undefined ? y : y === undefined ? x : lwwMerge(x, y);
    if (chosen !== undefined) settings[key] = cloneData(chosen);
  }

  const learningCmp = compareHlc(a.learning.updatedHlc, b.learning.updatedHlc);
  const learning =
    learningCmp > 0 ? a.learning : learningCmp < 0 ? b.learning : stableStringify(a.learning) >= stableStringify(b.learning) ? a.learning : b.learning;

  let updatedAt: string;
  let updatedBy: string;
  if (a.updatedAt !== b.updatedAt) {
    const newer = a.updatedAt > b.updatedAt ? a : b;
    updatedAt = newer.updatedAt;
    updatedBy = newer.updatedBy;
  } else {
    updatedAt = a.updatedAt;
    updatedBy = a.updatedBy >= b.updatedBy ? a.updatedBy : b.updatedBy;
  }

  const profiles: ProfileDocument['voice']['profiles'] = {};
  for (const ctx of ['messages', 'documents'] as const satisfies readonly VoiceContext[]) {
    const chosen = pickVoiceProfile(a.voice.profiles[ctx], b.voice.profiles[ctx]);
    if (chosen !== undefined) profiles[ctx] = chosen;
  }

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    version: Math.max(a.version, b.version),
    updatedAt,
    updatedBy,
    settings: settings as unknown as ProfileDocument['settings'],
    dictionary: orSetMerge(a.dictionary, b.dictionary),
    rules: {
      muted: orSetMerge(a.rules.muted, b.rules.muted),
      weights: mergeLwwRecord(a.rules.weights, b.rules.weights),
    },
    sites: {
      disabled: orSetMerge(a.sites.disabled, b.sites.disabled),
      overrides: mergeLwwRecord(a.sites.overrides, b.sites.overrides),
    },
    voice: {
      settings: cloneData(lwwMerge(a.voice.settings, b.voice.settings)),
      profiles,
    },
    learning: cloneData(learning),
  };
}

// ---------------------------------------------------------------------------
// Migration / forward compatibility
// ---------------------------------------------------------------------------

function keepValid<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const r = schema.safeParse(value);
  return r.success ? r.data : fallback;
}

function validArray<T>(schema: z.ZodType<T>, value: unknown, max: number): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    if (out.length >= max) break;
  }
  return out;
}

function validRecord<T>(keySchema: z.ZodType<string>, valueSchema: z.ZodType<T>, value: unknown, max: number): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(value)) return out;
  let n = 0;
  for (const key of Object.keys(value).sort()) {
    if (!keySchema.safeParse(key).success) continue;
    const r = valueSchema.safeParse(value[key]);
    if (!r.success) continue;
    out[key] = r.data;
    n += 1;
    if (n >= max) break;
  }
  return out;
}

/**
 * Coerce anything (an older or newer document, a partial one, garbage) into a valid ProfileDocument:
 * every known field is kept when it validates and otherwise filled from defaultProfile(); unknown
 * fields are dropped; invalid set elements and record entries are dropped individually.
 */
export function migrateProfile(input: unknown): ProfileDocument {
  const out = defaultProfile();
  if (!isRecord(input)) return out;

  const version = input['version'];
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) out.version = version;
  out.updatedAt = keepValid(IsoOrEmptySchema, input['updatedAt'], out.updatedAt);
  out.updatedBy = keepValid(z.string().max(100), input['updatedBy'], out.updatedBy);

  const settingsIn = isRecord(input['settings']) ? input['settings'] : {};
  const settingsOut = out.settings as unknown as Record<string, Lww<unknown>>;
  for (const path of LWW_STATIC_PATHS) {
    if (!path.startsWith('settings.')) continue;
    const key = path.slice('settings.'.length);
    const current = settingsOut[key];
    if (current === undefined) continue;
    settingsOut[key] = keepValid(lwwSchema(LWW_STATIC_SCHEMAS[path]) as z.ZodType<Lww<unknown>>, settingsIn[key], current);
  }

  out.dictionary = orSetMerge([], validArray(orSetElementSchema(DictionaryWordSchema), input['dictionary'], 5000));

  const rulesIn = isRecord(input['rules']) ? input['rules'] : {};
  out.rules.muted = orSetMerge([], validArray(orSetElementSchema(MuteEntrySchema), rulesIn['muted'], 2000));
  out.rules.weights = validRecord(RuleIdSchema, lwwSchema(RuleWeightSchema), rulesIn['weights'], 500);

  const sitesIn = isRecord(input['sites']) ? input['sites'] : {};
  out.sites.disabled = orSetMerge([], validArray(orSetElementSchema(HostSchema), sitesIn['disabled'], 2000));
  out.sites.overrides = validRecord(HostSchema, lwwSchema(SiteOverrideSchema), sitesIn['overrides'], 500);

  const voiceIn = isRecord(input['voice']) ? input['voice'] : {};
  out.voice.settings = keepValid(lwwSchema(VoiceSettingsSchema), voiceIn['settings'], out.voice.settings);
  const profilesIn = isRecord(voiceIn['profiles']) ? voiceIn['profiles'] : {};
  for (const ctx of ['messages', 'documents'] as const) {
    const r = VoiceProfileSchema.safeParse(profilesIn[ctx]);
    if (r.success && r.data.context === ctx) out.voice.profiles[ctx] = r.data;
  }

  const learningIn = isRecord(input['learning']) ? input['learning'] : {};
  out.learning.updatedHlc = keepValid(HlcSchema, learningIn['updatedHlc'], out.learning.updatedHlc);
  out.learning.stats = validRecord(z.string().min(1).max(400), RuleStatsSchema, learningIn['stats'], 20000) as Record<string, RuleStats>;
  out.learning.ruleStates = validRecord(z.string().min(1).max(400), LearnedRuleStateSchema, learningIn['ruleStates'], 20000) as Record<
    string,
    LearnedRuleState
  >;
  out.learning.dictionaryCandidates = validArray(DictionaryWordSchema, learningIn['dictionaryCandidates'], 1000);
  const dialect = DialectSchema.safeParse(learningIn['dialectInferred']);
  if (dialect.success) out.learning.dialectInferred = dialect.data;
  out.learning.history = validArray(LearningHistoryEntrySchema, learningIn['history'], 100);
  out.learning.lastEventCursor = keepValid(z.string().max(200), learningIn['lastEventCursor'], '');

  return out;
}
