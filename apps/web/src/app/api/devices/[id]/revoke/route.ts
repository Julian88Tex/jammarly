import { preflight } from '@/lib/cors';
import { revokeDevice } from '@/lib/devices';
import { ApiRouteError, jsonResponse, route } from '@/lib/http';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST -> { ok: true } (signed-in user, own devices only). The device's next request gets 401 device_revoked. */
export const POST = route<{ id: string }>('session', async (req, ctx) => {
  const { uid } = await requireUser(req);
  const { id } = await ctx.params;
  const found = await revokeDevice(uid, id);
  if (!found) throw new ApiRouteError(404, 'not_found', 'Unknown device.');
  return jsonResponse(req, { ok: true });
});

export const OPTIONS = preflight;
