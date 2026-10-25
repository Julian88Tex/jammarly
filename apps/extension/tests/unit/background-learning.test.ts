import { afterEach, describe, expect, it } from 'vitest';
import type { FeedbackEvent, FeedbackEventInput } from '@jammarly/shared/learning';
import { defaultProfile } from '@jammarly/shared/profile';
import type { Suggestion } from '@jammarly/shared/types';
import { createCore, type Core } from '../../src/background/core';
import { categoriesFrom, manualOffFromMuted } from '../../src/background/learning/fold';
import { applyLearnedState, dictionaryCandidates, encodeMute, foldEvents, lookupRuleState, mutedRulesForHost, promotedRules, resolveLearning, statsKey, wilson, LEARNER_CONSTANTS } from '../../src/background/shared-engine';
import { installChromeMock, type ChromeMock } from './helpers/chrome-mock';

function input(over: Partial<FeedbackEventInput> = {}): FeedbackEventInput {
  return {
    kind: 'dismiss',
    suggestionId: 's1',
    fieldId: 'f1',
    docKey: 'doc-1',
    host: 'mail.google.com',
    ctx: 'email',
    rule: 'hedging',
    category: 'delivery',
    severity: 'suggestion',
    confidence: 0.6,
    source: 'llm',
    original: 'Call me at +1 (415) 555-2671 or bob@example.com, probably',
    sentence: 'See https://example.com/private?token=abc for the details I probably mentioned.',
    spanLen: 9,
    sentenceLen: 80,
    ...over,
  };
}

