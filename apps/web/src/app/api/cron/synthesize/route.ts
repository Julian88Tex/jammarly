import { requireCron } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { ApiRouteError, jsonResponse, route } from '@/lib/http';
import { runLearningJob } from '@/lib/learning/job';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** GET ?ctx=messages|documents with Authorization: Bearer CRON_SECRET -> LearningRunStatus. */
export const GET = route('public', async (req) => {
  requireCron(req);
  const ctx = new URL(req.url).searchParams.get('ctx') ?? 'messages';
  if (ctx !== 'messages' && ctx !== 'documents') throw new ApiRouteError(400, 'schema_invalid', 'ctx must be "messages" or "documents".');
  const status = await runLearningJob({ context: ctx, trigger: 'cron' });
  return jsonResponse(req, status);
});

export const OPTIONS = preflight;
