import { describe, expect, it } from 'vitest';
import type { CheckRequest, CheckResult, DeviceSettings, EffectiveConfig, EngineOutput, TokenUsage } from '@jammarly/shared/types';
import { DEFAULT_DEVICE_SETTINGS } from '@jammarly/shared/types';
import type { LearnedRuleState, ProfileDocument } from '@jammarly/shared/profile';
import { defaultProfile } from '@jammarly/shared/profile';
import { applyEdits, splitParagraphs } from '@jammarly/shared/text';
import { createEngine, computeCacheKey, shardBlocks, type EngineMessage } from '../../src/background/engine/orchestrator';
import { createBlockCache } from '../../src/background/engine/cache';
import { createMockProvider, requestForBlocks } from '../../src/background/engine/mock';
import type { Provider, ProviderCheckInput, ProviderResult } from '../../src/background/engine/provider';
import { ProviderError, ZERO_USAGE } from '../../src/background/engine/provider';
import { createToneRunner } from '../../src/background/engine/tone';
import { computeEffectiveConfig } from '../../src/background/config';
import { encodeMute, mockCheck, statsKey } from '../../src/background/shared-engine';
import type { LearnedStateView } from '../../src/background/learning/fold';
import type { UsageLedger } from '../../src/background/storage';

const TEXT = 'I just wanted to kind of touch base and see if maybe you could possibly send me the the report when you get a chance.';
const PARA2 = 'We recieve the files tomorrow and I think that is fine.';
/** tests/fixtures/textarea.html as the content script serializes it. */
const TEXTAREA_FIXTURE = 'Their going to the the store tomorow, and i dont think its a good idea.  We was hoping you could of came with us.';

const NO_LEARNED: LearnedStateView = { ruleStates: {}, promoted: new Set() };

function learnedState(state: LearnedRuleState['state'], scope: LearnedRuleState['scope'], scopeKey: string): LearnedRuleState {
  return { state, eligibleForBulk: false, scope, scopeKey, since: '2026-01-01T00:00:00.000Z', reprobeStage: 0 };
}

/** What the shared mock engine answers for one provider call (only the requested blocks are dirty). */
function mockOutputFor(input: ProviderCheckInput): EngineOutput {
  return mockCheck(requestForBlocks(input.request, input.blockIds)).output;
}

function request(text: string, overrides: Partial<CheckRequest> = {}): CheckRequest {
  return {
    fieldId: 'f1',
    version: 1,
    text,
    blocks: splitParagraphs(text),
    dirtyBlockHashes: 'all',
    pass: 'deep',
    host: 'mail.google.com',
    context: 'email',
    fieldKind: 'textarea',
    protectedRanges: [],
    ...overrides,
  };
}

interface Harness {
  engine: ReturnType<typeof createEngine>;
  messages: EngineMessage[];
  results: CheckResult[];
  provider: Provider;
  settings: DeviceSettings;
  profile: ProfileDocument;
  learned: LearnedStateView;
  dismissed: Set<string>;
  applied: Set<string>;
  ledger: UsageLedger;
  check(req: CheckRequest, over?: Partial<{ host: string; docKey: string; settings: DeviceSettings; learned: LearnedStateView }>): Promise<void>;
  configFor(host: string): EffectiveConfig;
}

