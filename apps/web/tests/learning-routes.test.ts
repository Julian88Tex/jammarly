import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, ExportResponse, LearningDataDeleteResponse, LearningRunResponse, LearningRunStatus, LearningSummaryResponse, ServerKeyStatusResponse } from '@jammarly/shared/api';
import { mockVoiceProfile } from '@jammarly/shared/mock-engine';
import { POST as POST_EVENTS } from '@/app/api/events/route';
import { GET as EXPORT } from '@/app/api/export/route';
import { DELETE as DELETE_DATA } from '@/app/api/learning/data/route';
import { POST as RUN } from '@/app/api/learning/run/route';
import { GET as STATUS } from '@/app/api/learning/status/route';
import { GET as SUMMARY } from '@/app/api/learning/summary/route';
import { POST as POST_OPS } from '@/app/api/profile/ops/route';
import { DELETE as KEY_DELETE, GET as KEY_GET, PUT as KEY_PUT } from '@/app/api/server-key/route';
import type { MemoryBlobStore } from '@/lib/blob';
import { getServerApiKey } from '@/lib/server-key';
import { loadProfile, saveProfile } from '@/lib/store';
import { deviceHeaders, freshStore, hlc, json, loginCookie, makeEvent, makeSample, ownerHeaders, pairDevice, params, req, setupEnv, TEST_UID, P } from './helpers';

let store: MemoryBlobStore;
let cookie: string;

beforeEach(async () => {
  store = freshStore();
  cookie = await loginCookie();
});

async function uploadSome(token: string, n: number): Promise<void> {
  const events = Array.from({ length: n }, (_, i) => makeEvent({ kind: i % 4 === 0 ? 'dismiss' : i % 4 === 1 ? 'shown' : 'accept', rule: i % 2 === 0 ? 'wordy_phrase' : 'spelling', category: i % 2 === 0 ? 'clarity' : 'correctness' }));
  const res = await POST_EVENTS(req('/api/events', { body: { events, samples: [makeSample()] }, headers: deviceHeaders(token) }), params({}));
  expect(res.status).toBe(200);
}

describe('GET /api/learning/summary', () => {
  it('builds a 28-day summary with Wilson intervals for the owner', async () => {
    const device = await pairDevice(cookie);
    await uploadSome(device.token, 16);
    const res = await SUMMARY(req('/api/learning/summary', { headers: { cookie } }), params({}));
    expect(res.status).toBe(200);
    const summary = await json<LearningSummaryResponse>(res);
    expect(summary.window.days).toBe(28);
    expect(summary.overall.shown).toBe(4);
    expect(summary.overall.accepted).toBe(8);
    expect(summary.overall.dismissed).toBe(4);
    expect(summary.overall.acceptance.value).toBeCloseTo(8 / 12, 5);
    expect(summary.overall.acceptance.ciLow).toBeLessThan(summary.overall.acceptance.value);
    expect(summary.overall.acceptance.ciHigh).toBeGreaterThan(summary.overall.acceptance.value);
    expect(summary.byCategory.clarity.accepted + summary.byCategory.correctness.accepted).toBe(8);
    expect(summary.byHost[0]?.host).toBe('mail.google.com');
    expect(summary.privacy.rawEvents).toBe(16);
    expect((await SUMMARY(req('/api/learning/summary'), params({}))).status).toBe(401);
  });
});

describe('GET /api/export and DELETE /api/learning/data', () => {
  it('exports profile, devices, events and samples as one JSON document', async () => {
    const device = await pairDevice(cookie);
    await uploadSome(device.token, 3);
    const res = await EXPORT(req('/api/export', { headers: { cookie } }), params({}));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    const body = await json<ExportResponse>(res);
    expect(body.profile.schemaVersion).toBe(1);
    expect(body.devices.map((d) => d.id)).toEqual([device.deviceId]);
    expect(body.events).toHaveLength(3);
    expect(body.samples).toHaveLength(1);
    expect(Date.parse(body.exportedAt)).toBeGreaterThan(0);
  });

  it('deletes every learning artifact and resets the learning section with a new clock', async () => {
    const device = await pairDevice(cookie);
    await uploadSome(device.token, 3);
    for (let i = 0; i < 10; i += 1) await saveProfile(TEST_UID, (doc) => doc);
    await store.putJson(P.run('2026-10-21', 'messages'), { runId: 'x' });
    await saveProfile(TEST_UID, (doc) => {
      doc.voice.profiles.messages = mockVoiceProfile('messages');
      doc.learning.dictionaryCandidates = ['Bloop'];
      doc.learning.stats['global||x'] = { shown: 1, accepted: 1, dismissed: 0, ignored: 0, reported: 0, lastSeen: '' };
      return doc;
    });
    const before = (await loadProfile(TEST_UID)).profile.learning.updatedHlc;
    const res = await DELETE_DATA(req('/api/learning/data', { method: 'DELETE', headers: ownerHeaders(cookie) }), params({}));
    expect(res.status).toBe(200);
    const body = await json<LearningDataDeleteResponse>(res);
    expect(body.deleted).toMatchObject({ events: 1, samples: 1, snapshots: 1, runs: 1 });
    const { profile } = await loadProfile(TEST_UID);
    expect(profile.learning.stats).toEqual({});
    expect(profile.learning.dictionaryCandidates).toEqual([]);
    expect(profile.learning.lastEventCursor).toBe('');
    expect(profile.learning.updatedHlc).not.toBe(before);
    expect(profile.voice.profiles.messages?.traits).toEqual([]);
    expect(profile.voice.profiles.messages?.version).toBe(4);
    expect(store.paths().filter((p) => p.includes('/events/') && !p.endsWith('index.json'))).toEqual([]);
    expect(store.paths().filter((p) => p.includes('/snapshots/'))).toEqual([]);
    expect(store.paths().filter((p) => p.includes('/runs/'))).toEqual([]);
  });
});

