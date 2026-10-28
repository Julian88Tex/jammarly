import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { startPairing } from '@/lib/pairing';
import { requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST -> PairStartResponse { pairingId, code, expiresAt } (signed-in user; the device is paired to that user). */
export const POST = route('session', async (req) => {
  const { uid } = await requireUser(req);
  return jsonResponse(req, await startPairing(uid));
});

export const OPTIONS = preflight;