describe('learning: ingest and fold', () => {
  let mock: ChromeMock;
  afterEach(() => mock.uninstall());

  async function core(paired = false): Promise<Core> {
    mock = installChromeMock();
    const profile = defaultProfile();
    profile.settings.privacy.value.consentAt = '2026-01-01T00:00:00.000Z';
    mock.storage.local.data.set('profile', profile);
    mock.storage.local.data.set('settings', { provider: 'mock', ...(paired ? { pairing: { appOrigin: 'https://a', deviceId: 'd', token: 't', pairedAt: '' } } : {}) });
    const c = createCore({ chrome: mock.chrome, appOrigin: paired ? 'https://a' : '' });
    await c.ready;
    return c;
  }

  it('completes events with device/time/model/profile fields and redacts snippets', async () => {
    const c = await core();
    const [e] = await c.learning.ingest([input()], { deviceId: 'd_1', promptVersion: 'v3', model: 'mock', storeSnippets: true });
    expect(e!.v).toBe(1);
    expect(e!.eventId).toMatch(/[0-9a-f-]{36}/);
    expect(e!.deviceId).toBe('d_1');
    expect(e!.model).toBe('mock');
    expect(e!.promptVersion).toBe('v3');
    expect(e!.profileStrength).toBe(2);
    expect(e!.dialect).toBe('en-US');
    expect(e!.goals.formality).toBe('neutral');
    expect(e!.original).not.toContain('555');
    expect(e!.original).not.toContain('bob@example.com');
    expect(e!.original).toContain('‹phone›');
    expect(e!.sentence).toContain('‹url›');
    expect(e!.sentence).not.toContain('token=abc');
    expect(c.store.local.get('eventBuffer')).toHaveLength(1);
  });

  it('drops snippets entirely when storeSnippets is off', async () => {
    const c = await core();
    const [e] = await c.learning.ingest([input({ replacement: 'x', final: 'y' })], { deviceId: 'd_1', promptVersion: 'v3', storeSnippets: false });
    expect(e!.original).toBeUndefined();
    expect(e!.replacement).toBeUndefined();
    expect(e!.final).toBeUndefined();
    expect(e!.sentence).toBeUndefined();
    expect(e!.rule).toBe('hedging');
  });

  it('folds into the shadow (and into profile.learning when unpaired) idempotently by eventId; the most specific scope decides', async () => {
    const c = await core(false);
    const mail = Array.from({ length: 8 }, () => input());
    const slack = Array.from({ length: 8 }, () => input({ kind: 'accept', host: 'app.slack.com', ctx: 'chat' }));
    const events = await c.learning.ingest([...mail, ...slack], { deviceId: 'd_1', promptVersion: 'v3', storeSnippets: true });
    const key = statsKey('host', 'mail.google.com', 'hedging');
    expect(c.store.local.get('learningShadow').stats[key]?.dismissed).toBe(8);
    expect(c.store.local.get('learningShadow').stats[statsKey('global', '', 'hedging')]).toMatchObject({ accepted: 8, dismissed: 8 });
    expect(c.profile().learning.stats[key]?.dismissed).toBe(8);
    expect(c.profile().learning.updatedHlc).not.toBe(defaultProfile().learning.updatedHlc);
    expect(c.profile().learning.lastEventCursor).toBe(events[0]!.t);
    await c.learning.foldInto(events); // same ids again
    expect(c.store.local.get('learningShadow').stats[key]?.dismissed).toBe(8);
    const states = c.learned().ruleStates;
    expect(lookupRuleState(states, 'hedging', 'mail.google.com', 'email')?.state).toBe('suppressed');
    expect(lookupRuleState(states, 'hedging', 'app.slack.com', 'chat')?.state).toBe('active');
    expect(lookupRuleState(states, 'hedging', 'other.com', 'other')?.state).toBe('active'); // 8/16 globally
    expect(c.learned().promoted.size).toBe(0);
    expect(c.configFor('mail.google.com').mutedRules).toContain('hedging');
    expect(c.configFor('app.slack.com').mutedRules).not.toContain('hedging');
  });

  it('when paired the shadow is device-local and replaced by profile.learning on poll', async () => {
    const c = await core(true);
    await c.learning.ingest(Array.from({ length: 8 }, () => input()), { deviceId: 'd_1', promptVersion: 'v3', storeSnippets: true });
    const key = statsKey('host', 'mail.google.com', 'hedging');
    expect(c.store.local.get('learningShadow').stats[key]?.dismissed).toBe(8);
    expect(c.profile().learning.stats[key]).toBeUndefined(); // server-authoritative: not written back
    expect(lookupRuleState(c.learned().ruleStates, 'hedging', 'mail.google.com', 'email')?.state).toBe('suppressed');
    await c.learning.replaceShadow({ ...defaultProfile().learning, updatedHlc: '1800000000000-0-server' });
    expect(c.store.local.get('learningShadow').stats[key]).toBeUndefined();
    expect(lookupRuleState(c.learned().ruleStates, 'hedging', 'mail.google.com', 'email')).toBeUndefined();
  });

  it('builds a learning summary over the local buffer', async () => {
    const c = await core();
    await c.learning.ingest([input({ kind: 'shown' }), input({ kind: 'accept' }), input({ kind: 'dismiss' })], { deviceId: 'd_1', promptVersion: 'v3', storeSnippets: true });
    const s = c.learning.summary();
    expect(s.window.days).toBe(28);
    expect(s.overall.shown).toBe(1);
    expect(s.overall.accepted).toBe(1);
    expect(s.overall.dismissed).toBe(1);
    expect(s.byContext.email?.dismissed).toBe(1);
    expect(s.byHost[0]?.host).toBe('mail.google.com');
    expect(s.byRule.some((r) => r.rule === 'hedging' && r.scope === 'global')).toBe(true);
    expect(s.learnedState).toMatchObject({ suppressed: 0, demoted: 0, promoted: 0, manualOff: 0 });
    expect(s.privacy).toMatchObject({ storeSnippets: true, rawEvents: 3 });
  });

  it('infers the dialect from typed voice samples once enough markers agree', async () => {
    const c = await core();
    const sample = (sentence: string) => ({ t: '2026-10-01T00:00:00.000Z', host: 'mail.google.com', ctx: 'email' as const, voiceContext: 'messages' as const, sentence });
    await c.learning.addSamples(Array.from({ length: 3 }, () => sample('We realise the colour of the centre favours our neighbour.')), true);
    expect(c.store.local.get('learningShadow').dialectInferred).toBeUndefined(); // 15 markers: not enough yet
    await c.learning.addSamples(Array.from({ length: 9 }, () => sample('We realise the colour of the centre favours our neighbour.')), true);
    expect(c.store.local.get('sampleBuffer')).toHaveLength(12);
    expect(c.store.local.get('learningShadow').dialectInferred).toBe('en-GB');
    expect(c.profile().learning.dialectInferred).toBe('en-GB');
    expect(c.learning.summary().learnedState.dialectInferred).toBe('en-GB');
  });
});

