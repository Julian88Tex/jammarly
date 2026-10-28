/**
 * Authentication helpers for route handlers: device bearer tokens (each resolves to its user), the combined
 * "user session or device token" check for shared routes, and the cron secret. Dashboard sign-in itself is
 * JSlice single sign-on (see ./jslice and /api/auth/jslice).
 */
import { authenticateDeviceToken, touchLastSeen, type StoredDevice } from './devices';
import { getEnv } from './env';
import { ApiRouteError } from './errors';
import { bearerToken } from './http';
import { getRequestSession, isSignedIn } from './session';
import type { Actor } from './store';

export interface AuthedDevice {
  /** The user the device was paired to. */
  uid: string;
  device: StoredDevice;
}

/** 401 unauthorized when the bearer token is missing/invalid, 401 device_revoked when the device was revoked. */
export async function requireDevice(req: Request, nowMs: number = Date.now()): Promise<AuthedDevice> {
  const token = bearerToken(req);
  if (token === null) throw new ApiRouteError(401, 'unauthorized', 'Missing device token.');
  const result = await authenticateDeviceToken(token, nowMs);
  if (result.status === 'revoked') throw new ApiRouteError(401, 'device_revoked', 'This device was unpaired. Pair it again from the dashboard.');
  if (result.status === 'unknown') throw new ApiRouteError(401, 'unauthorized', 'Invalid device token.');
  await touchLastSeen(result.uid, result.device, nowMs);
  return { uid: result.uid, device: result.device };
}

/** Shared routes: a bearer token means a device (of its user), otherwise the user's session cookie must be present. */
export async function requireSessionOrDevice(req: Request, nowMs: number = Date.now()): Promise<{ uid: string; actor: Actor }> {
  if (bearerToken(req) !== null) {
    const { uid, device } = await requireDevice(req, nowMs);
    return { uid, actor: { kind: 'device', deviceId: device.id } };
  }
  const session = await getRequestSession(req, new Headers());
  if (!isSignedIn(session)) throw new ApiRouteError(401, 'unauthorized', 'Sign in or send a device token.');
  return { uid: session.uid, actor: { kind: 'user' } };
}

/** `Authorization: Bearer <CRON_SECRET>` (Vercel adds it to cron invocations). */
export function requireCron(req: Request): void {
  const token = bearerToken(req);
  const secret = getEnv().CRON_SECRET;
  if (token === null || token.length !== secret.length || !constantTimeEqual(token, secret)) {
    throw new ApiRouteError(401, 'unauthorized', 'Cron secret missing or wrong.');
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
