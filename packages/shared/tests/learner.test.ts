import { describe, expect, it } from 'vitest';
import type { FeedbackEvent, FeedbackKind } from '../src/learning';
import type { LearnedRuleState, ProfileDocument, RuleStats } from '../src/profile';
import type { Suggestion, SuggestionCategory, WritingContext } from '../src/types';
import { defaultProfile, emptyVoiceProfile } from '../src/profile';
import { formatHlc } from '../src/hlc';
import { applyOps } from '../src/merge';
import { CLARITY_RULES } from '../src/prompts/vocabulary';
import {
  applyLearnedState,
  buildLearningSummary,
  decodeMute,
  dictionaryCandidates,
  encodeMute,
  evaluateScope,
  foldEvents,
  inferDialect,
  LEARNER_CONSTANTS,
  lookupRuleState,
  mutedRulesForHost,
  parseStatsKey,
  probeKey,
  promotedRules,
  resolveLearning,
  resolveRuleStates,
  statsKey,
  STYLE_RULE_IDS,
  wilson,
} from '../src/learner';

const C = LEARNER_CONSTANTS;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const day = (n: number, hour = 12): string => new Date(T0 + n * 86_400_000 + hour * 3_600_000).toISOString();
const RULE_STATES = new Set(['active', 'demoted', 'suppressed', 'probing']);

let nextEvent = 0;
function ev(partial: Partial<FeedbackEvent> & { kind: FeedbackKind; rule: string }): FeedbackEvent {
  nextEvent += 1;
  const category: SuggestionCategory =
    partial.category ??
    (['spelling', 'subject_verb_agreement', 'capitalization', 'confusable_word', 'comma'].includes(partial.rule) ? 'correctness' : 'clarity');
  return {
    v: 1,
    eventId: partial.eventId ?? `e${nextEvent}`,
    t: partial.t ?? day(0),
    deviceId: 'd_1',
    suggestionId: partial.suggestionId ?? `s${nextEvent}`,
    fieldId: partial.fieldId ?? 'f1',
    docKey: partial.docKey ?? 'doc1',
    host: partial.host ?? 'app.slack.com',
    ctx: partial.ctx ?? 'chat',
    category,
    severity: partial.severity ?? 'warning',
    confidence: partial.confidence ?? 0.8,
    source: 'llm',
    spanLen: 5,
    sentenceLen: 40,
    promptVersion: 'v3',
    profileStrength: 2,
    goals: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' },
    dialect: 'en-US',
    ...partial,
  };
}

function many(n: number, partial: Partial<FeedbackEvent> & { kind: FeedbackKind; rule: string }): FeedbackEvent[] {
  return Array.from({ length: n }, () => ev({ ...partial }));
}

let nextSug = 0;
function sug(partial: Partial<Suggestion> & { rule: string }): Suggestion {
  nextSug += 1;
  const category = partial.category ?? (partial.rule === 'spelling' || partial.rule === 'subject_verb_agreement' ? 'correctness' : 'clarity');
  return {
    id: partial.id ?? `sug${nextSug}`,
    category,
    severity: category === 'correctness' ? 'error' : 'warning',
    kind: 'replace',
    source: 'llm',
    tier: category === 'correctness' ? 'A' : 'B',
    anchor: 'exact',
    range: { start: 0, end: 5 },
    highlight: { start: 0, end: 5 },
    original: 'teh',
    replacement: 'the',
    alternatives: [],
    title: 't',
    explanation: 'e',
    confidence: 0.9,
    meaningPreserving: true,
    autoApplySafe: true,
    blockId: 'b0',
    blockHash: 'h',
    conflictsWith: [],
    stale: false,
    promptVersion: 'v3',
    fingerprint: 'fp',
    learnedState: 'active',
    ...partial,
  };
}

const stats = (accepted: number, dismissed: number, extra: Partial<RuleStats> = {}): RuleStats => ({
  shown: accepted + dismissed,
  accepted,
  dismissed,
  ignored: 0,
  reported: 0,
  lastSeen: day(0),
  ...extra,
});

describe('wilson: the worked threshold table', () => {
  it('suppression (UB < 0.35 with n >= 8)', () => {
    expect(wilson(0, 8).ub).toBeCloseTo(0.324, 3);
    expect(wilson(1, 13).ub).toBeCloseTo(0.333, 3);
    expect(wilson(2, 17).ub).toBeLessThan(C.UB_SUPPRESS);
    expect(wilson(3, 21).ub).toBeLessThan(C.UB_SUPPRESS);
    expect(wilson(4, 25).ub).toBeLessThan(C.UB_SUPPRESS);
    // smallest-n claims: one fewer trial does not qualify
    expect(wilson(0, 7).ub).toBeGreaterThanOrEqual(C.UB_SUPPRESS);
    expect(wilson(1, 12).ub).toBeGreaterThanOrEqual(C.UB_SUPPRESS);
    expect(wilson(2, 16).ub).toBeGreaterThanOrEqual(C.UB_SUPPRESS);
  });
  it('demotion (UB < 0.50 with n >= 6), per reviewer item 30', () => {
    expect(wilson(1, 8).ub).toBeCloseTo(0.471, 3);
    expect(wilson(1, 8).ub).toBeGreaterThanOrEqual(C.UB_SUPPRESS);
    expect(wilson(1, 7).ub).toBeGreaterThan(C.UB_DEMOTE); // 0.513: not yet
    expect(wilson(2, 11).ub).toBeLessThan(C.UB_DEMOTE);
    expect(wilson(2, 10).ub).toBeGreaterThan(C.UB_DEMOTE);
    expect(wilson(0, 6).ub).toBeCloseTo(0.39, 2);
    expect(wilson(1, 10).ub).toBeCloseTo(0.404, 3);
  });
  it('promotion (LB >= 0.80 with n >= 10)', () => {
    expect(wilson(16, 16).lb).toBeCloseTo(0.806, 3);
    expect(wilson(24, 25).lb).toBeCloseTo(0.805, 3);
    expect(wilson(31, 33).lb).toBeGreaterThanOrEqual(C.LB_PROMOTE);
    expect(wilson(19, 20).lb).toBeCloseTo(0.764, 3);
    expect(wilson(19, 20).lb).toBeLessThan(C.LB_PROMOTE);
    expect(wilson(15, 15).lb).toBeLessThan(C.LB_PROMOTE);
  });
  it('is defined at the edges', () => {
    expect(wilson(0, 0)).toEqual({ lb: 0, ub: 1 });
    expect(wilson(5, 5).ub).toBe(1);
    expect(wilson(0, 5).lb).toBe(0);
    expect(wilson(10, 5).lb).toBeCloseTo(wilson(5, 5).lb, 12);
    const { lb, ub } = wilson(3, 10);
    expect(lb).toBeLessThan(0.3);
    expect(ub).toBeGreaterThan(0.3);
  });
});

