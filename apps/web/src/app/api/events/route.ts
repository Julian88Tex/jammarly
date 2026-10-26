import type { EventsUploadResponse } from '@jammarly/shared/api';
import type { FeedbackEvent } from '@jammarly/shared/learning';
import { requireDevice } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { appendBatch } from '@/lib/events';
import { jsonResponse, readJson, route } from '@/lib/http';
import { EventsUploadSchema } from '@/lib/schemas';
import { bumpDeviceQuota, loadProfile } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SNIPPET_FIELDS = ['original', 'replacement', 'final', 'sentence'] as const;

function stripSnippets(e: FeedbackEvent): FeedbackEvent {
  const copy: FeedbackEvent = { ...e };
  for (const field of SNIPPET_FIELDS) delete copy[field];
  return copy;
}

/**
 * POST EventsUploadRequest (device; stored under the device's user) -> EventsUploadResponse. Privacy is enforced here regardless of what the
 * device sent: with storeSnippets off, snippets are stripped and samples dropped. 429 beyond 6 batches/day.
 */
export const POST = route('device', async (req) => {
  const { uid, device } = await requireDevice(req);
  const body = await readJson(req, EventsUploadSchema);
  const { profile } = await loadProfile(uid);
  const privacy = profile.settings.privacy.value;
  const keepSnippets = privacy.storeSnippets;
  const events = body.events.map((e) => {
    const withDevice: FeedbackEvent = { ...e, v: 1, deviceId: device.id };
    return keepSnippets ? withDevice : stripSnippets(withDevice);
  });
  const samples = keepSnippets ? (body.samples ?? []) : [];
  if (events.length === 0 && samples.length === 0) {
    const empty: EventsUploadResponse = { accepted: 0, samplesAccepted: 0 };
    return jsonResponse(req, empty);
  }
  await bumpDeviceQuota(device.id, 'eventBatches');
  if (events.length > 0) await appendBatch(uid, 'events', device.id, events);
  if (samples.length > 0) await appendBatch(uid, 'samples', device.id, samples);
  const res: EventsUploadResponse = { accepted: events.length, samplesAccepted: samples.length };
  return jsonResponse(req, res);
});

export const OPTIONS = preflight;
