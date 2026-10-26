/**
 * Per-user learning data: the dashboard summary (last 28 days through the event index, with the previous
 * 28 days for trends), the JSON export and "Delete all learning data" (architecture §4 "Privacy").
 */
import type { ExportResponse, LearningDataDeleteResponse, LearningSummaryResponse } from '@jammarly/shared/api';
import { buildLearningSummary } from '@jammarly/shared/learner';
import { emptyVoiceProfile, type VoiceContext } from '@jammarly/shared/profile';
import { listDevices } from '../devices';
import { deleteAllBatches, readAllEvents, readAllSamples, readEventsFromDay, readSamplesSince } from '../events';
import { blob, dayOf, listSnapshots, loadProfile, saveProfile, serverHlcAfter, userPaths } from '../store';

const SUMMARY_DAYS = 28 as const;
const SUMMARY_CACHE_MS = 60_000;
const DAY_MS = 86_400_000;

const summaryCache = new Map<string, { at: number; version: number; value: LearningSummaryResponse }>();

export function resetSummaryCacheForTests(): void {
  summaryCache.clear();
}

export async function buildSummary(uid: string, nowMs: number = Date.now()): Promise<LearningSummaryResponse> {
  const loaded = await loadProfile(uid, nowMs);
  const cached = summaryCache.get(uid);
  if (cached !== undefined && cached.version === loaded.version && nowMs - cached.at < SUMMARY_CACHE_MS) return cached.value;
  const fromDay = dayOf(nowMs - 2 * SUMMARY_DAYS * DAY_MS);
  const events = await readEventsFromDay(uid, fromDay);
  const samples = await readSamplesSince(uid, '');
  const summary = buildLearningSummary(loaded.profile, events.items, {
    now: new Date(nowMs).toISOString(),
    days: SUMMARY_DAYS,
    storeSnippets: loaded.profile.settings.privacy.value.storeSnippets,
    voiceSamples: samples.items,
  });
  if (summaryCache.size > 1000) summaryCache.clear();
  summaryCache.set(uid, { at: nowMs, version: loaded.version, value: summary });
  return summary;
}

export async function exportAll(uid: string, nowMs: number = Date.now()): Promise<ExportResponse> {
  const loaded = await loadProfile(uid, nowMs);
  const devices = await listDevices(uid);
  const events = await readAllEvents(uid);
  const samples = await readAllSamples(uid);
  return { exportedAt: new Date(nowMs).toISOString(), profile: loaded.profile, devices, events: events.items, samples: samples.items };
}

/**
 * Delete every server-side learning artifact: event and sample batches, snapshots, run logs, dictionary
 * candidates, voice profiles (replaced by empty profiles with a higher version so every device adopts the
 * deletion on merge) and the learning counters, with a fresh updatedHlc.
 */
export async function deleteLearningData(uid: string, nowMs: number = Date.now()): Promise<LearningDataDeleteResponse> {
  const store = blob();
  const nowIso = new Date(nowMs).toISOString();
  const batches = await deleteAllBatches(uid);
  const snapshots = await listSnapshots(uid);
  if (snapshots.length > 0) await store.del(snapshots.map((s) => s.path));
  const runs = await store.list(userPaths(uid).runsPrefix);
  if (runs.length > 0) await store.del(runs.map((r) => r.path));
  await saveProfile(
    uid,
    (doc) => {
      for (const ctx of ['messages', 'documents'] as const satisfies readonly VoiceContext[]) {
        const existing = doc.voice.profiles[ctx];
        if (existing === undefined) continue;
        const empty = emptyVoiceProfile(ctx);
        empty.version = existing.version + 1;
        empty.generatedAt = nowIso;
        empty.generatedBy = 'owner';
        empty.changelog = 'Deleted from the dashboard.';
        doc.voice.profiles[ctx] = empty;
      }
      doc.learning = {
        updatedHlc: serverHlcAfter(doc.learning.updatedHlc),
        stats: {},
        ruleStates: {},
        dictionaryCandidates: [],
        history: [],
        lastEventCursor: '',
      };
      return doc;
    },
    { by: 'dashboard', nowMs },
  );
  summaryCache.delete(uid);
  return { deleted: { events: batches.events, samples: batches.samples, snapshots: snapshots.length, runs: runs.length } };
}
