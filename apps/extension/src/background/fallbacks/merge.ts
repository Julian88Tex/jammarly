/**
 * TODO(integration): local fallback for `@jammarly/shared/merge` (applyOps, mergeDocuments, migrateProfile),
 * which another agent is finishing. Implements the documented semantics (LWW registers by HLC, add-wins OR-sets,
 * wholesale learning section by updatedHlc) so the worker is testable now; swap the re-export in
 * ../shared-engine.ts once the shared module lands.
 */
import type { Lww, OrSetElement, ProfileDocument, ProfileOp, VoiceContext, VoiceProfile } from '@jammarly/shared/profile';
import { defaultProfile, emptyVoiceProfile, PROFILE_SCHEMA_VERSION, ZERO_HLC } from '@jammarly/shared/profile';
import { compareHlc, isHlc } from '@jammarly/shared/hlc';

type Learning = ProfileDocument['learning'];

export interface ApplyOpsResult {
  doc: ProfileDocument;
  applied: ProfileOp[];
  rejected: { op: ProfileOp; reason: string }[];
}

const LWW_PATHS = new Set<string>([
  'settings.goals', 'settings.dialect', 'settings.categories', 'settings.customInstructions', 'settings.styleDecisions',
  'settings.mode', 'settings.model', 'settings.fastModel', 'settings.userSalt', 'settings.privateSites', 'settings.privacy',
  'settings.ignoreOptOutHosts', 'settings.checkOptedOutFields', 'voice.settings',
]);
const SET_PATHS = new Set<string>(['dictionary', 'rules.muted', 'sites.disabled']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function lww<T>(raw: unknown, fallback: Lww<T>, check: (v: unknown) => boolean): Lww<T> {
  if (!isRecord(raw) || !('value' in raw) || !check(raw.value)) return clone(fallback);
  return { value: raw.value as T, hlc: isHlc(raw.hlc) ? raw.hlc : ZERO_HLC };
}

function orSet(raw: unknown): OrSetElement<string>[] {
  if (!Array.isArray(raw)) return [];
  const out: OrSetElement<string>[] = [];
  for (const el of raw) {
    if (!isRecord(el) || typeof el.value !== 'string') continue;
    const entry: OrSetElement<string> = { value: el.value, addedHlc: isHlc(el.addedHlc) ? el.addedHlc : ZERO_HLC };
    if (isHlc(el.removedHlc)) entry.removedHlc = el.removedHlc;
    out.push(entry);
  }
  return out;
}

const isString = (v: unknown): boolean => typeof v === 'string';
const isBool = (v: unknown): boolean => typeof v === 'boolean';
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObj = (v: unknown): boolean => isRecord(v);

/** Fills a possibly partial / foreign profile into a complete ProfileDocument (unknown fields dropped). */
export function migrateProfile(raw: unknown): ProfileDocument {
  const base = defaultProfile();
  if (!isRecord(raw)) return base;
  const s = isRecord(raw.settings) ? raw.settings : {};
  const settings: ProfileDocument['settings'] = {
    goals: lww(s.goals, base.settings.goals, isObj),
    dialect: lww(s.dialect, base.settings.dialect, isString),
    categories: lww(s.categories, base.settings.categories, isObj),
    customInstructions: lww(s.customInstructions, base.settings.customInstructions, isString),
    styleDecisions: lww(s.styleDecisions, base.settings.styleDecisions, isObj),
    mode: lww(s.mode, base.settings.mode, (v) => v === 'hybrid' || v === 'quality' || v === 'economy'),
    model: lww(s.model, base.settings.model, isString),
    fastModel: lww(s.fastModel, base.settings.fastModel, isString),
    userSalt: lww(s.userSalt, base.settings.userSalt, isString),
    privateSites: lww(s.privateSites, base.settings.privateSites, isStringArray),
    privacy: lww(s.privacy, base.settings.privacy, isObj),
    ignoreOptOutHosts: lww(s.ignoreOptOutHosts, base.settings.ignoreOptOutHosts, isStringArray),
    checkOptedOutFields: lww(s.checkOptedOutFields, base.settings.checkOptedOutFields, isBool),
  };
  // Fill missing privacy / goals / categories keys from defaults.
  settings.privacy = { ...settings.privacy, value: { ...base.settings.privacy.value, ...settings.privacy.value } };
  settings.goals = { ...settings.goals, value: { ...base.settings.goals.value, ...settings.goals.value } };
  settings.categories = { ...settings.categories, value: { ...base.settings.categories.value, ...settings.categories.value } };

  const rules = isRecord(raw.rules) ? raw.rules : {};
  const weights: Record<string, Lww<number>> = {};
  if (isRecord(rules.weights)) {
    for (const [k, v] of Object.entries(rules.weights)) {
      if (isRecord(v) && typeof v.value === 'number') weights[k] = { value: v.value, hlc: isHlc(v.hlc) ? v.hlc : ZERO_HLC };
    }
  }
  const sites = isRecord(raw.sites) ? raw.sites : {};
  const overrides: ProfileDocument['sites']['overrides'] = {};
  if (isRecord(sites.overrides)) {
    for (const [k, v] of Object.entries(sites.overrides)) {
      if (isRecord(v) && isRecord(v.value)) overrides[k] = { value: v.value, hlc: isHlc(v.hlc) ? v.hlc : ZERO_HLC };
    }
  }
  const voice = isRecord(raw.voice) ? raw.voice : {};
  const profiles: ProfileDocument['voice']['profiles'] = {};
  if (isRecord(voice.profiles)) {
    for (const ctx of ['messages', 'documents'] as VoiceContext[]) {
      const p = voice.profiles[ctx];
      if (isRecord(p)) profiles[ctx] = { ...emptyVoiceProfile(ctx), ...(p as Partial<VoiceProfile>), context: ctx };
    }
  }
  const learningRaw = isRecord(raw.learning) ? raw.learning : {};
  const learning: Learning = {
    updatedHlc: isHlc(learningRaw.updatedHlc) ? learningRaw.updatedHlc : ZERO_HLC,
    stats: isRecord(learningRaw.stats) ? (learningRaw.stats as Learning['stats']) : {},
    ruleStates: isRecord(learningRaw.ruleStates) ? (learningRaw.ruleStates as Learning['ruleStates']) : {},
    dictionaryCandidates: isStringArray(learningRaw.dictionaryCandidates) ? (learningRaw.dictionaryCandidates as string[]) : [],
    history: Array.isArray(learningRaw.history) ? (learningRaw.history as Learning['history']) : [],
    lastEventCursor: typeof learningRaw.lastEventCursor === 'string' ? learningRaw.lastEventCursor : '',
  };
  if (typeof learningRaw.dialectInferred === 'string') learning.dialectInferred = learningRaw.dialectInferred as Learning['dialectInferred'];

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : base.updatedBy,
    settings,
    dictionary: orSet(raw.dictionary),
    rules: { muted: orSet(rules.muted), weights },
    sites: { disabled: orSet(sites.disabled), overrides },
    voice: { settings: lww(voice.settings, base.voice.settings, isObj), profiles },
    learning,
  };
}

