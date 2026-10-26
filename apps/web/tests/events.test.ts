import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, EventsUploadResponse, PairRedeemResponse } from '@jammarly/shared/api';
import type { FeedbackEvent } from '@jammarly/shared/learning';
import { POST as POST_EVENTS } from '@/app/api/events/route';
import { POST as POST_OPS } from '@/app/api/profile/ops/route';
import type { MemoryBlobStore } from '@/lib/blob';
import { appendBatch, loadIndex, parseJsonl, purgeBefore, readAllSamples, readEventsSince } from '@/lib/events';
import { dayOf } from '@/lib/store';
import { deviceHeaders, freshStore, hlc, json, loginCookie, makeEvent, makeSample, ownerHeaders, pairDevice, params, req, TEST_UID, P } from './helpers';

let store: MemoryBlobStore;
let cookie: string;
let device: PairRedeemResponse;

beforeEach(async () => {
  store = freshStore();
  cookie = await loginCookie();
  device = await pairDevice(cookie);
});

describe('POST /api/events', () => {
  it('validates the batch (shape, size, snippet lengths)', async () => {
    const bad = await POST_EVENTS(req('/api/events', { body: { events: [{ kind: 'accept' }] }, headers: deviceHeaders(device.token) }), params({}));
    expect(bad.status).toBe(400);
    expect((await json<ApiError>(bad)).error.code).toBe('schema_invalid');
    const tooLong = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent({ original: 'x'.repeat(201) })] }, headers: deviceHeaders(device.token) }), params({}));
    expect(tooLong.status).toBe(400);
    const tooMany = await POST_EVENTS(req('/api/events', { body: { events: Array.from({ length: 501 }, () => makeEvent()) }, headers: deviceHeaders(device.token) }), params({}));
    expect(tooMany.status).toBe(400);
    const anon = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent()] } }), params({}));
    expect(anon.status).toBe(401);
  });

  it('appends the batch under today and the device, stamps the device id and updates the index', async () => {
    const events = [makeEvent({ deviceId: 'spoofed' }), makeEvent({ kind: 'dismiss' })];
    const res = await POST_EVENTS(req('/api/events', { body: { events, samples: [makeSample()] }, headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(200);
    expect(await json<EventsUploadResponse>(res)).toEqual({ accepted: 2, samplesAccepted: 1 });
    const day = dayOf(Date.now());
    const stored = parseJsonl<FeedbackEvent>(store.raw(P.eventsBatch(day, device.deviceId)) ?? '');
    expect(stored).toHaveLength(2);
    expect(stored.every((e) => e.deviceId === device.deviceId)).toBe(true);
    expect(stored[0]?.original).toBe('in order to finish on time');
    const { index } = await loadIndex(TEST_UID);
    expect(index.batches).toHaveLength(2);
    expect(index.batches[0]).toMatchObject({ kind: 'events', day, deviceId: device.deviceId, offset: 0, count: 2 });
    expect(index.batches[1]).toMatchObject({ kind: 'samples', count: 1 });

    const second = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent()] }, headers: deviceHeaders(device.token) }), params({}));
    expect(second.status).toBe(200);
    const after = await loadIndex(TEST_UID);
    expect(after.index.batches).toHaveLength(3);
    expect(after.index.batches[2]).toMatchObject({ offset: 2, count: 1 });
    expect(parseJsonl(store.raw(P.eventsBatch(day, device.deviceId)) ?? '')).toHaveLength(3);
    expect(store.ops.lists).toBe(0);
  });

  it('strips snippets and drops samples when storeSnippets is off, whatever the device sent', async () => {
    const privacy = { storeSnippets: false, retentionDays: 90, learningEnabled: true, consentAt: new Date().toISOString() };
    await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'set', path: 'settings.privacy', value: privacy, hlc: hlc('web') }] }, headers: ownerHeaders(cookie) }), params({}));
    const res = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent({ final: 'kept it' })], samples: [makeSample()] }, headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(200);
    expect(await json<EventsUploadResponse>(res)).toEqual({ accepted: 1, samplesAccepted: 0 });
    const stored = parseJsonl<FeedbackEvent>(store.raw(P.eventsBatch(dayOf(Date.now()), device.deviceId)) ?? '');
    expect(stored[0]).not.toHaveProperty('original');
    expect(stored[0]).not.toHaveProperty('replacement');
    expect(stored[0]).not.toHaveProperty('final');
    expect(stored[0]).not.toHaveProperty('sentence');
    expect(stored[0]?.rule).toBe('wordy_phrase');
    expect((await readAllSamples(TEST_UID)).items).toHaveLength(0);
  });

  it('caps uploads at 6 batches per device per day with 429 quota_exceeded', async () => {
    for (let i = 0; i < 6; i += 1) {
      const r = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent()] }, headers: deviceHeaders(device.token) }), params({}));
      expect(r.status).toBe(200);
    }
    const res = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent()] }, headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(429);
    expect((await json<ApiError>(res)).error.code).toBe('quota_exceeded');
    const empty = await POST_EVENTS(req('/api/events', { body: { events: [] }, headers: deviceHeaders(device.token) }), params({}));
    expect(empty.status).toBe(200);
  });
});

describe('event batches', () => {
  it('reads events since an upload cursor without re-reading earlier lines, and purges old days', async () => {
    const t0 = Date.parse('2026-10-20T10:00:00.000Z');
    const a = await appendBatch(TEST_UID, 'events', 'd_1', [makeEvent({ eventId: 'a1' }), makeEvent({ eventId: 'a2' })], t0);
    await appendBatch(TEST_UID, 'events', 'd_1', [makeEvent({ eventId: 'b1' })], t0 + 60_000);
    await appendBatch(TEST_UID, 'events', 'd_2', [makeEvent({ eventId: 'c1' })], t0 + 120_000 + 86_400_000);
    const all = await readEventsSince(TEST_UID, '');
    expect(all.items.map((e) => e.eventId).sort()).toEqual(['a1', 'a2', 'b1', 'c1']);
    const since = await readEventsSince(TEST_UID, a.uploadedAt);
    expect(since.items.map((e) => e.eventId).sort()).toEqual(['b1', 'c1']);
    expect(since.maxUploadedAt).toBe(new Date(t0 + 120_000 + 86_400_000).toISOString());
    const purged = await purgeBefore(TEST_UID, '2026-10-21');
    expect(purged).toBe(1);
    expect(store.has(P.eventsBatch('2026-10-20', 'd_1'))).toBe(false);
    expect((await loadIndex(TEST_UID)).index.batches.map((b) => b.deviceId)).toEqual(['d_2']);
  });
});
