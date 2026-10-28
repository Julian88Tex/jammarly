import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { deleteLearningData } from '@/lib/learning/data';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DELETE -> LearningDataDeleteResponse (signed-in user): every server-side learning artifact of theirs. */
export const DELETE = route('session', async (req) => {
  const { uid } = await requireUser(req);
  return jsonResponse(req, await deleteLearningData(uid));
});

export const OPTIONS = preflight;
