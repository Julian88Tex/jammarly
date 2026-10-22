import { preflight } from '@/lib/cors';
import { revokeDevice } from '@/lib/devices';
import { ApiRouteError, jsonResponse, route } from '@/lib/http';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST -> { ok: true } (owner). The device's next request gets 401 device_revoked. */
export const POST = route<{ id: string }>('owner', async (req, ctx) => {
  await requireOwner(req);
  const { id } = await ctx.params;
  const found = await revokeDevice(id);
  if (!found) throw new ApiRouteError(404, 'not_found', 'Unknown device.');
  return jsonResponse(req, { ok: true });
});

export const OPTIONS = preflight;
