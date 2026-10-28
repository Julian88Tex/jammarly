import { preflight } from '@/lib/cors';
import { ApiRouteError, jsonResponse, route } from '@/lib/http';
import { latestRunStatus } from '@/lib/learning/job';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> LearningRunStatus of the latest run (signed-in user); 404 not_found before the first run. */
export const GET = route('session', async (req) => {
  const { uid } = await requireUser(req);
  const status = await latestRunStatus(uid);
  if (status === null) throw new ApiRouteError(404, 'not_found', 'No learning run yet.');
  return jsonResponse(req, status);
});

export const OPTIONS = preflight;
