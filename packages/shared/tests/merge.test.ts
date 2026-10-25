import { describe, expect, it } from 'vitest';
import type { OrSetElement, ProfileDocument, ProfileOp, VoiceProfile } from '../src/profile';
import { defaultProfile, emptyVoiceProfile, ZERO_HLC } from '../src/profile';
import { formatHlc } from '../src/hlc';
import {
  applyOps,
  compactTombstones,
  isLwwPath,
  isSetPath,
  lwwMerge,
  mergeDocuments,
  migrateProfile,
  orSetAdd,
  orSetHas,
  orSetLive,
  orSetMerge,
  orSetRemove,
  ProfileDocumentSchema,
  ProfileOpSchema,
  schemaForLwwPath,
  stableStringify,
} from '../src/merge';

const h = (wallMs: number, counter: number, deviceId = 'dev'): string => formatHlc({ wallMs, counter, deviceId });
const T = 1_760_870_400_000;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function pick<T>(rng: () => number, items: readonly T[]): T {
  const v = items[Math.floor(rng() * items.length)];
  if (v === undefined) throw new Error('empty pick');
  return v;
}

function voiceProfile(version: number, generatedAt: string, summary = 'v'): VoiceProfile {
  return { ...emptyVoiceProfile('messages'), version, generatedAt, generatedBy: 'claude-opus-5-5', summary };
}

describe('lwwMerge', () => {
  it('returns the register with the greater clock', () => {
    const a = { value: 'a', hlc: h(T, 1) };
    const b = { value: 'b', hlc: h(T, 2) };
    expect(lwwMerge(a, b)).toBe(b);
    expect(lwwMerge(b, a)).toBe(b);
    expect(lwwMerge(a, { value: 'c', hlc: h(T + 1, 0) })).toEqual({ value: 'c', hlc: h(T + 1, 0) });
  });
  it('compares counters numerically', () => {
    const nine = { value: 9, hlc: `${T}-9-dev` };
    const ten = { value: 10, hlc: `${T}-10-dev` };
    expect(lwwMerge(nine, ten)).toBe(ten);
  });
  it('breaks exact clock ties deterministically regardless of order', () => {
    const a = { value: { x: 1 }, hlc: h(T, 1) };
    const b = { value: { x: 2 }, hlc: h(T, 1) };
    expect(lwwMerge(a, b)).toBe(lwwMerge(b, a));
  });
  it('a default (zero clock) register never beats a real write', () => {
    const z = { value: 'default', hlc: ZERO_HLC };
    const w = { value: 'written', hlc: h(1, 0) };
    expect(lwwMerge(z, w)).toBe(w);
    expect(lwwMerge(w, z)).toBe(w);
  });
});

