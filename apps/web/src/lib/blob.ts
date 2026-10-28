/**
 * Blob storage behind one small interface (architecture §4 "Storage", research 07 §2.1):
 *
 * - `VercelBlobStore` talks to the private Vercel Blob store bound to the project (OIDC on Vercel, or
 *   BLOB_READ_WRITE_TOKEN elsewhere): reads bypass the CDN (`useCache: false`) and honour `ifNoneMatch`,
 *   writes are ETag compare-and-swap (`ifMatch`), `BlobPreconditionFailedError` becomes {@link PreconditionFailed}
 *   and `BlobNotFoundError` becomes `null`.
 * - `MemoryBlobStore` has the same semantics in memory for tests and local development.
 *
 * `getBlobStore()` picks the implementation lazily (never at import); tests swap it with
 * {@link setBlobStoreForTests}.
 */
import { createHash } from 'node:crypto';
import { getEnv, isVercelRuntime } from './env';

export interface BlobGetHit<T> {
  value: T;
  etag: string;
}
export interface BlobNotModified {
  notModified: true;
}
export type BlobGetResult<T> = BlobGetHit<T> | BlobNotModified | null;

export interface BlobListEntry {
  path: string;
  etag: string;
  size: number;
  uploadedAt: string;
}

export interface BlobStore {
  getJson<T>(path: string, opts?: { ifNoneMatch?: string }): Promise<BlobGetResult<T>>;
  putJson(path: string, value: unknown, opts?: { ifMatch?: string; allowOverwrite?: boolean }): Promise<{ etag: string }>;
  /** Raw text (JSONL batches). */
  getText(path: string): Promise<{ text: string; etag: string } | null>;
  putText(path: string, text: string, opts?: { ifMatch?: string; allowOverwrite?: boolean }): Promise<{ etag: string }>;
  del(path: string | string[]): Promise<void>;
  list(prefix: string): Promise<BlobListEntry[]>;
}

/** Thrown by putJson when `ifMatch` does not match the blob's current ETag (HTTP 412 upstream). */
export class PreconditionFailed extends Error {
  override readonly name = 'PreconditionFailed';
  constructor(readonly path: string) {
    super(`precondition failed for ${path}`);
  }
}

/** Thrown by putJson when the path exists and `allowOverwrite` is false. */
export class BlobAlreadyExists extends Error {
  override readonly name = 'BlobAlreadyExists';
  constructor(readonly path: string) {
    super(`blob already exists: ${path}`);
  }
}

export function isNotModified<T>(r: BlobGetResult<T>): r is BlobNotModified {
  return r !== null && 'notModified' in r;
}

/** ETags may arrive quoted or weak; compare the opaque core. */
export function normalizeEtag(etag: string | null | undefined): string {
  if (typeof etag !== 'string') return '';
  return etag.trim().replace(/^W\//i, '').replace(/^"+|"+$/g, '');
}

export function etagsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEtag(a);
  const nb = normalizeEtag(b);
  return na.length > 0 && na === nb;
}

// ---------------------------------------------------------------------------
// Memory implementation
// ---------------------------------------------------------------------------

interface MemoryEntry {
  body: string;
  etag: string;
  uploadedAt: string;
}

