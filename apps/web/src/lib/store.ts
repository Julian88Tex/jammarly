/**
 * Each user's documents in Blob (architecture §4 "Storage"): the profile with ETag compare-and-swap, the tiny
 * version document and its 60-second in-memory cache, snapshots, the op path with its allowlist and quota, and
 * the Blob operation / per-device counters in quota.json.
 *
 * Every Blob call from the web app goes through {@link blob} (a counting wrapper) so the month's operation
 * counters stay roughly right for the dashboard's 80 % warning.
 */
import { createClock, parseHlc, type HlcClock } from '@jammarly/shared/hlc';
import { applyOps, cloneData, isLwwPath, isSetPath, migrateProfile, ProfileDocumentSchema, ProfileOpSchema } from '@jammarly/shared/merge';
import { defaultProfile, type Hlc, type ProfileDocument, type ProfileOp } from '@jammarly/shared/profile';
import { getBlobStore, type BlobGetResult, type BlobListEntry, type BlobStore, etagsEqual, isNotModified, PreconditionFailed } from './blob';
import { randomHex } from './crypto';
import { ApiRouteError } from './errors';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A user id is the JSlice `sub` (the stable Google subject). It becomes a Blob path segment, so it is checked
 * strictly before any path is built.
 */
export const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isUserId(uid: unknown): uid is string {
  return typeof uid === 'string' && USER_ID_RE.test(uid);
}

export function assertUserId(uid: string): string {
  if (!isUserId(uid)) throw new Error('invalid user id');
  return uid;
}

/** Every per-user document lives under `users/<uid>/`. */
export function userPrefix(uid: string): string {
  return `users/${assertUserId(uid)}`;
}

export function userPaths(uid: string) {
  const base = userPrefix(uid);
  return {
    account: `${base}/account.json`,
    profile: `${base}/profile.json`,
    version: `${base}/version.json`,
    snapshotPrefix: `${base}/snapshots/`,
    snapshot: (version: number): string => `${base}/snapshots/profile.v${version}.json`,
    devices: `${base}/devices.json`,
    pairing: (id: string): string => `${base}/pairings/${id}.json`,
    eventsPrefix: `${base}/events/`,
    eventsIndex: `${base}/events/index.json`,
    eventsBatch: (day: string, deviceId: string): string => `${base}/events/${day}/${deviceId}.jsonl`,
    samplesPrefix: `${base}/samples/`,
    samplesBatch: (day: string, deviceId: string): string => `${base}/samples/${day}/${deviceId}.jsonl`,
    runsPrefix: `${base}/runs/`,
    run: (date: string, ctx: string): string => `${base}/runs/${date}-${ctx}.json`,
    runsLatest: `${base}/runs/latest.json`,
    serverKey: `${base}/server-key.json`,
  } as const;
}

export type UserPaths = ReturnType<typeof userPaths>;

/**
 * Lookups that must work before the user is known, plus the store-wide Blob counters. They hold pointers
 * (`{ uid }`) or one-time markers, never user data.
 */
export const GLOBAL_PATHS = {
  /** One marker per user; the cron lists this prefix to find every user. */
  usersPrefix: 'auth/users/',
  user: (uid: string): string => `auth/users/${assertUserId(uid)}.json`,
  /** deviceId -> { uid }, so a bearer token resolves to its user. */
  device: (deviceId: string): string => `auth/devices/${deviceId}.json`,
  /** pairingId -> { uid }, so the unauthenticated redeem finds the user's pairing document. */
  pairing: (id: string): string => `auth/pairings/${id}.json`,
  /** Used JSlice token ids (sha256), kept so a token works once. */
  jtiPrefix: 'auth/jti/',
  jti: (hash: string): string => `auth/jti/${hash}.json`,
  /** Blob operation counters for the whole store (the Hobby budget is per store) and per-device write counters. */
  quota: 'system/quota.json',
} as const;

export const HLC_SKEW_MS = 5 * 60 * 1000;
export const PROFILE_WRITES_PER_HOUR = 10;
export const EVENT_BATCHES_PER_DAY = 6;
export const VERSION_CACHE_MS = 60_000;
export const SNAPSHOT_EVERY = 10;
export const SAVE_RETRIES = 3;
export const MAX_OPS_PER_REQUEST = 200;

/** Hobby plan monthly Blob budget (research 07 reviewer item 10). */
export const BLOB_LIMITS = { advancedOps: 2000, simpleOps: 10000 } as const;