describe('keys and mute encoding', () => {
  it('statsKey / parseStatsKey round-trip and normalise the global scopeKey', () => {
    expect(statsKey('host', 'app.slack.com', 'hedging')).toBe('host|app.slack.com|hedging');
    expect(statsKey('global', 'ignored', 'hedging')).toBe('global||hedging');
    expect(parseStatsKey('ctx|chat|passive_voice')).toEqual({ scope: 'ctx', scopeKey: 'chat', rule: 'passive_voice' });
    expect(parseStatsKey(probeKey('host', 'app.slack.com', 'x'))).toEqual({ scope: 'probe', scopeKey: 'host:app.slack.com', rule: 'x' });
    expect(parseStatsKey('nonsense')).toBeUndefined();
    expect(parseStatsKey('weird|a|b')).toBeUndefined();
    expect(parseStatsKey('global||')).toBeUndefined();
  });
  it('encodes and resolves manual mutes per host', () => {
    expect(encodeMute('hedging')).toBe('hedging');
    expect(encodeMute('hedging', 'App.Slack.com')).toBe('hedging@app.slack.com');
    expect(decodeMute('hedging@app.slack.com')).toEqual({ rule: 'hedging', host: 'app.slack.com' });
    expect(mutedRulesForHost(['hedging', 'cliche@slack.com', 'passive_voice@mail.google.com'], 'app.slack.com')).toEqual(['cliche', 'hedging']);
    expect(mutedRulesForHost(['cliche@slack.com'], 'notslack.com')).toEqual([]);
  });
});

describe('foldEvents', () => {
  it('applies the event weights to host, ctx and global scopes', () => {
    const events = [
      ...many(3, { kind: 'shown', rule: 'hedging' }),
      ev({ kind: 'accept', rule: 'hedging' }),
      ev({ kind: 'accepted_by_typing', rule: 'hedging' }),
      ev({ kind: 'dismiss', rule: 'hedging' }),
      ev({ kind: 'report_incorrect', rule: 'hedging' }),
      ev({ kind: 'ignore', rule: 'hedging' }),
      ev({ kind: 'self_corrected', rule: 'hedging' }), // not counted
      ev({ kind: 'edit_after_accept', rule: 'hedging' }), // not counted
    ];
    const r = foldEvents({}, events, { now: day(1) });
    const expected = { shown: 3, accepted: 2, dismissed: 1 + C.REPORT_WEIGHT, ignored: 1, reported: 1, lastSeen: day(0) };
    expect(r.stats[statsKey('host', 'app.slack.com', 'hedging')]).toEqual(expected);
    expect(r.stats[statsKey('ctx', 'chat', 'hedging')]).toEqual(expected);
    expect(r.stats[statsKey('global', '', 'hedging')]).toEqual(expected);
    expect(Object.keys(r.stats)).toHaveLength(3);
    expect(r.folded).toBe(8);
    expect(r.duplicates).toBe(0);
    expect(r.seen.size).toBe(10);
  });

  it('is idempotent per eventId across duplicate batches and never mutates its input', () => {
    const batch = [...many(4, { kind: 'dismiss', rule: 'hedging' }), ev({ kind: 'accept', rule: 'hedging' })];
    const first = foldEvents({}, batch, { now: day(1) });
    const snapshot = JSON.stringify(first.stats);
    const second = foldEvents(first.stats, batch, { now: day(1), seen: first.seen });
    expect(second.stats).toEqual(first.stats);
    expect(second.duplicates).toBe(5);
    expect(second.folded).toBe(0);
    expect(JSON.stringify(first.stats)).toBe(snapshot);
    // a batch mixing old and new ids folds only the new ones
    const third = foldEvents(first.stats, [...batch, ev({ kind: 'dismiss', rule: 'hedging' })], { now: day(1), seen: first.seen });
    expect(third.stats[statsKey('global', '', 'hedging')]?.dismissed).toBe(5);
    expect(third.folded).toBe(1);
    expect(third.duplicates).toBe(5);
  });

  it('skips events without an id or rule and uses now when t is unparsable', () => {
    const r = foldEvents({}, [ev({ kind: 'shown', rule: 'hedging', t: 'garbage' }), ev({ kind: 'shown', rule: '' }), { ...ev({ kind: 'shown', rule: 'x' }), eventId: '' }], { now: day(3) });
    expect(r.folded).toBe(1);
    expect(r.stats[statsKey('global', '', 'hedging')]?.lastSeen).toBe(day(3));
    expect(r.stats[statsKey('global', '', '')]).toBeUndefined();
  });

  it('returns manual overrides for "not on this site" and "never", with confirmation for core correctness', () => {
    const r = foldEvents(
      {},
      [
        ev({ kind: 'dismiss', rule: 'hedging', reason: 'not_this_site', host: 'App.Slack.com' }),
        ev({ kind: 'dismiss', rule: 'hedging', reason: 'not_this_site', host: 'app.slack.com' }), // duplicate override
        ev({ kind: 'dismiss', rule: 'cliche', reason: 'never' }),
        ev({ kind: 'dismiss', rule: 'spelling', reason: 'never' }),
        ev({ kind: 'dismiss', rule: 'passive_voice', reason: 'not_error' }),
      ],
      { now: day(0) },
    );
    expect(r.manualOff).toEqual([
      { scope: 'host', scopeKey: 'app.slack.com', rule: 'hedging' },
      { scope: 'global', rule: 'cliche' },
    ]);
    expect(r.needsConfirm).toEqual([{ scope: 'global', rule: 'spelling' }]);
    // the dismissals still count as negative evidence
    expect(r.stats[statsKey('global', '', 'hedging')]?.dismissed).toBe(2);
  });

  it('folds probe exposures into the probe counters as well as the regular ones', () => {
    const r = foldEvents({}, [ev({ kind: 'shown', rule: 'hedging', probe: true }), ev({ kind: 'accept', rule: 'hedging', probe: true }), ev({ kind: 'accept', rule: 'hedging' })], { now: day(0) });
    expect(r.stats[probeKey('host', 'app.slack.com', 'hedging')]).toMatchObject({ shown: 1, accepted: 1 });
    expect(r.stats[probeKey('global', '', 'hedging')]).toMatchObject({ shown: 1, accepted: 1 });
    expect(r.stats[statsKey('global', '', 'hedging')]).toMatchObject({ shown: 1, accepted: 2 });
  });
});

