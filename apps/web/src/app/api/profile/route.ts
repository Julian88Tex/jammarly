import { ETAG_HEADER, IF_MATCH_HEADER, IF_NONE_MATCH_HEADER, PROFILE_VERSION_HEADER, type ProfileGetResponse, type ProfilePutConflict } from '@jammarly/shared/api';
import { ProfileDocumentSchema } from '@jammarly/shared/merge';
import { requireSessionOrDevice } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { ApiRouteError, errorBody, jsonResponse, route } from '@/lib/http';
import { ProfileConflict, bumpDeviceQuota, loadProfileConditional, saveProfile, type ProfileLoaded } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function profileHeaders(loaded: { etag: string; version: number }): Record<string, string> {
  return { [ETAG_HEADER]: loaded.etag, [PROFILE_VERSION_HEADER]: String(loaded.version) };
}

export function conflictResponse(req: Request, err: ProfileConflict): Response {
  const body: ProfilePutConflict = {
    ...errorBody(err.code, err.message),
    current: { profile: err.current.profile, etag: err.current.etag, version: err.current.version },
  };
  return jsonResponse(req, body, { status: 412, headers: profileHeaders(err.current) });
}

/** GET (device or owner) with If-None-Match -> 304, or ProfileGetResponse + ETag + X-Profile-Version. */
export const GET = route('shared', async (req) => {
  await requireSessionOrDevice(req);
  const result = await loadProfileConditional(req.headers.get(IF_NONE_MATCH_HEADER));
  if ('notModified' in result) {
    return new Response(null, { status: 304, headers: { ...profileHeaders(result), ...Object.fromEntries(jsonResponse(req, null).headers) } });
  }
  const body: ProfileGetResponse = { profile: result.profile, etag: result.etag, version: result.version };
  return jsonResponse(req, body, { headers: profileHeaders(result) });
});

/** PUT (device or owner) full document with If-Match -> 200 ProfileGetResponse or 412 ProfilePutConflict. */
export const PUT = route('shared', async (req) => {
  const actor = await requireSessionOrDevice(req);
  const ifMatch = req.headers.get(IF_MATCH_HEADER);
  if (ifMatch === null || ifMatch.length === 0) throw new ApiRouteError(428, 'precondition_failed', 'PUT /api/profile requires an If-Match header.');
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiRouteError(400, 'schema_invalid', 'Request body is not valid JSON.');
  }
  const parsed = ProfileDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiRouteError(400, 'schema_invalid', `Profile is invalid at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'validation failed'}`);
  }
  const incoming = parsed.data;
  if (actor.kind === 'device') await bumpDeviceQuota(actor.deviceId, 'profileWrites');
  let stored: ProfileLoaded;
  try {
    stored = await saveProfile(
      (current) => {
        if (actor.kind !== 'device') return incoming;
        // Devices may replace everything except the server-authoritative voice profiles and learning section.
        return { ...incoming, voice: { settings: incoming.voice.settings, profiles: current.voice.profiles }, learning: current.learning };
      },
      { ifMatch, by: actor.kind === 'device' ? actor.deviceId : 'owner' },
    );
  } catch (err) {
    if (err instanceof ProfileConflict) return conflictResponse(req, err);
    throw err;
  }
  const body: ProfileGetResponse = { profile: stored.profile, etag: stored.etag, version: stored.version };
  return jsonResponse(req, body, { headers: profileHeaders(stored) });
});

export const OPTIONS = preflight;
