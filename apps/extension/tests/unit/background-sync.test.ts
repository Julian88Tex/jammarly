import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileDocument } from '@jammarly/shared/profile';
import { defaultProfile } from '@jammarly/shared/profile';
import type { FeedbackEvent } from '@jammarly/shared/learning';
import { createCore, type Core } from '../../src/background/core';
import { ALARM_EVENTS, ALARM_SYNC, EVENT_FLUSH_THRESHOLD, MAX_EVENT_UPLOADS_PER_DAY, MAX_PUSHES_PER_DAY } from '../../src/background/sync/client';
import { installChromeMock, type ChromeMock } from './helpers/chrome-mock';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(responder: Responder): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = responder(call);
    const h = new Headers(r.headers ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: h,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: f, calls };
}

function remoteProfile(mut?: (p: ProfileDocument) => void): ProfileDocument {
  const p = defaultProfile();
  p.version = 5;
  p.settings.dialect = { value: 'en-GB', hlc: '1800000000000-0-server' };
  p.dictionary.push({ value: 'serverword', addedHlc: '1800000000000-0-server' });
  p.learning = { ...p.learning, updatedHlc: '1800000000001-0-server', stats: { 'global||hedging': { shown: 20, accepted: 1, dismissed: 15, ignored: 0, reported: 0, lastSeen: '' } } };
  mut?.(p);
  return p;
}

const ORIGIN = 'https://app.test';