// ---------------------------------------------------------------------------
// Counting wrapper and the quota document
// ---------------------------------------------------------------------------

export interface QuotaDeviceCounters {
  day: string;
  profileWrites: number;
  eventBatches: number;
  /** "YYYY-MM-DDTHH" of the running hour and the profile writes inside it (10/hour rule). */
  hour: string;
  hourProfileWrites: number;
}

export interface QuotaDoc {
  month: string;
  advancedOps: number;
  simpleOps: number;
  perDevice: Record<string, QuotaDeviceCounters>;
}

const pending = { simple: 0, advanced: 0 };
let quotaCache: { doc: QuotaDoc; at: number } | null = null;
/** Per-user { version, etag } written or read within the last 60 s (bounded; cleared when it grows large). */
const versionCache = new Map<string, { version: number; etag: string; at: number }>();
const VERSION_CACHE_MAX_USERS = 5000;
const serverClock: HlcClock = createClock('server');

export function serverHlc(): Hlc {
  return serverClock.next();
}

/** A clock value strictly greater than `seen` and than everything the server issued so far. */
export function serverHlcAfter(seen: Hlc): Hlc {
  serverClock.receive(seen);
  return serverClock.next();
}

class CountingStore implements BlobStore {
  constructor(private readonly inner: BlobStore) {}
  getJson<T>(path: string, opts?: { ifNoneMatch?: string }): Promise<BlobGetResult<T>> {
    pending.simple += 1;
    return this.inner.getJson<T>(path, opts);
  }
  putJson(path: string, value: unknown, opts?: { ifMatch?: string; allowOverwrite?: boolean }): Promise<{ etag: string }> {
    pending.advanced += 1;
    return this.inner.putJson(path, value, opts);
  }
  getText(path: string): Promise<{ text: string; etag: string } | null> {
    pending.simple += 1;
    return this.inner.getText(path);
  }
  putText(path: string, text: string, opts?: { ifMatch?: string; allowOverwrite?: boolean }): Promise<{ etag: string }> {
    pending.advanced += 1;
    return this.inner.putText(path, text, opts);
  }
  del(path: string | string[]): Promise<void> {
    return this.inner.del(path);
  }
  list(prefix: string): Promise<BlobListEntry[]> {
    pending.advanced += 1;
    return this.inner.list(prefix);
  }
}

/** The counting store every module uses. */
export function blob(): BlobStore {
  return new CountingStore(getBlobStore());
}

/** Forget in-memory caches (tests swap the blob store between cases). */
export function resetStoreCachesForTests(): void {
  quotaCache = null;
  versionCache.clear();
  pending.simple = 0;
  pending.advanced = 0;
}

export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function hourOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

function emptyQuota(nowMs: number): QuotaDoc {
  return { month: monthOf(nowMs), advancedOps: 0, simpleOps: 0, perDevice: {} };
}

async function loadQuota(nowMs: number): Promise<QuotaDoc> {
  if (quotaCache !== null && nowMs - quotaCache.at < VERSION_CACHE_MS) return quotaCache.doc;
  const res = await getBlobStore().getJson<QuotaDoc>(GLOBAL_PATHS.quota);
  pending.simple += 1;
  let doc: QuotaDoc = res !== null && !isNotModified(res) && typeof res.value === 'object' && res.value !== null ? res.value : emptyQuota(nowMs);
  if (doc.month !== monthOf(nowMs)) doc = emptyQuota(nowMs);
  if (typeof doc.perDevice !== 'object' || doc.perDevice === null) doc.perDevice = {};
  // Counters of devices that wrote nothing today are worthless; drop them so the document stays small.
  const today = dayOf(nowMs);
  for (const [id, dev] of Object.entries(doc.perDevice)) if (dev?.day !== today) delete doc.perDevice[id];
  quotaCache = { doc, at: nowMs };
  return doc;
}

/** Fold the pending operation counters into the quota document and persist it (one advanced op). */
export async function persistQuota(nowMs: number = Date.now()): Promise<QuotaDoc> {
  const doc = await loadQuota(nowMs);
  doc.advancedOps += pending.advanced + 1; // + this write
  doc.simpleOps += pending.simple;
  pending.advanced = 0;
  pending.simple = 0;
  await getBlobStore().putJson(GLOBAL_PATHS.quota, doc);
  quotaCache = { doc, at: nowMs };
  return doc;
}

export interface QuotaStatus {
  month: string;
  advancedOps: number;
  simpleOps: number;
  limits: { advancedOps: number; simpleOps: number };
  perDevice: Record<string, QuotaDeviceCounters>;
}