describe('POST /api/learning/run and GET /api/learning/status', () => {
  it('runs the job inline (no request scope), reports status and caps manual runs at 3 per day', async () => {
    expect((await STATUS(req('/api/learning/status', { headers: { cookie } }), params({}))).status).toBe(404);
    const first = await RUN(req('/api/learning/run', { body: { contexts: ['messages'], statsOnly: true }, headers: ownerHeaders(cookie) }), params({}));
    expect(first.status).toBe(202);
    const started = await json<LearningRunResponse>(first);
    expect(started.started).toBe(true);
    expect(started.runId).toMatch(/-messages$/);
    const status = await json<LearningRunStatus>(await STATUS(req('/api/learning/status', { headers: { cookie } }), params({})));
    expect(status.stage).toBe('done');
    expect(status.context).toBe('messages');
    await RUN(req('/api/learning/run', { body: { statsOnly: true }, headers: ownerHeaders(cookie) }), params({}));
    await RUN(req('/api/learning/run', { body: { statsOnly: true }, headers: ownerHeaders(cookie) }), params({}));
    const fourth = await json<LearningRunResponse>(await RUN(req('/api/learning/run', { body: {}, headers: ownerHeaders(cookie) }), params({})));
    expect(fourth).toEqual({ started: false, reason: 'quota' });
    expect((await RUN(req('/api/learning/run', { body: {}, headers: { origin: 'https://jammarly-web.vercel.app' } }), params({}))).status).toBe(401);
  });

  it('owner voice ops through /api/profile/ops replace the stored profile only with a greater version', async () => {
    const v3 = mockVoiceProfile('messages');
    const put = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'voice', context: 'messages', profile: v3, hlc: hlc('web') }] }, headers: ownerHeaders(cookie) }), params({}));
    expect(put.status).toBe(200);
    const older = { ...v3, version: 2, summary: 'older' };
    await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 1, ops: [{ op: 'voice', context: 'messages', profile: older, hlc: hlc('web') }] }, headers: ownerHeaders(cookie) }), params({}));
    expect((await loadProfile(TEST_UID)).profile.voice.profiles.messages?.summary).toBe(v3.summary);
  });
});

describe('server key', () => {
  it('stores the key encrypted, reports only a hint and clears it', async () => {
    const none = await json<ServerKeyStatusResponse>(await KEY_GET(req('/api/server-key', { headers: { cookie } }), params({})));
    expect(none).toEqual({ configured: false, hint: '' });
    const key = 'sk-ant-api03-test-key-0123456789abcdefXYZ';
    const set = await KEY_PUT(req('/api/server-key', { method: 'PUT', body: { apiKey: key }, headers: ownerHeaders(cookie) }), params({}));
    expect(set.status).toBe(200);
    expect(await json<ServerKeyStatusResponse>(set)).toEqual({ configured: true, hint: 'fXYZ' });
    expect(store.raw(P.serverKey)).not.toContain(key);
    expect(await getServerApiKey(TEST_UID)).toEqual({ key, source: 'dashboard' });
    const bad = await KEY_PUT(req('/api/server-key', { method: 'PUT', body: { apiKey: 'has spaces in it which is wrong' }, headers: ownerHeaders(cookie) }), params({}));
    expect(bad.status).toBe(400);
    expect((await json<ApiError>(bad)).error.code).toBe('schema_invalid');
    const cleared = await json<ServerKeyStatusResponse>(await KEY_DELETE(req('/api/server-key', { method: 'DELETE', headers: ownerHeaders(cookie) }), params({})));
    expect(cleared.configured).toBe(false);
  });

  it('falls back to ANTHROPIC_API_KEY from the environment', async () => {
    setupEnv({ ANTHROPIC_API_KEY: 'sk-ant-env-key-0123456789abcdef-ENV1' });
    expect(await getServerApiKey(TEST_UID)).toEqual({ key: 'sk-ant-env-key-0123456789abcdef-ENV1', source: 'env' });
    const status = await json<ServerKeyStatusResponse>(await KEY_GET(req('/api/server-key', { headers: { cookie } }), params({})));
    expect(status).toEqual({ configured: true, hint: 'ENV1' });
  });

  it('cannot be opened with a different SESSION_SECRET', async () => {
    await KEY_PUT(req('/api/server-key', { method: 'PUT', body: { apiKey: 'sk-ant-api03-another-key-0123456789' }, headers: ownerHeaders(cookie) }), params({}));
    setupEnv({ SESSION_SECRET: 'a-completely-different-secret-that-is-long-enough-1234' });
    expect(await getServerApiKey(TEST_UID)).toBeNull();
  });
});
