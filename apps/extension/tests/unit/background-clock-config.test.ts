import { describe, expect, it } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS } from '@jammarly/shared/types';
import type { DeviceSettings } from '@jammarly/shared/types';
import type { ProfileDocument } from '@jammarly/shared/profile';
import { defaultProfile } from '@jammarly/shared/profile';
import { compareHlc, parseHlc } from '@jammarly/shared/hlc';
import { createDeviceClock, collectHlcs } from '../../src/background/clock';
import { computeEffectiveConfig, ensureUserSaltOp, modelsFor, mutedRulesFor } from '../../src/background/config';
import type { LearnedStateView } from '../../src/background/shared-engine';

const NO_LEARNED: LearnedStateView = { ruleStates: {}, promoted: [], manualOff: [] };
const SESSION_OFF = { hosts: [], fields: [] };

function profileWith(mut: (p: ProfileDocument) => void): ProfileDocument {
  const p = defaultProfile();
  p.settings.privacy.value.consentAt = '2026-01-01T00:00:00.000Z';
  p.settings.userSalt.value = 'ab'.repeat(32);
  mut(p);
  return p;
}

function config(host: string, settings: Partial<DeviceSettings> = {}, profile: ProfileDocument = profileWith(() => undefined), learned: LearnedStateView = NO_LEARNED, extra: Partial<Parameters<typeof computeEffectiveConfig>[0]> = {}) {
  return computeEffectiveConfig({ host, settings: { ...DEFAULT_DEVICE_SETTINGS, apiKey: 'sk-test', ...settings }, profile, learned, sessionOff: SESSION_OFF, runtimeId: 'ext-id', ...extra });
}

describe('device clock', () => {
  it('stamps empty hlcs with strictly increasing clocks and leaves valid ones alone', () => {
    let t = 1_700_000_000_000;
    const clock = createDeviceClock('d_test', undefined, undefined, { now: () => t });
    const ops = clock.stampOps([
      { op: 'add', path: 'dictionary', value: 'a', hlc: '' },
      { op: 'add', path: 'dictionary', value: 'b', hlc: '' },
      { op: 'add', path: 'dictionary', value: 'c', hlc: '1600000000000-0-other' },
    ]);
    expect(parseHlc(ops[0]!.hlc)?.deviceId).toBe('d_test');
    expect(compareHlc(ops[1]!.hlc, ops[0]!.hlc)).toBe(1);
    expect(ops[2]!.hlc).toBe('1600000000000-0-other');
    t += 5;
    expect(compareHlc(clock.next(), ops[1]!.hlc)).toBe(1);
  });

  it('seeds from the persisted clock and from every HLC in the profile', () => {
    const profile = defaultProfile();
    profile.settings.goals.hlc = '1700000000000-7-remote';
    profile.dictionary.push({ value: 'x', addedHlc: '1700000000005-2-remote', removedHlc: '1700000000006-0-remote' });
    expect(collectHlcs(profile)).toContain('1700000000006-0-remote');
    const clock = createDeviceClock('d_me', '1700000000003-3-d_me', profile, { now: () => 1_700_000_000_000 });
    const next = clock.next();
    // Must be greater than the remote clock seen in the profile (same wall, higher counter).
    expect(compareHlc(next, '1700000000006-0-remote')).toBe(1);
    expect(parseHlc(next)?.wallMs).toBe(1700000000006);
    // Clocks more than a day ahead of the local wall clock are ignored (one broken device cannot drag the rest).
    const drifted = createDeviceClock('d_me', '1900000000000-0-d_me', undefined, { now: () => 1_700_000_000_000 });
    expect(parseHlc(drifted.next())?.wallMs).toBe(1700000000000);
  });

  it('persists through onIssue', () => {
    const issued: string[] = [];
    const clock = createDeviceClock('d_me', undefined, undefined, { onIssue: (h) => issued.push(h) });
    clock.next();
    clock.next();
    expect(issued).toHaveLength(2);
    expect(clock.last()).toBe(issued[1]);
  });
});

