import { preflight } from '@/lib/cors';
import { jsonResponse, readJson, route } from '@/lib/http';
import { ServerKeySchema } from '@/lib/schemas';
import { clearServerApiKey, serverKeyStatus, setServerApiKey } from '@/lib/server-key';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> ServerKeyStatusResponse (owner). */
export const GET = route('owner', async (req) => {
  await requireOwner(req);
  return jsonResponse(req, await serverKeyStatus());
});

/** PUT { apiKey } -> ServerKeyStatusResponse; the key is stored encrypted and never echoed. */
export const PUT = route('owner', async (req) => {
  await requireOwner(req);
  const { apiKey } = await readJson(req, ServerKeySchema);
  return jsonResponse(req, await setServerApiKey(apiKey));
});

/** DELETE -> ServerKeyStatusResponse after removing the stored key (the env var, if any, remains). */
export const DELETE = route('owner', async (req) => {
  await requireOwner(req);
  return jsonResponse(req, await clearServerApiKey());
});

export const OPTIONS = preflight;
