import { describe, expect, it } from 'vitest';
import type { CheckRequest, CheckResult, DeviceSettings, EffectiveConfig, EngineOutput, TokenUsage } from '@jammarly/shared/types';
import { DEFAULT_DEVICE_SETTINGS } from '@jammarly/shared/types';
import type { LearnedRuleState, ProfileDocument } from '@jammarly/shared/profile';
import { defaultProfile } from '@jammarly/shared/profile';
import { applyEdits, countWords, splitParagraphs } from '@jammarly/shared/text';
import { createEngine, computeCacheKey, MAX_BLOCKS_PER_CALL, shardBlocks, type EngineMessage } from '../../src/background/engine/orchestrator';
import { createBlockCache } from '../../src/background/engine/cache';
import { createMockProvider, requestForBlocks } from '../../src/background/engine/mock';
import type { Provider, ProviderCheckInput, ProviderResult } from '../../src/background/engine/provider';
import { ProviderError, ZERO_USAGE } from '../../src/background/engine/provider';
import { createToneRunner, TONE_MIN_INTERVAL_MS } from '../../src/background/engine/tone';
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

function harness(opts: { provider?: Provider; settings?: Partial<DeviceSettings>; profile?: ProfileDocument; learned?: LearnedStateView; maxConcurrent?: number; tone?: boolean; keepalive?: { begin(): void; end(): void }; owedRetryMs?: number } = {}): Harness {
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
    rateLimit: { minWaitMs: 1, maxWaitMs: 20, backoffMs: [5, 10], owedRetryMs: opts.owedRetryMs ?? 60_000 },
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
    // The paragraphs that came back arrive first without an error (the content script only applies error-free
    // results), then the same result carries the error for the paragraph that failed.
    expect(h.results).toHaveLength(2);
    const [ok, failed] = h.results;
    expect(ok!.error).toBeUndefined();
    expect(ok!.blocks.map((b) => b.hash)).toEqual([request(PARA2).blocks[0]!.hash]);
    expect(ok!.suggestions.some((s) => s.original === 'recieve')).toBe(true);
    expect(failed!.error).toEqual({ code: 'truncated', retryable: false, message: "Couldn't check one paragraph" });
    expect(failed!.suggestions).toEqual(ok!.suggestions);
  });

  it('shards needed blocks into calls of at most 40 blocks and ~1,200 words', () => {
    const many = Array.from({ length: 45 }, (_, i) => `Paragraph ${i} is short.`).join('\n');
    const shards = shardBlocks(splitParagraphs(many));
    expect(shards.map((s) => s.length)).toEqual([40, 5]);
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

  it('carries document tone when one call covered every block, and then makes no separate tone call', async () => {
    const h = harness({ tone: true });
    const long = `${TEXT} ${PARA2} Please let me know if this works for you, thanks!`;
    await h.check(request(long));
    const result = h.results[0]!;
    expect(result.tone?.labels.length).toBeGreaterThan(0);
    expect(result.tone?.summary).toMatch(/^Sounds /);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.messages.some((m) => m.type === 'tone')).toBe(false);
  });

  it('emits the separate tone message when the call covered only part of a long field', async () => {
    const h = harness({ tone: true });
    const text = `${TEXT}\n${PARA2} Please let me know if this works for you, thanks!`;
    const req = request(text);
    req.dirtyBlockHashes = [req.blocks[1]!.hash];
    await h.check(req);
    expect(h.results[0]!.tone).toBeUndefined();
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

// ---------------------------------------------------------------------------------------------------------------
// Request budget for low-tier keys (few requests per minute; short bursts trip the limiter)
// ---------------------------------------------------------------------------------------------------------------

/** A ~216-word, 6-paragraph casual work email (greeting, four body paragraphs, sign-off). */
const EMAIL = [
  'Hi Sam',
  'I just wanted to give you a quick update on the Henderson project. Their was a delay with the vendor so the report wont be ready until next week, I think. The data was reviewed by the analytics team on monday and they said it looks really good overall.',
  'I was wondering if maybe we could move our meeting to thursday? Sorry for the late notice, and sorry again for the delay. In order to finalize the budget we need to make a decision about the staffing plan asap, because the client keeps asking about the timeline.',
  'Also, the new dashboard is really nice and the team did a great job on it. There is alot of good stuff in there and I think the client will like it alot. Let me know if you have any questions about the numbers before we send it over to them on friday.',
  'Finally, could you please double check the invoice amounts? I think there might be a mistake in the second invoice but im not totally sure. If its wrong we should fix it before the end of the month so accounting is happy. We can also talk about it at the meeting if that is easier for you.',
  'Thanks so much, Dana',
].join('\n');

interface CallLog {
  pass: 'fast' | 'deep';
  model: string;
  fieldId: string;
  blockIds: string[];
  start: number;
  end: number;
}

/** The mock engine's answers with a call log, per-call scripting and a tone call that returns real labels. */
function budgetProvider(opts: { delayMs?: number; script?: (call: CallLog, n: number) => 'ok' | ProviderError } = {}): Provider & { calls: CallLog[]; toneCalls: number } {
  const calls: CallLog[] = [];
  const p = {
    kind: 'anthropic' as const,
    calls,
    toneCalls: 0,
    async check(input: ProviderCheckInput, o: { model: string; pass: 'fast' | 'deep'; signal?: AbortSignal }): Promise<ProviderResult> {
      const log: CallLog = { pass: o.pass, model: o.model, fieldId: input.request.fieldId, blockIds: input.blockIds, start: performance.now(), end: Number.POSITIVE_INFINITY };
      calls.push(log);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      log.end = performance.now();
      if (o.signal?.aborted) throw new ProviderError('cancelled', 'cancelled', true);
      const verdict = opts.script?.(log, calls.length) ?? 'ok';
      if (verdict !== 'ok') throw verdict;
      const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 };
      return { output: mockOutputFor(input), usage, model: o.model, stopReason: 'end_turn' };
    },
    async tone(): Promise<ProviderResult> {
      p.toneCalls++;
      return { output: { tone: [{ label: 'friendly', strength: 'moderate' }], rationale: 'Sounds friendly.' }, usage: { ...ZERO_USAGE }, model: 'claude-haiku-5-5', stopReason: 'end_turn' };
    },
  };
  return p;
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The deep pass the content script sends after a fast pass: every block it has not seen at deep rank. */
function deepAfter(req: CheckRequest, version: number, dirty?: string[]): CheckRequest {
  return { ...req, version, pass: 'deep', dirtyBlockHashes: dirty ?? req.blocks.map((b) => b.hash) };
}

describe('request budget for low-tier keys', () => {
  it('the fixture is a ~216-word, 6-paragraph email that the old 4-block cap split into two calls per pass', () => {
    expect(countWords(EMAIL)).toBeGreaterThanOrEqual(200);
    expect(countWords(EMAIL)).toBeLessThanOrEqual(230);
    const paragraphs = splitParagraphs(EMAIL);
    expect(paragraphs).toHaveLength(6);
    // Before: MAX_BLOCKS_PER_CALL = 4 meant 2 calls per pass (+ 1 tone call) = 5 calls per pause.
    expect(shardBlocks(paragraphs, 4)).toHaveLength(2);
    // Now: one call per pass.
    expect(MAX_BLOCKS_PER_CALL).toBeGreaterThanOrEqual(40);
    expect(shardBlocks(paragraphs)).toHaveLength(1);
  });

  it('first pause on the email in hybrid mode: one fast call, one deep call, no tone call, never at the same time', async () => {
    const provider = budgetProvider({ delayMs: 15 });
    const h = harness({ provider, tone: true, settings: { mode: 'hybrid' } });
    // The content script's first check of a field (attach / first pause): fast with every block dirty, then the
    // deep pass after the idle delay. Here the deep request arrives while the fast call is still running.
    const fast = request(EMAIL, { pass: 'fast', version: 1 });
    const pFast = h.check(fast);
    await settle(3);
    const pDeep = h.check(deepAfter(fast, 1));
    await Promise.all([pFast, pDeep]);
    await settle();

    expect(provider.calls.map((c) => [c.pass, c.model, c.blockIds.length])).toEqual([
      ['fast', 'claude-haiku-5-5', 6],
      ['deep', 'claude-sonnet-5-5', 6],
    ]);
    // The deep call started only after the fast call had finished: no burst of two concurrent requests.
    expect(provider.calls[1]!.start).toBeGreaterThanOrEqual(provider.calls[0]!.end);
    // Both calls covered the whole email, so both carried its tone: no separate tone call.
    expect(provider.toneCalls).toBe(0);
    expect(h.results.map((r) => [r.pass, r.error?.code ?? null])).toEqual([
      ['fast', null],
      ['deep', null],
    ]);
    expect(h.results[0]!.tone).toBeDefined();
    expect(h.results[1]!.blocks.every((b) => b.pass === 'deep')).toBe(true);
  });

  it('a later pause after editing one paragraph: one fast call and one deep call on that paragraph, tone throttled', async () => {
    const provider = budgetProvider({ delayMs: 2 });
    const h = harness({ provider, tone: true });
    const first = request(EMAIL, { pass: 'fast', version: 1 });
    await h.check(first);
    await h.check(deepAfter(first, 1));
    await settle();
    const before = provider.calls.length;

    const edited = EMAIL.replace('Also, the new dashboard', 'Also, the shiny new dashboard');
    const req = request(edited, { pass: 'fast', version: 2 });
    const changed = req.blocks[3]!.hash;
    await h.check({ ...req, dirtyBlockHashes: [changed] });
    await h.check(deepAfter(req, 2, [changed]));
    await settle();

    const pause = provider.calls.slice(before);
    expect(pause.map((c) => [c.pass, c.blockIds])).toEqual([
      ['fast', ['b3']],
      ['deep', ['b3']],
    ]);
    // The tone of the whole email was known from the first pause and the text barely changed: no tone call.
    expect(provider.toneCalls).toBe(0);
    const last = h.results[h.results.length - 1]!;
    expect(last.blocks).toHaveLength(6);
    expect(last.blocks.every((b) => b.pass === 'deep')).toBe(true);
  });

  it('a fast pass that arrives while a deep pass for the same text is running waits and is served from it', async () => {
    const provider = budgetProvider({ delayMs: 15 });
    const h = harness({ provider });
    const deep = request(EMAIL, { pass: 'deep', version: 1 });
    const pDeep = h.check(deep);
    await settle(3);
    const pFast = h.check({ ...deep, pass: 'fast' });
    await Promise.all([pDeep, pFast]);
    expect(provider.calls.map((c) => c.pass)).toEqual(['deep']);
    const fast = h.results.find((r) => r.pass === 'fast')!;
    expect(fast.error).toBeUndefined();
    expect(fast.fromCache).toBe(true);
    expect(fast.blocks.every((b) => b.pass === 'deep')).toBe(true);
    expect(fast.suggestions.length).toBeGreaterThan(0);
  });

  it('a 429 on the deep pass keeps the fast pass suggestions in the error result', async () => {
    const provider = budgetProvider({ delayMs: 1, script: (c) => (c.pass === 'deep' ? new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, 5) : 'ok') });
    const h = harness({ provider });
    const fast = request(EMAIL, { pass: 'fast', version: 1 });
    await h.check(fast);
    await h.check(deepAfter(fast, 1));
    const [fastResult, deepResult] = h.results;
    expect(fastResult!.suggestions.length).toBeGreaterThan(0);
    expect(deepResult!.error?.code).toBe('rate-limit');
    expect(deepResult!.error?.retryable).toBe(true);
    // The shared cooldown with two retries is kept: three deep attempts in total.
    expect(provider.calls.filter((c) => c.pass === 'deep')).toHaveLength(3);
    // The error result still carries what the fast pass found (the side panel shows it, the worker keeps it).
    expect(deepResult!.suggestions.map((s) => s.id)).toEqual(fastResult!.suggestions.map((s) => s.id));
    expect(deepResult!.blocks.every((b) => b.pass === 'fast')).toBe(true);
  });

  it('a deep pass that stayed rate limited is run again after the next successful fast pass for the same text', async () => {
    let deepAttempts = 0;
    const provider = budgetProvider({
      delayMs: 1,
      script: (c) => {
        if (c.pass !== 'deep') return 'ok';
        deepAttempts++;
        return deepAttempts <= 3 ? new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, 5) : 'ok';
      },
    });
    const h = harness({ provider });
    const fast = request(EMAIL, { pass: 'fast', version: 1 });
    await h.check(fast);
    await h.check(deepAfter(fast, 1));
    expect(h.results[1]!.error?.code).toBe('rate-limit');
    // The content script re-sends the fast pass later (its own rate-limit retry, or the next idle): served from
    // the cache, and the owed deep pass follows on its own.
    await h.check({ ...fast, version: 2 });
    await settle(60);
    const deepResults = h.results.filter((r) => r.pass === 'deep');
    expect(deepResults.map((r) => r.error?.code ?? null)).toEqual(['rate-limit', null]);
    expect(deepResults[1]!.blocks.every((b) => b.pass === 'deep')).toBe(true);
    expect(provider.calls.filter((c) => c.pass === 'deep')).toHaveLength(4);
    // Paid off: a further fast pass does not start yet another deep pass.
    await h.check({ ...fast, version: 3 });
    await settle(30);
    expect(provider.calls.filter((c) => c.pass === 'deep')).toHaveLength(4);
  });

  it('an owed deep pass also re-runs on its own after the cooldown, once', async () => {
    const provider = budgetProvider({ delayMs: 1, script: (c) => (c.pass === 'deep' ? new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, 5) : 'ok') });
    const h = harness({ provider, owedRetryMs: 10 });
    const fast = request(EMAIL, { pass: 'fast', version: 1 });
    await h.check(fast);
    await h.check(deepAfter(fast, 1));
    await settle(250);
    // The original deep pass and one owed re-run, each with the two cooldown retries: 6 attempts, then it stops.
    expect(provider.calls.filter((c) => c.pass === 'deep')).toHaveLength(6);
    expect(h.results.filter((r) => r.pass === 'deep').every((r) => r.error?.code === 'rate-limit' && r.suggestions.length > 0)).toBe(true);
    await settle(60);
    expect(provider.calls.filter((c) => c.pass === 'deep')).toHaveLength(6);
    // cancel() drops anything still owed.
    h.engine.cancel('f1');
  });

  it('an owed deep pass is dropped once the user has changed the text', async () => {
    const provider = budgetProvider({ delayMs: 1, script: (c) => (c.pass === 'deep' ? new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, 5) : 'ok') });
    const h = harness({ provider, owedRetryMs: 30 });
    const fast = request(EMAIL, { pass: 'fast', version: 1 });
    await h.check(fast);
    await h.check(deepAfter(fast, 1));
    await h.check(request(`${EMAIL} More.`, { pass: 'fast', version: 2 }));
    await settle(120);
    expect(provider.calls.filter((c) => c.pass === 'deep')).toHaveLength(3);
  });

  it('edits while a call is on the wire: the sent call finishes silently, waiting requests collapse into one', async () => {
    const provider = budgetProvider({ delayMs: 20 });
    const h = harness({ provider });
    const p1 = h.check(request(`${EMAIL} One.`, { pass: 'fast', version: 1 }));
    await settle(3);
    const p2 = h.check(request(`${EMAIL} One. Two.`, { pass: 'fast', version: 2 }));
    await settle(1);
    const p3 = h.check(request(`${EMAIL} One. Two. Three.`, { pass: 'fast', version: 3 }));
    await Promise.all([p1, p2, p3]);
    // Version 1 was already sent (not aborted: the request was paid for), version 2 never left the queue.
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.start).toBeGreaterThanOrEqual(provider.calls[0]!.end);
    // Only the newest request reports, and it reuses the blocks version 1 cached: just the edited paragraph.
    expect(h.results.map((r) => r.version)).toEqual([3]);
    expect(provider.calls[1]!.blockIds).toEqual(['b5']);
  });

  it('long fields still shard; a shard that stays rate limited fails alone and the rest is delivered first', async () => {
    const long = Array.from({ length: 3 }, (_, i) => `Paragraph ${i} has teh typo. ${Array(700).fill('word').join(' ')}`).join('\n');
    const provider = budgetProvider({ delayMs: 1, script: (c) => (c.blockIds.includes('b0') ? new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, 5) : 'ok') });
    const h = harness({ provider });
    await h.check(request(long, { pass: 'fast' }));
    expect(h.results).toHaveLength(2);
    const [ok, failed] = h.results;
    expect(ok!.error).toBeUndefined();
    expect(ok!.blocks.map((b) => b.hash)).toEqual(request(long).blocks.slice(1).map((b) => b.hash));
    expect(failed!.error?.code).toBe('rate-limit');
    expect(failed!.suggestions).toEqual(ok!.suggestions);
  });

  it('a pass whose every call is rate limited emits one retryable error (the content script retries it)', async () => {
    const provider = budgetProvider({ delayMs: 1, script: () => new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, 5) });
    const h = harness({ provider });
    await h.check(request(EMAIL, { pass: 'fast' }));
    expect(h.results).toHaveLength(1);
    expect(h.results[0]!.error).toMatchObject({ code: 'rate-limit', retryable: true });
    expect(provider.calls).toHaveLength(3);
  });
});