describe('computeEffectiveConfig', () => {
  it('maps hosts to contexts and honours site overrides', () => {
    expect(config('mail.google.com').context).toBe('email');
    expect(config('app.slack.com').context).toBe('chat');
    expect(config('github.com').context).toBe('code');
    expect(config('unknown.example').context).toBe('other');
    const p = profileWith((d) => {
      d.sites.overrides['unknown.example'] = { value: { context: 'doc' }, hlc: '1700000000000-0-x' };
    });
    expect(config('unknown.example', {}, p).context).toBe('doc');
  });

  it('disables a host listed in sites.disabled (live elements only) or turned off for the session', () => {
    const p = profileWith((d) => {
      d.sites.disabled.push({ value: 'x.com', addedHlc: '1700000000001-0-a' });
      d.sites.disabled.push({ value: 'y.com', addedHlc: '1700000000001-0-a', removedHlc: '1700000000002-0-a' }); // tombstoned
    });
    expect(config('x.com', {}, p).enabledOnHost).toBe(false);
    expect(config('y.com', {}, p).enabledOnHost).toBe(true);
    expect(config('x.com', { enabled: false }, p).enabled).toBe(false);
    const off = computeEffectiveConfig({ host: 'z.com', settings: { ...DEFAULT_DEVICE_SETTINGS, apiKey: 'k' }, profile: p, learned: NO_LEARNED, sessionOff: { hosts: ['z.com'], fields: [] }, runtimeId: 'id' });
    expect(off.enabledOnHost).toBe(false);
    expect(off.enabled).toBe(true);
  });

  it('resolves muted rules: global, host-scoped and learner-suppressed in scope', () => {
    const p = profileWith((d) => {
      d.rules.muted.push({ value: 'hedging', addedHlc: '1700000000001-0-a' });
      d.rules.muted.push({ value: 'cliche@app.slack.com', addedHlc: '1700000000001-0-a' });
      d.rules.muted.push({ value: 'passive_voice', addedHlc: '1700000000001-0-a', removedHlc: '1700000000005-0-a' });
    });
    const learned: LearnedStateView = {
      ruleStates: {
        wordy_phrase: { state: 'suppressed', eligibleForBulk: false, scope: 'ctx', scopeKey: 'chat', since: '', reprobeStage: 0 },
        intensifier: { state: 'suppressed', eligibleForBulk: false, scope: 'host', scopeKey: 'mail.google.com', since: '', reprobeStage: 0 },
        redundancy: { state: 'demoted', eligibleForBulk: false, scope: 'global', scopeKey: '', since: '', reprobeStage: 0 },
      },
      promoted: [],
      manualOff: [],
    };
    const slack = config('app.slack.com', {}, p, learned);
    expect(slack.mutedRules).toEqual(['cliche', 'hedging', 'wordy_phrase']);
    expect(slack.demotedRules).toEqual(['redundancy']);
    const gmail = config('mail.google.com', {}, p, learned);
    expect(gmail.mutedRules).toEqual(['hedging', 'intensifier']);
    expect(mutedRulesFor('other.com', 'other', p, learned)).toEqual(['hedging']);
  });

  it('exposes only live dictionary values (tombstones excluded)', () => {
    const p = profileWith((d) => {
      d.dictionary.push({ value: 'jammarly', addedHlc: '1700000000001-0-a' });
      d.dictionary.push({ value: 'gone', addedHlc: '1700000000001-0-a', removedHlc: '1700000000002-0-a' });
      d.dictionary.push({ value: 'readded', addedHlc: '1700000000009-0-a', removedHlc: '1700000000002-0-a' });
    });
    expect(config('x.com', {}, p).dictionary).toEqual(['jammarly', 'readded']);
  });

  it('turns snippet storage off on private hosts and when learning is disabled', () => {
    const p = profileWith((d) => {
      d.settings.privateSites.value = ['bank.example'];
    });
    expect(config('mail.google.com', {}, p).storeSnippets).toBe(true);
    expect(config('secure.bank.example', {}, p).storeSnippets).toBe(false);
    const off = profileWith((d) => {
      d.settings.privacy.value.learningEnabled = false;
    });
    expect(config('mail.google.com', {}, off).storeSnippets).toBe(false);
  });

  it('computes consented / engineReady / budgetExhausted', () => {
    const unconsented = defaultProfile();
    expect(config('a.com', { provider: 'anthropic' }, unconsented).consented).toBe(false);
    expect(config('a.com', { provider: 'mock' }, unconsented).consented).toBe(true);
    expect(config('a.com', { apiKey: '' }).engineReady).toBe(false);
    expect(config('a.com', { apiKey: '', provider: 'mock' }).engineReady).toBe(true);
    const day = new Date(2026, 9, 21, 12).getTime();
    const usage = { days: { '2026-10-21': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2.5, requests: 3 } }, months: {} };
    expect(config('a.com', { dailyBudgetUsd: 2 }, undefined, undefined, { usage, now: day }).budgetExhausted).toBe(true);
    expect(config('a.com', { dailyBudgetUsd: 0 }, undefined, undefined, { usage, now: day }).budgetExhausted).toBe(false);
  });

  it('merges site goals over global goals and ANDs category overrides', () => {
    const p = profileWith((d) => {
      d.settings.goals.value = { audience: 'expert', formality: 'formal', domain: 'business', intent: 'convince' };
      d.sites.overrides['app.slack.com'] = { value: { goals: { formality: 'informal' }, categories: { delivery: false } }, hlc: '1700000000000-0-x' };
    });
    const c = config('app.slack.com', {}, p);
    expect(c.goals).toEqual({ audience: 'expert', formality: 'informal', domain: 'business', intent: 'convince' });
    expect(c.categories).toEqual({ correctness: true, clarity: true, engagement: true, delivery: false });
  });

  it('derives pass idle times from debounceMs and passes through display flags', () => {
    const c = config('a.com', { debounceMs: 700, showUnderlines: false, colorblindMode: true, gdocsInline: 'off' });
    expect(c.fastPassIdleMs).toBe(700);
    expect(c.deepPassIdleMs).toBe(2500);
    expect(config('a.com', { debounceMs: 1000 }).deepPassIdleMs).toBe(3500);
    expect(c.showUnderlines).toBe(false);
    expect(c.colorblindMode).toBe(true);
    expect(c.gdocsInline).toBe('off');
    expect(c.gdocsAnnounceId).toBe('ext-id');
    expect(c.shortcutSafeMode).toBe(false);
    expect(c.userSalt).toBe('ab'.repeat(32));
  });

  it('ensureUserSaltOp generates a 64-hex salt op only when the salt is empty', () => {
    const op = ensureUserSaltOp(defaultProfile());
    expect(op).toMatchObject({ op: 'set', path: 'settings.userSalt', hlc: '' });
    expect(String((op as { value: string }).value)).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureUserSaltOp(profileWith(() => undefined))).toBeNull();
  });

  it('routes models per mode and downgrades the deep pass when the budget is exhausted', () => {
    const base = { ...DEFAULT_DEVICE_SETTINGS, model: 'claude-opus-5-5', fastModel: 'claude-haiku-5-5' };
    const p = defaultProfile();
    expect(modelsFor({ ...base, mode: 'hybrid' }, p, false)).toMatchObject({ fast: 'claude-haiku-5-5', deep: 'claude-opus-5-5' });
    expect(modelsFor({ ...base, mode: 'quality' }, p, false)).toMatchObject({ fast: 'claude-opus-5-5', deep: 'claude-opus-5-5' });
    expect(modelsFor({ ...base, mode: 'economy' }, p, false)).toMatchObject({ fast: 'claude-haiku-5-5', deep: 'claude-haiku-5-5' });
    expect(modelsFor({ ...base, mode: 'hybrid' }, p, true).deep).toBe('claude-haiku-5-5');
    // Paired: the profile's engine settings win.
    p.settings.mode.value = 'economy';
    expect(modelsFor({ ...base, mode: 'quality', pairing: { appOrigin: 'https://a', deviceId: 'd', token: 't', pairedAt: '' } }, p, false).deep).toBe('claude-haiku-5-5');
  });
});