function harness(opts: { provider?: Provider; settings?: Partial<DeviceSettings>; profile?: ProfileDocument; learned?: LearnedStateView; maxConcurrent?: number; tone?: boolean; keepalive?: { begin(): void; end(): void } } = {}): Harness {
  const settings: DeviceSettings = { ...DEFAULT_DEVICE_SETTINGS, provider: 'mock', ...opts.settings };
  const profile = opts.profile ?? defaultProfile();
  const learned: LearnedStateView = opts.learned ?? NO_LEARNED;
  const messages: EngineMessage[] = [];
  const dismissed = new Set<string>();
  const applied = new Set<string>();
  let ledger: UsageLedger = { days: {}, months: {} };
  const provider = opts.provider ?? createMockProvider({ delayMs: 2 });
  const cache = createBlockCache({ promptVersion: 'v3' });
  const engine = createEngine({
    providerFor: () => provider,
    cache,
    usage: {
      ledger: () => ledger,
      record: (u: TokenUsage) => {
        const day = new Date().toISOString().slice(0, 10);
        const cur = ledger.days[day] ?? { ...ZERO_USAGE, requests: 0 };
        ledger = { ...ledger, days: { ...ledger.days, [day]: { ...cur, costUsd: cur.costUsd + u.costUsd, requests: cur.requests + 1 } } };
      },
    },
    dismissed: () => dismissed,
    applied: () => applied,
    ...(opts.tone ? { tone: createToneRunner() } : {}),
    ...(opts.keepalive ? { keepalive: opts.keepalive } : {}),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    rateLimit: { minWaitMs: 1, maxWaitMs: 20, backoffMs: [5, 10] },
  });
  const configFor = (host: string): EffectiveConfig =>
    computeEffectiveConfig({ host, settings, profile, learned, sessionOff: { hosts: [], fields: [] }, runtimeId: 'id', usage: ledger });
  const h: Harness = {
    engine,
    messages,
    get results() {
      return messages.filter((m): m is Extract<EngineMessage, { type: 'check-result' }> => m.type === 'check-result').map((m) => m.result);
    },
    provider,
    settings,
    profile,
    learned,
    dismissed,
    applied,
    get ledger() {
      return ledger;
    },
    configFor,
    check: (req, over = {}) =>
      engine.check(req, {
        host: over.host ?? req.host,
        docKey: over.docKey ?? 'doc1',
        settings: over.settings ?? settings,
        profile,
        learned: over.learned ?? learned,
        config: computeEffectiveConfig({ host: over.host ?? req.host, settings: over.settings ?? settings, profile, learned: over.learned ?? learned, sessionOff: { hosts: [], fields: [] }, runtimeId: 'id', usage: ledger }),
        send: (m) => messages.push(m),
      }),
  };
  return h;
}

/** A provider wrapping the mock engine that can be scripted to fail. */
function scriptedProvider(script: (call: number, input: ProviderCheckInput) => 'ok' | ProviderError, delayMs = 1): Provider & { calls: ProviderCheckInput[] } {
  const calls: ProviderCheckInput[] = [];
  return {
    kind: 'anthropic',
    calls,
    async check(input, o) {
      calls.push(input);
      await new Promise((r) => setTimeout(r, delayMs));
      if (o.signal?.aborted) throw new ProviderError('cancelled', 'cancelled', true);
      const verdict = script(calls.length, input);
      if (verdict !== 'ok') throw verdict;
      const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 };
      const result: ProviderResult = { output: mockOutputFor(input), usage, model: o.model, stopReason: 'end_turn' };
      return result;
    },
    async tone() {
      return { output: { tone: [], rationale: '' }, usage: { ...ZERO_USAGE }, model: 'x', stopReason: 'end_turn' };
    },
  };
}