describe('sync client (paired only)', () => {
  let mock: ChromeMock;
  afterEach(() => mock.uninstall());

  async function pairedCore(responder: Responder, extra: Record<string, unknown> = {}): Promise<{ core: Core; calls: Call[] }> {
    mock = installChromeMock();
    const local = defaultProfile();
    local.settings.privacy.value.consentAt = '2026-01-01T00:00:00.000Z';
    local.settings.userSalt = { value: 'ab'.repeat(32), hlc: '1900000000000-0-d_local' };
    local.settings.goals = { value: { audience: 'expert', formality: 'formal', domain: 'business', intent: 'convince' }, hlc: '1900000000000-0-d_local' };
    mock.storage.local.data.set('profile', local);
    mock.storage.local.data.set('settings', { provider: 'mock', ...extra });
    const { fetch, calls } = fakeFetch(responder);
    const core = createCore({ chrome: mock.chrome, appOrigin: ORIGIN, fetchImpl: fetch, extVersion: '0.1.0' });
    await core.ready;
    return { core, calls };
  }

  beforeEach(() => undefined);

  it('redeem stores the token, merges the remote profile over local (LWW + OR-set) and schedules alarms', async () => {
    const { core, calls } = await pairedCore((call) => {
      if (call.url.endsWith('/api/devices/pair/redeem')) return { status: 200, body: { deviceId: 'dev-1', token: 'jm1.dev-1.secret', profile: remoteProfile(), etag: '"e1"', version: 5 } };
      return { status: 404, body: { error: { code: 'not_found', message: 'nope' } } };
    });
    const r = await core.sync.redeem('p1', '123456');
    expect(r).toEqual({ deviceId: 'dev-1', appOrigin: ORIGIN });
    expect(calls[0]!.body).toMatchObject({ pairingId: 'p1', code: '123456', device: { extVersion: '0.1.0' } });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    const settings = core.settings();
    expect(settings.pairing).toMatchObject({ deviceId: 'dev-1', token: 'jm1.dev-1.secret', appOrigin: ORIGIN });
    const profile = core.profile();
    expect(profile.settings.dialect.value).toBe('en-GB'); // remote register newer
    expect(profile.settings.goals.value.formality).toBe('formal'); // local register newer
    expect(profile.dictionary.some((d) => d.value === 'serverword')).toBe(true);
    expect(profile.version).toBe(5);
    expect(core.syncState()).toMatchObject({ etag: '"e1"', version: 5, status: 'ok' });
    expect(core.store.local.get('learningShadow').stats['global||hedging']?.dismissed).toBe(15);
    expect(mock.alarms.created.get(ALARM_SYNC)?.periodInMinutes).toBe(15);
    expect(mock.alarms.created.get(ALARM_EVENTS)?.periodInMinutes).toBe(60);
    expect(core.publicSettings().paired).toBe(true);
    expect('token' in core.publicSettings()).toBe(false);
  });

  it('pollVersion: unchanged version does nothing; changed version fetches with If-None-Match (304 / 200 merge)', async () => {
    let version = 5;
    let serve304 = true;
    const { core, calls } = await pairedCore(
      (call) => {
        if (call.url.endsWith('/api/profile/version')) return { status: 200, body: { version, etag: `"e${version}"` } };
        if (call.url.endsWith('/api/profile')) {
          if (serve304) return { status: 304 };
          return { status: 200, body: { profile: remoteProfile((p) => (p.version = version)), etag: `"e${version}"`, version }, headers: { ETag: `"e${version}"` } };
        }
        return { status: 500 };
      },
      { pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' } },
    );
    await core.store.local.set('sync', { ...core.store.local.get('sync'), version: 5, etag: '"e5"' });
    await core.sync.pollVersion();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe('Bearer jm1.dev-1.s');

    version = 6;
    await core.sync.pollVersion();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.headers['if-none-match']).toBe('"e5"');
    expect(core.profile().settings.dialect.value).toBe('en-US'); // 304: nothing merged

    serve304 = false;
    version = 7;
    await core.sync.pollVersion();
    expect(core.profile().settings.dialect.value).toBe('en-GB');
    expect(core.syncState()?.version).toBe(7);
    expect(core.store.local.get('learningShadow').updatedHlc).toBe('1800000000001-0-server');
  });

  it('pushOps: queued ops push 2 s later; a 412 merges current and retries once; acked ops are cleared', async () => {
    let pushes = 0;
    const { core, calls } = await pairedCore(
      (call) => {
        if (call.url.endsWith('/api/profile/ops')) {
          pushes++;
          if (pushes === 1) return { status: 412, body: { error: { code: 'precondition_failed', message: 'stale' }, current: { profile: remoteProfile(), etag: '"e5"', version: 5 } } };
          return { status: 200, body: { profile: remoteProfile((p) => (p.version = 6)), etag: '"e6"', version: 6 } };
        }
        return { status: 500 };
      },
      { pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' } },
    );
    await core.applyProfileOps([{ op: 'add', path: 'dictionary', value: 'localword', hlc: '' }]);
    expect(core.syncState()?.pendingOps).toHaveLength(1);
    await core.sync.flushPush();
    expect(calls.filter((c) => c.url.endsWith('/api/profile/ops'))).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ baseVersion: 5 });
    expect((calls[1]!.body as { ops: unknown[] }).ops).toHaveLength(1);
    expect(core.syncState()?.pendingOps).toHaveLength(0);
    expect(core.syncState()?.version).toBe(6);
    const profile = core.profile();
    expect(profile.dictionary.some((d) => d.value === 'localword')).toBe(true);
    expect(profile.dictionary.some((d) => d.value === 'serverword')).toBe(true);
  });

  it('401 / device_revoked marks the device revoked but keeps working locally', async () => {
    const { core } = await pairedCore(() => ({ status: 401, body: { error: { code: 'device_revoked', message: 'gone' } } }), {
      pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' },
    });
    await core.sync.pollVersion();
    expect(core.syncState()?.status).toBe('revoked');
    await core.applyProfileOps([{ op: 'add', path: 'dictionary', value: 'stillworks', hlc: '' }]);
    expect(core.profile().dictionary.some((d) => d.value === 'stillworks')).toBe(true);
    expect(core.publicSettings().paired).toBe(true);
  });

  it('quota_exceeded pauses sync until the next day; network errors go offline with backoff', async () => {
    const { core, calls } = await pairedCore(() => ({ status: 429, body: { error: { code: 'quota_exceeded', message: 'too many' } } }), {
      pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' },
    });
    await core.sync.pollVersion();
    expect(core.syncState()?.status).toBe('paused');
    expect(core.store.local.get('syncMeta').pausedUntil).not.toBeNull();
    await core.sync.pollVersion();
    expect(calls).toHaveLength(1); // paused: no request

    mock.uninstall();
    const offline = await pairedCore(
      () => {
        throw new TypeError('fetch failed');
      },
      { pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' } },
    );
    await offline.core.sync.pollVersion();
    expect(offline.core.syncState()?.status).toBe('offline');
    expect(offline.core.store.local.get('syncMeta').backoffMs).toBeGreaterThan(0);
  });

  it('caps pushes at 12 per day and keeps queueing beyond the cap', async () => {
    const { core, calls } = await pairedCore((call) => (call.url.endsWith('/api/profile/ops') ? { status: 200, body: { profile: remoteProfile(), etag: '"e"', version: 5 } } : { status: 500 }), {
      pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' },
    });
    for (let i = 0; i < MAX_PUSHES_PER_DAY + 2; i++) {
      await core.applyProfileOps([{ op: 'add', path: 'dictionary', value: `w${i}`, hlc: '' }]);
      await core.sync.flushPush();
    }
    expect(calls.filter((c) => c.url.endsWith('/api/profile/ops'))).toHaveLength(MAX_PUSHES_PER_DAY);
    expect(core.syncState()?.pendingOps).toHaveLength(2);
  });

  it('uploads buffered events (snippets stripped when storage is off), removes them, and caps at 6 batches per day', async () => {
    const { core, calls } = await pairedCore((call) => (call.url.endsWith('/api/events') ? { status: 202, body: { accepted: 1, samplesAccepted: 0 } } : { status: 500 }), {
      pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' },
    });
    const event = (i: number): FeedbackEvent => ({
      v: 1,
      eventId: `e${i}`,
      t: new Date().toISOString(),
      deviceId: 'dev-1',
      promptVersion: 'v3',
      profileStrength: 2,
      goals: defaultProfile().settings.goals.value,
      dialect: 'en-US',
      kind: 'dismiss',
      suggestionId: 's',
      fieldId: 'f',
      docKey: 'd',
      host: 'x.com',
      ctx: 'other',
      rule: 'hedging',
      category: 'delivery',
      severity: 'suggestion',
      confidence: 0.6,
      source: 'llm',
      original: 'secret text',
      sentence: 'the whole sentence',
      spanLen: 6,
      sentenceLen: 18,
    });
    const profile = core.profile();
    await core.store.local.set('profile', { ...profile, settings: { ...profile.settings, privacy: { ...profile.settings.privacy, value: { ...profile.settings.privacy.value, storeSnippets: false } } } });
    await core.store.local.set('eventBuffer', [event(1), event(2)]);
    await core.sync.uploadEvents();
    const upload = calls.find((c) => c.url.endsWith('/api/events'))!;
    const sent = (upload.body as { events: FeedbackEvent[] }).events;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.original).toBeUndefined();
    expect(sent[0]!.sentence).toBeUndefined();
    expect(sent[0]!.rule).toBe('hedging');
    expect(core.store.local.get('eventBuffer')).toHaveLength(0);
    expect(core.syncState()?.eventUploadsToday).toBe(1);

    for (let i = 0; i < MAX_EVENT_UPLOADS_PER_DAY + 2; i++) {
      await core.store.local.set('eventBuffer', [event(100 + i)]);
      await core.sync.uploadEvents();
    }
    expect(calls.filter((c) => c.url.endsWith('/api/events'))).toHaveLength(MAX_EVENT_UPLOADS_PER_DAY);
    expect(core.store.local.get('eventBuffer')).toHaveLength(1);
  });

  it('flushes when the buffer reaches 200 events and unpair drops the token and alarms but keeps the profile', async () => {
    const { core, calls } = await pairedCore((call) => (call.url.endsWith('/api/events') ? { status: 202, body: { accepted: 200, samplesAccepted: 0 } } : { status: 500 }), {
      pairing: { appOrigin: ORIGIN, deviceId: 'dev-1', token: 'jm1.dev-1.s', pairedAt: '' },
    });
    const many = Array.from({ length: EVENT_FLUSH_THRESHOLD }, (_, i) => ({ eventId: `e${i}`, kind: 'shown', rule: 'x', t: new Date().toISOString() }) as unknown as FeedbackEvent);
    await core.store.local.set('eventBuffer', many);
    core.sync.notifyEventsBuffered();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.url.endsWith('/api/events'))).toBe(true);

    await core.sync.unpair();
    expect(core.settings().pairing).toBeNull();
    expect(core.syncState()).toBeNull();
    expect(mock.alarms.created.has(ALARM_SYNC)).toBe(false);
    expect(core.profile().settings.goals.value.formality).toBe('formal');
    expect(core.publicSettings().paired).toBe(false);
  });

  it('is unavailable without a compiled app origin', async () => {
    mock = installChromeMock();
    const core = createCore({ chrome: mock.chrome, appOrigin: '' });
    await core.ready;
    expect(core.sync.available()).toBe(false);
    expect(core.publicSettings().appOrigin).toBeNull();
    await expect(core.sync.redeem('p', 'c')).rejects.toThrow(/not available/);
  });
});
