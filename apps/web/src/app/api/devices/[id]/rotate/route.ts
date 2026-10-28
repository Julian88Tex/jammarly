import { requireDevice } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { rotateDevice } from '@/lib/devices';
import { ApiRouteError, jsonResponse, route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST (device, its own id) -> RotateResponse; the previous token stays valid for 5 minutes. */
export const POST = route<{ id: string }>('device', async (req, ctx) => {
  const { uid, device } = await requireDevice(req);
  const { id } = await ctx.params;
  if (id !== device.id) throw new ApiRouteError(403, 'unauthorized', 'A device can only rotate its own token.');
  return jsonResponse(req, await rotateDevice(uid, id));
});

export const OPTIONS = preflight;
