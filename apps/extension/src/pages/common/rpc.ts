/**
 * Request/response channel from an extension page to the service worker: `chrome.runtime.sendMessage` wrapped with
 * a timeout and a typed `{ ok: false }` fallback, so pages render a sane state when the worker is missing, answers
 * with an unexpected shape, rejects, or never replies.
 */
import type { RuntimeRequest, RuntimeResponse } from '@jammarly/shared/types';
import { chromeApi } from './env';

export const RPC_TIMEOUT_MS = 10_000;

export type RpcFailure = Extract<RuntimeResponse, { ok: false }>;
export type RpcSuccess = Extract<RuntimeResponse, { ok: true }>;
export type RpcSuccessType = RpcSuccess['type'];
export type RpcOf<K extends RpcSuccessType> = Extract<RpcSuccess, { type: K }>;

export interface RpcErrorRecord {
  at: string;
  request: RuntimeRequest['type'];
  code: string;
  message: string;
}

const recentErrors: RpcErrorRecord[] = [];
const MAX_RECENT_ERRORS = 10;

function recordError(request: RuntimeRequest['type'], failure: RpcFailure): void {
  recentErrors.unshift({ at: new Date().toISOString(), request, code: failure.error.code, message: failure.error.message });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.length = MAX_RECENT_ERRORS;
}

/** The most recent worker errors seen by this page (newest first); the options page shows them under Advanced. */
export function recentRpcErrors(): readonly RpcErrorRecord[] {
  return recentErrors;
}

export function failure(code: string, message: string): RpcFailure {
  return { ok: false, error: { code, message } };
}

/** Structural check: a RuntimeResponse is an object with a boolean `ok` and either a `type` or an `error`. */
export function isRuntimeResponse(value: unknown): value is RuntimeResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; type?: unknown; error?: unknown };
  if (v.ok === true) return typeof v.type === 'string';
  if (v.ok === false) {
    const e = v.error as { code?: unknown; message?: unknown } | undefined;
    return !!e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string';
  }
  return false;
}

export interface RequestOptions {
  timeoutMs?: number;
}

/**
 * Sends a RuntimeRequest and resolves with a RuntimeResponse, never rejecting:
 *  - no `chrome.runtime`            -> { ok:false, error.code 'no-runtime' }
 *  - sendMessage throws / rejects   -> 'unavailable'
 *  - reply undefined (no listener)  -> 'no-reply'
 *  - reply of an unexpected shape   -> 'bad-response'
 *  - no reply within the timeout    -> 'timeout'
 */
export function request(req: RuntimeRequest, opts: RequestOptions = {}): Promise<RuntimeResponse> {
  const api = chromeApi();
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  return new Promise<RuntimeResponse>((resolve) => {
    let settled = false;
    const finish = (res: RuntimeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!res.ok) recordError(req.type, res);
      resolve(res);
    };
    const timer = setTimeout(() => finish(failure('timeout', `The extension did not answer '${req.type}' within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    if (!api?.runtime?.sendMessage) {
      finish(failure('no-runtime', 'This page is not running inside the extension.'));
      return;
    }
    let pending: unknown;
    try {
      pending = api.runtime.sendMessage(req);
    } catch (err) {
      finish(failure('unavailable', errorMessage(err)));
      return;
    }
    Promise.resolve(pending).then(
      (reply: unknown) => {
        if (reply === undefined || reply === null) {
          finish(failure('no-reply', 'The extension did not answer. It may still be starting up.'));
        } else if (isRuntimeResponse(reply)) {
          finish(reply);
        } else {
          finish(failure('bad-response', 'The extension answered in an unexpected format.'));
        }
      },
      (err: unknown) => finish(failure('unavailable', errorMessage(err))),
    );
  });
}

/** Like {@link request} but narrows to one success type; any other shape becomes a failure. */
export async function requestAs<K extends RpcSuccessType>(req: RuntimeRequest, type: K, opts?: RequestOptions): Promise<RpcOf<K> | RpcFailure> {
  const res = await request(req, opts);
  if (!res.ok) return res;
  if (res.type === type) return res as RpcOf<K>;
  // 'ok' is an acceptable acknowledgment for writes whose caller asked for something richer; everything else is a shape error.
  return failure('bad-response', `Expected a '${type}' answer but got '${res.type}'.`);
}

/** Picks a success payload of the given type out of a response, or null. */
export function pick<K extends RpcSuccessType>(res: RuntimeResponse, type: K): RpcOf<K> | null {
  return res.ok && res.type === type ? (res as RpcOf<K>) : null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message;
  return 'Unknown error';
}

/** Human copy for a failure code, used by status lines and toasts. */
export function describeFailure(res: RpcFailure): string {
  switch (res.error.code) {
    case 'no-runtime':
      return 'Open this page from the extension to change settings.';
    case 'no-reply':
    case 'unavailable':
      return "Can't reach Jammarly's background service. Reload the extension and try again.";
    case 'timeout':
      return 'Jammarly is taking too long to answer. Try again in a moment.';
    case 'bad-response':
      return 'Jammarly answered in an unexpected format. Reload the extension.';
    default:
      return res.error.message || 'Something went wrong.';
  }
}
