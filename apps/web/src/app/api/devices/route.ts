import type { DevicesListResponse } from '@jammarly/shared/api';
import { preflight } from '@/lib/cors';
import { listDevices } from '@/lib/devices';
import { jsonResponse, route } from '@/lib/http';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> DevicesListResponse (the signed-in user's devices). */
export const GET = route('session', async (req) => {
  const { uid } = await requireUser(req);
  const devices = await listDevices(uid);
  const body: DevicesListResponse = { devices };
  return jsonResponse(req, body);
});

export const OPTIONS = preflight;