describe('promotedRules', () => {
  it('promotes correctness rules on global evidence only', () => {
    const s = {
      [statsKey('global', '', 'spelling')]: stats(16, 0),
      [statsKey('global', '', 'comma')]: stats(19, 1),
      [statsKey('global', '', 'hedging')]: stats(30, 0),
      [statsKey('host', 'app.slack.com', 'subject_verb_agreement')]: stats(30, 0),
      [statsKey('global', '', 'subject_verb_agreement')]: stats(5, 0),
    };
    expect([...promotedRules(s)].sort()).toEqual(['spelling']);
    expect(promotedRules({ [statsKey('global', '', 'comma')]: stats(24, 1) }).has('comma')).toBe(true);
    expect(promotedRules({ [statsKey('global', '', 'custom_rule')]: stats(24, 1) }).has('custom_rule')).toBe(false);
    expect(promotedRules({ [statsKey('global', '', 'custom_rule')]: stats(24, 1) }, { custom_rule: 'correctness' }).has('custom_rule')).toBe(true);
  });
});

describe('resolveRuleStates: scope chain', () => {
  it('uses the most specific scope with enough decisions and falls through otherwise', () => {
    const events = [
      ...many(8, { kind: 'dismiss', rule: 'hedging', host: 'app.slack.com', ctx: 'chat' }),
      ...many(8, { kind: 'accept', rule: 'hedging', host: 'discord.com', ctx: 'chat' }),
      ...many(6, { kind: 'dismiss', rule: 'hedging', host: 'teams.microsoft.com', ctx: 'chat' }),
      ...many(9, { kind: 'accept', rule: 'hedging', host: 'mail.google.com', ctx: 'email' }),
    ];
    const { stats: s } = foldEvents({}, events, { now: day(0) });
    const states = resolveRuleStates(s, {}, day(0));
    expect(states[statsKey('host', 'app.slack.com', 'hedging')]?.state).toBe('suppressed');
    expect(states[statsKey('host', 'discord.com', 'hedging')]?.state).toBe('active');
    expect(states[statsKey('host', 'teams.microsoft.com', 'hedging')]).toBeUndefined(); // 6 < N_MIN_SCOPE
    expect(states[statsKey('ctx', 'chat', 'hedging')]?.state).toBe('active'); // 8/22
    expect(states[statsKey('ctx', 'email', 'hedging')]?.state).toBe('active');
    expect(states[statsKey('global', '', 'hedging')]?.state).toBe('active');
    expect(lookupRuleState(states, 'hedging', 'app.slack.com', 'chat')?.scope).toBe('host');
    expect(lookupRuleState(states, 'hedging', 'app.slack.com', 'chat')?.state).toBe('suppressed');
    expect(lookupRuleState(states, 'hedging', 'teams.microsoft.com', 'chat')?.scope).toBe('ctx');
    expect(lookupRuleState(states, 'hedging', 'x.com', 'social')?.scope).toBe('global');
    expect(lookupRuleState(states, 'unknown_rule', 'x.com', 'social')).toBeUndefined();
    for (const st of Object.values(states)) {
      expect(RULE_STATES.has(st.state)).toBe(true);
      expect(st.eligibleForBulk).toBe(false);
    }
  });

  it('demotes on 1/8 at a host and on 0/6 through the global fallback', () => {
    const s1 = foldEvents({}, [ev({ kind: 'accept', rule: 'intensifier' }), ...many(7, { kind: 'dismiss', rule: 'intensifier' })], { now: day(0) }).stats;
    const st1 = resolveRuleStates(s1, {}, day(0));
    expect(st1[statsKey('host', 'app.slack.com', 'intensifier')]?.state).toBe('demoted');
    expect(evaluateScope(s1[statsKey('host', 'app.slack.com', 'intensifier')] ?? stats(0, 0)).ub).toBeCloseTo(0.471, 3);
    const s2 = foldEvents({}, many(6, { kind: 'dismiss', rule: 'cliche' }), { now: day(0) }).stats;
    const st2 = resolveRuleStates(s2, {}, day(0));
    expect(st2[statsKey('host', 'app.slack.com', 'cliche')]).toBeUndefined();
    expect(st2[statsKey('global', '', 'cliche')]?.state).toBe('demoted');
    expect(lookupRuleState(st2, 'cliche', 'app.slack.com', 'chat')?.state).toBe('demoted');
    const s3 = foldEvents({}, [...many(2, { kind: 'accept', rule: 'cliche' }), ...many(9, { kind: 'dismiss', rule: 'cliche' })], { now: day(0) }).stats;
    expect(resolveRuleStates(s3, {}, day(0))[statsKey('global', '', 'cliche')]?.state).toBe('demoted');
  });

  it('demotes on ignore rate over >= 20 exposures', () => {
    const base = { shown: 20, accepted: 1, dismissed: 1, reported: 0, lastSeen: day(0) };
    expect(evaluateScope({ ...base, ignored: 16 }).verdict).toBe('demoted');
    expect(evaluateScope({ ...base, ignored: 15 }).verdict).toBe('active');
    expect(evaluateScope({ ...base, shown: 19, ignored: 19 }).verdict).toBe('active');
    const s = { [statsKey('host', 'app.slack.com', 'cliche')]: { ...base, ignored: 16 }, [statsKey('global', '', 'cliche')]: { ...base, ignored: 16 } };
    const st = resolveRuleStates(s, {}, day(0));
    expect(st[statsKey('host', 'app.slack.com', 'cliche')]?.state).toBe('demoted'); // exposure evidence creates the host entry
  });

  it('keeps since while the state is unchanged and resets it on change', () => {
    const s = foldEvents({}, many(8, { kind: 'dismiss', rule: 'hedging' }), { now: day(0) }).stats;
    const a = resolveRuleStates(s, {}, day(0));
    const b = resolveRuleStates(s, a, day(5));
    expect(b[statsKey('global', '', 'hedging')]?.since).toBe(day(0));
    expect(b[statsKey('global', '', 'hedging')]?.nextReprobe).toBe(new Date(T0 + 12 * 3_600_000 + 30 * 86_400_000).toISOString());
    const s2 = foldEvents(s, many(20, { kind: 'accept', rule: 'hedging' }), { now: day(6) }).stats;
    const c = resolveRuleStates(s2, b, day(6));
    expect(c[statsKey('global', '', 'hedging')]?.state).toBe('active');
    expect(c[statsKey('global', '', 'hedging')]?.since).toBe(day(6));
  });
});

