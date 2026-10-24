import type { DevicesListResponse } from '@jammarly/shared/api';
import { preflight } from '@/lib/cors';
import { listDevices } from '@/lib/devices';
import { jsonResponse, route } from '@/lib/http';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> DevicesListResponse (owner). */
export const GET = route('owner', async (req) => {
  await requireOwner(req);
  const devices = await listDevices();
  const body: DevicesListResponse = { devices };
  return jsonResponse(req, body);
});

export const OPTIONS = preflight;
