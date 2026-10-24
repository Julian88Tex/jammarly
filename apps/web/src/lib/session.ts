/**
 * Owner session: an iron-session v9 sealed cookie named `jammarly_session` (httpOnly, sameSite lax, secure in
 * production, 30 days). Route handlers read and write it through the Web `Request` / `Headers` adapter so they
 * can be unit-tested with plain Request objects; server components read it through `cookies()`.
 */
import { getIronSession, webCookies, type IronSession, type SessionOptions } from 'iron-session';
import { getEnv } from './env';
import { ApiRouteError } from './errors';

export const SESSION_COOKIE = 'jammarly_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SessionData {
  uid: 'owner';
  /** Issued-at, epoch milliseconds (iron-session v9 stores plain JSON). */
  iat: number;
}

export type OwnerSession = IronSession<SessionData>;

export function sessionOptions(): SessionOptions {
  const env = getEnv();
  return {
    cookieName: SESSION_COOKIE,
    password: env.SESSION_SECRET,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
  };
}

/** Session bound to a route-handler request; `save()`/`destroy()` write Set-Cookie into `responseHeaders`. */
export function getRequestSession(req: Request, responseHeaders: Headers): Promise<OwnerSession> {
  return getIronSession<SessionData>(webCookies(req, responseHeaders), sessionOptions());
}

export function isOwner(session: Partial<SessionData>): boolean {
  return session.uid === 'owner' && typeof session.iat === 'number';
}

/** Throw 401 unless the request carries a valid owner session. */
export async function requireOwner(req: Request): Promise<OwnerSession> {
  const session = await getRequestSession(req, new Headers());
  if (!isOwner(session)) throw new ApiRouteError(401, 'unauthorized', 'Sign in to the dashboard first.');
  return session;
}

/** True when the request carries a valid owner session (no throw). */
export async function hasOwnerSession(req: Request): Promise<boolean> {
  try {
    const session = await getRequestSession(req, new Headers());
    return isOwner(session);
  } catch {
    return false;
  }
}

/**
 * Session for server components and layouts (reads the incoming cookies through next/headers). Imported
 * lazily so this module stays usable in plain Node tests.
 */
export async function getPageSession(): Promise<Partial<SessionData>> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const session = await getIronSession<SessionData>(store, sessionOptions());
  return { ...(session.uid !== undefined ? { uid: session.uid } : {}), ...(session.iat !== undefined ? { iat: session.iat } : {}) };
}