/**
 * Current store-wide counters including operations not yet persisted. `deviceIds` limits the per-device
 * counters to those devices (a user only ever sees their own).
 */
export async function getQuotaStatus(deviceIds: readonly string[], nowMs: number = Date.now()): Promise<QuotaStatus> {
  const doc = await loadQuota(nowMs);
  const perDevice: Record<string, QuotaDeviceCounters> = {};
  for (const id of deviceIds) {
    const dev = doc.perDevice[id];
    if (dev !== undefined) perDevice[id] = cloneData(dev);
  }
  return {
    month: doc.month,
    advancedOps: doc.advancedOps + pending.advanced,
    simpleOps: doc.simpleOps + pending.simple,
    limits: { ...BLOB_LIMITS },
    perDevice,
  };
}

/**
 * Enforce and record a per-device write (10 profile writes per hour, 6 event batches per day) and persist
 * the quota document. Throws 429 quota_exceeded.
 */
export async function bumpDeviceQuota(deviceId: string, kind: 'profileWrites' | 'eventBatches', nowMs: number = Date.now()): Promise<void> {
  const doc = await loadQuota(nowMs);
  const day = dayOf(nowMs);
  const hour = hourOf(nowMs);
  let dev = doc.perDevice[deviceId];
  if (dev === undefined || dev.day !== day) dev = { day, profileWrites: 0, eventBatches: 0, hour, hourProfileWrites: 0 };
  if (dev.hour !== hour) {
    dev.hour = hour;
    dev.hourProfileWrites = 0;
  }
  if (kind === 'profileWrites' && dev.hourProfileWrites >= PROFILE_WRITES_PER_HOUR) {
    throw new ApiRouteError(429, 'quota_exceeded', `This device already wrote the profile ${PROFILE_WRITES_PER_HOUR} times this hour.`);
  }
  if (kind === 'eventBatches' && dev.eventBatches >= EVENT_BATCHES_PER_DAY) {
    throw new ApiRouteError(429, 'quota_exceeded', `This device already uploaded ${EVENT_BATCHES_PER_DAY} event batches today.`);
  }
  if (kind === 'profileWrites') {
    dev.profileWrites += 1;
    dev.hourProfileWrites += 1;
  } else {
    dev.eventBatches += 1;
  }
  doc.perDevice[deviceId] = dev;
  quotaCache = { doc, at: nowMs };
  await persistQuota(nowMs);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface ProfileLoaded {
  profile: ProfileDocument;
  etag: string;
  version: number;
}

/** Thrown by saveProfile when the caller's If-Match is stale (412) or when every CAS retry lost (412 conflict_retry). */
export class ProfileConflict extends Error {
  override readonly name = 'ProfileConflict';
  constructor(
    readonly current: ProfileLoaded,
    readonly code: 'precondition_failed' | 'conflict_retry',
  ) {
    super(code === 'precondition_failed' ? 'The profile changed since you read it.' : 'The profile kept changing; retry.');
  }
}

function rememberVersion(uid: string, version: number, etag: string, nowMs: number): void {
  if (versionCache.size >= VERSION_CACHE_MAX_USERS && !versionCache.has(uid)) versionCache.clear();
  versionCache.set(uid, { version, etag, at: nowMs });
}

/** The user's cached { version, etag } when it was written or read within the last 60 s. */
export function cachedVersion(uid: string, nowMs: number = Date.now()): { version: number; etag: string } | null {
  const hit = versionCache.get(uid);
  if (hit === undefined || nowMs - hit.at >= VERSION_CACHE_MS) return null;
  return { version: hit.version, etag: hit.etag };
}

async function createInitialProfile(uid: string, nowMs: number): Promise<ProfileLoaded> {
  const PATHS = userPaths(uid);
  const store = blob();
  const nowIso = new Date(nowMs).toISOString();
  const doc = defaultProfile(nowIso);
  doc.updatedBy = 'server';
  doc.settings.userSalt = { value: randomHex(32), hlc: serverHlc() };
  try {
    const { etag } = await store.putJson(PATHS.profile, doc, { allowOverwrite: false });
    rememberVersion(uid, doc.version, etag, nowMs);
    await store.putJson(PATHS.version, { version: doc.version, etag });
    return { profile: doc, etag, version: doc.version };
  } catch {
    // Lost the race with another first read: use what is there now.
    const again = await store.getJson<unknown>(PATHS.profile);
    if (again === null || isNotModified(again)) throw new Error('profile could not be created');
    const profile = migrateProfile(again.value);
    rememberVersion(uid, profile.version, again.etag, nowMs);
    return { profile, etag: again.etag, version: profile.version };
  }
}

/** Read the user's profile (creating the default document on first read). */
export async function loadProfile(uid: string, nowMs: number = Date.now()): Promise<ProfileLoaded> {
  const res = await blob().getJson<unknown>(userPaths(uid).profile);
  if (res === null) return createInitialProfile(uid, nowMs);
  if (isNotModified(res)) throw new Error('unexpected 304 without If-None-Match');
  const profile = migrateProfile(res.value);
  rememberVersion(uid, profile.version, res.etag, nowMs);
  return { profile, etag: res.etag, version: profile.version };
}

/**
 * Conditional read for GET /api/profile: answers "not modified" from the 60-second cache without touching
 * Blob when the client's ETag is the one last written or read, otherwise asks Blob with If-None-Match.
 */
export async function loadProfileConditional(uid: string, ifNoneMatch: string | null, nowMs: number = Date.now()): Promise<ProfileLoaded | { notModified: true; etag: string; version: number }> {
  if (ifNoneMatch !== null) {
    const cached = cachedVersion(uid, nowMs);
    if (cached !== null && etagsEqual(ifNoneMatch, cached.etag)) return { notModified: true, etag: cached.etag, version: cached.version };
    const res = await blob().getJson<unknown>(userPaths(uid).profile, { ifNoneMatch });
    if (res === null) return createInitialProfile(uid, nowMs);
    if (isNotModified(res)) {
      // Cold cache: version.json is one cheap read and refreshes the cache.
      const v = cachedVersion(uid, nowMs) ?? (await getProfileVersion(uid, nowMs));
      return { notModified: true, etag: ifNoneMatch, version: v.version };
    }
    const profile = migrateProfile(res.value);
    rememberVersion(uid, profile.version, res.etag, nowMs);
    return { profile, etag: res.etag, version: profile.version };
  }
  return loadProfile(uid, nowMs);
}

/** { version, etag } for the polling route: the module cache for 60 s, then version.json, then the profile. */
export async function getProfileVersion(uid: string, nowMs: number = Date.now()): Promise<{ version: number; etag: string }> {
  const cached = cachedVersion(uid, nowMs);
  if (cached !== null) return cached;
  const res = await blob().getJson<{ version: number; etag: string }>(userPaths(uid).version);
  if (res !== null && !isNotModified(res) && typeof res.value?.version === 'number' && typeof res.value.etag === 'string') {
    rememberVersion(uid, res.value.version, res.value.etag, nowMs);
    return { version: res.value.version, etag: res.value.etag };
  }
  const loaded = await loadProfile(uid, nowMs);
  return { version: loaded.version, etag: loaded.etag };
}

export interface SaveProfileOptions {
  /** The ETag the caller read; a mismatch is a 412 without retry (PUT semantics). */
  ifMatch?: string;
  by?: string;
  nowMs?: number;
  /** Also write an immutable snapshot regardless of the version (the learning job does). */
  snapshot?: boolean;
}

/**
 * Read-mutate-write with ETag CAS, up to 3 attempts. `mutate` receives a copy of the current document and
 * returns the next one (it may throw an ApiRouteError to abort). The version is incremented on every
 * accepted write, version.json is refreshed, and every 10th version gets a snapshot.
 */
export async function saveProfile(uid: string, mutate: (doc: ProfileDocument) => ProfileDocument, opts: SaveProfileOptions = {}): Promise<ProfileLoaded> {
  const PATHS = userPaths(uid);
  const store = blob();
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let last: ProfileLoaded | null = null;
  for (let attempt = 0; attempt < SAVE_RETRIES; attempt += 1) {
    const current = await loadProfile(uid, nowMs);
    last = current;
    if (opts.ifMatch !== undefined && !etagsEqual(opts.ifMatch, current.etag)) throw new ProfileConflict(current, 'precondition_failed');
    const mutated = mutate(cloneData(current.profile));
    const parsed = ProfileDocumentSchema.safeParse(mutated);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiRouteError(400, 'schema_invalid', `Profile is invalid at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'validation failed'}`);
    }
    const next = parsed.data;
    next.version = current.version + 1;
    next.updatedAt = next.updatedAt > nowIso ? next.updatedAt : nowIso;
    if (opts.by !== undefined) next.updatedBy = opts.by;
    try {
      const { etag } = await store.putJson(PATHS.profile, next, { ifMatch: current.etag, allowOverwrite: true });
      rememberVersion(uid, next.version, etag, nowMs);
      await store.putJson(PATHS.version, { version: next.version, etag });
      if (opts.snapshot === true || next.version % SNAPSHOT_EVERY === 0) {
        await store.putJson(PATHS.snapshot(next.version), next);
      }
      return { profile: next, etag, version: next.version };
    } catch (err) {
      if (err instanceof PreconditionFailed) continue;
      throw err;
    }
  }
  throw new ProfileConflict(last ?? (await loadProfile(uid, nowMs)), 'conflict_retry');
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/** Who is writing: one of the user's devices, the user on the dashboard, or the learning job. */
export type Actor = { kind: 'device'; deviceId: string } | { kind: 'user' } | { kind: 'cron' };

export function actorName(actor: Actor): string {
  if (actor.kind === 'device') return actor.deviceId;
  return actor.kind === 'user' ? 'dashboard' : 'cron';
}

/** Structural validation, allowlist and clock-skew checks for a batch of ops (400 errors). */
export function validateOps(rawOps: unknown, actor: Actor, nowMs: number): ProfileOp[] {
  if (!Array.isArray(rawOps) || rawOps.length === 0) throw new ApiRouteError(400, 'schema_invalid', 'ops must be a non-empty array.');
  if (rawOps.length > MAX_OPS_PER_REQUEST) throw new ApiRouteError(400, 'schema_invalid', `At most ${MAX_OPS_PER_REQUEST} ops per request.`);
  const ops: ProfileOp[] = [];
  rawOps.forEach((raw, i) => {
    const parsed = ProfileOpSchema.safeParse(raw);
    if (!parsed.success) {
      const kind = typeof raw === 'object' && raw !== null ? (raw as { op?: unknown }).op : undefined;
      const known = kind === 'set' || kind === 'add' || kind === 'remove' || kind === 'voice' || kind === 'learning';
      if (!known) throw new ApiRouteError(400, 'op_not_allowed', `ops[${i}]: unknown op.`);
      throw new ApiRouteError(400, 'schema_invalid', `ops[${i}]: ${parsed.error.issues[0]?.message ?? 'invalid op'}`);
    }
    const op = parsed.data;
    if (op.op === 'voice' || op.op === 'learning') {
      if (actor.kind === 'device') throw new ApiRouteError(400, 'op_not_allowed', `ops[${i}]: '${op.op}' ops are accepted only from the dashboard or the learning job.`);
    } else if (op.op === 'set') {
      if (!isLwwPath(op.path)) throw new ApiRouteError(400, 'op_not_allowed', `ops[${i}]: path not allowed: ${op.path}`);
    } else if (!isSetPath(op.path)) {
      throw new ApiRouteError(400, 'op_not_allowed', `ops[${i}]: path not allowed: ${op.path}`);
    }
    const hlc = parseHlc(op.hlc);
    if (hlc === null) throw new ApiRouteError(400, 'schema_invalid', `ops[${i}]: invalid hlc.`);
    if (hlc.wallMs > nowMs + HLC_SKEW_MS) throw new ApiRouteError(400, 'hlc_skew', `ops[${i}]: clock is more than 5 minutes ahead of the server.`);
    ops.push(op as ProfileOp);
  });
  return ops;
}

/** Validate, enforce the device quota, merge with the shared rules and write (CAS with retries). */
export async function applyProfileOps(uid: string, rawOps: unknown, actor: Actor, nowMs: number = Date.now()): Promise<ProfileLoaded> {
  const ops = validateOps(rawOps, actor, nowMs);
  if (actor.kind === 'device') await bumpDeviceQuota(actor.deviceId, 'profileWrites', nowMs);
  const nowIso = new Date(nowMs).toISOString();
  return saveProfile(
    uid,
    (doc) => {
      const result = applyOps(doc, ops, { now: nowIso, by: actorName(actor) });
      const rejected = result.rejected[0];
      if (rejected !== undefined) {
        const code = rejected.reason === 'op_not_allowed' ? 'op_not_allowed' : 'schema_invalid';
        throw new ApiRouteError(400, code, `op rejected: ${rejected.message ?? rejected.reason}`);
      }
      return result.doc;
    },
    { by: actorName(actor), nowMs },
  );
}

/** List the snapshot blobs (an advanced op; never on the hot path). */
export async function listSnapshots(uid: string): Promise<BlobListEntry[]> {
  return blob().list(userPaths(uid).snapshotPrefix);
}
