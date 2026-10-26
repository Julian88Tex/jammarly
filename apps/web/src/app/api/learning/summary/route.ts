import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { buildSummary } from '@/lib/learning/data';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> LearningSummary (signed-in user): last 28 days of events through the index, with Wilson intervals. */
export const GET = route('session', async (req) => {
  const { uid } = await requireUser(req);
  return jsonResponse(req, await buildSummary(uid));
});

export const OPTIONS = preflight;
