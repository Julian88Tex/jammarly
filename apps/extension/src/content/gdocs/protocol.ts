/**
 * CustomEvent RPC between the isolated-world Google Docs adapter and the MAIN-world bridge (06 §6, Harper's pattern).
 *
 * Both worlds share `document`, so a request is a CustomEvent 'jammarly:gdocs-rpc' and the reply a
 * 'jammarly:gdocs-rpc-result'. In Chrome a CustomEvent `detail` only crosses worlds when it is structured-cloneable,
 * so every detail is a JSON string (primitives always cross). The bridge also pushes 'jammarly:gdocs-text' snapshots
 * (125 ms poll, only when the text changed) and 'jammarly:gdocs-status' on activation or failure.
 *
 * Offsets on the wire are RAW Docs offsets (into `getText()`, sentinel included); the adapter translates its
 * normalized offsets with `normalizeDocsText`. The MAIN-world side exposes nothing to the page but these events;
 * a page script could forge them, which is the documented, accepted risk of every cross-world bridge.
 *
 * Pure except for the event plumbing (`EventRpcClient`, `serveRpc`), which takes its EventTarget as a parameter.
 */
import type { RectJson } from './geometry';

export const RPC_REQUEST_EVENT = 'jammarly:gdocs-rpc';
export const RPC_RESULT_EVENT = 'jammarly:gdocs-rpc-result';
export const TEXT_EVENT = 'jammarly:gdocs-text';
export const STATUS_EVENT = 'jammarly:gdocs-status';
export const PROTOCOL_VERSION = 1;

export const DEFAULT_RPC_TIMEOUT_MS = 2000;
/** Harper's cadence; never faster (06 §6 performance budget). */
export const TEXT_POLL_INTERVAL_MS = 125;
/** How long the bridge waits for Docs to expose the API before giving up. */
export const ACTIVATION_TIMEOUT_MS = 20_000;
export const ACTIVATION_POLL_INTERVAL_MS = 250;

export type GdocsBridgeState = 'pending' | 'active' | 'inactive';

export interface GdocsStatus {
  state: GdocsBridgeState;
  /** `state === 'active'`: Docs exposed `_docs_annotate_getAnnotatedText` and returned a model for our id. */
  active: boolean;
  /** The id announced by the bootstrap (ours, or the pre-set flag another extension left). */
  announcedId: string;
  /** Why the bridge is inactive, when it is. */
  error?: string;
}

/** What the bridge pushes on every text change. `leading`/`trailing` are the stripped code units (see text.ts). */
export interface GdocsTextSnapshot {
  raw: string;
  text: string;
  leading: number;
  trailing: number;
  /** Bridge-side change counter (informational; the adapter keeps its own). */
  version: number;
}

export type GdocsApplyReason = 'stale' | 'mismatch' | 'unsupported' | 'no-effect' | 'error';

export interface GdocsApplyResult {
  ok: boolean;
  /** Raw text after the attempt. */
  text: string;
  reason?: GdocsApplyReason;
  /** 'replace' | 'delete-right' | 'delete-left' | 'noop'. */
  strategy?: string;
}

export interface GdocsSelection {
  start: number;
  end: number;
}

export interface RpcMethods {
  status: { params: Record<string, never>; result: GdocsStatus };
  getText: { params: Record<string, never>; result: { raw: string } };
  getSelection: { params: Record<string, never>; result: GdocsSelection | null };
  setSelection: { params: GdocsSelection; result: { ok: true } };
  applyEdit: {
    params: {
      start: number;
      end: number;
      replacement: string;
      /** Compare-and-swap guard: the raw text the caller read; a differing live text refuses with 'stale'. */
      expectedRaw?: string;
    };
    result: GdocsApplyResult;
  };
  getGeometry: { params: GdocsSelection; result: RectJson[] };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result'];

export const RPC_METHODS: readonly RpcMethod[] = ['status', 'getText', 'getSelection', 'setSelection', 'applyEdit', 'getGeometry'];
const METHOD_SET: ReadonlySet<string> = new Set(RPC_METHODS);

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: string;
  method: M;
  params: RpcParams<M>;
}

export type RpcResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/** What a caller sees: `call(method, params)` resolves with the typed result or rejects with the bridge's error. */
export interface GdocsRpc {
  call<M extends RpcMethod>(method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>>;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

// ---------------------------------------------------------------------------
// Encoding (JSON strings; plain objects are accepted on decode for same-world callers and tests)
// ---------------------------------------------------------------------------

function parseDetail(detail: unknown): Record<string, unknown> | null {
  let value: unknown = detail;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Validate a method's params; returns the cleaned params or null when the shape is wrong. */
export function validateParams<M extends RpcMethod>(method: M, params: unknown): RpcParams<M> | null {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  switch (method) {
    case 'status':
    case 'getText':
    case 'getSelection':
      return {} as RpcParams<M>;
    case 'setSelection':
    case 'getGeometry':
      if (!isInt(p.start) || !isInt(p.end) || p.start < 0 || p.end < 0) return null;
      return { start: p.start, end: p.end } as RpcParams<M>;
    case 'applyEdit': {
      if (!isInt(p.start) || !isInt(p.end) || p.start < 0 || p.end < p.start) return null;
      if (typeof p.replacement !== 'string') return null;
      if (p.expectedRaw !== undefined && typeof p.expectedRaw !== 'string') return null;
      const out: RpcParams<'applyEdit'> = { start: p.start, end: p.end, replacement: p.replacement };
      if (typeof p.expectedRaw === 'string') out.expectedRaw = p.expectedRaw;
      return out as RpcParams<M>;
    }
    default:
      return null;
  }
}

export function encodeRequest(req: RpcRequest): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, id: req.id, method: req.method, params: req.params });
}