function newerLww<T>(a: Lww<T>, b: Lww<T>): Lww<T> {
  return compareHlc(b.hlc, a.hlc) > 0 ? clone(b) : clone(a);
}

function mergeSets(a: OrSetElement<string>[], b: OrSetElement<string>[]): OrSetElement<string>[] {
  const byValue = new Map<string, OrSetElement<string>>();
  for (const el of [...a, ...b]) {
    const prev = byValue.get(el.value);
    if (!prev) {
      byValue.set(el.value, { ...el });
      continue;
    }
    const merged: OrSetElement<string> = { value: el.value, addedHlc: compareHlc(el.addedHlc, prev.addedHlc) > 0 ? el.addedHlc : prev.addedHlc };
    const removed = [prev.removedHlc, el.removedHlc].filter((h): h is string => typeof h === 'string');
    if (removed.length > 0) merged.removedHlc = removed.reduce((x, y) => (compareHlc(y, x) > 0 ? y : x));
    byValue.set(el.value, merged);
  }
  return [...byValue.values()];
}

function mergeLwwMap<T>(a: Record<string, Lww<T>>, b: Record<string, Lww<T>>): Record<string, Lww<T>> {
  const out: Record<string, Lww<T>> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    if (x && y) out[k] = newerLww(x, y);
    else if (x) out[k] = clone(x);
    else if (y) out[k] = clone(y);
  }
  return out;
}

/** Deterministic, commutative merge of two profile documents. */
export function mergeDocuments(localRaw: ProfileDocument, remoteRaw: ProfileDocument): ProfileDocument {
  const a = migrateProfile(localRaw);
  const b = migrateProfile(remoteRaw);
  const settings = {} as ProfileDocument['settings'];
  for (const key of Object.keys(a.settings) as (keyof ProfileDocument['settings'])[]) {
    (settings as Record<string, unknown>)[key] = newerLww(a.settings[key] as Lww<unknown>, b.settings[key] as Lww<unknown>);
  }
  const profiles: ProfileDocument['voice']['profiles'] = {};
  for (const ctx of ['messages', 'documents'] as VoiceContext[]) {
    const x = a.voice.profiles[ctx];
    const y = b.voice.profiles[ctx];
    if (x && y) profiles[ctx] = clone(y.version > x.version || (y.version === x.version && y.generatedAt > x.generatedAt) ? y : x);
    else if (x) profiles[ctx] = clone(x);
    else if (y) profiles[ctx] = clone(y);
  }
  const learning = compareHlc(b.learning.updatedHlc, a.learning.updatedHlc) > 0 ? clone(b.learning) : clone(a.learning);
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    version: Math.max(a.version, b.version),
    updatedAt: a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt,
    updatedBy: a.updatedAt > b.updatedAt ? a.updatedBy : b.updatedBy,
    settings,
    dictionary: mergeSets(a.dictionary, b.dictionary),
    rules: { muted: mergeSets(a.rules.muted, b.rules.muted), weights: mergeLwwMap(a.rules.weights, b.rules.weights) },
    sites: { disabled: mergeSets(a.sites.disabled, b.sites.disabled), overrides: mergeLwwMap(a.sites.overrides, b.sites.overrides) },
    voice: { settings: newerLww(a.voice.settings, b.voice.settings), profiles },
    learning,
  };
}

