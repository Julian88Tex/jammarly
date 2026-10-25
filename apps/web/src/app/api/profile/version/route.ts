import type { ProfileVersionResponse } from '@jammarly/shared/api';
import { requireSessionOrDevice } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { getProfileVersion } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET (device or owner) -> ProfileVersionResponse, served from a 60 s module cache when possible. */
export const GET = route('shared', async (req) => {
  await requireSessionOrDevice(req);
  const body: ProfileVersionResponse = await getProfileVersion();
  return jsonResponse(req, body, { headers: { 'Cache-Control': 'private, max-age=60' } });
});

export const OPTIONS = preflight;
