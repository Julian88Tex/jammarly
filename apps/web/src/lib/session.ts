/**
 * User session: an iron-session v9 sealed cookie named `jammarly_session` (httpOnly, sameSite lax, secure in
 * production, 30 days). `uid` is the JSlice `sub` (the user's stable Google subject id); every per-user
 * document lives under `users/<uid>/`. Route handlers read and write the cookie through the Web `Request` /
 * `Headers` adapter so they can be unit-tested with plain Request objects; server components read it through
 * `cookies()`.
 */
import { getIronSession, webCookies, type IronSession, type SessionOptions } from 'iron-session';
import { getEnv } from './env';
import { ApiRouteError } from './errors';
import { isUserId } from './store';

export const SESSION_COOKIE = 'jammarly_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SessionData {
  /** The JSlice `sub`. */
  uid: string;
  /** How the session started; only JSlice sessions count (an old single-owner cookie has no `via`). */
  via: 'jslice';
  /** Issued-at, epoch milliseconds (iron-session v9 stores plain JSON). */
  iat: number;
  email?: string;
  name?: string;
}

export type UserSession = IronSession<SessionData>;

/** The signed-in user as route handlers and pages see it. */
export interface SignedInUser {
  uid: string;
  email: string;
  name: string;
}

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
export function getRequestSession(req: Request, responseHeaders: Headers): Promise<UserSession> {
  return getIronSession<SessionData>(webCookies(req, responseHeaders), sessionOptions());
}

export function isSignedIn(session: Partial<SessionData>): session is SessionData {
  return session.via === 'jslice' && isUserId(session.uid) && typeof session.iat === 'number';
}

function toUser(session: SessionData): SignedInUser {
  return { uid: session.uid, email: session.email ?? '', name: session.name ?? '' };
}

/** Throw 401 unless the request carries a valid session; returns the user. */
export async function requireUser(req: Request): Promise<SignedInUser> {
  const session = await getRequestSession(req, new Headers());
  if (!isSignedIn(session)) throw new ApiRouteError(401, 'unauthorized', 'Sign in to the dashboard first.');
  return toUser(session);
}

/** The signed-in user, or null (no throw). */
export async function optionalUser(req: Request): Promise<SignedInUser | null> {
  try {
    const session = await getRequestSession(req, new Headers());
    return isSignedIn(session) ? toUser(session) : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in user for server components and layouts (reads the incoming cookies through next/headers), or
 * null. Imported lazily so this module stays usable in plain Node tests.
 */
export async function getPageUser(): Promise<SignedInUser | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const session = await getIronSession<SessionData>(store, sessionOptions());
  return isSignedIn(session) ? toUser(session) : null;
}

/** Like {@link getPageUser} but redirects to the login page when nobody is signed in. */
export async function requirePageUser(): Promise<SignedInUser> {
  const user = await getPageUser();
  if (user !== null) return user;
  const { redirect } = await import('next/navigation');
  return redirect('/login');
}
