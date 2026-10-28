import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { LOGGED_OUT_PATH } from '@/lib/jslice';
import { getRequestSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST -> 200 { ok: true, redirect: '/login?jslice=none' } and the session cookie is cleared (idempotent). The
 * page goes to `redirect`, where `jslice=none` stops the login page from signing the user straight back in.
 */
export const POST = route('session', async (req) => {
  const headers = new Headers();
  const session = await getRequestSession(req, headers);
  session.destroy();
  return jsonResponse(req, { ok: true, redirect: LOGGED_OUT_PATH }, { headers });
});

export const OPTIONS = preflight;
