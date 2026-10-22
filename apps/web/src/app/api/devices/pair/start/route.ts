import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { startPairing } from '@/lib/pairing';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST -> PairStartResponse { pairingId, code, expiresAt } (owner). */
export const POST = route('owner', async (req) => {
  await requireOwner(req);
  return jsonResponse(req, await startPairing());
});

export const OPTIONS = preflight;
