import { preflight } from '@/lib/cors';
import { jsonResponse, readJson, route } from '@/lib/http';
import { PairRedeemSchema, redeemPairing } from '@/lib/pairing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST PairRedeemRequest -> PairRedeemResponse (public, WAF rate-limited; the code is the credential). */
export const POST = route('device', async (req) => {
  const body = await readJson(req, PairRedeemSchema);
  return jsonResponse(req, await redeemPairing(body));
});

export const OPTIONS = preflight;