describe('OR-set', () => {
  it('add / remove / re-add follow add-wins observed-remove semantics', () => {
    let set: OrSetElement<string>[] = [];
    set = orSetAdd(set, 'alpha', h(T, 0));
    set = orSetAdd(set, 'beta', h(T, 1));
    expect(orSetLive(set)).toEqual(['alpha', 'beta']);
    set = orSetRemove(set, 'alpha', h(T, 2));
    expect(orSetLive(set)).toEqual(['beta']);
    expect(orSetHas(set, 'alpha')).toBe(false);
    expect(set.find((e) => e.value === 'alpha')).toEqual({ value: 'alpha', addedHlc: h(T, 0), removedHlc: h(T, 2) });
    set = orSetAdd(set, 'alpha', h(T, 3));
    expect(orSetLive(set)).toEqual(['alpha', 'beta']);
    expect(set.find((e) => e.value === 'alpha')).toEqual({ value: 'alpha', addedHlc: h(T, 3), removedHlc: h(T, 2) });
  });

  it('a stale concurrent add loses against a newer removal; a newer add wins', () => {
    const base = orSetAdd([], 'w', h(T, 0, 'a'));
    const removedOnB = orSetRemove(base, 'w', h(T + 10, 0, 'b'));
    const staleAddOnA = orSetAdd(base, 'w', h(T + 5, 0, 'a'));
    expect(orSetLive(orSetMerge(removedOnB, staleAddOnA))).toEqual([]);
    const newerAddOnA = orSetAdd(base, 'w', h(T + 20, 0, 'a'));
    expect(orSetLive(orSetMerge(removedOnB, newerAddOnA))).toEqual(['w']);
  });

  it('removing an unobserved value records a tombstone that beats older adds', () => {
    const removed = orSetRemove([], 'w', h(T + 10, 0, 'b'));
    expect(orSetLive(removed)).toEqual([]);
    expect(removed).toEqual([{ value: 'w', addedHlc: ZERO_HLC, removedHlc: h(T + 10, 0, 'b') }]);
    expect(orSetLive(orSetMerge(removed, orSetAdd([], 'w', h(T + 5, 0, 'a'))))).toEqual([]);
    expect(orSetLive(orSetMerge(removed, orSetAdd([], 'w', h(T + 15, 0, 'a'))))).toEqual(['w']);
  });

  it('merge keeps the max addedHlc and max removedHlc per value and is canonical', () => {
    const a: OrSetElement<string>[] = [
      { value: 'x', addedHlc: h(T, 1), removedHlc: h(T, 5) },
      { value: 'y', addedHlc: h(T, 2) },
    ];
    const b: OrSetElement<string>[] = [
      { value: 'y', addedHlc: h(T, 9), removedHlc: h(T, 3) },
      { value: 'x', addedHlc: h(T, 7) },
    ];
    const m = orSetMerge(a, b);
    expect(m).toEqual([
      { value: 'x', addedHlc: h(T, 7), removedHlc: h(T, 5) },
      { value: 'y', addedHlc: h(T, 9), removedHlc: h(T, 3) },
    ]);
    expect(orSetMerge(b, a)).toEqual(m);
    expect(orSetLive(m)).toEqual(['x', 'y']);
    expect(orSetMerge(m, m)).toEqual(m);
  });

  it('does not mutate its inputs', () => {
    const set = orSetAdd([], 'a', h(T, 0));
    const snapshot = JSON.stringify(set);
    orSetRemove(set, 'a', h(T, 1));
    orSetAdd(set, 'b', h(T, 2));
    expect(JSON.stringify(set)).toBe(snapshot);
  });

  it('compactTombstones drops only dead elements whose removal is old enough', () => {
    const day = 86_400_000;
    const set: OrSetElement<string>[] = [
      { value: 'live', addedHlc: h(T, 0) },
      { value: 'old-dead', addedHlc: h(T, 0), removedHlc: h(T + day, 0) },
      { value: 'fresh-dead', addedHlc: h(T, 0), removedHlc: h(T + 40 * day, 0) },
      { value: 'readded', addedHlc: h(T + 2 * day, 0), removedHlc: h(T + day, 0) },
    ];
    const out = compactTombstones(set, 30 * day, T + 45 * day);
    expect(out.map((e) => e.value)).toEqual(['fresh-dead', 'live', 'readded']);
    expect(orSetLive(out)).toEqual(['live', 'readded']);
  });
});

