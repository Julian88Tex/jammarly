/**
 * The server-side Anthropic key used only by the learning job: either the ANTHROPIC_API_KEY env var or a key
 * entered on the dashboard, stored AES-256-GCM encrypted under a key derived from SESSION_SECRET. It never
 * reaches devices and is never logged.
 */
import type { ServerKeyStatusResponse } from '@jammarly/shared/api';
import { isNotModified } from './blob';
import { openString, sealString, type SealedBox } from './crypto';
import { getEnv } from './env';
import { ApiRouteError } from './errors';
import { PATHS, blob } from './store';

interface ServerKeyDoc {
  box: SealedBox;
  hint: string;
  updatedAt: string;
}

const KEY_RE = /^[A-Za-z0-9_-]{20,256}$/;

export function keyHint(key: string): string {
  return key.slice(-4);
}

export async function getServerApiKey(): Promise<{ key: string; source: 'dashboard' | 'env' } | null> {
  const env = getEnv();
  const res = await blob().getJson<ServerKeyDoc>(PATHS.serverKey);
  if (res !== null && !isNotModified(res) && res.value?.box !== undefined) {
    const key = openString(res.value.box, env.SESSION_SECRET);
    if (key !== null && key.length > 0) return { key, source: 'dashboard' };
  }
  if (env.ANTHROPIC_API_KEY !== undefined) return { key: env.ANTHROPIC_API_KEY, source: 'env' };
  return null;
}

export async function serverKeyStatus(): Promise<ServerKeyStatusResponse> {
  const found = await getServerApiKey();
  return found === null ? { configured: false, hint: '' } : { configured: true, hint: keyHint(found.key) };
}

export async function setServerApiKey(key: string, nowMs: number = Date.now()): Promise<ServerKeyStatusResponse> {
  const trimmed = key.trim();
  if (!KEY_RE.test(trimmed)) throw new ApiRouteError(400, 'schema_invalid', 'That does not look like an API key.');
  const doc: ServerKeyDoc = { box: sealString(trimmed, getEnv().SESSION_SECRET), hint: keyHint(trimmed), updatedAt: new Date(nowMs).toISOString() };
  await blob().putJson(PATHS.serverKey, doc);
  return { configured: true, hint: doc.hint };
}

export async function clearServerApiKey(): Promise<ServerKeyStatusResponse> {
  await blob().del(PATHS.serverKey);
  return serverKeyStatus();
}
