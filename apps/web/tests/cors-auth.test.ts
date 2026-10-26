import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from 'jose';
import type { ApiError } from '@jammarly/shared/api';
import { POST as LOGOUT } from '@/app/api/auth/logout/route';
import { GET as LIST_DEVICES, OPTIONS as DEVICES_OPTIONS } from '@/app/api/devices/route';
import { GET as GET_PROFILE, OPTIONS as PROFILE_OPTIONS } from '@/app/api/profile/route';
import { POST as POST_EVENTS } from '@/app/api/events/route';
import { GET as HEALTH } from '@/app/api/health/route';
import { GET as CRON } from '@/app/api/cron/synthesize/route';
import { corsHeadersFor, parseExtensionOrigin } from '@/lib/cors';
import { jsliceSignInUrl, jsliceSilentUrl, safeNext } from '@/lib/jslice';
import { getRequestSession } from '@/lib/session';
import { GLOBAL_PATHS } from '@/lib/store';
import { APP_ORIGIN, EXT_ORIGIN, OTHER_EXT_ID, P, TEST_CRON_SECRET, TEST_UID, cookieFromResponse, deviceHeaders, freshStore, json, jsliceCallback, jsliceToken, loginCookie, ownerHeaders, pairDevice, params, req, setupEnv } from './helpers';

beforeEach(() => {
  freshStore();
});