describe('paths and schemas', () => {
  it('recognises static, dynamic and invalid paths', () => {
    expect(isLwwPath('settings.goals')).toBe(true);
    expect(isLwwPath('voice.settings')).toBe(true);
    expect(isLwwPath('rules.weights.passive_voice')).toBe(true);
    expect(isLwwPath('sites.overrides.mail.google.com')).toBe(true);
    expect(isLwwPath('rules.weights.')).toBe(false);
    expect(isLwwPath('rules.weights.bad id')).toBe(false);
    expect(isLwwPath('sites.overrides.not a host')).toBe(false);
    expect(isLwwPath('learning.stats')).toBe(false);
    expect(isLwwPath('__proto__')).toBe(false);
    expect(isSetPath('dictionary')).toBe(true);
    expect(isSetPath('rules.muted')).toBe(true);
    expect(isSetPath('sites.disabled')).toBe(true);
    expect(isSetPath('settings.goals')).toBe(false);
    expect(schemaForLwwPath('settings.dialect')?.safeParse('en-GB').success).toBe(true);
    expect(schemaForLwwPath('settings.dialect')?.safeParse('en-ZZ').success).toBe(false);
    expect(schemaForLwwPath('rules.weights.x')?.safeParse(2.5).success).toBe(false);
    expect(schemaForLwwPath('nope')).toBeUndefined();
  });

  it('ProfileDocumentSchema accepts the default document and merged documents', () => {
    expect(ProfileDocumentSchema.safeParse(defaultProfile()).success).toBe(true);
    const doc = applyOps(defaultProfile(), [
      { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: h(T, 0) },
      { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: h(T, 1) },
      { op: 'voice', context: 'messages', profile: voiceProfile(1, '2026-10-01T00:00:00.000Z'), hlc: h(T, 2) },
    ]).doc;
    expect(ProfileDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('ProfileDocumentSchema rejects bad clocks and shapes, strips unknown keys', () => {
    const bad = defaultProfile();
    bad.settings.dialect = { value: 'en-GB', hlc: 'not-a-clock' };
    expect(ProfileDocumentSchema.safeParse(bad).success).toBe(false);
    const bad2 = defaultProfile() as unknown as Record<string, unknown>;
    bad2['dictionary'] = [{ value: 42, addedHlc: h(T, 0) }];
    expect(ProfileDocumentSchema.safeParse(bad2).success).toBe(false);
    expect(ProfileDocumentSchema.safeParse({ ...defaultProfile(), schemaVersion: 2 }).success).toBe(false);
    const extra = { ...defaultProfile(), future: 1 };
    const parsed = ProfileDocumentSchema.safeParse(extra);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'future' in parsed.data).toBe(false);
  });

  it('ProfileOpSchema validates structure', () => {
    expect(ProfileOpSchema.safeParse({ op: 'set', path: 'settings.goals', value: {}, hlc: h(T, 0) }).success).toBe(true);
    expect(ProfileOpSchema.safeParse({ op: 'add', path: 'dictionary', value: 1, hlc: h(T, 0) }).success).toBe(false);
    expect(ProfileOpSchema.safeParse({ op: 'bogus', hlc: h(T, 0) }).success).toBe(false);
    expect(ProfileOpSchema.safeParse({ op: 'learning', patch: { updatedHlc: h(T, 0) }, hlc: h(T, 0) }).success).toBe(true);
    expect(ProfileOpSchema.safeParse({ op: 'learning', patch: { updatedHlc: 'x' }, hlc: h(T, 0) }).success).toBe(false);
  });
});

describe('applyOps', () => {
  const goals = { audience: 'expert', formality: 'formal', domain: 'technical', intent: 'convince' } as const;

  it('applies LWW sets on every static path and validates values', () => {
    const r = applyOps(defaultProfile(), [
      { op: 'set', path: 'settings.goals', value: goals, hlc: h(T, 0) },
      { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: h(T, 1) },
      { op: 'set', path: 'settings.categories', value: { correctness: true, clarity: false, engagement: false, delivery: true }, hlc: h(T, 2) },
      { op: 'set', path: 'settings.customInstructions', value: 'Keep it short.', hlc: h(T, 3) },
      { op: 'set', path: 'settings.styleDecisions', value: { serial_comma: 'oxford' }, hlc: h(T, 4) },
      { op: 'set', path: 'settings.mode', value: 'economy', hlc: h(T, 5) },
      { op: 'set', path: 'settings.model', value: 'claude-opus-5-5', hlc: h(T, 6) },
      { op: 'set', path: 'settings.fastModel', value: 'claude-haiku-5-5', hlc: h(T, 7) },
      { op: 'set', path: 'settings.userSalt', value: 'deadbeef', hlc: h(T, 8) },
      { op: 'set', path: 'settings.privateSites', value: ['bank.com', '*.hr.example.com'], hlc: h(T, 9) },
      { op: 'set', path: 'settings.privacy', value: { storeSnippets: false, retentionDays: 30, learningEnabled: true, consentAt: '2026-10-01T00:00:00.000Z' }, hlc: h(T, 10) },
      { op: 'set', path: 'settings.ignoreOptOutHosts', value: ['app.slack.com'], hlc: h(T, 11) },
      { op: 'set', path: 'settings.checkOptedOutFields', value: true, hlc: h(T, 12) },
      { op: 'set', path: 'voice.settings', value: { strength: 3, notes: 'be brief' }, hlc: h(T, 13) },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toBe(14);
    expect(r.doc.settings.goals).toEqual({ value: goals, hlc: h(T, 0) });
    expect(r.doc.settings.dialect.value).toBe('en-GB');
    expect(r.doc.settings.categories.value.clarity).toBe(false);
    expect(r.doc.settings.customInstructions.value).toBe('Keep it short.');
    expect(r.doc.settings.styleDecisions.value).toEqual({ serial_comma: 'oxford' });
    expect(r.doc.settings.mode.value).toBe('economy');
    expect(r.doc.settings.privateSites.value).toEqual(['bank.com', '*.hr.example.com']);
    expect(r.doc.settings.privacy.value.retentionDays).toBe(30);
    expect(r.doc.settings.checkOptedOutFields.value).toBe(true);
    expect(r.doc.voice.settings.value).toEqual({ strength: 3, notes: 'be brief' });
  });

  it('rejects invalid values, disallowed paths and bad clocks with distinct reasons', () => {
    const doc = defaultProfile();
    const ops: ProfileOp[] = [
      { op: 'set', path: 'settings.dialect', value: 'en-ZZ', hlc: h(T, 0) },
      { op: 'set', path: 'settings.goals', value: { audience: 'expert' }, hlc: h(T, 1) },
      { op: 'set', path: 'learning.stats' as never, value: {}, hlc: h(T, 2) },
      { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: 'nope' },
      { op: 'set', path: 'rules.weights.passive_voice', value: 7, hlc: h(T, 3) },
      { op: 'add', path: 'dictionary', value: '  padded ', hlc: h(T, 4) },
      { op: 'add', path: 'dictionary', value: 'x'.repeat(101), hlc: h(T, 5) },
      { op: 'add', path: 'settings.goals' as never, value: 'x', hlc: h(T, 6) },
      { op: 'remove', path: 'sites.disabled', value: 'not a host', hlc: h(T, 7) },
      { op: 'set', path: 'settings.privacy', value: { storeSnippets: true, retentionDays: 45, learningEnabled: true, consentAt: null }, hlc: h(T, 8) },
      { op: 'bogus' as never, hlc: h(T, 9) } as never,
    ];
    const r = applyOps(doc, ops);
    expect(r.applied).toBe(0);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'schema_invalid',
      'schema_invalid',
      'op_not_allowed',
      'hlc_invalid',
      'schema_invalid',
      'schema_invalid',
      'schema_invalid',
      'op_not_allowed',
      'schema_invalid',
      'schema_invalid',
      'op_not_allowed',
    ]);
    expect(r.doc).toEqual(defaultProfile());
  });

  it('handles dynamic rule-weight and site-override paths', () => {
    const r = applyOps(defaultProfile(), [
      { op: 'set', path: 'rules.weights.passive_voice', value: 0.5, hlc: h(T, 0) },
      { op: 'set', path: 'rules.weights.passive_voice', value: 1.5, hlc: h(T, 1) },
      { op: 'set', path: 'rules.weights.hedging', value: 2, hlc: h(T, 2) },
      { op: 'set', path: 'sites.overrides.App.Slack.com', value: { context: 'chat', goals: { formality: 'informal' } }, hlc: h(T, 3) },
      { op: 'set', path: 'sites.overrides.app.slack.com', value: { context: 'doc' }, hlc: h(T, 2) }, // older: loses
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toBe(5);
    expect(r.doc.rules.weights).toEqual({ passive_voice: { value: 1.5, hlc: h(T, 1) }, hedging: { value: 2, hlc: h(T, 2) } });
    expect(r.doc.sites.overrides).toEqual({ 'app.slack.com': { value: { context: 'chat', goals: { formality: 'informal' } }, hlc: h(T, 3) } });
  });

  it('applies set adds and removes', () => {
    const r = applyOps(defaultProfile(), [
      { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: h(T, 0) },
      { op: 'add', path: 'dictionary', value: 'kubectl', hlc: h(T, 1) },
      { op: 'remove', path: 'dictionary', value: 'kubectl', hlc: h(T, 2) },
      { op: 'add', path: 'rules.muted', value: 'hedging', hlc: h(T, 3) },
      { op: 'add', path: 'rules.muted', value: 'passive_voice@app.slack.com', hlc: h(T, 4) },
      { op: 'add', path: 'sites.disabled', value: 'bank.com', hlc: h(T, 5) },
    ]);
    expect(r.rejected).toEqual([]);
    expect(orSetLive(r.doc.dictionary)).toEqual(['Jammarly']);
    expect(orSetLive(r.doc.rules.muted)).toEqual(['hedging', 'passive_voice@app.slack.com']);
    expect(orSetLive(r.doc.sites.disabled)).toEqual(['bank.com']);
  });

  it('an older set is a no-op but still counts as applied (idempotent redelivery)', () => {
    const first = applyOps(defaultProfile(), [{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: h(T, 5) }]).doc;
    const r = applyOps(first, [{ op: 'set', path: 'settings.dialect', value: 'en-AU', hlc: h(T, 4) }]);
    expect(r.applied).toBe(1);
    expect(r.doc.settings.dialect.value).toBe('en-GB');
  });

  it('voice ops replace a profile only when newer by version, then by generatedAt', () => {
    const v1 = voiceProfile(1, '2026-10-01T00:00:00.000Z', 'first');
    const v1b = voiceProfile(1, '2026-10-02T00:00:00.000Z', 'regenerated');
    const v2 = voiceProfile(2, '2026-09-01T00:00:00.000Z', 'second');
    let doc = applyOps(defaultProfile(), [{ op: 'voice', context: 'messages', profile: v1, hlc: h(T, 0) }]).doc;
    expect(doc.voice.profiles.messages?.summary).toBe('first');
    doc = applyOps(doc, [{ op: 'voice', context: 'messages', profile: voiceProfile(1, '2026-09-30T00:00:00.000Z', 'older'), hlc: h(T, 1) }]).doc;
    expect(doc.voice.profiles.messages?.summary).toBe('first');
    doc = applyOps(doc, [{ op: 'voice', context: 'messages', profile: v1b, hlc: h(T, 2) }]).doc;
    expect(doc.voice.profiles.messages?.summary).toBe('regenerated');
    doc = applyOps(doc, [{ op: 'voice', context: 'messages', profile: v2, hlc: h(T, 3) }]).doc;
    expect(doc.voice.profiles.messages?.summary).toBe('second');
    doc = applyOps(doc, [{ op: 'voice', context: 'messages', profile: v1b, hlc: h(T, 4) }]).doc;
    expect(doc.voice.profiles.messages?.summary).toBe('second');
    expect(doc.voice.profiles.documents).toBeUndefined();
    const mismatch = applyOps(doc, [{ op: 'voice', context: 'documents', profile: v2, hlc: h(T, 5) }]);
    expect(mismatch.rejected[0]?.reason).toBe('schema_invalid');
  });

  it('learning ops replace the section only when updatedHlc is newer', () => {
    const stats = { 'global||hedging': { shown: 10, accepted: 1, dismissed: 8, ignored: 0, reported: 0, lastSeen: '2026-10-01T00:00:00.000Z' } };
    let doc = applyOps(defaultProfile(), [{ op: 'learning', patch: { updatedHlc: h(T, 5, 'web'), stats }, hlc: h(T, 5, 'web') }]).doc;
    expect(doc.learning.stats).toEqual(stats);
    expect(doc.learning.updatedHlc).toBe(h(T, 5, 'web'));
    expect(doc.learning.history).toEqual([]);
    const older = applyOps(doc, [{ op: 'learning', patch: { updatedHlc: h(T, 4, 'web'), stats: {} }, hlc: h(T, 6, 'web') }]);
    expect(older.applied).toBe(1);
    expect(older.doc.learning.stats).toEqual(stats);
    const missing = applyOps(doc, [{ op: 'learning', patch: { stats: {} }, hlc: h(T, 7, 'web') }]);
    expect(missing.rejected[0]?.reason).toBe('schema_invalid');
    doc = applyOps(doc, [{ op: 'learning', patch: { updatedHlc: h(T, 9, 'web'), dictionaryCandidates: ['Jammarly'] }, hlc: h(T, 9, 'web') }]).doc;
    expect(doc.learning.dictionaryCandidates).toEqual(['Jammarly']);
    expect(doc.learning.stats).toEqual(stats); // patch merges onto the section
  });

  it('is idempotent and never mutates its input', () => {
    const base = defaultProfile();
    const snapshot = JSON.stringify(base);
    const ops: ProfileOp[] = [
      { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: h(T, 0) },
      { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: h(T, 1) },
      { op: 'remove', path: 'rules.muted', value: 'hedging', hlc: h(T, 2) },
      { op: 'voice', context: 'documents', profile: { ...voiceProfile(3, '2026-10-01T00:00:00.000Z'), context: 'documents' }, hlc: h(T, 3) },
    ];
    const once = applyOps(base, ops);
    const twice = applyOps(once.doc, ops);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(twice.doc).toEqual(once.doc);
    expect(twice.applied).toBe(4);
    expect(twice.rejected).toEqual([]);
  });

  it('stamps updatedAt / updatedBy when asked and something applied', () => {
    const r = applyOps(defaultProfile(), [{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: h(T, 0) }], { now: '2026-10-21T00:00:00.000Z', by: 'd_1' });
    expect(r.doc.updatedAt).toBe('2026-10-21T00:00:00.000Z');
    expect(r.doc.updatedBy).toBe('d_1');
    const none = applyOps(defaultProfile(), [{ op: 'set', path: 'settings.dialect', value: 'xx', hlc: h(T, 0) }], { now: '2026-10-21T00:00:00.000Z', by: 'd_1' });
    expect(none.doc.updatedBy).toBe('init');
  });
});

describe('mergeDocuments', () => {
  it('merges field-wise: each side keeps what it changed', () => {
    const base = defaultProfile('2026-10-01T00:00:00.000Z');
    const a = applyOps(base, [
      { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: h(T, 0, 'a') },
      { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: h(T, 1, 'a') },
    ], { now: '2026-10-02T00:00:00.000Z', by: 'a' }).doc;
    a.version = 3;
    const b = applyOps(base, [
      { op: 'set', path: 'settings.mode', value: 'quality', hlc: h(T, 0, 'b') },
      { op: 'add', path: 'rules.muted', value: 'hedging', hlc: h(T, 1, 'b') },
      { op: 'set', path: 'settings.dialect', value: 'en-AU', hlc: h(T - 1, 0, 'b') }, // older than a's write
    ], { now: '2026-10-03T00:00:00.000Z', by: 'b' }).doc;
    b.version = 2;
    const m = mergeDocuments(a, b);
    expect(m.settings.dialect.value).toBe('en-GB');
    expect(m.settings.mode.value).toBe('quality');
    expect(orSetLive(m.dictionary)).toEqual(['Jammarly']);
    expect(orSetLive(m.rules.muted)).toEqual(['hedging']);
    expect(m.version).toBe(3);
    expect(m.updatedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(m.updatedBy).toBe('b');
    expect(mergeDocuments(b, a)).toEqual(m);
    expect(ProfileDocumentSchema.safeParse(m).success).toBe(true);
  });

  it('picks voice profiles by version then generatedAt, learning by updatedHlc', () => {
    const a = defaultProfile();
    a.voice.profiles.messages = voiceProfile(2, '2026-10-01T00:00:00.000Z', 'a');
    a.voice.profiles.documents = { ...voiceProfile(1, '2026-10-05T00:00:00.000Z', 'a-docs'), context: 'documents' };
    a.learning = { ...a.learning, updatedHlc: h(T, 1, 'web'), lastEventCursor: 'a' };
    const b = defaultProfile();
    b.voice.profiles.messages = voiceProfile(3, '2026-09-01T00:00:00.000Z', 'b');
    b.voice.profiles.documents = { ...voiceProfile(1, '2026-10-06T00:00:00.000Z', 'b-docs'), context: 'documents' };
    b.learning = { ...b.learning, updatedHlc: h(T, 2, 'web'), lastEventCursor: 'b' };
    const m = mergeDocuments(a, b);
    expect(m.voice.profiles.messages?.summary).toBe('b');
    expect(m.voice.profiles.documents?.summary).toBe('b-docs');
    expect(m.learning.lastEventCursor).toBe('b');
    expect(mergeDocuments(b, a)).toEqual(m);
  });

  it('properties (500 seeded cases): commutative, associative, idempotent, schema-valid', () => {
    const rng = makeRng(2026);
    const words = ['alpha', 'beta', 'gamma', 'delta', 'Jammarly', 'kubectl'];
    const rules = ['hedging', 'passive_voice', 'wordy_phrase', 'cliche'];
    const hosts = ['app.slack.com', 'mail.google.com', 'docs.google.com'];
    const dialects = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'] as const;
    const counters: Record<string, number> = {};
    const clock = (device: string): string => {
      counters[device] = (counters[device] ?? 0) + 1;
      return h(T + Math.floor(rng() * 5), counters[device] ?? 0, device);
    };
    const randomOp = (device: string): ProfileOp => {
      const hlc = clock(device);
      switch (Math.floor(rng() * 11)) {
        case 0:
          return { op: 'set', path: 'settings.dialect', value: pick(rng, dialects), hlc };
        case 1:
          return { op: 'set', path: 'settings.customInstructions', value: `note ${Math.floor(rng() * 100)}`, hlc };
        case 2:
          return { op: 'add', path: 'dictionary', value: pick(rng, words), hlc };
        case 3:
          return { op: 'remove', path: 'dictionary', value: pick(rng, words), hlc };
        case 4:
          return { op: 'add', path: 'rules.muted', value: pick(rng, rules), hlc };
        case 5:
          return { op: 'remove', path: 'rules.muted', value: pick(rng, rules), hlc };
        case 6:
          return { op: 'set', path: `rules.weights.${pick(rng, rules)}`, value: Math.floor(rng() * 5) / 2, hlc };
        case 7:
          return { op: 'set', path: `sites.overrides.${pick(rng, hosts)}`, value: { context: pick(rng, ['chat', 'email', 'doc'] as const) }, hlc };
        case 8:
          return pick(rng, [true, false])
            ? { op: 'add', path: 'sites.disabled', value: pick(rng, hosts), hlc }
            : { op: 'remove', path: 'sites.disabled', value: pick(rng, hosts), hlc };
        case 9:
          return { op: 'voice', context: 'messages', profile: voiceProfile(Math.floor(rng() * 3), `2026-10-0${1 + Math.floor(rng() * 5)}T00:00:00.000Z`, device), hlc };
        default:
          return { op: 'learning', patch: { updatedHlc: hlc, lastEventCursor: `${device}-${Math.floor(rng() * 10)}` }, hlc };
      }
    };
    const randomDoc = (base: ProfileDocument, device: string): ProfileDocument => {
      const ops: ProfileOp[] = [];
      const n = 2 + Math.floor(rng() * 5);
      for (let i = 0; i < n; i++) ops.push(randomOp(device));
      const r = applyOps(base, ops, { now: `2026-10-${String(1 + Math.floor(rng() * 20)).padStart(2, '0')}T00:00:00.000Z`, by: device });
      expect(r.rejected).toEqual([]);
      r.doc.version = Math.floor(rng() * 10);
      return r.doc;
    };
    const canon = (d: ProfileDocument): string => stableStringify(d);

    for (let i = 0; i < 500; i++) {
      const base = randomDoc(defaultProfile(), 'base');
      const a = randomDoc(base, 'a');
      const b = randomDoc(base, 'b');
      const c = randomDoc(base, 'c');
      const ab = mergeDocuments(a, b);
      expect(canon(ab)).toBe(canon(mergeDocuments(b, a)));
      expect(canon(mergeDocuments(ab, c))).toBe(canon(mergeDocuments(a, mergeDocuments(b, c))));
      expect(canon(mergeDocuments(a, a))).toBe(canon(a));
      expect(canon(mergeDocuments(ab, b))).toBe(canon(ab));
      expect(canon(mergeDocuments(ab, a))).toBe(canon(ab));
      if (i % 50 === 0) expect(ProfileDocumentSchema.safeParse(ab).success).toBe(true);
    }
  });
});

describe('migrateProfile', () => {
  it('returns the default document for non-objects and empty objects', () => {
    expect(migrateProfile(undefined)).toEqual(defaultProfile());
    expect(migrateProfile(null)).toEqual(defaultProfile());
    expect(migrateProfile('x')).toEqual(defaultProfile());
    expect(migrateProfile([])).toEqual(defaultProfile());
    expect(migrateProfile({})).toEqual(defaultProfile());
  });

  it('is the identity on valid documents', () => {
    const doc = applyOps(defaultProfile('2026-10-01T00:00:00.000Z'), [
      { op: 'set', path: 'settings.goals', value: { audience: 'expert', formality: 'formal', domain: 'technical', intent: 'convince' }, hlc: h(T, 0) },
      { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: h(T, 1) },
      { op: 'remove', path: 'dictionary', value: 'gone', hlc: h(T, 2) },
      { op: 'set', path: 'rules.weights.hedging', value: 0.5, hlc: h(T, 3) },
      { op: 'set', path: 'sites.overrides.app.slack.com', value: { context: 'chat' }, hlc: h(T, 4) },
      { op: 'voice', context: 'messages', profile: voiceProfile(1, '2026-10-01T00:00:00.000Z'), hlc: h(T, 5) },
      {
        op: 'learning',
        patch: {
          updatedHlc: h(T, 6, 'web'),
          stats: { 'global||hedging': { shown: 3, accepted: 1, dismissed: 2, ignored: 0, reported: 0, lastSeen: '2026-10-01T00:00:00.000Z' } },
          ruleStates: { 'global||hedging': { state: 'active', eligibleForBulk: false, scope: 'global', scopeKey: '', since: '2026-10-01T00:00:00.000Z', reprobeStage: 0 } },
          dictionaryCandidates: ['kubectl'],
          dialectInferred: 'en-GB',
          history: [{ at: '2026-10-01T00:00:00.000Z', eventsSeen: 10, changelog: 'x', model: 'm', version: 1 }],
          lastEventCursor: 'c',
        },
        hlc: h(T, 6, 'web'),
      },
    ], { now: '2026-10-02T00:00:00.000Z', by: 'd_1' }).doc;
    doc.version = 7;
    expect(migrateProfile(doc)).toEqual(doc);
    expect(migrateProfile(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('fills missing fields, drops invalid elements and unknown keys', () => {
    const partial = {
      schemaVersion: 1,
      version: 4,
      updatedAt: 'not a date',
      settings: {
        dialect: { value: 'en-GB', hlc: h(T, 0) },
        goals: { value: { audience: 'nope' }, hlc: h(T, 0) },
        mode: { value: 'quality' }, // missing hlc
        futureSetting: { value: 1, hlc: h(T, 0) },
      },
      dictionary: [{ value: 'ok', addedHlc: h(T, 0) }, { value: 42, addedHlc: h(T, 0) }, { value: 'bad clock', addedHlc: 'x' }, 'garbage'],
      rules: { muted: [{ value: 'hedging', addedHlc: h(T, 1), removedHlc: h(T, 2) }], weights: { hedging: { value: 3, hlc: h(T, 0) }, cliche: { value: 1, hlc: h(T, 0) }, 'bad id': { value: 1, hlc: h(T, 0) } } },
      sites: { overrides: { 'app.slack.com': { value: { context: 'chat', unknown: true }, hlc: h(T, 0) }, 'not a host': { value: {}, hlc: h(T, 0) } } },
      voice: { profiles: { messages: { ...voiceProfile(2, '2026-10-01T00:00:00.000Z'), extra: 1 }, documents: { version: 'x' } } },
      learning: { updatedHlc: 'bad', stats: { 'global||x': { shown: 1, accepted: 0, dismissed: 0, ignored: 0, reported: 0, lastSeen: '' }, bad: { shown: 'x' } }, dictionaryCandidates: ['fine', 7, '  '], dialectInferred: 'fr', history: 'nope' },
      unknownTop: {},
    };
    const out = migrateProfile(partial);
    const def = defaultProfile();
    expect(out.schemaVersion).toBe(1);
    expect(out.version).toBe(4);
    expect(out.updatedAt).toBe(def.updatedAt);
    expect(out.settings.dialect).toEqual({ value: 'en-GB', hlc: h(T, 0) });
    expect(out.settings.goals).toEqual(def.settings.goals);
    expect(out.settings.mode).toEqual(def.settings.mode);
    expect('futureSetting' in out.settings).toBe(false);
    expect(out.dictionary).toEqual([{ value: 'ok', addedHlc: h(T, 0) }]);
    expect(out.rules.muted).toEqual([{ value: 'hedging', addedHlc: h(T, 1), removedHlc: h(T, 2) }]);
    expect(out.rules.weights).toEqual({ cliche: { value: 1, hlc: h(T, 0) } });
    expect(out.sites.disabled).toEqual([]);
    expect(out.sites.overrides).toEqual({ 'app.slack.com': { value: { context: 'chat' }, hlc: h(T, 0) } });
    expect(out.voice.settings).toEqual(def.voice.settings);
    expect(out.voice.profiles.messages?.version).toBe(2);
    expect('extra' in (out.voice.profiles.messages ?? {})).toBe(false);
    expect(out.voice.profiles.documents).toBeUndefined();
    expect(out.learning.updatedHlc).toBe(ZERO_HLC);
    expect(Object.keys(out.learning.stats)).toEqual(['global||x']);
    expect(out.learning.dictionaryCandidates).toEqual(['fine']);
    expect(out.learning.dialectInferred).toBeUndefined();
    expect(out.learning.history).toEqual([]);
    expect('unknownTop' in out).toBe(false);
    expect(ProfileDocumentSchema.safeParse(out).success).toBe(true);
    expect(migrateProfile(out)).toEqual(out);
  });

  it('accepts a document whose schemaVersion is newer by keeping what it understands', () => {
    const future = { ...defaultProfile(), schemaVersion: 2, settings: { ...defaultProfile().settings, dialect: { value: 'en-IN', hlc: h(T, 0) } }, newSection: { a: 1 } };
    const out = migrateProfile(future);
    expect(out.schemaVersion).toBe(1);
    expect(out.settings.dialect.value).toBe('en-IN');
    expect(ProfileDocumentSchema.safeParse(out).success).toBe(true);
  });
});
