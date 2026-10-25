/**
 * Structural guards for data the pages receive from the worker. The contracts in @jammarly/shared/types describe
 * what a well-behaved worker sends; these helpers make the pages survive a worker that is still a placeholder, an
 * older build, or a bug, by coercing loose shapes into the documented ones (defaults for missing fields, malformed
 * entries dropped) instead of throwing half-way through a render. Secrets (`apiKey`, `pairing`, `token`) are stripped
 * from any settings object before it reaches page state, so a sloppy reply can never put them in the DOM.
 */
import type {
  ApplyTransaction,
  CheckError,
  FieldState,
  FieldStatus,
  PublicDeviceSettings,
  Suggestion,
  SuggestionCategory,
  SuggestionKind,
  SuggestionTier,
  ToneAnalysis,
  WritingGoals,
  WritingScore,
} from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import type { ProfileDocument } from '@jammarly/shared/profile';
import { defaultProfile } from '@jammarly/shared/profile';

type Dict = Record<string, unknown>;

function isObject(value: unknown): value is Dict {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isRange(value: unknown): value is { start: number; end: number } {
  if (!isObject(value)) return false;
  const { start, end } = value;
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) >= (start as number);
}

const KINDS: readonly SuggestionKind[] = ['replace', 'delete', 'insert', 'rewrite', 'flag'];
const TIERS: readonly SuggestionTier[] = ['A', 'B', 'C'];
const STATUSES: readonly FieldStatus[] = ['setup', 'idle', 'checking', 'clean', 'suggestions', 'error', 'off', 'unsupported'];

export const DEFAULT_GOALS: WritingGoals = { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' };

/** Fills missing or non-string goal fields from the defaults so the dialog and `set-goals` always carry all four. */
export function normalizeGoals(value: unknown): WritingGoals {
  if (!isObject(value)) return { ...DEFAULT_GOALS };
  return {
    audience: (str(value.audience, DEFAULT_GOALS.audience) || DEFAULT_GOALS.audience) as WritingGoals['audience'],
    formality: (str(value.formality, DEFAULT_GOALS.formality) || DEFAULT_GOALS.formality) as WritingGoals['formality'],
    domain: (str(value.domain, DEFAULT_GOALS.domain) || DEFAULT_GOALS.domain) as WritingGoals['domain'],
    intent: (str(value.intent, DEFAULT_GOALS.intent) || DEFAULT_GOALS.intent) as WritingGoals['intent'],
  };
}

/**
 * Keeps suggestions that have what the panel needs to render and apply them (id, category, a well-formed range,
 * original text) and fills the rest with safe defaults. An unknown tier becomes 'C' so nothing unexpected is ever
 * bulk-applied.
 */
export function sanitizeSuggestions(value: unknown): Suggestion[] {
  if (!Array.isArray(value)) return [];
  const out: Suggestion[] = [];
  for (const raw of value) {
    if (!isObject(raw)) continue;
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue;
    if (!(CATEGORIES as readonly string[]).includes(raw.category as string)) continue;
    if (!isRange(raw.range)) continue;
    if (typeof raw.original !== 'string') continue;
    const range = { start: raw.range.start, end: raw.range.end };
    const kind = (KINDS as readonly string[]).includes(raw.kind as string) ? (raw.kind as SuggestionKind) : 'replace';
    const tier = (TIERS as readonly string[]).includes(raw.tier as string) ? (raw.tier as SuggestionTier) : 'C';
    const s: Suggestion = {
      ...(raw as unknown as Suggestion),
      id: raw.id,
      category: raw.category as SuggestionCategory,
      rule: str(raw.rule, 'other'),
      severity: raw.severity === 'error' || raw.severity === 'warning' || raw.severity === 'suggestion' ? raw.severity : 'suggestion',
      kind,
      source: raw.source === 'rules' || raw.source === 'llm' || raw.source === 'both' ? raw.source : 'llm',
      tier,
      anchor: raw.anchor === 'normalized' ? 'normalized' : 'exact',
      range,
      highlight: isRange(raw.highlight) ? { start: raw.highlight.start, end: raw.highlight.end } : { ...range },
      original: raw.original,
      replacement: str(raw.replacement, kind === 'flag' ? raw.original : ''),
      alternatives: stringArray(raw.alternatives),
      title: str(raw.title, 'Suggestion'),
      explanation: str(raw.explanation, ''),
      confidence: num(raw.confidence, 0),
      meaningPreserving: bool(raw.meaningPreserving, false),
      autoApplySafe: bool(raw.autoApplySafe, false),
      blockId: str(raw.blockId, ''),
      blockHash: str(raw.blockHash, ''),
      conflictsWith: stringArray(raw.conflictsWith),
      stale: bool(raw.stale, false),
      promptVersion: str(raw.promptVersion, ''),
      fingerprint: str(raw.fingerprint, ''),
      learnedState: raw.learnedState === 'demoted' || raw.learnedState === 'probe' ? raw.learnedState : 'active',
    };
    out.push(s);
  }
  return out;
}

function coerceTransactions(value: unknown): ApplyTransaction[] {
  if (!Array.isArray(value)) return [];
  const out: ApplyTransaction[] = [];
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.id !== 'string') continue;
    const items = Array.isArray(raw.items)
      ? raw.items
          .filter((it): it is Dict => isObject(it) && typeof it.id === 'string')
          .map((it) => ({
            id: it.id as string,
            title: str(it.title, 'Change'),
            category: ((CATEGORIES as readonly string[]).includes(it.category as string) ? it.category : 'correctness') as SuggestionCategory,
            original: str(it.original, ''),
            replacement: str(it.replacement, ''),
          }))
      : [];
    out.push({
      id: raw.id,
      fieldId: str(raw.fieldId, ''),
      at: str(raw.at, ''),
      edits: Array.isArray(raw.edits) ? (raw.edits as ApplyTransaction['edits']) : [],
      items,
      appliedIds: stringArray(raw.appliedIds),
      revertedIds: stringArray(raw.revertedIds),
    });
  }
  return out;
}

