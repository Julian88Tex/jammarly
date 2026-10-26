/**
 * JSlice single sign-on (https://jslice.vercel.app, docs/INTEGRATION.md in the JSlice repo). JSlice signs the
 * user in with Google and sends them to `/api/auth/jslice?token=<jwt>&next=<path>` with a 60-second ES256 JWT:
 * `iss` = JSLICE_URL, `aud` = "jammerly", `sub` = the stable Google subject id, plus `email`, `name`,
 * `picture` and a unique `jti`. The public keys are at `${JSLICE_URL}/.well-known/jwks.json`.
 *
 * Each token works once: its `jti` (hashed) is recorded at `auth/jti/<sha256>.json` with a create-only write,
 * so a replay loses the race and is rejected. The cron sweeps markers older than a day.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { BlobAlreadyExists } from './blob';
import { sha256Hex } from './crypto';
import { getEnv } from './env';
import { GLOBAL_PATHS, blob, isUserId, userPaths } from './store';

export const JSLICE_APP_ID = 'jammerly';
export const JSLICE_CALLBACK_PATH = '/api/auth/jslice';
export const DEFAULT_NEXT = '/overview';
/** Where sign-out lands: `jslice=none` keeps the login page from signing the user straight back in. */
export const LOGGED_OUT_PATH = '/login?jslice=none';
export const JTI_KEEP_MS = 24 * 60 * 60 * 1000;

export interface JSliceClaims {
  sub: string;
  email: string;
  name: string;
  picture: string;
  jti: string;
  exp: number;
}

export class JSliceTokenError extends Error {
  override readonly name = 'JSliceTokenError';
}

let keySet: { issuer: string; get: JWTVerifyGetKey } | null = null;
let testKeySet: JWTVerifyGetKey | null = null;

/** Tests verify against a local key instead of fetching JSlice's JWKS. */
export function setJSliceKeySetForTests(get: JWTVerifyGetKey | null): void {
  testKeySet = get;
}

function jwks(issuer: string): JWTVerifyGetKey {
  if (testKeySet !== null) return testKeySet;
  if (keySet === null || keySet.issuer !== issuer) {
    keySet = { issuer, get: createRemoteJWKSet(new URL('/.well-known/jwks.json', issuer)) };
  }
  return keySet.get;
}

/** Verify a hand-off token (signature, issuer, audience, ES256, at most 2 minutes old) and read its claims. */
export async function verifyJSliceToken(token: string): Promise<JSliceClaims> {
  if (token.length === 0 || token.length > 8192) throw new JSliceTokenError('missing token');
  const issuer = getEnv().JSLICE_URL;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks(issuer), { issuer, audience: JSLICE_APP_ID, algorithms: ['ES256'], maxTokenAge: '2m' }));
  } catch (err) {
    throw new JSliceTokenError(err instanceof Error ? err.message : 'invalid token');
  }
  const { sub, jti, exp } = payload;
  if (!isUserId(sub)) throw new JSliceTokenError('token sub is missing or not a usable id');
  if (typeof jti !== 'string' || jti.length === 0 || typeof exp !== 'number') throw new JSliceTokenError('token is missing jti or exp');
  const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 320) : '');
  return { sub, jti, exp, email: str(payload.email), name: str(payload.name), picture: str(payload.picture) };
}

/** Record the jti; false when it was already used (a replay). */
export async function consumeJti(jti: string, exp: number, nowMs: number = Date.now()): Promise<boolean> {
  try {
    await blob().putJson(GLOBAL_PATHS.jti(sha256Hex(jti)), { usedAt: new Date(nowMs).toISOString(), exp }, { allowOverwrite: false });
    return true;
  } catch (err) {
    if (err instanceof BlobAlreadyExists || (err instanceof Error && err.name === 'BlobAlreadyExists')) return false;
    throw err;
  }
}

/** Delete used-jti markers older than a day (tokens live 60 s, so these can never be replayed anyway). */
export async function sweepUsedJtis(nowMs: number = Date.now()): Promise<number> {
  const store = blob();
  const old = (await store.list(GLOBAL_PATHS.jtiPrefix)).filter((e) => nowMs - Date.parse(e.uploadedAt) > JTI_KEEP_MS).map((e) => e.path);
  if (old.length > 0) await store.del(old);
  return old.length;
}

export interface AccountDoc {
  sub: string;
  email: string;
  name: string;
  picture: string;
  createdAt: string;
  lastLoginAt: string;
}

/**
 * Record the sign-in: `users/<sub>/account.json` (profile details, refreshed every sign-in) and the
 * `auth/users/<sub>.json` marker the cron lists to find every user (written once).
 */
export async function recordSignIn(claims: JSliceClaims, nowMs: number = Date.now()): Promise<AccountDoc> {
  const store = blob();
  const nowIso = new Date(nowMs).toISOString();
  const path = userPaths(claims.sub).account;
  const existing = await store.getJson<AccountDoc>(path);
  const createdAt = existing !== null && !('notModified' in existing) && typeof existing.value?.createdAt === 'string' ? existing.value.createdAt : nowIso;
  const account: AccountDoc = { sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture, createdAt, lastLoginAt: nowIso };
  await store.putJson(path, account);
  if (createdAt === nowIso) {
    try {
      await store.putJson(GLOBAL_PATHS.user(claims.sub), { createdAt }, { allowOverwrite: false });
    } catch (err) {
      if (!(err instanceof Error && err.name === 'BlobAlreadyExists')) throw err;
    }
  }
  return account;
}

/** Only a same-origin path is forwarded: it must start with a single "/" (no "//" and no backslashes). */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return DEFAULT_NEXT;
  return next;
}

/** Interactive sign-in: JSlice's front door for this app. */
export function jsliceSignInUrl(next: string): string {
  const url = new URL('/', getEnv().JSLICE_URL);
  url.searchParams.set('app', JSLICE_APP_ID);
  url.searchParams.set('next', safeNext(next));
  return url.toString();
}

/** Silent sign-in: JSlice returns a token when the visitor is signed in there, else `/login?jslice=none`. */
export function jsliceSilentUrl(next: string): string {
  const url = new URL(`/launch/${JSLICE_APP_ID}`, getEnv().JSLICE_URL);
  url.searchParams.set('silent', '1');
  url.searchParams.set('next', safeNext(next));
  return url.toString();
}
