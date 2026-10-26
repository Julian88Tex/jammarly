/**
 * Paired devices (`users/<uid>/devices.json`): metadata plus the SHA-256 of each bearer secret. Tokens are
 * `jm1.<deviceId>.<secret>`; only the hash is stored. Rotation keeps the previous hash valid for 5 minutes.
 *
 * Device ids are random and global, so a token names its device but not its user: `auth/devices/<deviceId>.json`
 * holds `{ uid }` and is written once when the device is created. The mapping never changes, so it is also
 * cached in memory.
 */
import type { DeviceInfo, RotateResponse } from '@jammarly/shared/api';
import { PreconditionFailed, isNotModified } from './blob';
import { newDeviceId, newSecret, safeEqual, sha256Hex } from './crypto';
import { ApiRouteError } from './errors';
import { GLOBAL_PATHS, blob, isUserId, userPaths } from './store';

export interface StoredDevice extends DeviceInfo {
  tokenHash: string;
  revoked?: boolean;
  prevTokenHash?: string;
  prevValidUntil?: string;
}

export interface DevicesDoc {
  devices: StoredDevice[];
}

export const ROTATE_GRACE_MS = 5 * 60 * 1000;
export const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000;
const TOKEN_RE = /^jm1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16,128})$/;

export function makeToken(deviceId: string, secret: string): string {
  return `jm1.${deviceId}.${secret}`;
}

export function parseToken(token: string): { deviceId: string; secret: string } | null {
  const m = TOKEN_RE.exec(token);
  if (m === null) return null;
  const deviceId = m[1];
  const secret = m[2];
  if (deviceId === undefined || secret === undefined) return null;
  return { deviceId, secret };
}

export function publicDevice(d: StoredDevice): DeviceInfo {
  return { id: d.id, name: d.name, platform: d.platform, extVersion: d.extVersion, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}

export async function loadDevices(uid: string): Promise<{ doc: DevicesDoc; etag: string | null }> {
  const res = await blob().getJson<DevicesDoc>(userPaths(uid).devices);
  if (res === null || isNotModified(res)) return { doc: { devices: [] }, etag: null };
  const devices = Array.isArray(res.value?.devices) ? res.value.devices : [];
  return { doc: { devices }, etag: res.etag };
}

/** Read-mutate-write with CAS (3 attempts). `mutate` edits the document in place. */
export async function saveDevices(uid: string, mutate: (doc: DevicesDoc) => void): Promise<DevicesDoc> {
  const store = blob();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { doc, etag } = await loadDevices(uid);
    mutate(doc);
    try {
      await store.putJson(userPaths(uid).devices, doc, etag === null ? { allowOverwrite: false } : { ifMatch: etag });
      return doc;
    } catch (err) {
      if (err instanceof PreconditionFailed || (err instanceof Error && err.name === 'BlobAlreadyExists')) continue;
      throw err;
    }
  }
  throw new ApiRouteError(409, 'conflict_retry', 'The device list kept changing; retry.');
}

export interface NewDeviceInput {
  name: string;
  platform: string;
  extVersion: string;
}

interface DeviceIndexDoc {
  uid: string;
  createdAt: string;
}

const deviceOwners = new Map<string, string>();

export function resetDeviceIndexCacheForTests(): void {
  deviceOwners.clear();
}

/** The user a device belongs to, or null for an unknown device id. */
export async function deviceOwner(deviceId: string): Promise<string | null> {
  const cached = deviceOwners.get(deviceId);
  if (cached !== undefined) return cached;
  const res = await blob().getJson<DeviceIndexDoc>(GLOBAL_PATHS.device(deviceId));
  if (res === null || isNotModified(res) || !isUserId(res.value?.uid)) return null;
  if (deviceOwners.size > 10_000) deviceOwners.clear();
  deviceOwners.set(deviceId, res.value.uid);
  return res.value.uid;
}

