import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, PairRedeemResponse, ProfileGetResponse, ProfileOpsResponse, ProfilePutConflict, ProfileVersionResponse } from '@jammarly/shared/api';
import type { MemoryBlobStore } from '@/lib/blob';
import { GET as GET_PROFILE, PUT as PUT_PROFILE } from '@/app/api/profile/route';
import { POST as POST_OPS } from '@/app/api/profile/ops/route';
import { GET as GET_VERSION } from '@/app/api/profile/version/route';
import { deviceHeaders, freshStore, hlc, json, loginCookie, ownerHeaders, pairDevice, params, req } from './helpers';

let store: MemoryBlobStore;
let cookie: string;
let device: PairRedeemResponse;

beforeEach(async () => {
  store = freshStore();
  cookie = await loginCookie();
  device = await pairDevice(cookie);
});

describe('POST /api/profile/ops', () => {
  it('applies device ops, increments the version and returns the etag in the body and the header', async () => {
    const res = await POST_OPS(
      req('/api/profile/ops', { body: { baseVersion: device.version, ops: [{ op: 'set', path: 'settings.dialect', value: 'en-AU', hlc: hlc(device.deviceId) }] }, headers: deviceHeaders(device.token) }),
      params({}),
    );
    expect(res.status).toBe(200);
    const body = await json<ProfileOpsResponse>(res);
    expect(body.version).toBe(device.version + 1);
    expect(body.profile.settings.dialect.value).toBe('en-AU');
    expect(res.headers.get('ETag')).toBe(body.etag);
    expect(res.headers.get('X-Profile-Version')).toBe(String(body.version));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(`chrome-extension://hkobmhfcoefpipbfkihdbbkgblckhkae`);
    expect(body.etag).not.toBe(device.etag);
  });

  it('rejects voice ops from a device (op_not_allowed) but accepts them from the owner', async () => {
    const voiceOp = { op: 'voice', context: 'messages', profile: { ...(await import('@jammarly/shared/profile')).emptyVoiceProfile('messages'), version: 1, generatedAt: new Date().toISOString() }, hlc: hlc('web') };
    const denied = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [voiceOp] }, headers: deviceHeaders(device.token) }), params({}));
    expect(denied.status).toBe(400);
    expect((await json<ApiError>(denied)).error.code).toBe('op_not_allowed');
    const allowed = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [voiceOp] }, headers: ownerHeaders(cookie) }), params({}));
    expect(allowed.status).toBe(200);
    expect((await json<ProfileOpsResponse>(allowed)).profile.voice.profiles.messages?.version).toBe(1);
  });

  it('rejects paths outside the allowlist', async () => {
    const res = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'set', path: 'learning.stats', value: {}, hlc: hlc() }] }, headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error.code).toBe('op_not_allowed');
  });

  it('rejects clocks more than 5 minutes ahead with hlc_skew', async () => {
    const res = await POST_OPS(
      req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: hlc(device.deviceId, Date.now() + 6 * 60_000) }] }, headers: deviceHeaders(device.token) }),
      params({}),
    );
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error.code).toBe('hlc_skew');
  });

  it('rejects invalid values with schema_invalid', async () => {
    const res = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'set', path: 'settings.dialect', value: 'fr-FR', hlc: hlc() }] }, headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error.code).toBe('schema_invalid');
    const malformed = await POST_OPS(req('/api/profile/ops', { rawBody: '{not json', method: 'POST', headers: { ...deviceHeaders(device.token), 'content-type': 'application/json' } }), params({}));
    expect(malformed.status).toBe(400);
  });

  it('answers 429 quota_exceeded after 10 writes in an hour', async () => {
    for (let i = 0; i < 10; i += 1) {
      const r = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'add', path: 'dictionary', value: `word${i}`, hlc: hlc(device.deviceId, Date.now() + i) }] }, headers: deviceHeaders(device.token) }), params({}));
      expect(r.status).toBe(200);
    }
    const res = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'add', path: 'dictionary', value: 'eleventh', hlc: hlc(device.deviceId) }] }, headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(429);
    expect((await json<ApiError>(res)).error.code).toBe('quota_exceeded');
  });

  it('requires a credential', async () => {
    const res = await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: hlc() }] } }), params({}));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/profile', () => {
  it('returns the profile with ETag and X-Profile-Version for a device', async () => {
    const res = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token) }), params({}));
    expect(res.status).toBe(200);
    const body = await json<ProfileGetResponse>(res);
    expect(body.version).toBe(0);
    expect(res.headers.get('ETag')).toBe(body.etag);
    expect(res.headers.get('X-Profile-Version')).toBe('0');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
  });

  it('answers 304 for a matching If-None-Match without touching Blob when the etag is cached', async () => {
    const first = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token) }), params({}));
    const etag = first.headers.get('ETag') ?? '';
    const readsBefore = store.ops.reads;
    const res = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token, { 'if-none-match': etag }) }), params({}));
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    // One read for devices.json (auth); none for the profile itself.
    expect(store.ops.reads - readsBefore).toBe(1);
  });

  it('answers 304 through Blob when the cache is cold, and 200 after a change', async () => {
    const first = await json<ProfileGetResponse>(await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token) }), params({})));
    const { resetStoreCachesForTests } = await import('@/lib/store');
    resetStoreCachesForTests();
    const notModified = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token, { 'if-none-match': first.etag }) }), params({}));
    expect(notModified.status).toBe(304);
    await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: hlc(device.deviceId) }] }, headers: deviceHeaders(device.token) }), params({}));
    const changed = await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token, { 'if-none-match': first.etag }) }), params({}));
    expect(changed.status).toBe(200);
    expect((await json<ProfileGetResponse>(changed)).version).toBe(1);
  });

  it('works for the owner session and rejects anonymous callers', async () => {
    expect((await GET_PROFILE(req('/api/profile', { headers: { cookie } }), params({}))).status).toBe(200);
    expect((await GET_PROFILE(req('/api/profile'), params({}))).status).toBe(401);
  });
});

