import { ETAG_HEADER, PROFILE_VERSION_HEADER, type ProfileOpsResponse } from '@jammarly/shared/api';
import { requireSessionOrDevice } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { jsonResponse, readJson, route } from '@/lib/http';
import { ProfileOpsSchema } from '@/lib/schemas';
import { ProfileConflict, applyProfileOps } from '@/lib/store';
import { conflictResponse } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST ProfileOpsRequest (device or signed-in user) -> ProfileOpsResponse after the server-side merge (CAS, 3 retries). */
export const POST = route('shared', async (req) => {
  const { uid, actor } = await requireSessionOrDevice(req);
  const body = await readJson(req, ProfileOpsSchema);
  try {
    const stored = await applyProfileOps(uid, body.ops, actor);
    const res: ProfileOpsResponse = { profile: stored.profile, etag: stored.etag, version: stored.version };
    return jsonResponse(req, res, { headers: { [ETAG_HEADER]: stored.etag, [PROFILE_VERSION_HEADER]: String(stored.version) } });
  } catch (err) {
    if (err instanceof ProfileConflict) return conflictResponse(req, err);
    throw err;
  }
});

export const OPTIONS = preflight;