describe('tone runner budget', () => {
  it('skips the tone call for a remembered text and throttles small edits, but not big changes or old tones', async () => {
    let clock = 1_000_000;
    const runner = createToneRunner({ now: () => clock });
    const provider = budgetProvider();
    const sent: unknown[] = [];
    const run = { provider, model: 'claude-haiku-5-5', send: (t: unknown) => sent.push(t) };
    const req = request(EMAIL, { pass: 'deep' });
    runner.remember(req, { labels: [{ label: 'friendly', strength: 'moderate' }], summary: 'Sounds friendly.' });
    // Same text: cache hit, no call.
    await runner.maybeRun(req, run);
    expect(provider.toneCalls).toBe(0);
    expect(sent).toHaveLength(1);
    // A small edit within the interval: no call.
    await runner.maybeRun(request(`${EMAIL} Cheers.`, { pass: 'deep' }), run);
    expect(provider.toneCalls).toBe(0);
    // A big change: a call.
    await runner.maybeRun(request(`${EMAIL}\n${EMAIL}`, { pass: 'deep' }), run);
    expect(provider.toneCalls).toBe(1);
    // A small edit after the interval: a call.
    clock += TONE_MIN_INTERVAL_MS;
    await runner.maybeRun(request(`${EMAIL}\n${EMAIL} Bye.`, { pass: 'deep' }), run);
    expect(provider.toneCalls).toBe(2);
  });
});