function coerceTone(value: unknown): ToneAnalysis | undefined {
  if (!isObject(value) || !Array.isArray(value.labels)) return undefined;
  const labels = value.labels
    .filter((l): l is Dict => isObject(l) && typeof l.label === 'string')
    .map((l) => ({ label: l.label as string, strength: (l.strength === 'slight' || l.strength === 'strong' ? l.strength : 'moderate') as 'slight' | 'moderate' | 'strong' }));
  return { labels, summary: str(value.summary, '') };
}

function coerceScore(value: unknown): WritingScore | undefined {
  if (!isObject(value) || typeof value.overall !== 'number' || !Number.isFinite(value.overall)) return undefined;
  const score: WritingScore = { overall: Math.max(0, Math.min(100, Math.round(value.overall))), wordCount: num(value.wordCount, 0), readingTimeSeconds: num(value.readingTimeSeconds, 0) };
  if (typeof value.readability === 'number') score.readability = value.readability;
  return score;
}

export function coerceCheckError(value: unknown): CheckError | undefined {
  if (!isObject(value) || typeof value.code !== 'string') return undefined;
  const err: CheckError = { code: value.code as CheckError['code'], message: str(value.message, ''), retryable: bool(value.retryable, false) };
  if (typeof value.retryAfterMs === 'number') err.retryAfterMs = value.retryAfterMs;
  return err;
}

