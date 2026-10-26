import { beforeEach, describe, expect, it } from 'vitest';
import type { DevicesListResponse, PairRedeemResponse, PairStartResponse, ProfileGetResponse, ProfileOpsResponse } from '@jammarly/shared/api';
import { GET as CRON } from '@/app/api/cron/synthesize/route';
import { POST as REVOKE } from '@/app/api/devices/[id]/revoke/route';
import { POST as PAIR_START } from '@/app/api/devices/pair/start/route';
import { POST as PAIR_REDEEM } from '@/app/api/devices/pair/redeem/route';
import { GET as LIST_DEVICES } from '@/app/api/devices/route';
import { POST as POST_EVENTS } from '@/app/api/events/route';
import { GET as HEALTH } from '@/app/api/health/route';
import { POST as POST_OPS } from '@/app/api/profile/ops/route';
import { GET as GET_PROFILE } from '@/app/api/profile/route';
import type { MemoryBlobStore } from '@/lib/blob';
import { authenticateDeviceToken, resetDeviceIndexCacheForTests } from '@/lib/devices';
import { cronOrder, listUserIds } from '@/lib/learning/job';
import { GLOBAL_PATHS, dayOf, loadProfile, resetStoreCachesForTests, userPaths } from '@/lib/store';
import { EXT_ORIGIN, OTHER_UID, TEST_CRON_SECRET, TEST_UID, deviceHeaders, freshStore, hlc, json, loginCookie, makeEvent, ownerHeaders, pairDevice, params, req } from './helpers';

let store: MemoryBlobStore;
let cookieA: string;
let cookieB: string;
let deviceA: PairRedeemResponse;
let deviceB: PairRedeemResponse;

beforeEach(async () => {
  store = freshStore();
  cookieA = await loginCookie(TEST_UID);
  cookieB = await loginCookie(OTHER_UID);
  deviceA = await pairDevice(cookieA, 'A laptop');
  deviceB = await pairDevice(cookieB, 'B laptop');
});

async function profileFor(token: string): Promise<ProfileGetResponse> {
  return json<ProfileGetResponse>(await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(token) }), params({})));
}

const cron = (ctx: string): Promise<Response> => CRON(req(`/api/cron/synthesize?ctx=${ctx}`, { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }), params({}));

