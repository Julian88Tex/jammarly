import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventRpcClient,
  PROTOCOL_VERSION,
  RPC_METHODS,
  RPC_REQUEST_EVENT,
  RPC_RESULT_EVENT,
  decodeRequest,
  decodeResponse,
  decodeSnapshot,
  decodeStatus,
  dispatchDetail,
  encodeRequest,
  encodeResponse,
  encodeSnapshot,
  encodeStatus,
  errorMessage,
  newRequestId,
  serveRpc,
  validateParams,
  type RpcHandlers,
} from '../../src/content/gdocs/protocol';

describe('request encoding', () => {
  it('round-trips a request through a JSON string', () => {
    const encoded = encodeRequest({ id: 'r1', method: 'applyEdit', params: { start: 1, end: 4, replacement: 'x', expectedRaw: 'raw' } });
    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded).v).toBe(PROTOCOL_VERSION);
    expect(decodeRequest(encoded)).toEqual({ id: 'r1', method: 'applyEdit', params: { start: 1, end: 4, replacement: 'x', expectedRaw: 'raw' } });
  });

  it('accepts a plain object detail (same-world callers)', () => {
    expect(decodeRequest({ id: 'a', method: 'status' })).toEqual({ id: 'a', method: 'status', params: {} });
  });

  it('rejects malformed requests', () => {
    expect(decodeRequest('not json')).toBeNull();
    expect(decodeRequest(null)).toBeNull();
    expect(decodeRequest(42)).toBeNull();
    expect(decodeRequest('[]')).toBeNull();
    expect(decodeRequest(JSON.stringify({ method: 'status' }))).toBeNull();
    expect(decodeRequest(JSON.stringify({ id: '', method: 'status' }))).toBeNull();
    expect(decodeRequest(JSON.stringify({ id: 'x', method: 'eval' }))).toBeNull();
  });

  it('validates params per method', () => {
    expect(validateParams('setSelection', { start: 1, end: 2 })).toEqual({ start: 1, end: 2 });
    expect(validateParams('setSelection', { start: -1, end: 2 })).toBeNull();
    expect(validateParams('setSelection', { start: 1.5, end: 2 })).toBeNull();
    expect(validateParams('getGeometry', { start: 1 })).toBeNull();
    expect(validateParams('applyEdit', { start: 4, end: 2, replacement: 'x' })).toBeNull();
    expect(validateParams('applyEdit', { start: 1, end: 2, replacement: 7 })).toBeNull();
    expect(validateParams('applyEdit', { start: 1, end: 2, replacement: 'x', expectedRaw: 5 })).toBeNull();
    expect(validateParams('applyEdit', { start: 1, end: 2, replacement: 'x', extra: true })).toEqual({ start: 1, end: 2, replacement: 'x' });
    expect(validateParams('status', { junk: 1 })).toEqual({});
    expect(validateParams('getText', undefined)).toEqual({});
    expect(decodeRequest(JSON.stringify({ id: 'x', method: 'applyEdit', params: { start: 'a' } }))).toBeNull();
  });

  it('lists every method once', () => {
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
    expect(RPC_METHODS).toContain('getGeometry');
  });
});

describe('response, snapshot and status encoding', () => {
  it('round-trips ok and error responses', () => {
    expect(decodeResponse(encodeResponse({ id: '1', ok: true, result: { raw: 'x' } }))).toEqual({ id: '1', ok: true, result: { raw: 'x' } });
    expect(decodeResponse(encodeResponse({ id: '1', ok: true, result: undefined }))).toEqual({ id: '1', ok: true, result: null });
    expect(decodeResponse(encodeResponse({ id: '2', ok: false, error: 'boom' }))).toEqual({ id: '2', ok: false, error: 'boom' });
  });

  it('rejects malformed responses and defaults a missing error message', () => {
    expect(decodeResponse('{')).toBeNull();
    expect(decodeResponse(JSON.stringify({ id: 1, ok: true }))).toBeNull();
    expect(decodeResponse(JSON.stringify({ id: 'x', ok: 'yes' }))).toBeNull();
    expect(decodeResponse(JSON.stringify({ id: 'x', ok: false }))).toEqual({ id: 'x', ok: false, error: 'unknown error' });
  });

  it('round-trips text snapshots and tolerates missing counters', () => {
    const snap = { raw: '\u0003abc\n', text: 'abc', leading: 1, trailing: 1, version: 3 };
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap);
    expect(decodeSnapshot(JSON.stringify({ raw: 'a', text: 'a' }))).toEqual({ raw: 'a', text: 'a', leading: 0, trailing: 0, version: 0 });
    expect(decodeSnapshot(JSON.stringify({ raw: 'a' }))).toBeNull();
  });

  it('round-trips status in every state', () => {
    expect(decodeStatus(encodeStatus({ state: 'pending', active: false, announcedId: 'id' }))).toEqual({ state: 'pending', active: false, announcedId: 'id' });
    expect(decodeStatus(encodeStatus({ state: 'active', active: true, announcedId: 'id' }))).toEqual({ state: 'active', active: true, announcedId: 'id' });
    expect(decodeStatus(encodeStatus({ state: 'inactive', active: false, announcedId: '', error: 'no api' }))).toEqual({ state: 'inactive', active: false, announcedId: '', error: 'no api' });
    expect(decodeStatus(JSON.stringify({ state: 'weird' }))).toBeNull();
    expect(decodeStatus(JSON.stringify({ state: 'active' }))).toEqual({ state: 'active', active: true, announcedId: '' });
  });

  it('formats error messages from anything', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('s')).toBe('s');
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('generates distinct request ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
  });
});

