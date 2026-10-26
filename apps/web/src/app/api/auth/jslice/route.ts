import { getEnv } from '@/lib/env';
import { route } from '@/lib/http';
import { JSliceTokenError, consumeJti, recordSignIn, safeNext, verifyJSliceToken } from '@/lib/jslice';
import { getRequestSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

/**
 * GET ?token=<JSlice JWT>&next=<path>: JSlice sends the user here after Google sign-in. A valid, unused token
 * starts the session (uid = the token's `sub`) and redirects to `next` (only a path starting with a single
 * "/"). Anything else redirects to `/login?error=jslice`; JSlice probes this route without a token and reads
 * that `error=` redirect as "this app accepts the hand-off".
 */
export const GET = route('public', async (req) => {
  const env = getEnv();
  const params = new URL(req.url).searchParams;
  const next = safeNext(params.get('next'));
  const failed = new URL('/login', env.APP_ORIGIN);
  failed.searchParams.set('error', 'jslice');
  failed.searchParams.set('next', next);

  const token = params.get('token') ?? '';
  let claims;
  try {
    claims = await verifyJSliceToken(token);
  } catch (err) {
    if (err instanceof JSliceTokenError) return redirect(failed.toString());
    throw err;
  }
  // Each token works once.
  if (!(await consumeJti(claims.jti, claims.exp))) return redirect(failed.toString());

  await recordSignIn(claims);
  const headers = new Headers();
  const session = await getRequestSession(req, headers);
  session.uid = claims.sub;
  session.via = 'jslice';
  session.iat = Date.now();
  session.email = claims.email;
  session.name = claims.name;
  await session.save();
  return redirect(new URL(next, env.APP_ORIGIN).toString(), headers);
});
