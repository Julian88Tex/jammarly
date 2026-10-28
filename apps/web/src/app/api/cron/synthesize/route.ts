import type { LearningRunStatus } from '@jammarly/shared/api';
import { getDeadline } from '@vercel/functions';
import { requireCron } from '@/lib/auth';
import { preflight } from '@/lib/cors';
import { ApiRouteError, jsonResponse, route } from '@/lib/http';
import { sweepUsedJtis } from '@/lib/jslice';
import { STAGE_MIN_REMAINING_MS, cronOrder, listUserIds, needsCronRun, runLearningJob } from '@/lib/learning/job';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export interface CronSummary {
  context: 'messages' | 'documents';
  users: number;
  ran: number;
  skipped: number;
  /** Users not reached before the deadline; they go first tomorrow (see cronOrder). */
  deferred: number;
  stages: Partial<Record<LearningRunStatus['stage'], number>>;
}

function deadlineMs(): number | null {
  try {
    const d = getDeadline();
    return d === undefined ? null : d.getTime();
  } catch {
    return null;
  }
}

/**
 * GET ?ctx=messages|documents with Authorization: Bearer CRON_SECRET -> CronSummary. Runs the learning job for
 * that context for every user with something new (see needsCronRun), one after another, until fewer than
 * 20 s remain. Each run is idempotent and resumable, so a user cut off mid-run resumes on the next call.
 */
export const GET = route('public', async (req) => {
  requireCron(req);
  const ctx = new URL(req.url).searchParams.get('ctx') ?? 'messages';
  if (ctx !== 'messages' && ctx !== 'documents') throw new ApiRouteError(400, 'schema_invalid', 'ctx must be "messages" or "documents".');
  const nowMs = Date.now();
  const deadline = deadlineMs();
  const remaining = (): number => (deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now());
  const uids = cronOrder(await listUserIds(), nowMs);
  const summary: CronSummary = { context: ctx, users: uids.length, ran: 0, skipped: 0, deferred: 0, stages: {} };
  for (const uid of uids) {
    if (remaining() < STAGE_MIN_REMAINING_MS) {
      summary.deferred += 1;
      continue;
    }
    try {
      if (!(await needsCronRun(uid, ctx, nowMs))) {
        summary.skipped += 1;
        continue;
      }
      const status = await runLearningJob({ uid, context: ctx, trigger: 'cron', deadlineMs: deadline });
      summary.ran += 1;
      summary.stages[status.stage] = (summary.stages[status.stage] ?? 0) + 1;
    } catch (err) {
      // One user's failure never stops the others.
      console.error('[jammarly] cron run failed for one user:', err instanceof Error ? err.message : String(err));
      summary.stages.failed = (summary.stages.failed ?? 0) + 1;
    }
  }
  if (ctx === 'messages' && remaining() >= STAGE_MIN_REMAINING_MS) await sweepUsedJtis(nowMs).catch(() => 0);
  return jsonResponse(req, summary);
});

export const OPTIONS = preflight;
