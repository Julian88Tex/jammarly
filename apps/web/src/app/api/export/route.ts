import { preflight } from '@/lib/cors';
import { jsonResponse, route } from '@/lib/http';
import { exportAll } from '@/lib/learning/data';
import { requireOwner } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET -> ExportResponse (owner): profile, devices, events and samples as one JSON document. */
export const GET = route('owner', async (req) => {
  await requireOwner(req);
  const body = await exportAll();
  return jsonResponse(req, body, { headers: { 'Content-Disposition': `attachment; filename="jammarly-export-${body.exportedAt.slice(0, 10)}.json"` } });
});

export const OPTIONS = preflight;