describe('CORS matrix', () => {
  it('echoes the allowed extension origin with Vary and never credentials', async () => {
    const cookie = await loginCookie();
    const device = await pairDevice(cookie);
    const res = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token) }), params({}));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(EXT_ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PUT,DELETE,OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, If-Match, If-None-Match');
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe('ETag, X-Profile-Version');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('gives an unknown extension origin nothing and rejects it on device routes', async () => {
    const other = `chrome-extension://${OTHER_EXT_ID}`;
    expect(corsHeadersFor(req('/api/profile', { headers: { origin: other } }))).toEqual({});
    expect(corsHeadersFor(req('/api/profile', { headers: { origin: 'https://evil.example' } }))).toEqual({});
    expect(corsHeadersFor(req('/api/profile'))).toEqual({});
    const res = await POST_EVENTS(req('/api/events', { body: { events: [] }, headers: { origin: other, authorization: 'Bearer jm1.d_x.y' } }), params({}));
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const browser = await POST_EVENTS(req('/api/events', { body: { events: [] }, headers: { origin: 'https://evil.example' } }), params({}));
    expect(browser.status).toBe(403);
  });

  it('session routes reject any extension origin with 403 and cross-site browser origins', async () => {
    const cookie = await loginCookie();
    const fromExtension = await LIST_DEVICES(req('/api/devices', { headers: { cookie, origin: EXT_ORIGIN } }), params({}));
    expect(fromExtension.status).toBe(403);
    const crossSite = await LIST_DEVICES(req('/api/devices', { headers: { cookie, origin: 'https://evil.example' } }), params({}));
    expect(crossSite.status).toBe(403);
    const sameOrigin = await LIST_DEVICES(req('/api/devices', { headers: { cookie, origin: APP_ORIGIN } }), params({}));
    expect(sameOrigin.status).toBe(200);
    const noOrigin = await LIST_DEVICES(req('/api/devices', { headers: { cookie } }), params({}));
    expect(noOrigin.status).toBe(200);
  });

  it('shared routes reject a cookie session presented from an extension origin', async () => {
    const cookie = await loginCookie();
    const res = await GET_PROFILE(req('/api/profile', { headers: { cookie, origin: EXT_ORIGIN } }), params({}));
    expect(res.status).toBe(403);
  });

  it('answers OPTIONS preflights with 204 and the allow headers only for allowed origins', async () => {
    const allowed = await PROFILE_OPTIONS(req('/api/profile', { method: 'OPTIONS', headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'PUT' } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(EXT_ORIGIN);
    expect(allowed.headers.get('Access-Control-Max-Age')).toBe('86400');
    const unknown = await DEVICES_OPTIONS(req('/api/devices', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(unknown.status).toBe(204);
    expect(unknown.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('parses extension origins strictly', () => {
    expect(parseExtensionOrigin(EXT_ORIGIN)).toBe('hkobmhfcoefpipbfkihdbbkgblckhkae');
    expect(parseExtensionOrigin('chrome-extension://short')).toBeNull();
    expect(parseExtensionOrigin('https://x.example')).toBeNull();
  });
});

describe('JSlice sign-in (GET /api/auth/jslice)', () => {
  it('starts a session for the token sub, records the account and redirects to next', async () => {
    const store = freshStore();
    const res = await jsliceCallback(await jsliceToken({ sub: TEST_UID, email: 'writer@example.com' }), '/tuning');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/tuning`);
    const setCookie = res.headers.getSetCookie()[0] ?? '';
    expect(setCookie).toMatch(/^jammarly_session=/);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie.toLowerCase()).toContain('path=/');
    const cookie = cookieFromResponse(res);
    expect((await LIST_DEVICES(req('/api/devices', { headers: { cookie } }), params({}))).status).toBe(200);
    expect(JSON.parse(store.raw(P.account) ?? '{}')).toMatchObject({ sub: TEST_UID, email: 'writer@example.com', name: 'Test Writer' });
    expect(store.has(GLOBAL_PATHS.user(TEST_UID))).toBe(true);
  });

  it('accepts a token once: a replay redirects to the login page with an error', async () => {
    const token = await jsliceToken();
    expect((await jsliceCallback(token)).headers.get('location')).toBe(`${APP_ORIGIN}/overview`);
    const replay = await jsliceCallback(token);
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe(`${APP_ORIGIN}/login?error=jslice&next=%2Foverview`);
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  it('answers a call without a token with an error= redirect (JSlice probes for it)', async () => {
    const res = await jsliceCallback(null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('error=');
  });

  it('rejects a wrong audience, a wrong issuer, an expired token, a foreign key and an unusable sub', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const old = Math.floor(Date.now() / 1000) - 600;
    const bad = [
      await jsliceToken({ audience: 'jalto' }),
      await jsliceToken({ issuer: 'https://evil.example' }),
      await jsliceToken({ iat: old, expiresInSeconds: 60 }),
      await jsliceToken({ privateKey }),
      await jsliceToken({ sub: '../owner' }),
      'not-a-jwt',
    ];
    for (const token of bad) {
      const res = await jsliceCallback(token);
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('/login?error=jslice');
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it('forwards next only when it starts with a single slash', async () => {
    for (const [next, expected] of [
      ['/voice', '/voice'],
      ['/privacy?tab=1', '/privacy?tab=1'],
      ['//evil.example/x', '/overview'],
      ['https://evil.example', '/overview'],
      ['/\\evil.example', '/overview'],
    ] as const) {
      const res = await jsliceCallback(await jsliceToken(), next);
      expect(res.headers.get('location')).toBe(`${APP_ORIGIN}${expected}`);
    }
    expect(safeNext(null)).toBe('/overview');
  });

  it('builds the interactive and silent JSlice URLs', () => {
    expect(jsliceSignInUrl('/tuning')).toBe('https://jslice.vercel.app/?app=jammerly&next=%2Ftuning');
    expect(jsliceSilentUrl('/overview')).toBe('https://jslice.vercel.app/launch/jammerly?silent=1&next=%2Foverview');
    expect(jsliceSilentUrl('//evil.example')).toBe('https://jslice.vercel.app/launch/jammerly?silent=1&next=%2Foverview');
  });

  it('logout clears the cookie and points at /login?jslice=none', async () => {
    const cookie = await loginCookie();
    const out = await LOGOUT(req('/api/auth/logout', { method: 'POST', headers: ownerHeaders(cookie) }), params({}));
    expect(out.status).toBe(200);
    expect(await json<{ redirect: string }>(out)).toMatchObject({ ok: true, redirect: '/login?jslice=none' });
    expect(out.headers.getSetCookie()[0] ?? '').toMatch(/jammarly_session=;|max-age=0/i);
  });

  it('a garbage cookie or a sealed cookie from the old owner login is not a session', async () => {
    expect((await LIST_DEVICES(req('/api/devices', { headers: { cookie: 'jammarly_session=garbage', origin: APP_ORIGIN } }), params({}))).status).toBe(401);
    const headers = new Headers();
    const legacy = await getRequestSession(req('/'), headers);
    Object.assign(legacy, { uid: 'owner', iat: Date.now() });
    await legacy.save();
    const cookie = (headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^jammarly_session=/);
    expect((await LIST_DEVICES(req('/api/devices', { headers: { cookie, origin: APP_ORIGIN } }), params({}))).status).toBe(401);
    // The same cookie with the JSlice marker and a real sub is a session (so the 401 above is about the marker).
    const ok = new Headers();
    const current = await getRequestSession(req('/'), ok);
    Object.assign(current, { uid: TEST_UID, via: 'jslice', iat: Date.now() });
    await current.save();
    const okCookie = (ok.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect((await LIST_DEVICES(req('/api/devices', { headers: { cookie: okCookie, origin: APP_ORIGIN } }), params({}))).status).toBe(200);
  });

  it('fails fast with a clear message when the environment is incomplete', async () => {
    setupEnv({ JSLICE_URL: undefined });
    const res = await jsliceCallback(await jsliceToken());
    expect(res.status).toBe(500);
    const body = await json<ApiError>(res);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toContain('JSLICE_URL');
    setupEnv({ SESSION_SECRET: 'short' });
    const short = await jsliceCallback(await jsliceToken());
    expect(short.status).toBe(500);
    const shortBody = await json<ApiError>(short);
    expect(shortBody.error.message).toContain('SESSION_SECRET');
    expect(shortBody.error.message).not.toContain('short');
  });
});

describe('cron and health', () => {
  it('cron requires the bearer CRON_SECRET', async () => {
    expect((await CRON(req('/api/cron/synthesize?ctx=messages'), params({}))).status).toBe(401);
    expect((await CRON(req('/api/cron/synthesize?ctx=messages', { headers: { authorization: 'Bearer wrong-secret-0123456789' } }), params({}))).status).toBe(401);
    const bad = await CRON(req('/api/cron/synthesize?ctx=code', { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }), params({}));
    expect(bad.status).toBe(400);
    await loginCookie();
    const ok = await CRON(req('/api/cron/synthesize?ctx=messages', { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }), params({}));
    expect(ok.status).toBe(200);
    expect(await json<{ context: string; users: number }>(ok)).toMatchObject({ context: 'messages', users: 1, ran: 0, skipped: 1, deferred: 0 });
  });

  it('health is public and adds Blob counters for a signed-in user', async () => {
    const anon = await json<{ ok: boolean; version: string; blob?: unknown }>(await HEALTH(req('/api/health'), params({})));
    expect(anon.ok).toBe(true);
    expect(anon.blob).toBeUndefined();
    const cookie = await loginCookie();
    const owner = await json<{ blob?: { advancedOps: number; limits: { advancedOps: number } } }>(await HEALTH(req('/api/health', { headers: { cookie } }), params({})));
    expect(owner.blob?.limits.advancedOps).toBe(2000);
    expect(typeof owner.blob?.advancedOps).toBe('number');
  });
});
