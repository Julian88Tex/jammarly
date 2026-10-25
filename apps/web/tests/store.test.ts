import { beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailed, type MemoryBlobStore } from '@/lib/blob';
import { ApiRouteError } from '@/lib/errors';
import { PATHS, ProfileConflict, applyProfileOps, bumpDeviceQuota, cachedVersion, getProfileVersion, getQuotaStatus, loadProfile, resetStoreCachesForTests, saveProfile } from '@/lib/store';
import { freshStore, hlc } from './helpers';

let store: MemoryBlobStore;

beforeEach(() => {
  store = freshStore();
});

describe('loadProfile / saveProfile', () => {
  it('creates the default profile with a random userSalt on first read and writes version.json', async () => {
    const loaded = await loadProfile();
    expect(loaded.version).toBe(0);
    expect(loaded.profile.settings.userSalt.value).toMatch(/^[0-9a-f]{64}$/);
    expect(store.has(PATHS.profile)).toBe(true);
    expect(store.has(PATHS.version)).toBe(true);
    const again = await loadProfile();
    expect(again.profile.settings.userSalt.value).toBe(loaded.profile.settings.userSalt.value);
  });

  it('increments the version on every write and refreshes version.json and the cache', async () => {
    const a = await saveProfile((doc) => ({ ...doc, settings: { ...doc.settings, dialect: { value: 'en-GB', hlc: hlc() } } }), { by: 'test' });
    expect(a.version).toBe(1);
    expect(a.profile.updatedBy).toBe('test');
    const b = await saveProfile((doc) => doc);
    expect(b.version).toBe(2);
    expect(b.etag).not.toBe(a.etag);
    expect(cachedVersion()).toEqual({ version: 2, etag: b.etag });
    expect(await getProfileVersion()).toEqual({ version: 2, etag: b.etag });
    expect(JSON.parse(store.raw(PATHS.version) ?? '{}')).toEqual({ version: 2, etag: b.etag });
  });

  it('writes a snapshot every 10th version', async () => {
    for (let i = 0; i < 10; i += 1) await saveProfile((doc) => doc);
    expect(store.has(PATHS.snapshot(10))).toBe(true);
    expect(store.has(PATHS.snapshot(9))).toBe(false);
  });

  it('retries on a CAS conflict and re-applies the mutation on the fresh document', async () => {
    await loadProfile();
    const original = store.putJson.bind(store);
    let injected = 0;
    store.putJson = async (path, value, opts) => {
      if (path === PATHS.profile && injected === 0) {
        injected += 1;
        // Someone else wrote in between: bump the stored document, then fail this write.
        await original(path, { ...(JSON.parse(store.raw(path) ?? '{}') as object), version: 7 }, {});
        throw new PreconditionFailed(path);
      }
      return original(path, value, opts);
    };
    let calls = 0;
    const saved = await saveProfile((doc) => {
      calls += 1;
      return doc;
    });
    expect(injected).toBe(1);
    expect(calls).toBe(2);
    expect(saved.version).toBe(8);
  });

  it('gives up with conflict_retry after three lost races', async () => {
    await loadProfile();
    const original = store.putJson.bind(store);
    store.putJson = async (path, value, opts) => {
      if (path === PATHS.profile) throw new PreconditionFailed(path);
      return original(path, value, opts);
    };
    await expect(saveProfile((doc) => doc)).rejects.toMatchObject({ code: 'conflict_retry' });
  });

  it('rejects a stale If-Match without retrying (precondition_failed carries the current document)', async () => {
    const first = await loadProfile();
    await saveProfile((doc) => doc);
    try {
      await saveProfile((doc) => doc, { ifMatch: first.etag });
      throw new Error('expected a conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileConflict);
      expect((err as ProfileConflict).code).toBe('precondition_failed');
      expect((err as ProfileConflict).current.version).toBe(1);
    }
  });

  it('rejects a mutation that produces an invalid document', async () => {
    await expect(saveProfile((doc) => ({ ...doc, settings: { ...doc.settings, dialect: { value: 'fr-FR' as never, hlc: hlc() } } }))).rejects.toMatchObject({ code: 'schema_invalid' });
  });
});

describe('ops path', () => {
  it('applies set/add/remove ops and bumps the version', async () => {
    const r = await applyProfileOps(
      [
        { op: 'set', path: 'settings.dialect', value: 'en-GB', hlc: hlc('d_a') },
        { op: 'add', path: 'dictionary', value: 'Jammarly', hlc: hlc('d_a') },
      ],
      { kind: 'device', deviceId: 'd_a' },
    );
    expect(r.version).toBe(1);
    expect(r.profile.settings.dialect.value).toBe('en-GB');
    expect(r.profile.dictionary.map((e) => e.value)).toEqual(['Jammarly']);
    expect(r.profile.updatedBy).toBe('d_a');
  });

  it('rejects unknown ops and voice/learning ops from devices', async () => {
    await expect(applyProfileOps([{ op: 'nuke', hlc: hlc() }], { kind: 'device', deviceId: 'd_a' })).rejects.toMatchObject({ code: 'op_not_allowed' });
    await expect(applyProfileOps([{ op: 'learning', patch: { updatedHlc: hlc() }, hlc: hlc() }], { kind: 'device', deviceId: 'd_a' })).rejects.toMatchObject({ code: 'op_not_allowed' });
    const ok = await applyProfileOps([{ op: 'learning', patch: { updatedHlc: hlc('web', Date.now() + 1) }, hlc: hlc('web') }], { kind: 'owner' });
    expect(ok.version).toBe(1);
  });

  it('enforces the 10 writes per hour device quota with 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      await applyProfileOps([{ op: 'set', path: 'settings.checkOptedOutFields', value: i % 2 === 0, hlc: hlc('d_q', Date.now() + i) }], { kind: 'device', deviceId: 'd_q' });
    }
    await expect(applyProfileOps([{ op: 'set', path: 'settings.checkOptedOutFields', value: true, hlc: hlc('d_q') }], { kind: 'device', deviceId: 'd_q' })).rejects.toMatchObject({ status: 429, code: 'quota_exceeded' });
    const quota = await getQuotaStatus();
    expect(quota.perDevice['d_q']?.profileWrites).toBe(10);
    expect(quota.advancedOps).toBeGreaterThan(0);
  });

  it('resets the hourly counter in the next hour and the event batch counter the next day', async () => {
    const t0 = Date.parse('2026-10-22T10:00:00.000Z');
    for (let i = 0; i < 10; i += 1) await bumpDeviceQuota('d_h', 'profileWrites', t0 + i);
    await expect(bumpDeviceQuota('d_h', 'profileWrites', t0 + 20)).rejects.toBeInstanceOf(ApiRouteError);
    await bumpDeviceQuota('d_h', 'profileWrites', t0 + 3_600_000);
    for (let i = 0; i < 6; i += 1) await bumpDeviceQuota('d_h', 'eventBatches', t0 + i);
    await expect(bumpDeviceQuota('d_h', 'eventBatches', t0 + 30)).rejects.toMatchObject({ code: 'quota_exceeded' });
    await bumpDeviceQuota('d_h', 'eventBatches', t0 + 86_400_000);
    resetStoreCachesForTests();
    const status = await getQuotaStatus(t0 + 86_400_000);
    expect(status.perDevice['d_h']?.eventBatches).toBe(1);
  });
});