/** Applies ops to a copy of `doc`; ops with unknown paths, bad shapes or stale clocks are reported, never thrown. */
export function applyOps(docRaw: ProfileDocument, ops: readonly ProfileOp[]): ApplyOpsResult {
  const doc = clone(migrateProfile(docRaw));
  const applied: ProfileOp[] = [];
  const rejected: ApplyOpsResult['rejected'] = [];
  for (const op of ops) {
    const reason = applyOne(doc, op);
    if (reason === null) applied.push(op);
    else rejected.push({ op, reason });
  }
  return { doc, applied, rejected };
}

function applyOne(doc: ProfileDocument, op: ProfileOp): string | null {
  if (!isRecord(op) || typeof op.op !== 'string') return 'malformed';
  if (!isHlc(op.hlc)) return 'invalid_hlc';
  switch (op.op) {
    case 'set': {
      const path = op.path;
      if (LWW_PATHS.has(path)) {
        const [section, key] = path.split('.') as ['settings' | 'voice', string];
        const target = doc[section] as unknown as Record<string, Lww<unknown>>;
        const current = target[key];
        if (!current) return 'op_not_allowed';
        if (compareHlc(op.hlc, current.hlc) <= 0) return 'stale';
        target[key] = { value: clone(op.value), hlc: op.hlc };
        return null;
      }
      if (path.startsWith('rules.weights.')) {
        const rule = path.slice('rules.weights.'.length);
        if (rule.length === 0 || typeof op.value !== 'number') return 'schema_invalid';
        const current = doc.rules.weights[rule];
        if (current && compareHlc(op.hlc, current.hlc) <= 0) return 'stale';
        doc.rules.weights[rule] = { value: Math.max(0, Math.min(2, op.value)), hlc: op.hlc };
        return null;
      }
      if (path.startsWith('sites.overrides.')) {
        const host = path.slice('sites.overrides.'.length);
        if (host.length === 0 || !isRecord(op.value)) return 'schema_invalid';
        const current = doc.sites.overrides[host];
        if (current && compareHlc(op.hlc, current.hlc) <= 0) return 'stale';
        doc.sites.overrides[host] = { value: clone(op.value) as ProfileDocument['sites']['overrides'][string]['value'], hlc: op.hlc };
        return null;
      }
      return 'op_not_allowed';
    }
    case 'add':
    case 'remove': {
      if (!SET_PATHS.has(op.path) || typeof op.value !== 'string' || op.value.length === 0) return 'op_not_allowed';
      const set = op.path === 'dictionary' ? doc.dictionary : op.path === 'rules.muted' ? doc.rules.muted : doc.sites.disabled;
      const existing = set.find((e) => e.value === op.value);
      if (op.op === 'add') {
        if (!existing) set.push({ value: op.value, addedHlc: op.hlc });
        else if (compareHlc(op.hlc, existing.addedHlc) > 0) existing.addedHlc = op.hlc;
        else return 'stale';
      } else {
        if (!existing) set.push({ value: op.value, addedHlc: ZERO_HLC, removedHlc: op.hlc });
        else if (!existing.removedHlc || compareHlc(op.hlc, existing.removedHlc) > 0) existing.removedHlc = op.hlc;
        else return 'stale';
      }
      return null;
    }
    case 'voice': {
      if (op.context !== 'messages' && op.context !== 'documents') return 'schema_invalid';
      if (!isRecord(op.profile)) return 'schema_invalid';
      doc.voice.profiles[op.context] = { ...emptyVoiceProfile(op.context), ...clone(op.profile), context: op.context };
      return null;
    }
    case 'learning': {
      if (!isRecord(op.patch)) return 'schema_invalid';
      if (compareHlc(op.hlc, doc.learning.updatedHlc) <= 0) return 'stale';
      doc.learning = { ...doc.learning, ...clone(op.patch), updatedHlc: op.hlc };
      return null;
    }
    default:
      return 'op_not_allowed';
  }
}
