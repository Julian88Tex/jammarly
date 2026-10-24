import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS } from '@jammarly/shared/types';
import { createChromeMock } from './helpers/chrome-mock';
import { createStore, dismissedFingerprints, normalizeSettings, sweepDismissals, withDismissal, LIMITS } from '../../src/background/storage';
import { createBlockCache } from '../../src/background/engine/cache';
import { recordUsage, budgetState, usageTotals, wouldExceedBudget } from '../../src/background/usage';
import { migrateProfile } from '../../src/background/shared-engine';

const DAY = 24 * 60 * 60 * 1000;

describe('storage: settings and profile normalization', () => {
  it('merges stored settings over the defaults and tolerates unknown keys', () => {
    const s = normalizeSettings({ provider: 'mock', debounceMs: 900, somethingUnknown: 1, dailyBudgetUsd: -5, mode: 'turbo' });
    expect(s.provider).toBe('mock');
    expect(s.debounceMs).toBe(900);
    expect(s.dailyBudgetUsd).toBe(DEFAULT_DEVICE_SETTINGS.dailyBudgetUsd); // negative rejected
    expect(s.mode).toBe('hybrid'); // bad enum rejected
    expect((s as unknown as Record<string, unknown>).somethingUnknown).toBeUndefined();
    expect(s.apiKey).toBe('');
  });

  it('loads defaults when storage is empty and normalizes a partial profile', async () => {
    const mock = createChromeMock();
    mock.storage.local.data.set('profile', { version: 3, settings: { dialect: { value: 'en-GB', hlc: '1700000000000-0000-dev' } } });
    const store = createStore(mock.chrome.storage);
    await store.ready;
    expect(store.local.get('settings')).toEqual(DEFAULT_DEVICE_SETTINGS);
    const profile = store.local.get('profile');
    expect(profile.version).toBe(3);
    expect(profile.settings.dialect.value).toBe('en-GB');
    expect(profile.settings.goals.value.formality).toBe('neutral');
    expect(profile.dictionary).toEqual([]);
    expect(store.local.get('sync').status).toBe('ok');
  });

  it('write-through cache: set/patch update memory first and persist; reads never hit storage', async () => {
    const mock = createChromeMock();
    const store = createStore(mock.chrome.storage);
    await store.ready;
    const p = store.local.patch('settings', { provider: 'mock' });
    expect(store.local.get('settings').provider).toBe('mock'); // before the write completes
    await p;
    expect(mock.storage.local.data.get('settings')).toMatchObject({ provider: 'mock' });
    const writes = mock.storage.local.writes;
    store.local.get('settings');
    store.local.get('profile');
    expect(mock.storage.local.writes).toBe(writes);
  });

  it('picks up changes written by another context through onChanged', async () => {
    const mock = createChromeMock();
    const store = createStore(mock.chrome.storage);
    await store.ready;
    let seen = 0;
    store.local.onChange('settings', () => seen++);
    await mock.chrome.storage.local.set({ settings: { ...DEFAULT_DEVICE_SETTINGS, provider: 'mock', apiKey: 'k' } });
    expect(store.local.get('settings').provider).toBe('mock');
    expect(seen).toBe(1);
  });

  it('calls setAccessLevel(TRUSTED_CONTEXTS) when the API exists and skips it otherwise', async () => {
    const withApi = createChromeMock({ localSetAccessLevel: true });
    const store = createStore(withApi.chrome.storage);
    await store.ready;
    expect(store.localLocked).toBe(true);
    expect(withApi.storage.local.accessLevel).toBe('TRUSTED_CONTEXTS');
    const without = createChromeMock({ localSetAccessLevel: false });
    const store2 = createStore(without.chrome.storage);
    await store2.ready;
    expect(store2.localLocked).toBe(false);
  });

  it('bounds the event buffer at load (oldest first eviction)', async () => {
    const mock = createChromeMock();
    const events = Array.from({ length: LIMITS.EVENT_BUFFER_MAX + 10 }, (_, i) => ({ eventId: `e${i}`, kind: 'shown' }));
    mock.storage.local.data.set('eventBuffer', events);
    const store = createStore(mock.chrome.storage);
    await store.ready;
    const buf = store.local.get('eventBuffer');
    expect(buf.length).toBe(LIMITS.EVENT_BUFFER_MAX);
    expect(buf[0]?.eventId).toBe('e10');
  });
});

