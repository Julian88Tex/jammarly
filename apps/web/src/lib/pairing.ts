/**
 * Device pairing (research 07 §4.2 option A plus the typed-code fallback): the owner starts a pairing from
 * the dashboard, the extension redeems the 6-digit code once within 10 minutes and receives its bearer token
 * together with the current profile.
 */
import { z } from 'zod';
import type { PairRedeemRequest, PairRedeemResponse, PairStartResponse } from '@jammarly/shared/api';
import { PreconditionFailed, isNotModified } from './blob';
import { newPairingCode, randomHex, safeEqual, sha256Hex } from './crypto';
import { createDevice } from './devices';
import { ApiRouteError } from './errors';
import { PATHS, blob, loadProfile } from './store';

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

export async function startPairing(nowMs: number = Date.now()): Promise<PairStartResponse> {
  const pairingId = randomHex(8);
  const code = newPairingCode();
  const expiresAt = new Date(nowMs + PAIRING_TTL_MS).toISOString();
  const doc: PairingDoc = { codeHash: sha256Hex(code), expiresAt, used: false, createdAt: new Date(nowMs).toISOString() };
  await blob().putJson(PATHS.pairing(pairingId), doc, { allowOverwrite: false });
  return { pairingId, code, expiresAt };
}

export async function redeemPairing(body: PairRedeemRequest, nowMs: number = Date.now()): Promise<PairRedeemResponse> {
  const store = blob();
  const path = PATHS.pairing(body.pairingId);
  const res = await store.getJson<PairingDoc>(path);
  if (res === null || isNotModified(res)) throw new ApiRouteError(400, 'pairing_invalid', 'Unknown pairing. Start a new one from the dashboard.');
  const doc = res.value;
  if (doc.used) throw new ApiRouteError(400, 'pairing_invalid', 'This pairing code was already used.');
  if (Date.parse(doc.expiresAt) <= nowMs) {
    await store.del(path);
    throw new ApiRouteError(410, 'pairing_expired', 'This pairing code expired. Start a new one from the dashboard.');
  }
  if (!safeEqual(sha256Hex(body.code), doc.codeHash)) throw new ApiRouteError(400, 'pairing_invalid', 'Wrong code.');
  try {
    await store.putJson(path, { ...doc, used: true }, { ifMatch: res.etag });
  } catch (err) {
    if (err instanceof PreconditionFailed) throw new ApiRouteError(400, 'pairing_invalid', 'This pairing code was already used.');
    throw err;
  }
  await store.del(path);
  const { device, token } = await createDevice(body.device, nowMs);
  const loaded = await loadProfile(nowMs);
  return { deviceId: device.id, token, profile: loaded.profile, etag: loaded.etag, version: loaded.version };
}
