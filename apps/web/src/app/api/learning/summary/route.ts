import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { buildSummary } from '@/lib/learning/data';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> LearningSummary (owner): last 28 days of events through the index, with Wilson intervals. */
export const GET = route('owner', async (req) => {
  await requireOwner(req);
  return jsonResponse(req, await buildSummary());
});

export const OPTIONS = preflight;
