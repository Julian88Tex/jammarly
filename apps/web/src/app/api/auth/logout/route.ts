import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { getRequestSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST -> 200 { ok: true } and the session cookie is cleared (idempotent). */
export const POST = route('owner', async (req) => {
  const headers = new Headers();
  const session = await getRequestSession(req, headers);
  session.destroy();
  return jsonResponse(req, { ok: true }, { headers });
});

export const OPTIONS = preflight;
