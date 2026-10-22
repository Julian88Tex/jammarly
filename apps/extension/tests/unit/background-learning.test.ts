import { afterEach, describe, expect, it } from 'vitest';
import type { FeedbackEvent, FeedbackEventInput } from '@jammarly/shared/learning';
import { defaultProfile } from '@jammarly/shared/profile';
import type { Suggestion } from '@jammarly/shared/types';
import { createCore, type Core } from '../../src/background/core';
import { applyLearnedState, dictionaryCandidates, foldEvents, resolveRuleStates, wilson, LEARNER_CONSTANTS, statsKey } from '../../src/background/shared-engine';
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

  it('folds into the shadow (and into profile.learning when unpaired) idempotently by eventId', async () => {
    const c = await core(false);
    const events = await c.learning.ingest(Array.from({ length: 8 }, () => input()), { deviceId: 'd_1', promptVersion: 'v3', storeSnippets: true });
    const key = statsKey('host', 'mail.google.com', 'hedging');
    expect(c.store.local.get('learningShadow').stats[key]?.dismissed).toBe(8);
    expect(c.profile().learning.stats[key]?.dismissed).toBe(8);
    expect(c.profile().learning.updatedHlc).not.toBe(defaultProfile().learning.updatedHlc);
    await c.learning.foldInto(events); // same ids again
    expect(c.store.local.get('learningShadow').stats[key]?.dismissed).toBe(8);
    expect(c.learned().ruleStates.hedging?.state).toBe('suppressed');
    expect(c.configFor('mail.google.com').mutedRules).toContain('hedging');
    expect(c.configFor('app.slack.com').mutedRules).not.toContain('hedging');
  });

  it('when paired the shadow is device-local and replaced by profile.learning on poll', async () => {
    const c = await core(true);
    await c.learning.ingest(Array.from({ length: 8 }, () => input()), { deviceId: 'd_1', promptVersion: 'v3', storeSnippets: true });
    const key = statsKey('host', 'mail.google.com', 'hedging');
    expect(c.store.local.get('learningShadow').stats[key]?.dismissed).toBe(8);
    expect(c.profile().learning.stats[key]).toBeUndefined(); // server-authoritative: not written back
    await c.learning.replaceShadow({ ...defaultProfile().learning, updatedHlc: '1800000000000-0-server' });
    expect(c.store.local.get('learningShadow').stats[key]).toBeUndefined();
    expect(c.learned().ruleStates.hedging).toBeUndefined();
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
    expect(s.privacy.rawEvents).toBe(3);
  });
});

describe('learner fallback (deterministic rules)', () => {
  const base = defaultProfile().learning;
  const ev = (kind: FeedbackEvent['kind'], rule = 'hedging', host = 'h.com'): FeedbackEvent =>
    ({ ...input({ kind, rule, host }), v: 1, eventId: `${kind}-${Math.random()}`, t: '2026-10-01T00:00:00.000Z', deviceId: 'd', promptVersion: 'v3', profileStrength: 2, goals: defaultProfile().settings.goals.value, dialect: 'en-US' }) as FeedbackEvent;

  it('wilson thresholds match the research worked examples', () => {
    expect(wilson(0, 8).ub).toBeCloseTo(0.324, 2);
    expect(wilson(1, 13).ub).toBeCloseTo(0.333, 2);
    expect(wilson(16, 16).lb).toBeCloseTo(0.806, 2);
    expect(wilson(19, 20).lb).toBeLessThan(LEARNER_CONSTANTS.LB_PROMOTE);
  });

  it('suppresses at 0/8 dismissals in the most specific scope, never core correctness, and promotes 16/16 correctness globally', () => {
    let learning = foldEvents(base, Array.from({ length: 8 }, () => ev('dismiss')));
    let states = resolveRuleStates(learning, () => 'delivery');
    expect(states.hedging).toMatchObject({ state: 'suppressed', scope: 'host', scopeKey: 'h.com', eligibleForBulk: false });

    learning = foldEvents(base, Array.from({ length: 8 }, () => ev('dismiss', 'spelling')));
    states = resolveRuleStates(learning, () => 'correctness');
    expect(states.spelling?.state).toBe('demoted');

    learning = foldEvents(base, Array.from({ length: 16 }, () => ev('accept', 'repeated_word')));
    states = resolveRuleStates(learning, () => 'correctness');
    expect(states.repeated_word).toMatchObject({ state: 'active', eligibleForBulk: true });
  });

  it('applyLearnedState hides suppressed in scope, keeps high-confidence correctness errors, and promotes tier', () => {
    const s = (over: Partial<Suggestion>): Suggestion => ({
      id: 'x', category: 'delivery', rule: 'hedging', severity: 'suggestion', kind: 'delete', source: 'llm', tier: 'B', anchor: 'exact', range: { start: 0, end: 1 }, highlight: { start: 0, end: 1 }, original: 'a', replacement: '', alternatives: [], title: 't', explanation: '', confidence: 0.75, meaningPreserving: true, autoApplySafe: true, blockId: 'b0', blockHash: 'h', conflictsWith: [], stale: false, promptVersion: 'v3', fingerprint: 'fp', learnedState: 'active', ...over,
    });
    const ruleStates = {
      hedging: { state: 'suppressed' as const, eligibleForBulk: false, scope: 'host' as const, scopeKey: 'h.com', since: '', reprobeStage: 0 },
      spelling: { state: 'suppressed' as const, eligibleForBulk: false, scope: 'global' as const, scopeKey: '', since: '', reprobeStage: 0 },
    };
    const out = applyLearnedState(
      [s({}), s({ id: 'y', rule: 'spelling', category: 'correctness', severity: 'error', confidence: 0.95 }), s({ id: 'z', rule: 'article', category: 'correctness', severity: 'error', confidence: 0.75, tier: 'B' })],
      { ruleStates, promoted: ['article'], manualOff: [], host: 'h.com', ctx: 'other' },
    );
    expect(out.map((x) => x.id)).toEqual(['y', 'z']);
    expect(out[1]!.tier).toBe('A');
    const elsewhere = applyLearnedState([s({})], { ruleStates, promoted: [], manualOff: [], host: 'other.com', ctx: 'other' });
    expect(elsewhere).toHaveLength(1);
  });

  it('dictionaryCandidates follows the dismissal thresholds', () => {
    const events = [
      ...Array.from({ length: 3 }, () => ev('dismiss', 'spelling')).map((e) => ({ ...e, original: 'jammarly' })),
      ...[ev('dismiss', 'spelling'), ev('dismiss', 'spelling')].map((e, i) => ({ ...e, original: 'Okafor', docKey: `d${i}` })),
      { ...ev('dismiss', 'spelling'), original: 'once' },
    ];
    expect(dictionaryCandidates(events, ['okafor'])).toEqual(['jammarly']);
    expect(dictionaryCandidates(events)).toEqual(['jammarly', 'okafor']);
  });
});