describe('one deployment, many users', () => {
  it('keeps every document under users/<sub>/ and resolves each device token to its user', async () => {
    expect(store.has(userPaths(TEST_UID).devices)).toBe(true);
    expect(store.has(userPaths(OTHER_UID).devices)).toBe(true);
    expect(JSON.parse(store.raw(GLOBAL_PATHS.device(deviceA.deviceId)) ?? '{}')).toMatchObject({ uid: TEST_UID });
    expect(JSON.parse(store.raw(GLOBAL_PATHS.device(deviceB.deviceId)) ?? '{}')).toMatchObject({ uid: OTHER_UID });
    resetDeviceIndexCacheForTests();
    expect(await authenticateDeviceToken(deviceA.token)).toMatchObject({ status: 'ok', uid: TEST_UID });
    expect(await authenticateDeviceToken(deviceB.token)).toMatchObject({ status: 'ok', uid: OTHER_UID });
    expect(store.paths().filter((k) => k.startsWith('users/owner'))).toEqual([]);
  });

  it('gives each user their own profile and keeps writes apart', async () => {
    const a = await profileFor(deviceA.token);
    const b = await profileFor(deviceB.token);
    expect(a.profile.settings.userSalt.value).not.toBe(b.profile.settings.userSalt.value);
    const op = { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: hlc(deviceA.deviceId) };
    const res = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: a.version, ops: [op] }, headers: deviceHeaders(deviceA.token) }), params({}));
    expect(res.status).toBe(200);
    expect((await json<ProfileOpsResponse>(res)).profile.settings.dialect.value).toBe('en-GB');
    expect((await profileFor(deviceA.token)).profile.settings.dialect.value).toBe('en-GB');
    expect((await profileFor(deviceB.token)).profile.settings.dialect.value).toBe('en-US');
    // The dashboard session sees the same document as the user's devices.
    const viaCookie = await json<ProfileGetResponse>(await GET_PROFILE(req('/api/profile', { headers: ownerHeaders(cookieA) }), params({})));
    expect(viaCookie.profile.settings.dialect.value).toBe('en-GB');
  });

  it('lists only your own devices and cannot revoke someone else\'s', async () => {
    const listA = await json<DevicesListResponse>(await LIST_DEVICES(req('/api/devices', { headers: ownerHeaders(cookieA) }), params({})));
    expect(listA.devices.map((d) => d.id)).toEqual([deviceA.deviceId]);
    const revoke = await REVOKE(req(`/api/devices/${deviceA.deviceId}/revoke`, { method: 'POST', headers: ownerHeaders(cookieB) }), params({ id: deviceA.deviceId }));
    expect(revoke.status).toBe(404);
    expect((await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(deviceA.token) }), params({}))).status).toBe(200);
  });

  it('pairs a device to the user who started the pairing', async () => {
    const started = await json<PairStartResponse>(await PAIR_START(req('/api/devices/pair/start', { method: 'POST', headers: ownerHeaders(cookieB) }), params({})));
    expect(store.has(userPaths(OTHER_UID).pairing(started.pairingId))).toBe(true);
    expect(JSON.parse(store.raw(GLOBAL_PATHS.pairing(started.pairingId)) ?? '{}')).toMatchObject({ uid: OTHER_UID });
    const body = { pairingId: started.pairingId, code: started.code, device: { name: 'B phone', platform: 'android', extVersion: '0.1.0' } };
    const redeemed = await json<PairRedeemResponse>(await PAIR_REDEEM(req('/api/devices/pair/redeem', { body, headers: { origin: EXT_ORIGIN } }), params({})));
    expect(store.has(userPaths(OTHER_UID).pairing(started.pairingId))).toBe(false);
    expect(store.has(GLOBAL_PATHS.pairing(started.pairingId))).toBe(false);
    const b = await profileFor(deviceB.token);
    expect(redeemed.profile.settings.userSalt.value).toBe(b.profile.settings.userSalt.value);
    const listB = await json<DevicesListResponse>(await LIST_DEVICES(req('/api/devices', { headers: ownerHeaders(cookieB) }), params({})));
    expect(listB.devices.map((d) => d.name).sort()).toEqual(['B laptop', 'B phone']);
  });

  it('stores events under the uploading device\'s user', async () => {
    const res = await POST_EVENTS(req('/api/events', { body: { events: [makeEvent()] }, headers: deviceHeaders(deviceB.token) }), params({}));
    expect(res.status).toBe(200);
    const day = dayOf(Date.now());
    expect(store.has(userPaths(OTHER_UID).eventsBatch(day, deviceB.deviceId))).toBe(true);
    expect(store.has(userPaths(TEST_UID).eventsIndex)).toBe(false);
  });

  it('health shows per-device counters only for your own devices', async () => {
    for (const d of [deviceA, deviceB]) {
      await POST_EVENTS(req('/api/events', { body: { events: [makeEvent()] }, headers: deviceHeaders(d.token) }), params({}));
    }
    const body = await json<{ blob?: { perDevice: Record<string, unknown> } }>(await HEALTH(req('/api/health', { headers: { cookie: cookieA } }), params({})));
    expect(Object.keys(body.blob?.perDevice ?? {})).toEqual([deviceA.deviceId]);
  });

  it('the cron runs the learning job for every user with new events and skips the rest', async () => {
    await loginCookie('100000000000000000099'); // a third user with nothing uploaded
    expect(await listUserIds()).toHaveLength(3);
    const events = Array.from({ length: 5 }, () => makeEvent());
    for (const d of [deviceA, deviceB]) {
      expect((await POST_EVENTS(req('/api/events', { body: { events }, headers: deviceHeaders(d.token) }), params({}))).status).toBe(200);
    }
    const first = await json<{ users: number; ran: number; skipped: number; deferred: number; stages: Record<string, number> }>(await cron('messages'));
    expect(first).toMatchObject({ users: 3, ran: 2, skipped: 1, deferred: 0, stages: { done: 2 } });
    resetStoreCachesForTests();
    for (const uid of [TEST_UID, OTHER_UID]) {
      const { profile } = await loadProfile(uid);
      expect(profile.learning.lastEventCursor.length).toBeGreaterThan(0);
      expect(Object.keys(profile.learning.stats).length).toBeGreaterThan(0);
      expect(store.has(userPaths(uid).run(dayOf(Date.now()), 'messages'))).toBe(true);
    }
    // Nothing new since: the next invocation skips everyone; the other context still runs once.
    expect(await json(await cron('messages'))).toMatchObject({ ran: 0, skipped: 3 });
    expect(await json(await cron('documents'))).toMatchObject({ ran: 2, skipped: 1 });
  });

  it('rotates the cron order by day so nobody is always last', () => {
    const ids = ['a', 'b', 'c'];
    const day = 86_400_000;
    expect(cronOrder(ids, 0)).toEqual(['a', 'b', 'c']);
    expect(cronOrder(ids, day)).toEqual(['b', 'c', 'a']);
    expect(cronOrder(ids, 2 * day)).toEqual(['c', 'a', 'b']);
    expect(cronOrder([], day)).toEqual([]);
  });
});