export async function createDevice(uid: string, input: NewDeviceInput, nowMs: number = Date.now()): Promise<{ device: DeviceInfo; token: string }> {
  const id = newDeviceId();
  const secret = newSecret();
  const nowIso = new Date(nowMs).toISOString();
  const stored: StoredDevice = {
    id,
    name: input.name,
    platform: input.platform,
    extVersion: input.extVersion,
    createdAt: nowIso,
    lastSeenAt: nowIso,
    tokenHash: sha256Hex(secret),
  };
  // The index first: a device listed for a user always resolves back to that user.
  const index: DeviceIndexDoc = { uid, createdAt: nowIso };
  await blob().putJson(GLOBAL_PATHS.device(id), index, { allowOverwrite: false });
  deviceOwners.set(id, uid);
  await saveDevices(uid, (doc) => {
    doc.devices.push(stored);
  });
  return { device: publicDevice(stored), token: makeToken(id, secret) };
}

export async function listDevices(uid: string): Promise<DeviceInfo[]> {
  const { doc } = await loadDevices(uid);
  return doc.devices.map(publicDevice);
}

/** Mark a device revoked (its token stops working immediately). Returns false when unknown. */
export async function revokeDevice(uid: string, id: string): Promise<boolean> {
  let found = false;
  await saveDevices(uid, (doc) => {
    const d = doc.devices.find((x) => x.id === id);
    if (d === undefined) return;
    found = true;
    d.revoked = true;
    d.tokenHash = '';
    delete d.prevTokenHash;
    delete d.prevValidUntil;
  });
  return found;
}

/** Issue a new secret; the old one stays valid for ROTATE_GRACE_MS. */
export async function rotateDevice(uid: string, id: string, nowMs: number = Date.now()): Promise<RotateResponse> {
  const secret = newSecret();
  const previousValidUntil = new Date(nowMs + ROTATE_GRACE_MS).toISOString();
  let found = false;
  await saveDevices(uid, (doc) => {
    const d = doc.devices.find((x) => x.id === id && x.revoked !== true);
    if (d === undefined) return;
    found = true;
    d.prevTokenHash = d.tokenHash;
    d.prevValidUntil = previousValidUntil;
    d.tokenHash = sha256Hex(secret);
  });
  if (!found) throw new ApiRouteError(404, 'not_found', 'Unknown device.');
  return { token: makeToken(id, secret), previousValidUntil };
}

export type DeviceAuthResult = { status: 'ok'; uid: string; device: StoredDevice } | { status: 'revoked' } | { status: 'unknown' };

export async function authenticateDeviceToken(token: string, nowMs: number = Date.now()): Promise<DeviceAuthResult> {
  const parsed = parseToken(token);
  if (parsed === null) return { status: 'unknown' };
  const uid = await deviceOwner(parsed.deviceId);
  if (uid === null) return { status: 'unknown' };
  const { doc } = await loadDevices(uid);
  const device = doc.devices.find((d) => d.id === parsed.deviceId);
  if (device === undefined) return { status: 'unknown' };
  if (device.revoked === true) return { status: 'revoked' };
  const hash = sha256Hex(parsed.secret);
  if (device.tokenHash.length > 0 && safeEqual(hash, device.tokenHash)) return { status: 'ok', uid, device };
  if (
    device.prevTokenHash !== undefined &&
    device.prevValidUntil !== undefined &&
    Date.parse(device.prevValidUntil) > nowMs &&
    safeEqual(hash, device.prevTokenHash)
  ) {
    return { status: 'ok', uid, device };
  }
  return { status: 'unknown' };
}

/** Update lastSeenAt at most once per hour (a Blob write otherwise happens on every request). */
export async function touchLastSeen(uid: string, device: StoredDevice, nowMs: number = Date.now()): Promise<void> {
  const last = Date.parse(device.lastSeenAt);
  if (Number.isFinite(last) && nowMs - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
  const nowIso = new Date(nowMs).toISOString();
  try {
    await saveDevices(uid, (doc) => {
      const d = doc.devices.find((x) => x.id === device.id);
      if (d !== undefined) d.lastSeenAt = nowIso;
    });
  } catch {
    // Best effort; never fail the request over a last-seen timestamp.
  }
}
