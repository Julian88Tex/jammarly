import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { deleteLearningData } from '@/lib/learning/data';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE -> LearningDataDeleteResponse (owner): every server-side learning artifact. */
export const DELETE = route('owner', async (req) => {
  await requireOwner(req);
  return jsonResponse(req, await deleteLearningData());
});

export const OPTIONS = preflight;
