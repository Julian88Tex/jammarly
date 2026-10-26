/**
 * The server-side Anthropic key used only by the learning job: a key the user entered on the dashboard (stored
 * per user, AES-256-GCM encrypted under a key derived from SESSION_SECRET), else the ANTHROPIC_API_KEY env var
 * shared by every user. It never reaches devices and is never logged.
 */
import type { ServerKeyStatusResponse } from '@jammarly/shared/api';
import { isNotModified } from './blob';
import { openString, sealString, type SealedBox } from './crypto';
import { getEnv } from './env';
import { ApiRouteError } from './errors';
import { blob, userPaths } from './store';

interface ServerKeyDoc {
  box: SealedBox;
  hint: string;
  updatedAt: string;
}

const KEY_RE = /^[A-Za-z0-9_-]{20,256}$/;

export function keyHint(key: string): string {
  return key.slice(-4);
}

export async function getServerApiKey(uid: string): Promise<{ key: string; source: 'dashboard' | 'env' } | null> {
  const env = getEnv();
  const res = await blob().getJson<ServerKeyDoc>(userPaths(uid).serverKey);
  if (res !== null && !isNotModified(res) && res.value?.box !== undefined) {
    const key = openString(res.value.box, env.SESSION_SECRET);
    if (key !== null && key.length > 0) return { key, source: 'dashboard' };
  }
  if (env.ANTHROPIC_API_KEY !== undefined) return { key: env.ANTHROPIC_API_KEY, source: 'env' };
  return null;
}

export async function serverKeyStatus(uid: string): Promise<ServerKeyStatusResponse> {
  const found = await getServerApiKey(uid);
  return found === null ? { configured: false, hint: '' } : { configured: true, hint: keyHint(found.key) };
}

export async function setServerApiKey(uid: string, key: string, nowMs: number = Date.now()): Promise<ServerKeyStatusResponse> {
  const trimmed = key.trim();
  if (!KEY_RE.test(trimmed)) throw new ApiRouteError(400, 'schema_invalid', 'That does not look like an API key.');
  const doc: ServerKeyDoc = { box: sealString(trimmed, getEnv().SESSION_SECRET), hint: keyHint(trimmed), updatedAt: new Date(nowMs).toISOString() };
  await blob().putJson(userPaths(uid).serverKey, doc);
  return { configured: true, hint: doc.hint };
}

export async function clearServerApiKey(uid: string): Promise<ServerKeyStatusResponse> {
  await blob().del(userPaths(uid).serverKey);
  return serverKeyStatus(uid);
}
