/** Browser-side helpers for the dashboard: same-origin fetch with typed errors, and profile ops stamped with the web clock. */
import type { ProfileOpsResponse } from '@jammarly/shared/api';
import { createClock } from '@jammarly/shared/hlc';
import type { LwwPath, ProfileOp, SetPath, VoiceContext, VoiceProfile } from '@jammarly/shared/profile';

const clock = createClock('web');

export class ApiClientError extends Error {
  override readonly name = 'ApiClientError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers, ...(body === undefined ? {} : { body }) });
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiClientError(res.status, err?.code ?? 'internal', err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

export const ops = {
  set: (path: LwwPath, value: unknown): ProfileOp => ({ op: 'set', path, value, hlc: clock.next() }),
  add: (path: SetPath, value: string): ProfileOp => ({ op: 'add', path, value, hlc: clock.next() }),
  remove: (path: SetPath, value: string): ProfileOp => ({ op: 'remove', path, value, hlc: clock.next() }),
  voice: (context: VoiceContext, profile: VoiceProfile): ProfileOp => ({ op: 'voice', context, profile, hlc: clock.next() }),
};

export function sendOps(list: ProfileOp[], baseVersion: number): Promise<ProfileOpsResponse> {
  return api<ProfileOpsResponse>('/api/profile/ops', { body: { baseVersion, ops: list } });
}

export function describeError(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export function formatDate(iso: string | undefined | null): string {
  if (iso === undefined || iso === null || iso.length === 0) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(iso: string | undefined | null, nowMs = Date.now()): string {
  if (iso === undefined || iso === null || iso.length === 0) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = Math.max(0, nowMs - ms);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