describe('resolveRuleStates: suppression cap', () => {
  const styleRules = [...CLARITY_RULES].slice(0, 9);
  const cap = Math.floor(C.MAX_SUPPRESSED_SHARE * STYLE_RULE_IDS.length);

  it('caps suppressed style rules per scope and is stable across re-resolution', () => {
    expect(cap).toBe(7);
    let s: Record<string, RuleStats> = {};
    for (const rule of styleRules) s[statsKey('global', '', rule)] = stats(0, 8);
    const first = resolveRuleStates(s, {}, day(0));
    const states = (r: Record<string, LearnedRuleState>) => styleRules.map((rule) => r[statsKey('global', '', rule)]?.state);
    expect(states(first).filter((x) => x === 'suppressed')).toHaveLength(cap);
    expect(states(first).filter((x) => x === 'demoted')).toHaveLength(2);
    const second = resolveRuleStates(s, first, day(1));
    expect(states(second)).toEqual(states(first));
    // a tenth rule arriving later is demoted, the seven already suppressed stay
    s = { ...s, [statsKey('global', '', 'rewrite_for_clarity')]: stats(0, 8) };
    const third = resolveRuleStates(s, second, day(2));
    expect(states(third)).toEqual(states(first));
    expect(third[statsKey('global', '', 'rewrite_for_clarity')]?.state).toBe('demoted');
  });

  it('downgrades the oldest suppressions first and never counts correctness rules', () => {
    const s: Record<string, RuleStats> = {};
    const prev: Record<string, LearnedRuleState> = {};
    styleRules.forEach((rule, i) => {
      s[statsKey('global', '', rule)] = stats(0, 8);
      prev[statsKey('global', '', rule)] = { state: 'suppressed', eligibleForBulk: false, scope: 'global', scopeKey: '', since: day(-i), reprobeStage: 0, nextReprobe: day(60) };
    });
    const correctness = ['spelling', 'comma', 'tense', 'article', 'preposition', 'pronoun_case', 'noun_number', 'extra_word', 'word_order'];
    for (const rule of correctness) s[statsKey('global', '', rule)] = stats(0, 8);
    const r = resolveRuleStates(s, prev, day(1));
    const demoted = styleRules.filter((rule) => r[statsKey('global', '', rule)]?.state === 'demoted');
    expect(demoted).toEqual([styleRules[7], styleRules[8]]); // since day(-7), day(-8): the two oldest
    expect(correctness.every((rule) => r[statsKey('global', '', rule)]?.state === 'suppressed')).toBe(true);
  });
});

describe('reprobe lifecycle over simulated days', () => {
  const rule = 'passive_voice';
  const host = 'app.slack.com';
  const key = statsKey('host', host, rule);
  const probe = (kind: FeedbackKind, t: string) => ev({ kind, rule, host, ctx: 'chat', probe: true, t });

  it('suppresses, probes after 30 days, re-suppresses with a longer wait, then un-suppresses on two accepts', () => {
    let fold = foldEvents({}, many(8, { kind: 'dismiss', rule, host, ctx: 'chat', t: day(0) }), { now: day(0) });
    let r = resolveLearning(fold.stats, {}, day(0));
    expect(r.ruleStates[key]).toMatchObject({ state: 'suppressed', reprobeStage: 0, since: day(0), nextReprobe: day(30) });

    r = resolveLearning(r.stats, r.ruleStates, day(29));
    expect(r.ruleStates[key]?.state).toBe('suppressed');

    r = resolveLearning(r.stats, r.ruleStates, day(30));
    expect(r.ruleStates[key]).toMatchObject({ state: 'probing', reprobeStage: 0, since: day(30) });
    expect(r.ruleStates[key]?.nextReprobe).toBeUndefined();

    // the next three exposures are probes; a fourth in the same pass is held back
    const applied = applyLearnedState(
      Array.from({ length: 5 }, () => sug({ rule, category: 'clarity' })),
      { ruleStates: r.ruleStates, promoted: new Set(), manualOff: [], host, ctx: 'chat', mutedRules: [] },
    );
    expect(applied.visible.map((s) => s.learnedState)).toEqual(['probe', 'probe', 'probe']);
    expect(applied.hidden.map((h) => h.reason)).toEqual(['probe_limit', 'probe_limit']);

    // 3 probes decided: 1 accept, 2 dismissals -> back to suppressed, stage 1 (60 days)
    fold = foldEvents(r.stats, [probe('shown', day(30)), probe('shown', day(30)), probe('shown', day(30)), probe('accept', day(30)), probe('dismiss', day(30)), probe('dismiss', day(31))], { now: day(31), seen: fold.seen });
    r = resolveLearning(fold.stats, r.ruleStates, day(31));
    expect(r.ruleStates[key]).toMatchObject({ state: 'suppressed', reprobeStage: 1, since: day(31), nextReprobe: day(91) });
    expect(r.stats[probeKey('host', host, rule)]).toBeUndefined(); // cycle counters cleared
    expect(r.stats[key]).toMatchObject({ accepted: 1, dismissed: 10 });

    // 1/11 now has UB 0.377 (> 0.35): the failed probe extends the suppression instead of demoting
    r = resolveLearning(r.stats, r.ruleStates, day(90));
    expect(r.ruleStates[key]).toMatchObject({ state: 'suppressed', reprobeStage: 1, nextReprobe: day(91) });
    expect(evaluateScope(r.stats[key] ?? stats(0, 0)).verdict).toBe('demoted');
    // strong contrary evidence from elsewhere (not a probe) releases the suppression outright
    const flipped = foldEvents(r.stats, many(20, { kind: 'accept', rule, host, ctx: 'chat', t: day(90) }), { now: day(90) });
    expect(resolveRuleStates(flipped.stats, r.ruleStates, day(90))[key]?.state).toBe('active');
    r = resolveLearning(r.stats, r.ruleStates, day(91));
    expect(r.ruleStates[key]).toMatchObject({ state: 'probing', reprobeStage: 1 });

    // two probe accepts un-suppress the rule even before the third exposure is decided
    fold = foldEvents(r.stats, [probe('shown', day(91)), probe('accept', day(91)), probe('shown', day(92)), probe('accept', day(92))], { now: day(92), seen: fold.seen });
    r = resolveLearning(fold.stats, r.ruleStates, day(92));
    expect(r.ruleStates[key]).toMatchObject({ state: 'active', reprobeStage: 0, since: day(92) });
    expect(r.ruleStates[key]?.nextReprobe).toBeUndefined();
    // counters halved: (1 + 2) accepts -> 1, (8 + 2) dismissals -> 5
    expect(r.stats[key]).toMatchObject({ accepted: 1, dismissed: 5 });
    expect(r.stats[probeKey('host', host, rule)]).toBeUndefined();

    // and it stays active on the next resolution instead of snapping back to suppressed
    const later = resolveLearning(r.stats, r.ruleStates, day(93));
    expect(later.ruleStates[key]?.state).toBe('active');
    expect(later.stats).toBe(r.stats); // no settlement needed: same object
  });

  it('caps the stage at the last entry and skips probing for manually muted rules', () => {
    let prev: Record<string, LearnedRuleState> = {
      [key]: { state: 'suppressed', eligibleForBulk: false, scope: 'host', scopeKey: host, since: day(0), reprobeStage: 3, nextReprobe: day(1) },
    };
    const s = { [key]: stats(0, 8), [statsKey('global', '', rule)]: stats(0, 8) };
    let r = resolveLearning(s, prev, day(1));
    expect(r.ruleStates[key]?.state).toBe('probing');
    const fold = foldEvents(r.stats, [probe('dismiss', day(1)), probe('dismiss', day(1)), probe('ignore', day(1))], { now: day(1) });
    r = resolveLearning(fold.stats, r.ruleStates, day(2));
    expect(r.ruleStates[key]).toMatchObject({ state: 'suppressed', reprobeStage: 3, nextReprobe: day(2 + 180) });

    prev = { [key]: { state: 'suppressed', eligibleForBulk: false, scope: 'host', scopeKey: host, since: day(0), reprobeStage: 0, nextReprobe: day(1) } };
    const muted = resolveLearning(s, prev, day(5), [{ scope: 'host', scopeKey: host, rule }]);
    expect(muted.ruleStates[key]?.state).toBe('suppressed');
    const mutedGlobally = resolveLearning(s, prev, day(5), [{ scope: 'global', rule }]);
    expect(mutedGlobally.ruleStates[key]?.state).toBe('suppressed');
    const otherHostMuted = resolveLearning(s, prev, day(5), [{ scope: 'host', scopeKey: 'mail.google.com', rule }]);
    expect(otherHostMuted.ruleStates[key]?.state).toBe('probing');
  });
});