export class MemoryBlobStore implements BlobStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private counter = 0;
  /** Operation counters, useful to assert "no Blob touched" in tests. */
  readonly ops = { reads: 0, writes: 0, deletes: 0, lists: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  async getJson<T>(path: string, opts: { ifNoneMatch?: string } = {}): Promise<BlobGetResult<T>> {
    this.ops.reads += 1;
    const entry = this.entries.get(path);
    if (entry === undefined) return null;
    if (opts.ifNoneMatch !== undefined && etagsEqual(opts.ifNoneMatch, entry.etag)) return { notModified: true };
    return { value: JSON.parse(entry.body) as T, etag: entry.etag };
  }

  async putJson(path: string, value: unknown, opts: { ifMatch?: string; allowOverwrite?: boolean } = {}): Promise<{ etag: string }> {
    return this.putText(path, JSON.stringify(value), opts);
  }

  async getText(path: string): Promise<{ text: string; etag: string } | null> {
    this.ops.reads += 1;
    const entry = this.entries.get(path);
    return entry === undefined ? null : { text: entry.body, etag: entry.etag };
  }

  async putText(path: string, text: string, opts: { ifMatch?: string; allowOverwrite?: boolean } = {}): Promise<{ etag: string }> {
    this.ops.writes += 1;
    const existing = this.entries.get(path);
    if (opts.ifMatch !== undefined) {
      if (existing === undefined || !etagsEqual(opts.ifMatch, existing.etag)) throw new PreconditionFailed(path);
    } else if (existing !== undefined && opts.allowOverwrite === false) {
      throw new BlobAlreadyExists(path);
    }
    this.counter += 1;
    const etag = `"${this.counter}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}"`;
    this.entries.set(path, { body: text, etag, uploadedAt: new Date(this.now()).toISOString() });
    return { etag };
  }

  async del(path: string | string[]): Promise<void> {
    this.ops.deletes += 1;
    for (const p of Array.isArray(path) ? path : [path]) this.entries.delete(p);
  }

  async list(prefix: string): Promise<BlobListEntry[]> {
    this.ops.lists += 1;
    const out: BlobListEntry[] = [];
    for (const [path, e] of this.entries) {
      if (path.startsWith(prefix)) out.push({ path, etag: e.etag, size: e.body.length, uploadedAt: e.uploadedAt });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Test helpers. */
  has(path: string): boolean {
    return this.entries.has(path);
  }
  paths(): string[] {
    return [...this.entries.keys()].sort();
  }
  raw(path: string): string | undefined {
    return this.entries.get(path)?.body;
  }
}

// ---------------------------------------------------------------------------
// Vercel implementation
// ---------------------------------------------------------------------------

type BlobSdk = typeof import('@vercel/blob');

export class VercelBlobStore implements BlobStore {
  private sdk: Promise<BlobSdk> | null = null;

  constructor(private readonly token?: string) {}

  private load(): Promise<BlobSdk> {
    if (this.sdk === null) this.sdk = import('@vercel/blob');
    return this.sdk;
  }

  private common(): { token?: string } {
    return this.token === undefined ? {} : { token: this.token };
  }

  private async fetchText(path: string, ifNoneMatch?: string): Promise<{ text: string; etag: string } | { notModified: true } | null> {
    const sdk = await this.load();
    try {
      const res = await sdk.get(path, {
        access: 'private',
        useCache: false,
        ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
        ...this.common(),
      });
      if (res === null) return null;
      if (res.statusCode === 304) return { notModified: true };
      const text = await new Response(res.stream).text();
      return { text, etag: res.blob.etag };
    } catch (err) {
      if (err instanceof sdk.BlobNotFoundError) return null;
      throw err;
    }
  }

  async getJson<T>(path: string, opts: { ifNoneMatch?: string } = {}): Promise<BlobGetResult<T>> {
    const res = await this.fetchText(path, opts.ifNoneMatch);
    if (res === null) return null;
    if ('notModified' in res) return res;
    return { value: JSON.parse(res.text) as T, etag: res.etag };
  }

  async getText(path: string): Promise<{ text: string; etag: string } | null> {
    const res = await this.fetchText(path);
    if (res === null || 'notModified' in res) return null;
    return res;
  }

  async putText(path: string, text: string, opts: { ifMatch?: string; allowOverwrite?: boolean } = {}, contentType = 'application/x-ndjson'): Promise<{ etag: string }> {
    const sdk = await this.load();
    try {
      const res = await sdk.put(path, text, {
        access: 'private',
        allowOverwrite: opts.allowOverwrite ?? true,
        addRandomSuffix: false,
        contentType,
        ...(opts.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
        ...this.common(),
      });
      return { etag: res.etag };
    } catch (err) {
      if (err instanceof sdk.BlobPreconditionFailedError) throw new PreconditionFailed(path);
      // A create-only write (allowOverwrite: false) to an existing path comes back as a 400 "already exists".
      if (opts.allowOverwrite === false && err instanceof sdk.BlobError && /already exists/i.test(err.message)) throw new BlobAlreadyExists(path);
      throw err;
    }
  }

  async putJson(path: string, value: unknown, opts: { ifMatch?: string; allowOverwrite?: boolean } = {}): Promise<{ etag: string }> {
    return this.putText(path, JSON.stringify(value), opts, 'application/json');
  }

  async del(path: string | string[]): Promise<void> {
    const sdk = await this.load();
    const paths = Array.isArray(path) ? path : [path];
    if (paths.length === 0) return;
    await sdk.del(paths, this.common());
  }

  async list(prefix: string): Promise<BlobListEntry[]> {
    const sdk = await this.load();
    const out: BlobListEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await sdk.list({ prefix, limit: 1000, ...(cursor !== undefined ? { cursor } : {}), ...this.common() });
      for (const b of page.blobs) out.push({ path: b.pathname, etag: b.etag, size: b.size, uploadedAt: b.uploadedAt.toISOString() });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let current: BlobStore | null = null;
let memoryFallbackWarned = false;

/** The process-wide store: Vercel Blob on Vercel or with a token, otherwise an in-memory store (local dev). */
export function getBlobStore(): BlobStore {
  if (current !== null) return current;
  const env = getEnv();
  if (env.BLOB_READ_WRITE_TOKEN !== undefined) {
    current = new VercelBlobStore(env.BLOB_READ_WRITE_TOKEN);
  } else if (isVercelRuntime()) {
    current = new VercelBlobStore();
  } else {
    if (!memoryFallbackWarned && env.NODE_ENV !== 'test') {
      memoryFallbackWarned = true;
      console.warn('[jammarly] no Blob token or OIDC available: using the in-memory blob store (data is lost on restart)');
    }
    current = new MemoryBlobStore();
  }
  return current;
}

/** Swap the store (tests, local tooling). Pass null to go back to automatic selection. */
export function setBlobStoreForTests(store: BlobStore | null): void {
  current = store;
}