describe('storage: dismissal memory', () => {
  it('sweeps entries older than 30 days and drops empty docKeys', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const dismissals = {
      doc1: [
        { fingerprint: 'old', rule: 'spelling', at: new Date(now - 31 * DAY).toISOString() },
        { fingerprint: 'fresh', rule: 'spelling', at: new Date(now - 2 * DAY).toISOString() },
      ],
      doc2: [{ fingerprint: 'ancient', rule: 'x', at: new Date(now - 90 * DAY).toISOString() }],
    };
    const swept = sweepDismissals(dismissals, now);
    expect(swept.doc1?.map((e) => e.fingerprint)).toEqual(['fresh']);
    expect(swept.doc2).toBeUndefined();
    expect([...dismissedFingerprints(dismissals, 'doc1', now)]).toEqual(['fresh']);
  });

  it('withDismissal de-duplicates by fingerprint', () => {
    const d1 = withDismissal({}, 'k', { fingerprint: 'f', rule: 'r', at: '2026-01-01T00:00:00Z' });
    const d2 = withDismissal(d1, 'k', { fingerprint: 'f', rule: 'r', at: '2026-02-01T00:00:00Z' });
    expect(d2.k).toHaveLength(1);
    expect(d2.k?.[0]?.at).toBe('2026-02-01T00:00:00Z');
  });
});

describe('block cache', () => {
  const entry = (pass: 'fast' | 'deep') => ({ pass, model: 'm', suggestions: [], at: 0 });

  it('is bounded (LRU) and evicts the least recently used entry', () => {
    const cache = createBlockCache({ promptVersion: 'v3', max: 3 });
    cache.set('k', 'a', entry('fast'));
    cache.set('k', 'b', entry('fast'));
    cache.set('k', 'c', entry('fast'));
    cache.get('k', 'a'); // touch a: b is now the oldest
    cache.set('k', 'd', entry('fast'));
    expect(cache.size).toBe(3);
    expect(cache.has('k', 'b')).toBe(false);
    expect(cache.has('k', 'a')).toBe(true);
  });

  it('persists to storage.session and reloads, clearing when the prompt version changed', async () => {
    const mock = createChromeMock();
    const store = createStore(mock.chrome.storage);
    await store.ready;
    const cache = createBlockCache({ promptVersion: 'v3', session: store.session, persistDelayMs: 1 });
    cache.set('k', 'a', entry('deep'));
    await cache.flush();
    await store.session.flush();
    expect(mock.storage.session.data.get('blockCache')).toMatchObject({ promptVersion: 'v3' });

    const again = createBlockCache({ promptVersion: 'v3', session: store.session });
    await again.load();
    expect(again.get('k', 'a')?.pass).toBe('deep');

    const newer = createBlockCache({ promptVersion: 'v4', session: store.session });
    await newer.load();
    expect(newer.size).toBe(0);
  });
});

describe('usage ledger', () => {
  it('records per day and month and derives the budget state', () => {
    const now = Date.parse('2026-10-21T12:00:00');
    let ledger = { days: {}, months: {} };
    ledger = recordUsage(ledger, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5 }, now);
    ledger = recordUsage(ledger, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.6 }, now);
    const totals = usageTotals(ledger, now);
    expect(totals.today.requests).toBe(2);
    expect(totals.today.costUsd).toBeCloseTo(2.1);
    expect(totals.month.inputTokens).toBe(101);
    const budget = budgetState({ dailyBudgetUsd: 2 }, ledger, now);
    expect(budget.exhausted).toBe(true);
    expect(wouldExceedBudget(budget, 0.01)).toBe(true);
    expect(budgetState({ dailyBudgetUsd: 0 }, ledger, now).exhausted).toBe(false);
  });
});

describe('migrateProfile', () => {
  it('fills a foreign object into a complete profile document', () => {
    const p = migrateProfile({ dictionary: [{ value: 'jammarly', addedHlc: '1700000000000-0000-d_1' }, { nope: true }], rules: { muted: 'bad' } });
    expect(p.dictionary).toHaveLength(1);
    expect(p.rules.muted).toEqual([]);
    expect(p.settings.privacy.value.consentAt).toBeNull();
    expect(p.learning.ruleStates).toEqual({});
  });
});