describe('applyLearnedState', () => {
  const host = 'app.slack.com';
  const ctx: WritingContext = 'chat';
  const suppressed = (rule: string, scope: 'host' | 'global' = 'host'): Record<string, LearnedRuleState> => ({
    [statsKey(scope, host, rule)]: { state: 'suppressed', eligibleForBulk: false, scope, scopeKey: scope === 'host' ? host : '', since: day(0), reprobeStage: 0 },
  });
  const base = { promoted: new Set<string>(), manualOff: [], host, ctx, mutedRules: [] as string[] };

  it('hides suppressed rules, marks demoted ones and leaves others active', () => {
    const ruleStates: Record<string, LearnedRuleState> = {
      ...suppressed('hedging'),
      [statsKey('ctx', ctx, 'cliche')]: { state: 'demoted', eligibleForBulk: false, scope: 'ctx', scopeKey: ctx, since: day(0), reprobeStage: 0 },
    };
    const input = [sug({ rule: 'hedging', id: 'a' }), sug({ rule: 'cliche', id: 'b' }), sug({ rule: 'wordy_phrase', id: 'c', learnedState: 'probe' })];
    const r = applyLearnedState(input, { ...base, ruleStates });
    expect(r.hidden).toEqual([{ id: 'a', reason: 'suppressed' }]);
    expect(r.visible.map((s) => [s.id, s.learnedState])).toEqual([['b', 'demoted'], ['c', 'active']]);
    expect(input[2]?.learnedState).toBe('probe'); // inputs untouched
  });

  it('applies the correctness floor unless the rule is manually muted', () => {
    const ruleStates = suppressed('subject_verb_agreement');
    const high = sug({ rule: 'subject_verb_agreement', id: 'high', confidence: 0.95 });
    const low = sug({ rule: 'subject_verb_agreement', id: 'low', confidence: 0.8, tier: 'B' });
    const warning = sug({ rule: 'subject_verb_agreement', id: 'warn', confidence: 0.95, severity: 'warning', tier: 'B' });
    let r = applyLearnedState([high, low, warning], { ...base, ruleStates });
    expect(r.visible.map((s) => s.id)).toEqual(['high']);
    expect(r.hidden).toEqual([{ id: 'low', reason: 'suppressed' }, { id: 'warn', reason: 'suppressed' }]);
    r = applyLearnedState([high], { ...base, ruleStates, mutedRules: ['subject_verb_agreement'] });
    expect(r.hidden).toEqual([{ id: 'high', reason: 'manual' }]);
    r = applyLearnedState([high], { ...base, ruleStates, mutedRules: ['subject_verb_agreement@slack.com'] });
    expect(r.hidden).toEqual([{ id: 'high', reason: 'manual' }]);
    r = applyLearnedState([high], { ...base, ruleStates, mutedRules: ['subject_verb_agreement@mail.google.com'] });
    expect(r.visible).toHaveLength(1);
    r = applyLearnedState([high], { ...base, ruleStates, manualOff: [{ scope: 'host', scopeKey: host, rule: 'subject_verb_agreement' }] });
    expect(r.hidden).toEqual([{ id: 'high', reason: 'manual' }]);
    r = applyLearnedState([high], { ...base, ruleStates, manualOff: [{ scope: 'global', rule: 'subject_verb_agreement' }] });
    expect(r.hidden).toEqual([{ id: 'high', reason: 'manual' }]);
    r = applyLearnedState([high], { ...base, ruleStates, manualOff: [{ scope: 'host', scopeKey: 'discord.com', rule: 'subject_verb_agreement' }] });
    expect(r.visible).toHaveLength(1);
  });

  it('upgrades promoted correctness fixes from Tier B to Tier A at confidence >= 0.70 only', () => {
    const promoted = new Set(['spelling']);
    const candidates = [
      sug({ rule: 'spelling', id: 'ok', tier: 'B', confidence: 0.75 }),
      sug({ rule: 'spelling', id: 'edge', tier: 'B', confidence: 0.7 }),
      sug({ rule: 'spelling', id: 'too-low', tier: 'C', confidence: 0.65 }),
      sug({ rule: 'spelling', id: 'normalized', tier: 'B', confidence: 0.8, anchor: 'normalized' }),
      sug({ rule: 'spelling', id: 'unsafe', tier: 'B', confidence: 0.8, autoApplySafe: false }),
      sug({ rule: 'spelling', id: 'warning', tier: 'B', confidence: 0.8, severity: 'warning' }),
      sug({ rule: 'spelling', id: 'rewrite', tier: 'C', confidence: 0.8, kind: 'rewrite' }),
      sug({ rule: 'comma', id: 'not-promoted', tier: 'B', confidence: 0.8 }),
      sug({ rule: 'spelling', id: 'already-a', tier: 'A', confidence: 0.9 }),
    ];
    const r = applyLearnedState(candidates, { ...base, ruleStates: {}, promoted });
    const tiers = Object.fromEntries(r.visible.map((s) => [s.id, s.tier]));
    expect(tiers).toEqual({ ok: 'A', edge: 'A', 'too-low': 'C', normalized: 'B', unsafe: 'B', warning: 'B', rewrite: 'C', 'not-promoted': 'B', 'already-a': 'A' });
    expect(candidates[0]?.tier).toBe('B');
  });
});

