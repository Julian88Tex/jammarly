/**
 * Device pairing (research 07 §4.2 option A plus the typed-code fallback): a signed-in user starts a pairing
 * from the dashboard, the extension redeems the 6-digit code once within 10 minutes and receives its bearer
 * token together with that user's profile.
 *
 * The pairing document lives at `users/<uid>/pairings/<id>.json`. The redeem request carries only the pairing
 * id and code, so `auth/pairings/<id>.json` points from the id to the user; both are deleted on redeem.
 */
import { z } from 'zod';
import type { PairRedeemRequest, PairRedeemResponse, PairStartResponse } from '@jammarly/shared/api';
import { PreconditionFailed, isNotModified } from './blob';
import { newPairingCode, randomHex, safeEqual, sha256Hex } from './crypto';
import { createDevice } from './devices';
import { ApiRouteError } from './errors';
import { GLOBAL_PATHS, blob, isUserId, loadProfile, userPaths } from './store';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface PairingDoc {
  codeHash: string;
  expiresAt: string;
  used: boolean;
  createdAt: string;
}

export const PairRedeemSchema = z.object({
  pairingId: z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex pairing id'),
  code: z.string().regex(/^\d{6}$/, 'expected a 6-digit code'),
  device: z.object({
    name: z.string().min(1).max(80),
    platform: z.string().min(1).max(40),
    extVersion: z.string().min(1).max(40),
  }),
}) satisfies z.ZodType<PairRedeemRequest>;

interface PairingPointer {
  uid: string;
  expiresAt: string;
}

export async function startPairing(uid: string, nowMs: number = Date.now()): Promise<PairStartResponse> {
  const store = blob();
  const pairingId = randomHex(8);
  const code = newPairingCode();
  const expiresAt = new Date(nowMs + PAIRING_TTL_MS).toISOString();
  const doc: PairingDoc = { codeHash: sha256Hex(code), expiresAt, used: false, createdAt: new Date(nowMs).toISOString() };
  await store.putJson(userPaths(uid).pairing(pairingId), doc, { allowOverwrite: false });
  const pointer: PairingPointer = { uid, expiresAt };
  await store.putJson(GLOBAL_PATHS.pairing(pairingId), pointer, { allowOverwrite: false });
  return { pairingId, code, expiresAt };
}

export async function redeemPairing(body: PairRedeemRequest, nowMs: number = Date.now()): Promise<PairRedeemResponse> {
  const store = blob();
  const pointerPath = GLOBAL_PATHS.pairing(body.pairingId);
  const pointer = await store.getJson<PairingPointer>(pointerPath);
  if (pointer === null || isNotModified(pointer) || !isUserId(pointer.value?.uid)) throw new ApiRouteError(400, 'pairing_invalid', 'Unknown pairing. Start a new one from the dashboard.');
  const uid = pointer.value.uid;
  const path = userPaths(uid).pairing(body.pairingId);
  const res = await store.getJson<PairingDoc>(path);
  if (res === null || isNotModified(res)) {
    await store.del(pointerPath);
    throw new ApiRouteError(400, 'pairing_invalid', 'Unknown pairing. Start a new one from the dashboard.');
  }
  const doc = res.value;
  if (doc.used) throw new ApiRouteError(400, 'pairing_invalid', 'This pairing code was already used.');
  if (Date.parse(doc.expiresAt) <= nowMs) {
    await store.del([path, pointerPath]);
    throw new ApiRouteError(410, 'pairing_expired', 'This pairing code expired. Start a new one from the dashboard.');
  }
  if (!safeEqual(sha256Hex(body.code), doc.codeHash)) throw new ApiRouteError(400, 'pairing_invalid', 'Wrong code.');
  try {
    await store.putJson(path, { ...doc, used: true }, { ifMatch: res.etag });
  } catch (err) {
    if (err instanceof PreconditionFailed) throw new ApiRouteError(400, 'pairing_invalid', 'This pairing code was already used.');
    throw err;
  }
  await store.del([path, pointerPath]);
  const { device, token } = await createDevice(uid, body.device, nowMs);
  const loaded = await loadProfile(uid, nowMs);
  return { deviceId: device.id, token, profile: loaded.profile, etag: loaded.etag, version: loaded.version };
}
