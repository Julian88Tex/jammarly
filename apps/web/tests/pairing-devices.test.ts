import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, DevicesListResponse, PairStartResponse, RotateResponse } from '@jammarly/shared/api';
import { POST as PAIR_START } from '@/app/api/devices/pair/start/route';
import { POST as PAIR_REDEEM } from '@/app/api/devices/pair/redeem/route';
import { GET as LIST_DEVICES } from '@/app/api/devices/route';
import { POST as REVOKE } from '@/app/api/devices/[id]/revoke/route';
import { POST as ROTATE } from '@/app/api/devices/[id]/rotate/route';
import { GET as GET_PROFILE } from '@/app/api/profile/route';
import { requireDevice } from '@/lib/auth';
import { authenticateDeviceToken, parseToken } from '@/lib/devices';
import { PAIRING_TTL_MS, redeemPairing, startPairing } from '@/lib/pairing';

import { EXT_ORIGIN, deviceHeaders, freshStore, json, loginCookie, ownerHeaders, pairDevice, params, req, TEST_UID, P } from './helpers';

let cookie: string;

beforeEach(async () => {
  freshStore();
  cookie = await loginCookie();
});

describe('pairing', () => {
  it('start returns a 16-hex pairing id, a 6-digit code and a 10 minute expiry (owner only)', async () => {
    const res = await PAIR_START(req('/api/devices/pair/start', { method: 'POST', headers: ownerHeaders(cookie) }), params({}));
    expect(res.status).toBe(200);
    const body = await json<PairStartResponse>(res);
    expect(body.pairingId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.code).toMatch(/^\d{6}$/);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const anon = await PAIR_START(req('/api/devices/pair/start', { method: 'POST', headers: { origin: 'https://jammarly-web.vercel.app' } }), params({}));
    expect(anon.status).toBe(401);
  });

  it('redeem mints a jm1 token, returns the profile and consumes the pairing', async () => {
    const started = await json<PairStartResponse>(await PAIR_START(req('/api/devices/pair/start', { method: 'POST', headers: ownerHeaders(cookie) }), params({})));
    const body = { pairingId: started.pairingId, code: started.code, device: { name: 'Chrome on Linux', platform: 'linux', extVersion: '0.1.0' } };
    const res = await PAIR_REDEEM(req('/api/devices/pair/redeem', { body, headers: { origin: EXT_ORIGIN } }), params({}));
    expect(res.status).toBe(200);
    const redeemed = await json<{ deviceId: string; token: string; version: number; etag: string; profile: { schemaVersion: number } }>(res);
    expect(redeemed.token).toMatch(/^jm1\.d_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(parseToken(redeemed.token)?.deviceId).toBe(redeemed.deviceId);
    expect(redeemed.profile.schemaVersion).toBe(1);
    expect(redeemed.version).toBe(0);
    expect(redeemed.etag.length).toBeGreaterThan(0);
    const again = await PAIR_REDEEM(req('/api/devices/pair/redeem', { body, headers: { origin: EXT_ORIGIN } }), params({}));
    expect(again.status).toBe(400);
    expect((await json<ApiError>(again)).error.code).toBe('pairing_invalid');
  });

  it('rejects a wrong code, an unknown pairing and an expired pairing', async () => {
    const started = await startPairing(TEST_UID);
    await expect(redeemPairing({ pairingId: started.pairingId, code: started.code === '000000' ? '000001' : '000000', device: { name: 'x', platform: 'mac', extVersion: '1' } })).rejects.toMatchObject({ status: 400, code: 'pairing_invalid' });
    await expect(redeemPairing({ pairingId: '0123456789abcdef', code: '123456', device: { name: 'x', platform: 'mac', extVersion: '1' } })).rejects.toMatchObject({ code: 'pairing_invalid' });
    await expect(redeemPairing({ pairingId: started.pairingId, code: started.code, device: { name: 'x', platform: 'mac', extVersion: '1' } }, Date.now() + PAIRING_TTL_MS + 1)).rejects.toMatchObject({ status: 410, code: 'pairing_expired' });
  });

  it('validates the redeem body', async () => {
    const res = await PAIR_REDEEM(req('/api/devices/pair/redeem', { body: { pairingId: 'nope', code: '12', device: {} }, headers: { origin: EXT_ORIGIN } }), params({}));
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error.code).toBe('schema_invalid');
  });

  it('lists devices for the owner with last seen', async () => {
    const paired = await pairDevice(cookie, 'Edge on Windows');
    const res = await LIST_DEVICES(req('/api/devices', { headers: { cookie } }), params({}));
    expect(res.status).toBe(200);
    const body = await json<DevicesListResponse>(res);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ id: paired.deviceId, name: 'Edge on Windows', platform: 'mac' });
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });
});