describe('orchestrator with the mock provider', () => {
  it('first check (all dirty) calls the provider, anchors >= 3 suggestions including the repeated word, and emits progress', async () => {
    const h = harness();
    await h.check(request(TEXT));
    const stages = h.messages.filter((m) => m.type === 'check-progress').map((m) => (m as { stage: string }).stage);
    expect(stages).toEqual(['queued', 'sent', 'streaming']);
    const result = h.results[0]!;
    expect(result.fromCache).toBe(false);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    const repeated = result.suggestions.find((s) => s.rule === 'repeated_word')!;
    expect(repeated).toBeDefined();
    expect(['the the', 'the ']).toContain(TEXT.slice(repeated.range.start, repeated.range.end));
    expect(result.blocks).toEqual([{ hash: request(TEXT).blocks[0]!.hash, pass: 'deep', model: 'mock', fromCache: false }]);
    expect(result.score?.wordCount).toBe(25);
    expect(result.score!.overall).toBeLessThan(100);
    expect(result.model).toBe('mock');
  });

  it('second identical check is served from cache with no provider call and stable ids', async () => {
    let calls = 0;
    const base = createMockProvider({ delayMs: 1 });
    const counting: Provider = { ...base, check: (i, o) => (calls++, base.check(i, o)) };
    const h = harness({ provider: counting });
    await h.check(request(TEXT));
    await h.check(request(TEXT, { version: 2 }));
    expect(calls).toBe(1);
    const [a, b] = h.results;
    expect(b!.fromCache).toBe(true);
    expect(b!.blocks[0]!.fromCache).toBe(true);
    expect(b!.suggestions.map((s) => s.id)).toEqual(a!.suggestions.map((s) => s.id));
    expect(b!.suggestions.map((s) => s.range)).toEqual(a!.suggestions.map((s) => s.range));
    expect(h.messages.filter((m) => m.type === 'check-progress')).toHaveLength(3); // none for the cached run
  });

  it('a dirty subset only sends the dirty block to the provider and merges the cached rest', async () => {
    const provider = scriptedProvider(() => 'ok');
    const h = harness({ provider });
    const text = `${TEXT}\n${PARA2}`;
    await h.check(request(text));
    expect(provider.calls[0]!.blockIds).toEqual(['b0', 'b1']);
    const changed = `${TEXT}\nWe recieve the files tomorrow, and I think that is fine.`;
    const req = request(changed, { version: 2 });
    req.dirtyBlockHashes = [req.blocks[1]!.hash];
    await h.check(req);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.blockIds).toEqual(['b1']);
    const result = h.results[1]!;
    expect(result.fromCache).toBe(false);
    expect(result.blocks.map((b) => b.fromCache)).toEqual([true, false]);
    // Suggestions from the untouched first paragraph are still present (served from cache).
    expect(result.suggestions.some((s) => s.rule === 'repeated_word')).toBe(true);
    expect(result.suggestions.some((s) => s.rule === 'spelling' && s.original === 'recieve')).toBe(true);
  });

  it('skips a fast pass for blocks that already have a deep entry and never downgrades deep to fast', async () => {
    const provider = scriptedProvider(() => 'ok');
    const h = harness({ provider });
    await h.check(request(TEXT, { pass: 'deep' }));
    await h.check(request(TEXT, { pass: 'fast', version: 2 }));
    expect(provider.calls).toHaveLength(1);
    const fast = h.results[1]!;
    expect(fast.fromCache).toBe(true);
    expect(fast.blocks[0]!.pass).toBe('deep');
    expect(fast.pass).toBe('fast');
  });

  it('a deep pass supersedes a cached fast result', async () => {
    const provider = scriptedProvider(() => 'ok');
    const h = harness({ provider });
    await h.check(request(TEXT, { pass: 'fast' }));
    expect(h.results[0]!.blocks[0]!.pass).toBe('fast');
    await h.check(request(TEXT, { pass: 'deep', version: 2 }));
    expect(provider.calls).toHaveLength(2);
    expect(h.results[1]!.blocks[0]!.pass).toBe('deep');
    expect(h.results[1]!.blocks[0]!.fromCache).toBe(false);
  });

  it('hides learner-suppressed rules in scope, marks demoted ones and keeps the correctness floor', async () => {
    const learned: LearnedStateView = {
      ruleStates: {
        [statsKey('ctx', 'email', 'hedging')]: learnedState('suppressed', 'ctx', 'email'),
        [statsKey('global', '', 'wordy_phrase')]: learnedState('demoted', 'global', ''),
        [statsKey('host', 'other.host', 'tone_rewrite_confident')]: learnedState('suppressed', 'host', 'other.host'),
        // A suppressed correctness rule still shows its high-confidence errors: never learned away (§3.7).
        [statsKey('global', '', 'repeated_word')]: learnedState('suppressed', 'global', ''),
      },
      promoted: new Set(),
    };
    const h = harness({ learned });
    await h.check(request(TEXT));
    const rules = h.results[0]!.suggestions.map((s) => s.rule);
    expect(rules).not.toContain('hedging');
    expect(rules).toContain('tone_rewrite_confident'); // suppression scoped to another host
    expect(rules).toContain('repeated_word'); // correctness floor: an error at confidence 0.98
    expect(h.results[0]!.suggestions.find((s) => s.rule === 'wordy_phrase')!.learnedState).toBe('demoted');
    expect(h.results[0]!.suggestions.find((s) => s.rule === 'repeated_word')!.learnedState).toBe('active');
  });

  it('filters dismissed and applied fingerprints at serve time (the cache keeps them)', async () => {
    const h = harness();
    await h.check(request(TEXT));
    const repeated = h.results[0]!.suggestions.find((s) => s.rule === 'repeated_word')!;
    const wordy = h.results[0]!.suggestions.find((s) => s.rule === 'wordy_phrase')!;
    h.dismissed.add(repeated.fingerprint);
    h.applied.add(wordy.fingerprint);
    await h.check(request(TEXT, { version: 2 }));
    const rules = h.results[1]!.suggestions.map((s) => s.rule);
    expect(rules).not.toContain('repeated_word');
    expect(rules).not.toContain('wordy_phrase');
    expect(h.results[1]!.fromCache).toBe(true);
  });

  it('manually muted rules (rules.muted: global, host-scoped and parent-domain) are removed, even above the correctness floor', async () => {
    const profile = defaultProfile();
    for (const value of [encodeMute('wordy_phrase'), encodeMute('hedging', 'mail.google.com'), encodeMute('tone_rewrite_confident', 'other.com'), encodeMute('repeated_word', 'google.com')]) {
      profile.rules.muted.push({ value, addedHlc: '1700000000000-0-test' });
    }
    const h = harness({ profile });
    await h.check(request(TEXT));
    const rules = h.results[0]!.suggestions.map((s) => s.rule);
    expect(rules).not.toContain('wordy_phrase');
    expect(rules).not.toContain('hedging');
    expect(rules).not.toContain('repeated_word'); // "repeated_word@google.com" covers mail.google.com
    expect(rules).toContain('tone_rewrite_confident'); // muted on another site only
    expect(h.configFor('mail.google.com').mutedRules).toEqual(['hedging', 'repeated_word', 'wordy_phrase']);
  });

  it('retries a truncated 4-block call as two halves and still emits everything', async () => {
    const provider = scriptedProvider((call, input) => (call === 1 && input.blockIds.length === 4 ? new ProviderError('truncated', 'cut', false) : 'ok'));
    const h = harness({ provider });
    const text = [TEXT, PARA2, 'This is teh third paragraph.', 'And definately people write a fourth.'].join('\n');
    await h.check(request(text));
    expect(provider.calls.map((c) => c.blockIds)).toEqual([['b0', 'b1', 'b2', 'b3'], ['b0', 'b1'], ['b2', 'b3']]);
    const result = h.results[0]!;
    expect(result.error).toBeUndefined();
    expect(result.blocks).toHaveLength(4);
    expect(result.suggestions.some((s) => s.original === 'teh')).toBe(true);
    expect(result.suggestions.some((s) => s.original === 'definately')).toBe(true);
    expect(result.usage?.inputTokens).toBe(200);
  });

  it('reports blocks that stay truncated after the split while emitting the others', async () => {
    const provider = scriptedProvider((_call, input) => (input.blockIds.includes('b0') ? new ProviderError('truncated', 'cut', false) : 'ok'));
    const h = harness({ provider });
    await h.check(request(`${TEXT}\n${PARA2}`));
    const result = h.results[0]!;
    expect(result.error).toEqual({ code: 'truncated', retryable: false, message: "Couldn't check one paragraph" });
    expect(result.blocks.map((b) => b.hash)).toEqual([request(PARA2).blocks[0]!.hash]);
    expect(result.suggestions.some((s) => s.original === 'recieve')).toBe(true);
  });

  it('shards needed blocks into calls of at most 4 blocks and ~1,200 words', () => {
    const many = Array.from({ length: 9 }, (_, i) => `Paragraph ${i} is short.`).join('\n');
    const shards = shardBlocks(splitParagraphs(many));
    expect(shards.map((s) => s.length)).toEqual([4, 4, 1]);
    const long = Array.from({ length: 3 }, () => Array(700).fill('word').join(' ')).join('\n');
    expect(shardBlocks(splitParagraphs(long)).map((s) => s.length)).toEqual([1, 1, 1]);
  });

  it('caps concurrent model calls at 3 across fields and queues the rest', async () => {
    let active = 0;
    let peak = 0;
    const slow: Provider = {
      kind: 'anthropic',
      async check(input, o) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return { output: mockOutputFor(input), usage: { ...ZERO_USAGE }, model: o.model, stopReason: 'end_turn' };
      },
      async tone() {
        return { output: {}, usage: { ...ZERO_USAGE }, model: 'x', stopReason: null };
      },
    };
    const h = harness({ provider: slow });
    await Promise.all(Array.from({ length: 6 }, (_, i) => h.check(request(`Paragraph number ${i} has teh typo.`, { fieldId: `f${i}` }))));
    expect(peak).toBe(3);
    expect(h.results).toHaveLength(6);
    expect(h.engine.inFlight).toBe(0);
  });

  it('a newer request for the same field and pass aborts the older one, which never emits', async () => {
    const provider = scriptedProvider(() => 'ok', 20);
    const h = harness({ provider });
    const first = h.check(request(TEXT, { version: 1 }));
    const second = h.check(request(`${TEXT} Extra.`, { version: 2 }));
    await Promise.all([first, second]);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]!.version).toBe(2);
  });

  it('cancel(fieldId) drops the in-flight request silently', async () => {
    const provider = scriptedProvider(() => 'ok', 20);
    const h = harness({ provider });
    const p = h.check(request(TEXT));
    setTimeout(() => h.engine.cancel('f1'), 2);
    await p;
    expect(h.results).toHaveLength(0);
  });

  it('answers consent-required, no-api-key and budget errors without calling the provider', async () => {
    const provider = scriptedProvider(() => 'ok');
    const unconsented = harness({ provider, settings: { provider: 'anthropic', apiKey: 'sk-x' } });
    await unconsented.check(request(TEXT));
    expect(unconsented.results[0]!.error?.code).toBe('consent-required');

    const profile = defaultProfile();
    profile.settings.privacy.value.consentAt = '2026-01-01T00:00:00Z';
    const noKey = harness({ provider, profile, settings: { provider: 'anthropic', apiKey: '' } });
    await noKey.check(request(TEXT));
    expect(noKey.results[0]!.error?.code).toBe('no-api-key');

    const budget = harness({ provider, profile, settings: { provider: 'anthropic', apiKey: 'sk-x', dailyBudgetUsd: 0.000001 } });
    await budget.check(request(TEXT));
    expect(budget.results[0]!.error?.code).toBe('budget');
    expect(provider.calls).toHaveLength(0);
  });

  it('maps a provider failure to the result error and does not cache it', async () => {
    const provider = scriptedProvider(() => new ProviderError('auth', 'bad key', false));
    const h = harness({ provider });
    await h.check(request(TEXT));
    expect(h.results[0]!.error).toEqual({ code: 'auth', message: 'bad key', retryable: false });
    await h.check(request(TEXT, { version: 2 }));
    expect(provider.calls).toHaveLength(2);
  });

  it('retries a rate-limited call after a cooldown and returns its suggestions', async () => {
    const provider = scriptedProvider((n) => (n === 1 ? new ProviderError('rate-limit', 'slow down', true, 15) : 'ok'));
    const h = harness({ provider });
    await h.check(request(TEXT));
    expect(provider.calls).toHaveLength(2);
    expect(h.results[0]!.error).toBeUndefined();
    expect(h.results[0]!.suggestions.length).toBeGreaterThan(0);
  });

  it('gives up after the retries with a retryable rate-limit error and does not cache it', async () => {
    const provider = scriptedProvider(() => new ProviderError('rate-limit', 'slow down', true, 15));
    const h = harness({ provider });
    await h.check(request(TEXT));
    const err = h.results[0]!.error!;
    expect(err.code).toBe('rate-limit');
    expect(err.retryable).toBe(true);
    expect(typeof err.retryAfterMs).toBe('number');
    expect(provider.calls).toHaveLength(3);
    await h.check(request(TEXT, { version: 2 }));
    expect(provider.calls).toHaveLength(6);
  });

  it('answers a rules pass from the local rules engine', async () => {
    const provider = scriptedProvider(() => 'ok');
    const h = harness({ provider });
    await h.check(request(TEXT, { pass: 'rules' }));
    expect(provider.calls).toHaveLength(0);
    const result = h.results[0]!;
    expect(result.pass).toBe('rules');
    expect(result.suggestions.some((s) => s.rule === 'repeated_word' && s.source === 'rules')).toBe(true);
    expect(result.score).toBeDefined();
  });

  it('carries document tone when one call covered every block and emits the separate tone message for long fields', async () => {
    const h = harness({ tone: true });
    const long = `${TEXT} ${PARA2} Please let me know if this works for you, thanks!`;
    await h.check(request(long));
    const result = h.results[0]!;
    expect(result.tone?.labels.length).toBeGreaterThan(0);
    expect(result.tone?.summary).toMatch(/^Sounds /);
    await new Promise((r) => setTimeout(r, 20));
    const tone = h.messages.find((m) => m.type === 'tone') as Extract<EngineMessage, { type: 'tone' }> | undefined;
    expect(tone).toBeDefined();
    expect(tone!.tone.labels.length).toBeGreaterThan(0);
  });

  it('cache key changes with model, goals, dialect and categories but not with the host', () => {
    const profile = defaultProfile();
    const settings = { ...DEFAULT_DEVICE_SETTINGS, provider: 'mock' as const };
    const cfg = (host: string) => computeEffectiveConfig({ host, settings, profile, learned: NO_LEARNED, sessionOff: { hosts: [], fields: [] }, runtimeId: 'id' });
    const a = computeCacheKey({ model: 'm', pass: 'deep', config: cfg('a.com'), profile, context: 'email' });
    expect(computeCacheKey({ model: 'm', pass: 'deep', config: cfg('b.com'), profile, context: 'email' })).toBe(a);
    expect(computeCacheKey({ model: 'other', pass: 'deep', config: cfg('a.com'), profile, context: 'email' })).not.toBe(a);
    expect(computeCacheKey({ model: 'm', pass: 'fast', config: cfg('a.com'), profile, context: 'email' })).not.toBe(a);
    expect(computeCacheKey({ model: 'm', pass: 'deep', config: { ...cfg('a.com'), dialect: 'en-GB' }, profile, context: 'email' })).not.toBe(a);
    expect(computeCacheKey({ model: 'm', pass: 'deep', config: { ...cfg('a.com'), categories: { ...cfg('a.com').categories, delivery: false } }, profile, context: 'email' })).not.toBe(a);
  });

  it('checks the textarea fixture as a deep pass through a fake port context and returns the full mock suggestion set', async () => {
    const h = harness();
    await h.check(request(TEXTAREA_FIXTURE, { fieldKind: 'textarea', context: 'doc', host: 'localhost', dirtyBlockHashes: 'all' }));
    const result = h.results[0]!;
    expect(result.error).toBeUndefined();
    expect(result.model).toBe('mock');
    expect(result.fromCache).toBe(false);
    const pairs = result.suggestions.map((s) => [s.rule, s.original, s.replacement]);
    // Anchoring trims the shared word of "the the" -> "the" into a deletion of the duplicate.
    for (const expected of [
      ['confusable_word', 'Their', "They're"],
      ['repeated_word', 'the ', ''],
      ['spelling', 'tomorow', 'tomorrow'],
      ['capitalization', 'i', 'I'],
      ['apostrophe', 'dont', "don't"],
      ['apostrophe', 'its', "it's"],
      ['subject_verb_agreement', 'was', 'were'],
      ['verb_form', 'of came', 'have come'],
    ]) {
      expect(pairs).toContainEqual(expected);
    }
    for (const s of result.suggestions) expect(TEXTAREA_FIXTURE.slice(s.range.start, s.range.end)).toBe(s.original);
    expect(result.suggestions.every((s) => s.category === 'correctness' && s.tier === 'A' && s.anchor === 'exact')).toBe(true);
    const applied = applyEdits(TEXTAREA_FIXTURE, result.suggestions.map((s) => ({ range: s.range, original: s.original, replacement: s.replacement })));
    expect(applied.skipped).toEqual([]);
    expect(applied.text).toBe("They're going to the store tomorrow, and I don't think it's a good idea.  We were hoping you could have come with us.");
  });

  it('promotes a correctness rule to Tier A at confidence >= 0.70 only when the learner promoted it', async () => {
    const output: EngineOutput = {
      blocks: [
        {
          block_id: 'b0',
          suggestions: [
            { id: 's1', category: 'correctness', rule: 'spelling', severity: 'error', kind: 'replace', original: 'recieve', prefix: 'We', suffix: 'the files', occurrence: 1, replacement: 'receive', alternatives: [], explanation: 'Misspelling.', confidence: 0.75, meaning_preserving: true, auto_apply_safe: true },
          ],
        },
      ],
      document: { tone: [], consistency: [], notes: '' },
    };
    const provider: Provider = {
      kind: 'anthropic',
      async check(_input, o) {
        return { output, usage: { ...ZERO_USAGE }, model: o.model, stopReason: 'end_turn' };
      },
      async tone() {
        return { output: {}, usage: { ...ZERO_USAGE }, model: 'x', stopReason: null };
      },
    };
    const plain = harness({ provider });
    await plain.check(request(PARA2));
    expect(plain.results[0]!.suggestions.map((s) => [s.rule, s.tier])).toEqual([['spelling', 'B']]);
    const promoted = harness({ provider, learned: { ruleStates: {}, promoted: new Set(['spelling']) } });
    await promoted.check(request(PARA2));
    expect(promoted.results[0]!.suggestions.map((s) => [s.rule, s.tier])).toEqual([['spelling', 'A']]);
  });

  it('runs the keepalive only while a model call is in flight', async () => {
    let begins = 0;
    let ends = 0;
    const h = harness({ keepalive: { begin: () => begins++, end: () => ends++ } });
    await h.check(request(TEXT));
    expect(begins).toBe(1);
    expect(ends).toBe(1);
    await h.check(request(TEXT, { version: 2 })); // cached: no call, no keepalive
    expect(begins).toBe(1);
  });
});