/** A FieldState with every field the panel reads present, or null when the value is not recognisably a field. */
export function coerceFieldState(value: unknown): FieldState | null {
  if (!isObject(value)) return null;
  if (typeof value.fieldId !== 'string' || value.fieldId.length === 0) return null;
  if (!Array.isArray(value.suggestions) || typeof value.status !== 'string') return null;
  const transactions = coerceTransactions(value.transactions);
  const field: FieldState = {
    fieldId: value.fieldId,
    tabId: num(value.tabId, -1),
    frameId: num(value.frameId, 0),
    host: str(value.host, ''),
    fieldKind: (str(value.fieldKind, 'contenteditable') || 'contenteditable') as FieldState['fieldKind'],
    label: str(value.label, ''),
    version: num(value.version, 0),
    textPreview: str(value.textPreview, ''),
    wordCount: Math.max(0, num(value.wordCount, 0)),
    suggestions: sanitizeSuggestions(value.suggestions),
    status: (STATUSES as readonly string[]).includes(value.status) ? (value.status as FieldStatus) : 'idle',
    checkedBy: value.checkedBy === 'fast' || value.checkedBy === 'deep' ? value.checkedBy : 'rules',
    active: bool(value.active, false),
    undoAvailable: num(value.undoAvailable, transactions.length),
    transactions,
  };
  const tone = coerceTone(value.tone);
  if (tone) field.tone = tone;
  const score = coerceScore(value.score);
  if (score) field.score = score;
  const error = coerceCheckError(value.error);
  if (error) field.error = error;
  if (isObject(value.usage)) field.usage = value.usage as unknown as FieldState['usage'];
  return field;
}

const SECRET_KEYS = ['apiKey', 'pairing', 'token'] as const;

/** A key hint is the last few characters for recognition only; anything longer could be the key itself. */
export const KEY_HINT_MAX_CHARS = 8;

/** The hint when it is plausibly a redacted tail (short, no whitespace, not key-shaped), else null. */
export function validKeyHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > KEY_HINT_MAX_CHARS || /\s/.test(trimmed) || /^sk-/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * PublicDeviceSettings from a settings reply: secrets stripped, the three derived flags normalised. Returns null
 * when the value is not an object at all. Unknown extra keys are kept, except that an optional `apiKeyHint` survives
 * only when it passes {@link validKeyHint}.
 */
export function coerceSettings(value: unknown): PublicDeviceSettings | null {
  if (!isObject(value)) return null;
  const copy: Dict = { ...value };
  for (const key of SECRET_KEYS) delete copy[key];
  if ('apiKeyHint' in copy) {
    const hint = validKeyHint(copy.apiKeyHint);
    if (hint) copy.apiKeyHint = hint;
    else delete copy.apiKeyHint;
  }
  copy.hasApiKey = bool(copy.hasApiKey, false);
  copy.paired = bool(copy.paired, false);
  copy.appOrigin = typeof copy.appOrigin === 'string' && copy.appOrigin.length > 0 ? copy.appOrigin : null;
  return copy as unknown as PublicDeviceSettings;
}

