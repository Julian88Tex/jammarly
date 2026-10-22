import { verifyOwnerLogin } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { clientIp, jsonResponse, readJson, route } from '@/lib/http';
import { LoginSchema } from '@/lib/schemas';
import { getRequestSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { password } -> 200 { ok: true } + Set-Cookie; 401 unauthorized; 429 rate_limited after 5 failures (60 s). */
export const POST = route('owner', async (req) => {
  const { password } = await readJson(req, LoginSchema);
  await verifyOwnerLogin(password, clientIp(req));
  const headers = new Headers();
  const session = await getRequestSession(req, headers);
  session.uid = 'owner';
  session.iat = Date.now();
  await session.save();
  return jsonResponse(req, { ok: true }, { headers });
});

export const OPTIONS = preflight;
