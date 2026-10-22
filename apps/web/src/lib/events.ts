/**
 * Feedback-event and voice-sample batches: `events/<YYYY-MM-DD>/<deviceId>.jsonl` and
 * `samples/<YYYY-MM-DD>/<deviceId>.jsonl` (one append per upload call: read + concat + put) plus
 * `events/index.json`, the list of batches with counts and offsets, so the hot path never calls `list()`.
 */
import type { FeedbackEvent, VoiceSample } from '@jammarly/shared/learning';
import { PreconditionFailed, isNotModified } from './blob';
import { ApiRouteError } from './errors';
import { PATHS, blob, dayOf } from './store';

export type BatchKind = 'events' | 'samples';

export interface BatchIndexEntry {
  kind: BatchKind;
  path: string;
  day: string;
  deviceId: string;
  /** Line offset of this upload inside the day file. */
  offset: number;
  count: number;
  uploadedAt: string;
}

export interface BatchIndex {
  v: 1;
  batches: BatchIndexEntry[];
}

export function emptyIndex(): BatchIndex {
  return { v: 1, batches: [] };
}

export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

function countLines(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.trim().length > 0) n += 1;
  return n;
}

export async function loadIndex(): Promise<{ index: BatchIndex; etag: string | null }> {
  const res = await blob().getJson<BatchIndex>(PATHS.eventsIndex);
  if (res === null || isNotModified(res)) return { index: emptyIndex(), etag: null };
  const batches = Array.isArray(res.value?.batches) ? res.value.batches : [];
  return { index: { v: 1, batches }, etag: res.etag };
}

export async function updateIndex(mutate: (index: BatchIndex) => void): Promise<BatchIndex> {
  const store = blob();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { index, etag } = await loadIndex();
    mutate(index);
    try {
      await store.putJson(PATHS.eventsIndex, index, etag === null ? { allowOverwrite: false } : { ifMatch: etag });
      return index;
    } catch (err) {
      if (err instanceof PreconditionFailed || (err instanceof Error && err.name === 'BlobAlreadyExists')) continue;
      throw err;
    }
  }
  throw new ApiRouteError(409, 'conflict_retry', 'The event index kept changing; retry.');
}

function batchPath(kind: BatchKind, day: string, deviceId: string): string {
  return kind === 'events' ? PATHS.eventsBatch(day, deviceId) : PATHS.samplesBatch(day, deviceId);
}

/** Append one upload to the device's day file and record it in the index. */
export async function appendBatch(kind: BatchKind, deviceId: string, lines: readonly unknown[], nowMs: number = Date.now()): Promise<BatchIndexEntry> {
  const store = blob();
  const day = dayOf(nowMs);
  const path = batchPath(kind, day, deviceId);
  const existing = await store.getText(path);
  const prior = existing?.text ?? '';
  const offset = countLines(prior);
  const text = prior + lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
  await store.putText(path, text);
  const entry: BatchIndexEntry = { kind, path, day, deviceId, offset, count: lines.length, uploadedAt: new Date(nowMs).toISOString() };
  await updateIndex((index) => {
    index.batches.push(entry);
  });
  return entry;
}

export interface ReadResult<T> {
  items: T[];
  entries: BatchIndexEntry[];
  /** Max uploadedAt among the matched entries ('' when none). */
  maxUploadedAt: string;
}

/** Read the lines of every index entry that matches `filter`, each file once, from the lowest matched offset. */
export async function readBatches<T>(kind: BatchKind, filter: (e: BatchIndexEntry) => boolean): Promise<ReadResult<T>> {
  const { index } = await loadIndex();
  const entries = index.batches.filter((e) => e.kind === kind && filter(e));
  const minOffset = new Map<string, number>();
  for (const e of entries) {
    const cur = minOffset.get(e.path);
    minOffset.set(e.path, cur === undefined ? e.offset : Math.min(cur, e.offset));
  }
  const store = blob();
  const items: T[] = [];
  let maxUploadedAt = '';
  for (const [path, offset] of minOffset) {
    const file = await store.getText(path);
    if (file === null) continue;
    const parsed = parseJsonl<T>(file.text);
    for (const item of parsed.slice(offset)) items.push(item);
  }
  for (const e of entries) if (e.uploadedAt > maxUploadedAt) maxUploadedAt = e.uploadedAt;
  return { items, entries, maxUploadedAt };
}

export function readEventsSince(cursor: string): Promise<ReadResult<FeedbackEvent>> {
  return readBatches<FeedbackEvent>('events', (e) => cursor.length === 0 || e.uploadedAt > cursor);
}

export function readEventsFromDay(fromDay: string): Promise<ReadResult<FeedbackEvent>> {
  return readBatches<FeedbackEvent>('events', (e) => e.day >= fromDay);
}

export function readAllEvents(): Promise<ReadResult<FeedbackEvent>> {
  return readBatches<FeedbackEvent>('events', () => true);
}

export function readSamplesSince(cursor: string): Promise<ReadResult<VoiceSample>> {
  return readBatches<VoiceSample>('samples', (e) => cursor.length === 0 || e.uploadedAt > cursor);
}

export function readAllSamples(): Promise<ReadResult<VoiceSample>> {
  return readBatches<VoiceSample>('samples', () => true);
}

/** Delete batches whose day is before `cutoffDay` (retention). Deletes are free; the index is rewritten once. */
export async function purgeBefore(cutoffDay: string): Promise<number> {
  const { index } = await loadIndex();
  const old = index.batches.filter((e) => e.day < cutoffDay);
  if (old.length === 0) return 0;
  const paths = [...new Set(old.map((e) => e.path))];
  await blob().del(paths);
  await updateIndex((idx) => {
    idx.batches = idx.batches.filter((e) => e.day >= cutoffDay);
  });
  return paths.length;
}

/** Delete every event and sample batch (index-driven plus a list() sweep for orphans) and reset the index. */
export async function deleteAllBatches(): Promise<{ events: number; samples: number }> {
  const store = blob();
  const { index } = await loadIndex();
  const paths = new Set<string>(index.batches.map((e) => e.path));
  for (const prefix of [PATHS.eventsPrefix, PATHS.samplesPrefix]) {
    for (const entry of await store.list(prefix)) if (entry.path !== PATHS.eventsIndex) paths.add(entry.path);
  }
  let events = 0;
  let samples = 0;
  for (const p of paths) {
    if (p.startsWith(PATHS.samplesPrefix)) samples += 1;
    else events += 1;
  }
  if (paths.size > 0) await store.del([...paths]);
  await store.putJson(PATHS.eventsIndex, emptyIndex());
  return { events, samples };
}
