import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerToContent } from '@jammarly/shared/types';
import { CONTENT_PORT_NAME, PortClient, isWorkerToContent } from '../../../src/content/controller/port-client';
import { FAKE_TIMER_APIS, installFakeChrome, type FakeChrome } from './helpers';

let fake: FakeChrome;

function make(opts: { backoffMs?: number[] } = {}) {
  const onMessage = vi.fn<(msg: WorkerToContent) => void>();
  const onConnected = vi.fn<(reconnect: boolean) => void>();
  const onInvalidated = vi.fn();
  const client = new PortClient({
    runtime: () => (fake.runtime.id ? (fake.runtime as never) : undefined),
    onMessage,
    onConnected,
    onInvalidated,
    ...(opts.backoffMs ? { backoffMs: opts.backoffMs } : {}),
  });
  return { client, onMessage, onConnected, onInvalidated };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  fake = installFakeChrome();
});

afterEach(() => {
  fake.uninstall();
  vi.useRealTimers();
});

describe('PortClient', () => {
  it('connects with the content port name and reports the first connect as not a reconnect', () => {
    const { client, onConnected } = make();
    client.connect();
    expect(fake.runtime.connect).toHaveBeenCalledWith({ name: CONTENT_PORT_NAME });
    expect(onConnected).toHaveBeenCalledWith(false);
    expect(client.connected).toBe(true);
    expect(client.state).toBe('connected');
    expect(client.send({ type: 'ping' })).toBe(true);
    expect(fake.port.posted).toEqual([{ type: 'ping' }]);
    client.connect(); // idempotent while connected
    expect(fake.runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('delivers well-formed worker messages and ignores garbage', () => {
    const { client, onMessage } = make();
    client.connect();
    fake.port.emit({ type: 'ping' });
    fake.port.emit({ nope: true });
    fake.port.emit({ type: 'unknown-thing' });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: 'ping' });
    expect(isWorkerToContent({ type: 'config', config: {} })).toBe(true);
    expect(isWorkerToContent('config')).toBe(false);
    expect(isWorkerToContent(null)).toBe(false);
  });

  it('reconnects with exponential backoff after a disconnect and reports a reconnect', () => {
    const { client, onConnected } = make({ backoffMs: [500, 1000, 2000] });
    client.connect();
    const first = fake.port;
    first.fireDisconnect();
    expect(client.connected).toBe(false);
    expect(client.state).toBe('reconnecting');
    expect(client.send({ type: 'ping' })).toBe(false);
    vi.advanceTimersByTime(499);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenLastCalledWith(true);
    fake.port.fireDisconnect();
    vi.advanceTimersByTime(999);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(3);
    expect(client.reconnectAttempts).toBe(2);
    fake.port.emit({ type: 'ping' }); // a message resets the backoff
    expect(client.reconnectAttempts).toBe(0);
  });

  it('tears down instead of retrying when the extension context is invalidated', () => {
    const { client, onInvalidated } = make();
    client.connect();
    fake.runtime.id = undefined;
    fake.port.fireDisconnect();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('invalidated');
    vi.advanceTimersByTime(60_000);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(1);
    client.connect();
    expect(fake.runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('fails fast when connect throws (no runtime) and when there is no runtime id at all', () => {
    const { client, onInvalidated } = make();
    fake.runtime.connect.mockImplementationOnce(() => {
      throw new Error('Extension context invalidated.');
    });
    client.connect();
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it('pings every 20 s while a request is outstanding and stops when none is', () => {
    const { client } = make();
    client.connect();
    client.setOutstanding('f1:fast', true);
    vi.advanceTimersByTime(20_000);
    expect(fake.port.messages('ping')).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    expect(fake.port.messages('ping')).toHaveLength(2);
    client.setOutstanding('f1:fast', false);
    vi.advanceTimersByTime(60_000);
    expect(fake.port.messages('ping')).toHaveLength(2);
    expect(client.outstandingCount).toBe(0);
    client.dispose();
    expect(client.state).toBe('disposed');
    expect(fake.port.disconnected).toBe(true);
  });

  it('reconnects immediately on a bfcache pageshow when the port is gone', () => {
    const { client } = make({ backoffMs: [30_000] });
    client.connect();
    fake.port.fireDisconnect();
    expect(fake.runtime.connect).toHaveBeenCalledTimes(1);
    const ev = new Event('pageshow');
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(2);
    expect(client.connected).toBe(true);
    client.dispose();
  });

  it('treats a throwing postMessage as a disconnect', () => {
    const { client } = make({ backoffMs: [100] });
    client.connect();
    fake.port.disconnect(); // the other side is gone but onDisconnect has not fired yet
    expect(client.send({ type: 'ping' })).toBe(false);
    expect(client.connected).toBe(false);
    vi.advanceTimersByTime(100);
    expect(fake.runtime.connect).toHaveBeenCalledTimes(2);
  });
});
