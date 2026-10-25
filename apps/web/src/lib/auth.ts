/**
 * Authentication helpers for route handlers: owner password verification with a fixed minimum response time
 * and a per-IP in-memory failure counter (the WAF rule is the real limiter), device bearer tokens, and the
 * combined "owner session or device token" check for shared routes.
 */
import { verifyPassword } from './crypto';
import { authenticateDeviceToken, touchLastSeen, type StoredDevice } from './devices';
import { getEnv } from './env';
import { ApiRouteError } from './errors';
import { bearerToken } from './http';
import { getRequestSession, isOwner } from './session';
import type { Actor } from './store';

export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 60_000;
export const LOGIN_MIN_RESPONSE_MS = 400;

interface Attempts {
  fails: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempts>();
let minResponseMs = LOGIN_MIN_RESPONSE_MS;

export function setLoginMinDelayForTests(ms: number): void {
  minResponseMs = ms;
}

export function resetLoginLimiterForTests(): void {
  attempts.clear();
  minResponseMs = LOGIN_MIN_RESPONSE_MS;
}

export function loginLockRemaining(ip: string, nowMs: number): number {
  const a = attempts.get(ip);
  if (a === undefined) return 0;
  return a.lockedUntil > nowMs ? a.lockedUntil - nowMs : 0;
}

function recordFailure(ip: string, nowMs: number): void {
  const a = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  if (a.lockedUntil !== 0 && a.lockedUntil <= nowMs) a.fails = 0;
  a.fails += 1;
  a.lockedUntil = a.fails >= LOGIN_MAX_FAILS ? nowMs + LOGIN_LOCK_MS : 0;
  if (a.fails >= LOGIN_MAX_FAILS) a.fails = 0;
  attempts.set(ip, a);
  if (attempts.size > 10_000) attempts.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the owner password. Always takes at least `minResponseMs`; a locked IP gets 429 rate_limited, a
 * wrong password 401 unauthorized.
 */
export async function verifyOwnerLogin(password: string, ip: string, nowMs: number = Date.now()): Promise<void> {
  const started = Date.now();
  const remaining = loginLockRemaining(ip, nowMs);
  if (remaining > 0) {
    await padTo(started);
    throw new ApiRouteError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(remaining / 1000)} s.`, { retryAfterMs: remaining });
  }
  const ok = verifyPassword(password, getEnv().OWNER_PASSWORD_HASH);
  await padTo(started);
  if (!ok) {
    recordFailure(ip, nowMs);
    throw new ApiRouteError(401, 'unauthorized', 'Wrong password.');
  }
  attempts.delete(ip);
}

async function padTo(startedMs: number): Promise<void> {
  const elapsed = Date.now() - startedMs;
  if (elapsed < minResponseMs) await sleep(minResponseMs - elapsed);
}

/** 401 unauthorized when the bearer token is missing/invalid, 401 device_revoked when the device was revoked. */
export async function requireDevice(req: Request, nowMs: number = Date.now()): Promise<StoredDevice> {
  const token = bearerToken(req);
  if (token === null) throw new ApiRouteError(401, 'unauthorized', 'Missing device token.');
  const result = await authenticateDeviceToken(token, nowMs);
  if (result.status === 'revoked') throw new ApiRouteError(401, 'device_revoked', 'This device was unpaired. Pair it again from the dashboard.');
  if (result.status === 'unknown') throw new ApiRouteError(401, 'unauthorized', 'Invalid device token.');
  await touchLastSeen(result.device, nowMs);
  return result.device;
}

/** Shared routes: a bearer token means a device, otherwise the owner cookie must be present. */
export async function requireSessionOrDevice(req: Request, nowMs: number = Date.now()): Promise<Actor> {
  if (bearerToken(req) !== null) {
    const device = await requireDevice(req, nowMs);
    return { kind: 'device', deviceId: device.id };
  }
  const session = await getRequestSession(req, new Headers());
  if (!isOwner(session)) throw new ApiRouteError(401, 'unauthorized', 'Sign in or send a device token.');
  return { kind: 'owner' };
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
