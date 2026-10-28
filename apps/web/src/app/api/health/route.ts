import type { HealthResponse } from '@jammarly/shared/api';
import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { listDevices } from '@/lib/devices';
import { optionalUser } from '@/lib/session';
import { getQuotaStatus, type QuotaStatus } from '@/lib/store';
import { APP_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type HealthWithQuota = HealthResponse & { blob?: QuotaStatus };

/**
 * GET -> { ok, version } for everyone, plus { blob: quota counters } for a signed-in user (the store-wide
 * Blob counters and the per-device counters of that user's own devices).
 */
export const GET = route('public', async (req) => {
  const body: HealthWithQuota = { ok: true, version: APP_VERSION };
  const user = await optionalUser(req);
  if (user !== null) body.blob = await getQuotaStatus((await listDevices(user.uid)).map((d) => d.id));
  return jsonResponse(req, body);
});

export const OPTIONS = preflight;