describe('device auth', () => {
  it('rejects malformed, unknown and missing tokens with 401 unauthorized', async () => {
    await expect(requireDevice(req('/api/profile'))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(requireDevice(req('/api/profile', { headers: { authorization: 'Bearer garbage' } }))).rejects.toMatchObject({ code: 'unauthorized' });
    await pairDevice(cookie);
    await expect(requireDevice(req('/api/profile', { headers: { authorization: 'Bearer jm1.d_000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }))).rejects.toMatchObject({ code: 'unauthorized' });
    const wrongSecret = (await pairDevice(cookie)).token.replace(/\.[^.]+$/, '.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    await expect(requireDevice(req('/api/profile', { headers: { authorization: `Bearer ${wrongSecret}` } }))).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('answers 401 device_revoked after the owner revokes a device', async () => {
    const paired = await pairDevice(cookie);
    const ok = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(paired.token) }), params({}));
    expect(ok.status).toBe(200);
    const revoke = await REVOKE(req(`/api/devices/${paired.deviceId}/revoke`, { method: 'POST', headers: ownerHeaders(cookie) }), params({ id: paired.deviceId }));
    expect(revoke.status).toBe(200);
    const denied = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(paired.token) }), params({}));
    expect(denied.status).toBe(401);
    expect((await json<ApiError>(denied)).error.code).toBe('device_revoked');
    const unknown = await REVOKE(req('/api/devices/d_nope/revoke', { method: 'POST', headers: ownerHeaders(cookie) }), params({ id: 'd_nope' }));
    expect(unknown.status).toBe(404);
  });

  it('rotates the token and keeps the previous one valid for 5 minutes', async () => {
    const paired = await pairDevice(cookie);
    const res = await ROTATE(req(`/api/devices/${paired.deviceId}/rotate`, { method: 'POST', headers: deviceHeaders(paired.token) }), params({ id: paired.deviceId }));
    expect(res.status).toBe(200);
    const rotated = await json<RotateResponse>(res);
    expect(rotated.token).not.toBe(paired.token);
    expect(Date.parse(rotated.previousValidUntil) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await authenticateDeviceToken(rotated.token)).status).toBe('ok');
    expect((await authenticateDeviceToken(paired.token)).status).toBe('ok');
    expect((await authenticateDeviceToken(paired.token, Date.now() + 6 * 60_000)).status).toBe('unknown');
    const other = await pairDevice(cookie);
    const forbidden = await ROTATE(req(`/api/devices/${paired.deviceId}/rotate`, { method: 'POST', headers: deviceHeaders(other.token) }), params({ id: paired.deviceId }));
    expect(forbidden.status).toBe(403);
  });

  it('stores only the token hash', async () => {
    const store = freshStore();
    cookie = await loginCookie();
    const paired = await pairDevice(cookie);
    const raw = store.raw(P.devices) ?? '';
    const secret = parseToken(paired.token)?.secret ?? '';
    expect(raw).not.toContain(secret);
    expect(raw).toContain('tokenHash');
  });
});