function lww<T>(raw: unknown, fallback: { value: T; hlc: string }, check: (v: unknown) => v is T): { value: T; hlc: string } {
  if (!isObject(raw) || !check(raw.value)) return fallback;
  return { value: raw.value, hlc: str(raw.hlc, fallback.hlc) };
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObj = (v: unknown): v is Record<string, unknown> => isObject(v);

function orSet(value: unknown): ProfileDocument['dictionary'] {
  if (!Array.isArray(value)) return [];
  return value.filter((el): el is ProfileDocument['dictionary'][number] => isObject(el) && typeof el.value === 'string' && typeof el.addedHlc === 'string' && (el.removedHlc === undefined || typeof el.removedHlc === 'string'));
}

/**
 * A ProfileDocument every page reader can trust: anything missing or malformed falls back to `defaultProfile()`
 * field by field. Returns null when the value is not an object with a `settings` object (nothing to work with).
 */
export function coerceProfile(value: unknown): ProfileDocument | null {
  if (!isObject(value) || !isObject(value.settings)) return null;
  const base = defaultProfile();
  const s = value.settings;
  const settings: ProfileDocument['settings'] = {
    goals: isObject(s.goals) && isObject(s.goals.value) ? { value: normalizeGoals(s.goals.value), hlc: str(s.goals.hlc, base.settings.goals.hlc) } : base.settings.goals,
    dialect: lww(s.dialect, base.settings.dialect, isString) as ProfileDocument['settings']['dialect'],
    categories: isObject(s.categories) && isObject(s.categories.value) ? { value: { ...base.settings.categories.value, ...(s.categories.value as Record<SuggestionCategory, boolean>) }, hlc: str(s.categories.hlc, base.settings.categories.hlc) } : base.settings.categories,
    customInstructions: lww(s.customInstructions, base.settings.customInstructions, isString),
    styleDecisions: lww(s.styleDecisions, base.settings.styleDecisions, isObj) as ProfileDocument['settings']['styleDecisions'],
    mode: lww(s.mode, base.settings.mode, isString) as ProfileDocument['settings']['mode'],
    model: lww(s.model, base.settings.model, isString),
    fastModel: lww(s.fastModel, base.settings.fastModel, isString),
    userSalt: lww(s.userSalt, base.settings.userSalt, isString),
    privateSites: lww(s.privateSites, base.settings.privateSites, isStringArray),
    privacy: isObject(s.privacy) && isObject(s.privacy.value) ? { value: { ...base.settings.privacy.value, ...(s.privacy.value as Partial<ProfileDocument['settings']['privacy']['value']>) }, hlc: str(s.privacy.hlc, base.settings.privacy.hlc) } : base.settings.privacy,
    ignoreOptOutHosts: lww(s.ignoreOptOutHosts, base.settings.ignoreOptOutHosts, isStringArray),
    checkOptedOutFields: lww(s.checkOptedOutFields, base.settings.checkOptedOutFields, isBoolean),
  };
  const privacy = settings.privacy.value;
  if (!(privacy.retentionDays === 30 || privacy.retentionDays === 90 || privacy.retentionDays === 365)) privacy.retentionDays = 90;
  if (typeof privacy.storeSnippets !== 'boolean') privacy.storeSnippets = true;
  if (typeof privacy.learningEnabled !== 'boolean') privacy.learningEnabled = true;
  if (privacy.consentAt !== null && typeof privacy.consentAt !== 'string') privacy.consentAt = null;
  const rules = isObject(value.rules) ? value.rules : {};
  const sites = isObject(value.sites) ? value.sites : {};
  const voice = isObject(value.voice) ? value.voice : {};
  const learning = isObject(value.learning) ? value.learning : {};
  return {
    ...base,
    ...(value as Partial<ProfileDocument>),
    schemaVersion: base.schemaVersion,
    version: num(value.version, 0),
    updatedAt: str(value.updatedAt, base.updatedAt),
    updatedBy: str(value.updatedBy, base.updatedBy),
    settings,
    dictionary: orSet(value.dictionary),
    rules: { muted: orSet(rules.muted), weights: isObject(rules.weights) ? (rules.weights as ProfileDocument['rules']['weights']) : {} },
    sites: { disabled: orSet(sites.disabled), overrides: isObject(sites.overrides) ? (sites.overrides as ProfileDocument['sites']['overrides']) : {} },
    voice: { settings: isObject(voice.settings) && isObject(voice.settings.value) ? (voice.settings as unknown as ProfileDocument['voice']['settings']) : base.voice.settings, profiles: isObject(voice.profiles) ? (voice.profiles as ProfileDocument['voice']['profiles']) : {} },
    learning: { ...base.learning, ...(learning as Partial<ProfileDocument['learning']>) },
  };
}

/** An http(s) URL string safe to put in an href, or null (javascript:, data:, garbage, non-strings). */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Compact count for badges: 0..99 as digits, anything above as "99+". */
export function formatBadge(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return n > 99 ? '99+' : String(n);
}