describe('PUT /api/profile', () => {
  it('replaces the document when If-Match is current and returns 412 with the current document when stale', async () => {
    const current = await json<ProfileGetResponse>(await GET_PROFILE(req('/api/profile', { headers: ownerHeaders(cookie) }), params({})));
    const edited = { ...current.profile, settings: { ...current.profile.settings, customInstructions: { value: 'Keep it short.', hlc: hlc('web') } } };
    const ok = await PUT_PROFILE(req('/api/profile', { method: 'PUT', body: edited, headers: ownerHeaders(cookie, { 'if-match': current.etag }) }), params({}));
    expect(ok.status).toBe(200);
    const saved = await json<ProfileGetResponse>(ok);
    expect(saved.version).toBe(1);
    expect(saved.profile.settings.customInstructions.value).toBe('Keep it short.');

    const stale = await PUT_PROFILE(req('/api/profile', { method: 'PUT', body: edited, headers: ownerHeaders(cookie, { 'if-match': current.etag }) }), params({}));
    expect(stale.status).toBe(412);
    const conflict = await json<ProfilePutConflict>(stale);
    expect(conflict.error.code).toBe('precondition_failed');
    expect(conflict.current.version).toBe(1);
    expect(conflict.current.etag).toBe(saved.etag);
  });

  it('requires If-Match and a valid document', async () => {
    const current = await json<ProfileGetResponse>(await GET_PROFILE(req('/api/profile', { headers: ownerHeaders(cookie) }), params({})));
    const missing = await PUT_PROFILE(req('/api/profile', { method: 'PUT', body: current.profile, headers: ownerHeaders(cookie) }), params({}));
    expect(missing.status).toBe(428);
    const invalid = await PUT_PROFILE(req('/api/profile', { method: 'PUT', body: { schemaVersion: 2 }, headers: ownerHeaders(cookie, { 'if-match': current.etag }) }), params({}));
    expect(invalid.status).toBe(400);
    expect((await json<ApiError>(invalid)).error.code).toBe('schema_invalid');
  });

  it('keeps the server-authoritative learning and voice profiles when a device PUTs', async () => {
    await POST_OPS(req('/api/profile/ops', { body: { baseVersion: 0, ops: [{ op: 'learning', patch: { updatedHlc: hlc('web', Date.now() + 1), dictionaryCandidates: ['Bloop'] }, hlc: hlc('web') }] }, headers: ownerHeaders(cookie) }), params({}));
    const current = await json<ProfileGetResponse>(await GET_PROFILE(req('/api/profile', { headers: deviceHeaders(device.token) }), params({})));
    const tampered = { ...current.profile, learning: { ...current.profile.learning, dictionaryCandidates: [] } };
    const res = await PUT_PROFILE(req('/api/profile', { method: 'PUT', body: tampered, headers: deviceHeaders(device.token, { 'if-match': current.etag }) }), params({}));
    expect(res.status).toBe(200);
    expect((await json<ProfileGetResponse>(res)).profile.learning.dictionaryCandidates).toEqual(['Bloop']);
  });
});

describe('GET /api/profile/version', () => {
  it('serves the tiny document with a private 60 s cache header and from memory on repeat', async () => {
    const first = await GET_VERSION(req('/api/profile/version', { headers: deviceHeaders(device.token) }), params({}));
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, max-age=60');
    const body = await json<ProfileVersionResponse>(first);
    expect(body).toEqual({ version: 0, etag: device.etag });
    const readsBefore = store.ops.reads;
    await GET_VERSION(req('/api/profile/version', { headers: deviceHeaders(device.token) }), params({}));
    expect(store.ops.reads - readsBefore).toBe(1); // devices.json only
  });
});
