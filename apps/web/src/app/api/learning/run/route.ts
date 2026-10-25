import type { LearningRunResponse } from '@jammarly/shared/api';
import type { VoiceContext } from '@jammarly/shared/profile';
import { preflight } from '@/lib/cors';
import { jsonResponse, readJson, route } from '@/lib/http';
import { scheduleBackground } from '@/lib/learning/background';
import { MANUAL_RUNS_PER_DAY, RUN_STALE_MS, loadRun, loadRunsLatest, runLearningJob, saveRunsLatest } from '@/lib/learning/job';
import { LearningRunSchema } from '@/lib/schemas';
import { requireOwner } from '@/lib/session';
import { dayOf } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST LearningRunRequest (owner, <= 3/day) -> LearningRunResponse; the job runs after the response when possible. */
export const POST = route('owner', async (req) => {
  await requireOwner(req);
  const body = await readJson(req, LearningRunSchema);
  const contexts: VoiceContext[] = body.contexts ?? ['messages', 'documents'];
  const nowMs = Date.now();
  const today = dayOf(nowMs);
  const latest = await loadRunsLatest();
  if (latest.manual.day === today && latest.manual.count >= MANUAL_RUNS_PER_DAY) {
    const res: LearningRunResponse = { started: false, reason: 'quota' };
    return jsonResponse(req, res);
  }
  if (latest.latest !== null) {
    const current = await loadRun(latest.latest.path);
    const terminal = current === null || current.stage === 'done' || current.stage === 'failed' || current.stage === 'partial';
    if (current !== null && !terminal && nowMs - Date.parse(current.startedAt) < RUN_STALE_MS) {
      const res: LearningRunResponse = { started: false, reason: 'already_running', runId: current.runId };
      return jsonResponse(req, res);
    }
  }
  latest.manual = { day: today, count: (latest.manual.day === today ? latest.manual.count : 0) + 1 };
  await saveRunsLatest(latest);
  const first = contexts[0] ?? 'messages';
  const runId = `${today}-${first}`;
  await scheduleBackground(async () => {
    for (const context of contexts) {
      await runLearningJob({ context, trigger: 'manual', ...(body.statsOnly === true ? { statsOnly: true } : {}), nowMs: Date.now() });
    }
  });
  const res: LearningRunResponse = { started: true, runId };
  return jsonResponse(req, res, { status: 202 });
});

export const OPTIONS = preflight;
