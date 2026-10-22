import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ApiError } from '@jammarly/shared/api';
import { POST as LOGIN } from '@/app/api/auth/login/route';
import { POST as LOGOUT } from '@/app/api/auth/logout/route';
import { GET as LIST_DEVICES, OPTIONS as DEVICES_OPTIONS } from '@/app/api/devices/route';
import { GET as GET_PROFILE, OPTIONS as PROFILE_OPTIONS } from '@/app/api/profile/route';
import { POST as POST_EVENTS } from '@/app/api/events/route';
import { GET as HEALTH } from '@/app/api/health/route';
import { GET as CRON } from '@/app/api/cron/synthesize/route';
import { corsHeadersFor, parseExtensionOrigin } from '@/lib/cors';
import { hashPassword, verifyPassword } from '@/lib/crypto';
import { APP_ORIGIN, EXT_ORIGIN, OTHER_EXT_ID, TEST_CRON_SECRET, TEST_PASSWORD, cookieFromResponse, deviceHeaders, freshStore, json, loginCookie, ownerHeaders, pairDevice, params, req, setupEnv } from './helpers';

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

  it('owner routes reject any extension origin with 403 and cross-site browser origins', async () => {
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

describe('POST /api/auth/login', () => {
  it('rejects a wrong password with 401 and sets no cookie', async () => {
    const res = await LOGIN(req('/api/auth/login', { body: { password: 'nope' }, headers: { origin: APP_ORIGIN, 'x-forwarded-for': '198.51.100.7' } }), params({}));
    expect(res.status).toBe(401);
    expect((await json<ApiError>(res)).error.code).toBe('unauthorized');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('locks an IP for 60 s after 5 failures, independently of other IPs', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await LOGIN(req('/api/auth/login', { body: { password: `bad${i}` }, headers: { origin: APP_ORIGIN, 'x-forwarded-for': '198.51.100.9' } }), params({}));
      expect(r.status).toBe(401);
    }
    const locked = await LOGIN(req('/api/auth/login', { body: { password: TEST_PASSWORD }, headers: { origin: APP_ORIGIN, 'x-forwarded-for': '198.51.100.9' } }), params({}));
    expect(locked.status).toBe(429);
    expect((await json<ApiError>(locked)).error.code).toBe('rate_limited');
    const otherIp = await LOGIN(req('/api/auth/login', { body: { password: TEST_PASSWORD }, headers: { origin: APP_ORIGIN, 'x-forwarded-for': '198.51.100.10' } }), params({}));
    expect(otherIp.status).toBe(200);
  });

  it('sets an httpOnly lax session cookie on success and clears it on logout', async () => {
    const res = await LOGIN(req('/api/auth/login', { body: { password: TEST_PASSWORD }, headers: { origin: APP_ORIGIN } }), params({}));
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie()[0] ?? '';
    expect(setCookie).toMatch(/^jammarly_session=/);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie.toLowerCase()).toContain('path=/');
    const cookie = cookieFromResponse(res);
    expect((await LIST_DEVICES(req('/api/devices', { headers: { cookie } }), params({}))).status).toBe(200);
    const out = await LOGOUT(req('/api/auth/logout', { method: 'POST', headers: ownerHeaders(cookie) }), params({}));
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()[0] ?? '').toMatch(/jammarly_session=;|max-age=0/i);
  });

  it('rejects logins from an extension origin and malformed bodies', async () => {
    const ext = await LOGIN(req('/api/auth/login', { body: { password: TEST_PASSWORD }, headers: { origin: EXT_ORIGIN } }), params({}));
    expect(ext.status).toBe(403);
    const bad = await LOGIN(req('/api/auth/login', { body: { nope: 1 }, headers: { origin: APP_ORIGIN } }), params({}));
    expect(bad.status).toBe(400);
  });

  it('accepts the hash format printed by scripts/hash-password.mjs', async () => {
    const script = path.resolve(__dirname, '../scripts/hash-password.mjs');
    const out = execFileSync(process.execPath, [script, 'pw-from-script'], { encoding: 'utf8' }).trim();
    expect(out).toMatch(/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
    expect(verifyPassword('pw-from-script', out)).toBe(true);
    expect(verifyPassword('other', out)).toBe(false);
    const viaStdin = execFileSync(process.execPath, [script], { encoding: 'utf8', input: 'from stdin\n' }).trim();
    expect(verifyPassword('from stdin', viaStdin)).toBe(true);
    expect(verifyPassword('pw', 'not-a-hash')).toBe(false);
    expect(hashPassword('a')).not.toBe(hashPassword('a'));

    setupEnv({ OWNER_PASSWORD_HASH: out });
    const res = await LOGIN(req('/api/auth/login', { body: { password: 'pw-from-script' }, headers: { origin: APP_ORIGIN } }), params({}));
    expect(res.status).toBe(200);
  });

  it('fails fast with a clear message when the environment is incomplete', async () => {
    setupEnv({ SESSION_SECRET: 'short' });
    const res = await LOGIN(req('/api/auth/login', { body: { password: TEST_PASSWORD }, headers: { origin: APP_ORIGIN } }), params({}));
    expect(res.status).toBe(500);
    const body = await json<ApiError>(res);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toContain('SESSION_SECRET');
    expect(body.error.message).not.toContain('short');
  });
});

describe('cron and health', () => {
  it('cron requires the bearer CRON_SECRET', async () => {
    expect((await CRON(req('/api/cron/synthesize?ctx=messages'), params({}))).status).toBe(401);
    expect((await CRON(req('/api/cron/synthesize?ctx=messages', { headers: { authorization: 'Bearer wrong-secret-0123456789' } }), params({}))).status).toBe(401);
    const bad = await CRON(req('/api/cron/synthesize?ctx=code', { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }), params({}));
    expect(bad.status).toBe(400);
    const ok = await CRON(req('/api/cron/synthesize?ctx=messages', { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }), params({}));
    expect(ok.status).toBe(200);
    expect(await json<{ stage: string }>(ok)).toMatchObject({ stage: 'done', context: 'messages' });
  });

  it('health is public and adds Blob counters for the owner', async () => {
    const anon = await json<{ ok: boolean; version: string; blob?: unknown }>(await HEALTH(req('/api/health'), params({})));
    expect(anon.ok).toBe(true);
    expect(anon.blob).toBeUndefined();
    const cookie = await loginCookie();
    const owner = await json<{ blob?: { advancedOps: number; limits: { advancedOps: number } } }>(await HEALTH(req('/api/health', { headers: { cookie } }), params({})));
    expect(owner.blob?.limits.advancedOps).toBe(2000);
    expect(typeof owner.blob?.advancedOps).toBe('number');
  });
});