export function decodeRequest(detail: unknown): RpcRequest | null {
  const o = parseDetail(detail);
  if (!o) return null;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  if (typeof o.method !== 'string' || !METHOD_SET.has(o.method)) return null;
  const method = o.method as RpcMethod;
  const params = validateParams(method, o.params);
  if (params === null) return null;
  return { id: o.id, method, params } as RpcRequest;
}

export function encodeResponse(res: RpcResponse): string {
  return JSON.stringify(res.ok ? { v: PROTOCOL_VERSION, id: res.id, ok: true, result: res.result ?? null } : { v: PROTOCOL_VERSION, id: res.id, ok: false, error: res.error });
}

export function decodeResponse(detail: unknown): RpcResponse | null {
  const o = parseDetail(detail);
  if (!o || typeof o.id !== 'string' || typeof o.ok !== 'boolean') return null;
  if (o.ok) return { id: o.id, ok: true, result: o.result };
  return { id: o.id, ok: false, error: typeof o.error === 'string' ? o.error : 'unknown error' };
}

export function encodeSnapshot(s: GdocsTextSnapshot): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, raw: s.raw, text: s.text, leading: s.leading, trailing: s.trailing, version: s.version });
}

export function decodeSnapshot(detail: unknown): GdocsTextSnapshot | null {
  const o = parseDetail(detail);
  if (!o || typeof o.raw !== 'string' || typeof o.text !== 'string') return null;
  const leading = isInt(o.leading) ? o.leading : 0;
  const trailing = isInt(o.trailing) ? o.trailing : 0;
  const version = isInt(o.version) ? o.version : 0;
  return { raw: o.raw, text: o.text, leading, trailing, version };
}

export function encodeStatus(s: GdocsStatus): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, state: s.state, active: s.active, announcedId: s.announcedId, ...(s.error ? { error: s.error } : {}) });
}

export function decodeStatus(detail: unknown): GdocsStatus | null {
  const o = parseDetail(detail);
  if (!o) return null;
  const state = o.state === 'active' || o.state === 'inactive' || o.state === 'pending' ? o.state : null;
  if (!state) return null;
  const out: GdocsStatus = { state, active: state === 'active' && o.active !== false, announcedId: typeof o.announcedId === 'string' ? o.announcedId : '' };
  if (typeof o.error === 'string') out.error = o.error;
  return out;
}

// ---------------------------------------------------------------------------
// Event plumbing
// ---------------------------------------------------------------------------

/** Dispatch `type` with a string detail on `target`. */
export function dispatchDetail(target: EventTarget, type: string, detail: string): void {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

let counter = 0;
export function newRequestId(): string {
  counter = (counter + 1) % 0x7fffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Isolated-world client: dispatches requests on `target` and resolves replies by id. */
export class EventRpcClient implements GdocsRpc {
  private readonly pending = new Map<string, Pending>();
  private readonly onResult = (ev: Event): void => {
    const res = decodeResponse((ev as CustomEvent).detail);
    if (!res) return;
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  };
  private disposed = false;

  constructor(
    private readonly target: EventTarget,
    private readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ) {
    target.addEventListener(RPC_RESULT_EVENT, this.onResult);
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>, timeoutMs: number = this.timeoutMs): Promise<RpcResult<M>> {
    if (this.disposed) return Promise.reject(new Error('gdocs rpc client disposed'));
    const id = newRequestId();
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gdocs rpc timeout: ${method}`));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        dispatchDetail(this.target, RPC_REQUEST_EVENT, encodeRequest({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(errorMessage(e)));
      }
    });
  }

  /** Outstanding calls, for diagnostics and tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.disposed = true;
    this.target.removeEventListener(RPC_RESULT_EVENT, this.onResult);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('gdocs rpc client disposed'));
      this.pending.delete(id);
    }
  }
}

/** One handler per method; may be sync or async; a throw becomes `{ ok: false, error }`. */
export type RpcHandlers = { [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>> | RpcResult<M> };

/** MAIN-world server: answer requests arriving on `target`. Returns the unsubscribe function. */
export function serveRpc(target: EventTarget, handlers: RpcHandlers): () => void {
  const onRequest = (ev: Event): void => {
    const req = decodeRequest((ev as CustomEvent).detail);
    if (!req) return;
    const reply = (res: RpcResponse): void => {
      try {
        dispatchDetail(target, RPC_RESULT_EVENT, encodeResponse(res));
      } catch {
        // nothing else to do: the caller times out
      }
    };
    let result: unknown;
    try {
      const handler = handlers[req.method] as (params: unknown) => unknown;
      result = handler(req.params);
    } catch (e) {
      reply({ id: req.id, ok: false, error: errorMessage(e) });
      return;
    }
    Promise.resolve(result).then(
      (value) => reply({ id: req.id, ok: true, result: value }),
      (e: unknown) => reply({ id: req.id, ok: false, error: errorMessage(e) }),
    );
  };
  target.addEventListener(RPC_REQUEST_EVENT, onRequest);
  return () => target.removeEventListener(RPC_REQUEST_EVENT, onRequest);
}
