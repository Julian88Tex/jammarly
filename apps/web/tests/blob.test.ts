import { describe, expect, it } from 'vitest';
import { BlobAlreadyExists, MemoryBlobStore, PreconditionFailed, etagsEqual, isNotModified, normalizeEtag } from '@/lib/blob';

describe('MemoryBlobStore CAS semantics', () => {
  it('round-trips JSON and returns a fresh etag per write', async () => {
    const store = new MemoryBlobStore();
    const a = await store.putJson('x/a.json', { n: 1 });
    const b = await store.putJson('x/a.json', { n: 2 });
    expect(a.etag).not.toBe(b.etag);
    const got = await store.getJson<{ n: number }>('x/a.json');
    expect(got !== null && !isNotModified(got) && got.value.n).toBe(2);
    expect(got !== null && !isNotModified(got) && got.etag).toBe(b.etag);
  });

  it('returns null for a missing path', async () => {
    const store = new MemoryBlobStore();
    expect(await store.getJson('missing.json')).toBeNull();
    expect(await store.getText('missing.jsonl')).toBeNull();
  });

  it('throws PreconditionFailed when ifMatch does not match', async () => {
    const store = new MemoryBlobStore();
    const { etag } = await store.putJson('p.json', { v: 1 });
    await expect(store.putJson('p.json', { v: 2 }, { ifMatch: '"stale"' })).rejects.toBeInstanceOf(PreconditionFailed);
    const ok = await store.putJson('p.json', { v: 2 }, { ifMatch: etag });
    expect(ok.etag).not.toBe(etag);
    await expect(store.putJson('p.json', { v: 3 }, { ifMatch: etag })).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('throws PreconditionFailed for ifMatch on a path that does not exist yet', async () => {
    const store = new MemoryBlobStore();
    await expect(store.putJson('new.json', {}, { ifMatch: '"x"' })).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('honours the overwrite flag', async () => {
    const store = new MemoryBlobStore();
    await store.putJson('o.json', { v: 1 }, { allowOverwrite: false });
    await expect(store.putJson('o.json', { v: 2 }, { allowOverwrite: false })).rejects.toBeInstanceOf(BlobAlreadyExists);
    await store.putJson('o.json', { v: 3 });
    await store.putJson('o.json', { v: 4 }, { allowOverwrite: true });
    expect(store.raw('o.json')).toBe('{"v":4}');
  });

  it('answers notModified for a matching If-None-Match (quoted or weak)', async () => {
    const store = new MemoryBlobStore();
    const { etag } = await store.putJson('c.json', { v: 1 });
    expect(isNotModified(await store.getJson('c.json', { ifNoneMatch: etag }))).toBe(true);
    expect(isNotModified(await store.getJson('c.json', { ifNoneMatch: `W/${etag}` }))).toBe(true);
    expect(isNotModified(await store.getJson('c.json', { ifNoneMatch: '"other"' }))).toBe(false);
  });

  it('lists by prefix and deletes one or many paths', async () => {
    const store = new MemoryBlobStore(() => 1_700_000_000_000);
    await store.putJson('users/u1/events/2026-01-01/d1.jsonl', []);
    await store.putJson('users/u1/events/2026-01-02/d1.jsonl', []);
    await store.putJson('users/u1/samples/2026-01-01/d1.jsonl', []);
    const events = await store.list('users/u1/events/');
    expect(events.map((e) => e.path)).toEqual(['users/u1/events/2026-01-01/d1.jsonl', 'users/u1/events/2026-01-02/d1.jsonl']);
    expect(events[0]?.uploadedAt).toBe('2023-11-14T22:13:20.000Z');
    await store.del(['users/u1/events/2026-01-01/d1.jsonl', 'users/u1/events/2026-01-02/d1.jsonl']);
    expect(await store.list('users/u1/events/')).toEqual([]);
    expect(store.has('users/u1/samples/2026-01-01/d1.jsonl')).toBe(true);
  });

  it('normalizes etags for comparison', () => {
    expect(normalizeEtag('W/"abc"')).toBe('abc');
    expect(etagsEqual('"abc"', 'abc')).toBe(true);
    expect(etagsEqual('', '')).toBe(false);
    expect(etagsEqual(null, '"x"')).toBe(false);
  });
});