describe('dictionaryCandidates', () => {
  const dismiss = (original: string, fieldId = 'f1', rule = 'spelling') => ev({ kind: 'dismiss', rule, original, fieldId, category: 'correctness' });

  it('applies the three dismissal rules', () => {
    const events = [
      dismiss('kubectl'),
      dismiss('kubectl'),
      dismiss('kubectl'), // >= 3 in one field
      dismiss('gitops', 'f1'),
      dismiss('gitops', 'f2'), // 2 across 2 fields
      dismiss('Jammarly'),
      dismiss('Jammarly'), // capitalized, 2
      dismiss('lowercase'),
      dismiss('lowercase'), // 2 in one field, not capitalized: no
      dismiss('once'),
    ];
    expect(dictionaryCandidates(events, [])).toEqual(['kubectl', 'Jammarly', 'gitops']);
  });

  it('counts self-corrections back to the token, excludes existing and contested words, ignores bad tokens', () => {
    const events = [
      dismiss('kubectl'),
      dismiss('kubectl'),
      ev({ kind: 'self_corrected', rule: 'spelling', original: 'kubectl', final: 'kubectl', fieldId: 'f3' }),
      ev({ kind: 'self_corrected', rule: 'spelling', original: 'teh', final: 'the', fieldId: 'f3' }),
      dismiss('Existing'),
      dismiss('Existing'),
      dismiss('contested'),
      dismiss('contested'),
      dismiss('contested'),
      ev({ kind: 'accept', rule: 'spelling', original: 'contested' }),
      ev({ kind: 'accept', rule: 'spelling', original: 'contested' }),
      dismiss('AB12'),
      dismiss('AB12'),
      dismiss('AB12'),
      dismiss('‹email›'),
      dismiss('‹email›'),
      dismiss('‹email›'),
      dismiss('x'),
      dismiss('x'),
      dismiss('x'),
      dismiss('passive thing', 'f1', 'passive_voice'),
      dismiss('passive thing', 'f1', 'passive_voice'),
      dismiss('passive thing', 'f1', 'passive_voice'),
      dismiss('résumé', 'f1', 'capitalization'),
      dismiss('résumé', 'f2', 'spelling_dialect'),
    ];
    expect(dictionaryCandidates(events, ['existing'])).toEqual(['kubectl', 'résumé']);
  });

  it('keeps the most frequent casing', () => {
    const events = [dismiss('iPhone'), dismiss('iPhone'), dismiss('Iphone')];
    expect(dictionaryCandidates(events, [])).toEqual(['iPhone']);
  });
});

describe('inferDialect', () => {
  const british = 'I favour the colour grey, organise my centre, apologise and realise my neighbour travelled.';
  const american = 'I favor the color gray, organize my center, apologize and realize my neighbor traveled.';

  it('needs at least 20 markers and 80% agreement', () => {
    expect(inferDialect([british, british])).toBeUndefined(); // 18 markers
    expect(inferDialect([british, british, british])).toBe('en-GB');
    expect(inferDialect([american, american, american])).toBe('en-US');
    expect(inferDialect([british, british, american, american])).toBeUndefined();
    expect(inferDialect([british, british, british, british, 'the color and the center'])).toBe('en-GB'); // 36/38
    expect(inferDialect([])).toBeUndefined();
    expect(inferDialect(['nothing dialect-specific here at all'])).toBeUndefined();
  });

  it('separates Canadian, Australian and Indian English from British', () => {
    const canadian = 'The colour of the centre favours my neighbour; organize, realize, apologize, tire, curb, program.';
    expect(inferDialect([canadian, canadian, canadian])).toBe('en-CA');
    const australian = 'Favour the colour grey, organise the programme-free program; arvo, servo, brekkie, ute, esky, bogan.';
    expect(inferDialect([australian, australian])).toBe('en-AU');
    const indian = 'Favour the colour grey, organise the centre; lakh, crore, prepone, lakh, crore, timepass.';
    expect(inferDialect([indian, indian])).toBe('en-IN');
  });

  it('is case-insensitive and ignores punctuation', () => {
    const s = 'COLOUR, Colour! colour? favour; favour: organise... organise';
    expect(inferDialect([s, s, s])).toBe('en-GB');
  });
});

