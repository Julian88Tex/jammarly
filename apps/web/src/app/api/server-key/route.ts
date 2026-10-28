import { preflight } from '@/lib/cors';
import { jsonResponse, readJson, route } from '@/lib/http';
import { ServerKeySchema } from '@/lib/schemas';
import { clearServerApiKey, serverKeyStatus, setServerApiKey } from '@/lib/server-key';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> ServerKeyStatusResponse (signed-in user; a key stored by this user, else the shared env key). */
export const GET = route('session', async (req) => {
  const { uid } = await requireUser(req);
  return jsonResponse(req, await serverKeyStatus(uid));
});

/** PUT { apiKey } -> ServerKeyStatusResponse; the key is stored encrypted and never echoed. */
export const PUT = route('session', async (req) => {
  const { uid } = await requireUser(req);
  const { apiKey } = await readJson(req, ServerKeySchema);
  return jsonResponse(req, await setServerApiKey(uid, apiKey));
});

/** DELETE -> ServerKeyStatusResponse after removing the stored key (the env var, if any, remains). */
export const DELETE = route('session', async (req) => {
  const { uid } = await requireUser(req);
  return jsonResponse(req, await clearServerApiKey(uid));
});

export const OPTIONS = preflight;
