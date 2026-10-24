import type { HealthResponse } from '@jammarly/shared/api';
import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { hasOwnerSession } from '@/lib/session';
import { getQuotaStatus, type QuotaStatus } from '@/lib/store';
import { APP_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type HealthWithQuota = HealthResponse & { blob?: QuotaStatus };

/** GET -> { ok, version } for everyone, plus { blob: quota counters } for the owner. */
export const GET = route('public', async (req) => {
  const body: HealthWithQuota = { ok: true, version: APP_VERSION };
  if (await hasOwnerSession(req)) body.blob = await getQuotaStatus();
  return jsonResponse(req, body);
});

export const OPTIONS = preflight;