describe('buildLearningSummary', () => {
  const T = 1_760_870_400_000;
  const h = (n: number) => formatHlc({ wallMs: T + n, counter: 0, deviceId: 'web' });
  const now = day(14);

  function docWithLearning(): ProfileDocument {
    const events = [
      ...many(16, { kind: 'accept', rule: 'spelling', t: day(10) }),
      ...many(8, { kind: 'dismiss', rule: 'hedging', t: day(10) }),
      ...many(8, { kind: 'accept', rule: 'cliche', host: 'mail.google.com', ctx: 'email', t: day(10) }),
    ];
    const fold = foldEvents({}, events, { now });
    const r = resolveLearning(fold.stats, {}, now);
    const doc = applyOps(defaultProfile(), [
      { op: 'learning', patch: { updatedHlc: h(1), stats: r.stats, ruleStates: r.ruleStates, dictionaryCandidates: ['kubectl'], dialectInferred: 'en-GB' }, hlc: h(1) },
      { op: 'add', path: 'rules.muted', value: 'hedging@app.slack.com', hlc: h(2) },
      { op: 'add', path: 'rules.muted', value: 'cliche', hlc: h(3) },
      { op: 'add', path: 'dictionary', value: 'kubectl', hlc: h(4) },
      { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: h(5) },
      { op: 'voice', context: 'messages', profile: { ...emptyVoiceProfile('messages'), version: 2, generatedAt: day(9), confidence: 'medium', traits: [{ id: 't1', label: 'l', description: 'd', dimension: 'tone', evidenceCount: 3, confidence: 'high', locked: false }] }, hlc: h(6) },
    ]).doc;
    doc.learning.history = Array.from({ length: 35 }, (_, i) => ({ at: day(i), eventsSeen: i, changelog: `run ${i}`, model: 'm', version: i }));
    return doc;
  }

  it('computes window rates with CIs, trends against the previous window and per-100-word density', () => {
    const current = [
      ...many(10, { kind: 'shown', rule: 'hedging', t: day(10), fieldId: 'fA', wordCountTyped: 100 }),
      ev({ kind: 'shown', rule: 'hedging', t: day(10), fieldId: 'fA', wordCountTyped: 300 }),
      ...many(4, { kind: 'shown', rule: 'spelling', t: day(11), fieldId: 'fB', wordCountTyped: 200 }),
      ...many(6, { kind: 'accept', rule: 'hedging', t: day(10) }),
      ...many(2, { kind: 'dismiss', rule: 'hedging', t: day(11) }),
      ev({ kind: 'report_incorrect', rule: 'hedging', t: day(11) }),
      ...many(3, { kind: 'ignore', rule: 'hedging', t: day(12) }),
      ...many(4, { kind: 'accept', rule: 'spelling', t: day(12), host: 'mail.google.com', ctx: 'email' }),
    ];
    const previous = [...many(2, { kind: 'accept', rule: 'hedging', t: day(3) }), ...many(6, { kind: 'dismiss', rule: 'hedging', t: day(4) })];
    const tooOld = many(5, { kind: 'dismiss', rule: 'hedging', t: day(-10) });
    const s = buildLearningSummary(docWithLearning(), [...current, ...previous, ...tooOld, ev({ kind: 'shown', rule: 'x', t: 'garbage' })], { now, days: 7, storeSnippets: true });

    expect(s.window).toEqual({ days: 7, from: day(7), to: now });
    expect(s.overall).toMatchObject({ shown: 15, accepted: 10, dismissed: 3, ignored: 3 });
    expect(s.overall.acceptance.value).toBeCloseTo(10 / 13, 6);
    expect(s.overall.acceptance.n).toBe(13);
    expect(s.overall.acceptance.ciLow).toBeCloseTo(wilson(10, 13).lb, 6);
    expect(s.overall.acceptance.ciHigh).toBeCloseTo(wilson(10, 13).ub, 6);
    expect(s.overall.acceptance.prev).toBeCloseTo(0.25, 6);
    expect(s.overall.acceptance.delta).toBeCloseTo(10 / 13 - 0.25, 6);
    expect(s.overall.dismissRate.value).toBeCloseTo(3 / 13, 6);
    expect(s.overall.ignoreRate.value).toBeCloseTo(3 / 15, 6);
    expect(s.overall.ignoreRate.n).toBe(15);

    expect(s.byCategory.clarity).toMatchObject({ shown: 11, accepted: 6, dismissed: 3, ignored: 3 });
    expect(s.byCategory.correctness).toMatchObject({ shown: 4, accepted: 4, dismissed: 0 });
    expect(s.byCategory.engagement.acceptance).toEqual({ value: 0, ciLow: 0, ciHigh: 0, prev: 0, delta: 0, n: 0 });
    // words typed: max per field (300 + 200) = 500; 11 clarity shown per 500 words = 2.2 per 100
    expect(s.byCategory.clarity.per100Words.value).toBeCloseTo(2.2, 6);
    expect(s.byCategory.clarity.per100Words.n).toBe(500);
    expect(s.byCategory.correctness.per100Words.value).toBeCloseTo(0.8, 6);

    expect(s.byContext.chat?.accepted).toBe(6);
    expect(s.byContext.email?.accepted).toBe(4);
    expect(s.byContext.doc).toBeUndefined();
    expect(s.byHost.map((x) => x.host)).toEqual(['app.slack.com', 'mail.google.com']);
    expect(s.byHost[0]?.shown).toBe(15);

    expect(s.privacy).toEqual({ storeSnippets: true, rawEvents: current.length + previous.length + tooOld.length, oldestEvent: day(-10) });
    expect(s.history).toHaveLength(30);
    expect(s.history[0]?.version).toBe(5);
  });

  it('reports rule rows, learned-state counts and voice rows from the document', () => {
    const doc = docWithLearning();
    const samples = [
      { t: day(13), host: 'app.slack.com', ctx: 'chat' as const, voiceContext: 'messages' as const, sentence: 'hi' },
      { t: day(-20), host: 'app.slack.com', ctx: 'chat' as const, voiceContext: 'messages' as const, sentence: 'old' },
    ];
    const s = buildLearningSummary(doc, many(3, { kind: 'accept', rule: 'spelling', t: day(13) }), { now, days: 28, storeSnippets: false, voiceSamples: samples });

    const rows = Object.fromEntries(s.byRule.map((r) => [`${r.scope}|${r.scopeKey}|${r.rule}`, r]));
    expect(rows['global||spelling']).toMatchObject({ category: 'correctness', state: 'active', eligibleForBulk: true, manualOff: false, accepted: 16, dismissed: 0 });
    expect(rows['global||spelling']?.wilsonLB).toBeCloseTo(0.806, 3);
    expect(rows['host|app.slack.com|hedging']).toMatchObject({ category: 'delivery', state: 'suppressed', eligibleForBulk: false, manualOff: true });
    expect(rows['host|app.slack.com|hedging']?.wilsonUB).toBeCloseTo(0.324, 3);
    expect(rows['host|app.slack.com|hedging']?.nextReprobe).toBe(new Date(T0 + 14 * 86_400_000 + 12 * 3_600_000 + 30 * 86_400_000).toISOString());
    expect(rows['global||hedging']).toMatchObject({ state: 'suppressed', manualOff: false });
    expect(rows['global||cliche']).toMatchObject({ category: 'engagement', state: 'active', manualOff: true });
    expect(rows['host|mail.google.com|cliche']).toMatchObject({ state: 'active', manualOff: true });
    expect(s.byRule.every((r) => RULE_STATES.has(r.state))).toBe(true);

    expect(s.learnedState).toEqual({
      suppressed: 3, // hedging at host, ctx and global
      demoted: 0,
      promoted: 1,
      manualOff: 2,
      dictionaryLearned: 1,
      dictionaryManual: 1,
      dialectInferred: 'en-GB',
    });
    expect(s.voice).toEqual({ messages: { version: 2, generatedAt: day(9), traits: 1, confidence: 'medium', strength: 2, samples30d: 1, decisions30d: 3 } });
    expect(s.privacy.storeSnippets).toBe(false);
  });
});