describe('EventRpcClient + serveRpc', () => {
  let target: EventTarget;
  let unsubscribe: (() => void) | null = null;
  let client: EventRpcClient | null = null;

  const handlers: RpcHandlers = {
    status: () => ({ state: 'active', active: true, announcedId: 'abc' }),
    getText: async () => ({ raw: '\u0003hi\n' }),
    getSelection: () => null,
    setSelection: () => {
      throw new Error('sync failure');
    },
    applyEdit: async () => {
      throw new Error('async failure');
    },
    getGeometry: () => [],
  };

  beforeEach(() => {
    target = new EventTarget();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    client?.dispose();
    client = null;
    vi.useRealTimers();
  });

  it('resolves sync and async handlers', async () => {
    unsubscribe = serveRpc(target, handlers);
    client = new EventRpcClient(target);
    await expect(client.call('status', {})).resolves.toEqual({ state: 'active', active: true, announcedId: 'abc' });
    await expect(client.call('getText', {})).resolves.toEqual({ raw: '\u0003hi\n' });
    await expect(client.call('getSelection', {})).resolves.toBeNull();
    expect(client.pendingCount).toBe(0);
  });

  it('turns thrown and rejected handler errors into rejections', async () => {
    unsubscribe = serveRpc(target, handlers);
    client = new EventRpcClient(target);
    await expect(client.call('setSelection', { start: 0, end: 1 })).rejects.toThrow('sync failure');
    await expect(client.call('applyEdit', { start: 0, end: 1, replacement: 'x' })).rejects.toThrow('async failure');
  });

  it('sends string details and ignores results for unknown ids', async () => {
    const seen: unknown[] = [];
    target.addEventListener(RPC_REQUEST_EVENT, (ev) => seen.push((ev as CustomEvent).detail));
    unsubscribe = serveRpc(target, handlers);
    client = new EventRpcClient(target);
    dispatchDetail(target, RPC_RESULT_EVENT, encodeResponse({ id: 'nobody', ok: true, result: 1 }));
    dispatchDetail(target, RPC_RESULT_EVENT, 'garbage');
    await client.call('status', {});
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe('string');
  });

  it('ignores malformed requests on the server side', async () => {
    unsubscribe = serveRpc(target, handlers);
    const results: unknown[] = [];
    target.addEventListener(RPC_RESULT_EVENT, (ev) => results.push((ev as CustomEvent).detail));
    dispatchDetail(target, RPC_REQUEST_EVENT, 'nope');
    dispatchDetail(target, RPC_REQUEST_EVENT, JSON.stringify({ id: 'x', method: 'unknown' }));
    await Promise.resolve();
    expect(results).toEqual([]);
  });

  it('times out when nobody answers', async () => {
    vi.useFakeTimers();
    client = new EventRpcClient(target, 50);
    const p = client.call('status', {});
    const assertion = expect(p).rejects.toThrow(/timeout: status/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(client.pendingCount).toBe(0);
  });

  it('honours a per-call timeout', async () => {
    vi.useFakeTimers();
    client = new EventRpcClient(target, 10_000);
    const p = client.call('getText', {}, 20);
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it('rejects pending calls on dispose and refuses new ones', async () => {
    client = new EventRpcClient(target);
    const p = client.call('status', {});
    const assertion = expect(p).rejects.toThrow(/disposed/);
    client.dispose();
    await assertion;
    await expect(client.call('status', {})).rejects.toThrow(/disposed/);
  });

  it('stops answering after unsubscribe', async () => {
    vi.useFakeTimers();
    const stop = serveRpc(target, handlers);
    stop();
    client = new EventRpcClient(target, 30);
    const p = client.call('status', {});
    const assertion = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
  });
});