describe('shared learner (deterministic rules, as the worker calls it)', () => {
  const NOW = '2026-10-02T00:00:00.000Z';
  const ev = (kind: FeedbackEvent['kind'], rule = 'hedging', host = 'h.com'): FeedbackEvent =>
    ({ ...input({ kind, rule, host }), v: 1, eventId: `${kind}-${rule}-${Math.random()}`, t: '2026-10-01T00:00:00.000Z', deviceId: 'd', promptVersion: 'v3', profileStrength: 2, goals: defaultProfile().settings.goals.value, dialect: 'en-US' }) as FeedbackEvent;
  const many = (n: number, kind: FeedbackEvent['kind'], rule?: string, host?: string): FeedbackEvent[] => Array.from({ length: n }, () => ev(kind, rule, host));

  it('wilson thresholds match the research worked examples', () => {
    expect(wilson(0, 8).ub).toBeCloseTo(0.324, 2);
    expect(wilson(1, 13).ub).toBeCloseTo(0.333, 2);
    expect(wilson(16, 16).lb).toBeCloseTo(0.806, 2);
    expect(wilson(19, 20).lb).toBeLessThan(LEARNER_CONSTANTS.LB_PROMOTE);
  });

  it('suppresses at 0/8 dismissals in the most specific scope and promotes 16/16 correctness globally', () => {
    const fold = foldEvents({}, [...many(8, 'dismiss'), ...many(16, 'accept', 'repeated_word')], { now: NOW });
    expect(fold.folded).toBe(24);
    const { ruleStates } = resolveLearning(fold.stats, {}, NOW);
    expect(ruleStates[statsKey('host', 'h.com', 'hedging')]).toMatchObject({ state: 'suppressed', scope: 'host', scopeKey: 'h.com', eligibleForBulk: false });
    expect(lookupRuleState(ruleStates, 'hedging', 'h.com', 'email')?.state).toBe('suppressed');
    expect(ruleStates[statsKey('global', '', 'repeated_word')]).toMatchObject({ state: 'active', eligibleForBulk: true });
    expect(promotedRules(fold.stats)).toEqual(new Set(['repeated_word']));
  });

  it('applyLearnedState hides suppressed rules in scope, keeps high-confidence correctness errors (a manual mute still hides them) and promotes Tier B to A', () => {
    const s = (over: Partial<Suggestion>): Suggestion => ({
      id: 'x', category: 'delivery', rule: 'hedging', severity: 'suggestion', kind: 'delete', source: 'llm', tier: 'B', anchor: 'exact', range: { start: 0, end: 1 }, highlight: { start: 0, end: 1 }, original: 'a', replacement: '', alternatives: [], title: 't', explanation: '', confidence: 0.75, meaningPreserving: true, autoApplySafe: true, blockId: 'b0', blockHash: 'h', conflictsWith: [], stale: false, promptVersion: 'v3', fingerprint: 'fp', learnedState: 'active', ...over,
    });
    const ruleStates = {
      [statsKey('host', 'h.com', 'hedging')]: { state: 'suppressed' as const, eligibleForBulk: false, scope: 'host' as const, scopeKey: 'h.com', since: '', reprobeStage: 0 },
      [statsKey('global', '', 'spelling')]: { state: 'suppressed' as const, eligibleForBulk: false, scope: 'global' as const, scopeKey: '', since: '', reprobeStage: 0 },
    };
    const base = { ruleStates, promoted: new Set(['article']), manualOff: [], host: 'h.com', ctx: 'other' as const, mutedRules: [] as string[] };
    const high = s({ id: 'y', rule: 'spelling', category: 'correctness', severity: 'error', confidence: 0.95, tier: 'A' });
    const out = applyLearnedState(
      [s({}), high, s({ id: 'low', rule: 'spelling', category: 'correctness', severity: 'error', confidence: 0.8 }), s({ id: 'z', rule: 'article', category: 'correctness', severity: 'error', confidence: 0.75 })],
      base,
    );
    expect(out.visible.map((x) => [x.id, x.tier])).toEqual([['y', 'A'], ['z', 'A']]);
    expect(out.hidden).toEqual([{ id: 'x', reason: 'suppressed' }, { id: 'low', reason: 'suppressed' }]);
    const elsewhere = applyLearnedState([s({})], { ...base, host: 'other.com' });
    expect(elsewhere.visible).toHaveLength(1);
    const muted = applyLearnedState([high], { ...base, mutedRules: [encodeMute('spelling', 'h.com')] });
    expect(muted.hidden).toEqual([{ id: 'y', reason: 'manual' }]);
  });

  it('dictionaryCandidates follows the dismissal thresholds (a document is a field)', () => {
    const events = [
      ...many(3, 'dismiss', 'spelling').map((e) => ({ ...e, original: 'jammarly' })),
      ...[ev('dismiss', 'spelling'), ev('dismiss', 'spelling')].map((e, i) => ({ ...e, original: 'Okafor', fieldId: `f${i}` })),
      { ...ev('dismiss', 'spelling'), original: 'once' },
    ];
    expect(dictionaryCandidates(events, ['okafor'])).toEqual(['jammarly']);
    expect(dictionaryCandidates(events, [])).toEqual(['jammarly', 'Okafor']);
  });

  it('manual overrides live in rules.muted: encodeMute entries resolve per host and feed the learner as ManualOff', () => {
    const entries = [encodeMute('hedging'), encodeMute('cliche', 'Mail.Google.com'), encodeMute('passive_voice', 'other.com')];
    expect(entries).toEqual(['hedging', 'cliche@mail.google.com', 'passive_voice@other.com']);
    expect(mutedRulesForHost(entries, 'mail.google.com')).toEqual(['cliche', 'hedging']);
    expect(mutedRulesForHost(entries, 'sub.other.com')).toEqual(['hedging', 'passive_voice']);
    expect(manualOffFromMuted(entries)).toEqual([
      { scope: 'global', rule: 'hedging' },
      { scope: 'host', scopeKey: 'mail.google.com', rule: 'cliche' },
      { scope: 'host', scopeKey: 'other.com', rule: 'passive_voice' },
    ]);
    expect(categoriesFrom([ev('shown', 'custom_rule'), ev('shown', 'custom_rule')])).toEqual({ custom_rule: 'delivery' });
    expect(LEARNER_CONSTANTS.CORE_CORRECTNESS.has('spelling')).toBe(true);
    expect(LEARNER_CONSTANTS.CORE_CORRECTNESS.has('hedging')).toBe(false);
  });
});