describe('one-week synthetic replay: fold -> resolve -> apply', () => {
  it('converges to the expected states without unreachable or mixed states', () => {
    const slack = { host: 'app.slack.com', ctx: 'chat' as const };
    const gmail = { host: 'mail.google.com', ctx: 'email' as const };
    const suggestionsForSlack = () => [
      sug({ rule: 'hedging', category: 'delivery', confidence: 0.8, tier: 'B' }),
      sug({ rule: 'spelling', confidence: 0.75, tier: 'B' }),
      sug({ rule: 'spelling', confidence: 0.95, tier: 'A' }),
      sug({ rule: 'wordy_phrase', confidence: 0.8, tier: 'B' }),
      sug({ rule: 'intensifier', category: 'engagement', confidence: 0.8, tier: 'B' }),
      sug({ rule: 'subject_verb_agreement', confidence: 0.92, tier: 'A' }),
    ];

    let stats: Record<string, RuleStats> = {};
    let ruleStates: Record<string, LearnedRuleState> = {};
    let seen = new Set<string>();
    const manualOff: ReturnType<typeof foldEvents>['manualOff'] = [];
    const timeline: { day: number; visible: string[]; hidden: string[] }[] = [];

    for (let d = 0; d < 7; d++) {
      const t = day(d);
      const events: FeedbackEvent[] = [
        // hedging on Slack: shown and dismissed twice a day
        ...many(2, { kind: 'shown', rule: 'hedging', ...slack, t, wordCountTyped: 120 }),
        ...many(2, { kind: 'dismiss', rule: 'hedging', ...slack, t }),
        // hedging in Gmail: accepted
        ...many(2, { kind: 'shown', rule: 'hedging', ...gmail, t, fieldId: 'g1' }),
        ...many(2, { kind: 'accept', rule: 'hedging', ...gmail, t }),
        // spelling: always accepted everywhere
        ...many(2, { kind: 'accept', rule: 'spelling', ...slack, t, category: 'correctness' }),
        ...many(1, { kind: 'accept', rule: 'spelling', ...gmail, t, category: 'correctness' }),
        // wordy_phrase: 50/50
        ev({ kind: 'accept', rule: 'wordy_phrase', ...slack, t }),
        ev({ kind: 'dismiss', rule: 'wordy_phrase', ...slack, t }),
        // intensifier: one accept then 7 dismissals (1/8, UB 0.471) -> demoted on Slack; 1/7 (UB 0.513) is not yet
        ...(d === 0 ? [ev({ kind: 'accept', rule: 'intensifier', ...slack, t })] : many(d === 1 ? 2 : 1, { kind: 'dismiss', rule: 'intensifier', ...slack, t })),
        // subject_verb_agreement: user keeps dismissing low-confidence ones
        ...many(2, { kind: 'dismiss', rule: 'subject_verb_agreement', ...slack, t, category: 'correctness' }),
      ];
      if (d === 2) events.push(ev({ kind: 'dismiss', rule: 'cliche', ...slack, t, reason: 'not_this_site' }));

      // the device uploads the day's batch twice (retry): the second copy must change nothing
      const fold = foldEvents(stats, events, { now: t, seen });
      const again = foldEvents(fold.stats, events, { now: t, seen: fold.seen });
      expect(again.stats).toEqual(fold.stats);
      expect(again.folded).toBe(0);
      stats = fold.stats;
      seen = fold.seen;
      for (const m of fold.manualOff) manualOff.push(m);

      const resolved = resolveLearning(stats, ruleStates, t, manualOff);
      stats = resolved.stats;
      ruleStates = resolved.ruleStates;
      const promoted = promotedRules(stats);

      for (const [key, st] of Object.entries(ruleStates)) {
        expect(RULE_STATES.has(st.state), key).toBe(true);
        expect(parseStatsKey(key)?.scope).not.toBe('probe');
        expect(st.scope).toBe(parseStatsKey(key)?.scope);
        if (st.state === 'suppressed') expect(st.nextReprobe).toBeDefined();
        else if (st.state !== 'probing') expect(st.nextReprobe).toBeUndefined();
        expect(st.eligibleForBulk).toBe(promoted.has(parseStatsKey(key)?.rule ?? ''));
      }
      for (const key of Object.keys(stats)) {
        const p = parseStatsKey(key);
        if (p !== undefined && p.scope !== 'probe') expect(ruleStates[statsKey('global', '', p.rule)], key).toBeDefined();
      }

      const applied = applyLearnedState(suggestionsForSlack(), { ruleStates, promoted, manualOff, host: slack.host, ctx: slack.ctx, mutedRules: [] });
      timeline.push({
        day: d,
        visible: applied.visible.map((s) => `${s.rule}:${s.learnedState}:${s.tier}`),
        hidden: applied.hidden.map((h) => `${h.reason}`),
      });
    }

    // Day 0: nothing learned yet.
    expect(timeline[0]?.hidden).toEqual([]);
    expect(timeline[0]?.visible).toContain('spelling:active:B');

    // Day 3: hedging has 8 dismissals on Slack -> suppressed there, active in Gmail.
    const hedgingSlack = ruleStates[statsKey('host', 'app.slack.com', 'hedging')];
    const hedgingGmail = ruleStates[statsKey('host', 'mail.google.com', 'hedging')];
    expect(hedgingSlack?.state).toBe('suppressed');
    expect(hedgingGmail?.state).toBe('active');
    expect(timeline[3]?.hidden).toContain('suppressed');
    expect(timeline[2]?.hidden).not.toContain('suppressed');

    // Spelling: 21 global accepts -> promoted (eligibleForBulk) while its state stays active; the 0.75 fix becomes Tier A.
    const spellingGlobal = ruleStates[statsKey('global', '', 'spelling')];
    expect(spellingGlobal).toMatchObject({ state: 'active', eligibleForBulk: true });
    expect(promotedRules(stats).has('spelling')).toBe(true);
    expect(timeline[6]?.visible).toContain('spelling:active:A');
    expect(timeline[6]?.visible.filter((v) => v.startsWith('spelling:active:A'))).toHaveLength(2);
    expect(timeline[0]?.visible.filter((v) => v === 'spelling:active:A')).toHaveLength(1);

    // wordy_phrase stays active; intensifier is demoted on Slack (1/7 accepts).
    expect(lookupRuleState(ruleStates, 'wordy_phrase', slack.host, slack.ctx)?.state).toBe('active');
    expect(lookupRuleState(ruleStates, 'intensifier', slack.host, slack.ctx)?.state).toBe('demoted');
    expect(timeline[6]?.visible).toContain('intensifier:demoted:B');
    expect(timeline[5]?.visible).toContain('intensifier:active:B'); // 1/7 the day before: not yet

    // subject_verb_agreement is suppressed on Slack but the 0.92 error stays visible through the floor.
    expect(lookupRuleState(ruleStates, 'subject_verb_agreement', slack.host, slack.ctx)?.state).toBe('suppressed');
    expect(timeline[6]?.visible).toContain('subject_verb_agreement:active:A');

    // The "not on this site" dismissal became a host override, not a learned state.
    expect(manualOff).toEqual([{ scope: 'host', scopeKey: 'app.slack.com', rule: 'cliche' }]);
    const withCliche = applyLearnedState([sug({ rule: 'cliche', category: 'engagement' })], { ruleStates, promoted: promotedRules(stats), manualOff, host: slack.host, ctx: slack.ctx, mutedRules: [] });
    expect(withCliche.hidden).toEqual([{ id: withCliche.hidden[0]?.id ?? '', reason: 'manual' }]);

    // Final visibility on Slack: hedging hidden (suppressed), everything else visible.
    expect(timeline[6]?.hidden).toEqual(['suppressed']);
    expect(timeline[6]?.visible).toHaveLength(5);
  });
});
