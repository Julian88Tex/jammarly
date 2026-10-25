/**
 * Typed long-lived port from the side panel (or popup) to the service worker: PanelToWorker out, WorkerToPanel in,
 * over `chrome.runtime.connect({ name: 'jammarly-sidepanel' })` with reconnect and backoff. Messages sent while
 * disconnected are queued (bounded) and flushed after the next `onOpen` so `hello` always goes first.
 */
import type { PanelToWorker, WorkerToPanel } from '@jammarly/shared/types';
import { chromeApi } from './env';

export const PANEL_PORT_NAME = 'jammarly-sidepanel';

export type PortStatus = 'connecting' | 'open' | 'closed';

export interface PanelPort {
  /** Sends a message; queued when the port is not open. */
  send(msg: PanelToWorker): void;
  onMessage(handler: (msg: WorkerToPanel) => void): () => void;
  onStatus(handler: (status: PortStatus) => void): () => void;
  readonly status: PortStatus;
  /** Number of reconnect attempts since the last successful open. */
  readonly attempts: number;
  /** Closes the port and stops reconnecting. */
  close(): void;
}

export interface ConnectOptions {
  name?: string;
  /** Called on every (re)connect before queued messages flush; send `hello` here. */
  onOpen?: (port: PanelPort) => void;
  /** Delays between reconnect attempts; the last value repeats. */
  backoffMs?: number[];
  maxQueue?: number;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10_000, 30_000];

/** Structural check for an incoming WorkerToPanel message. */
export function isWorkerToPanel(value: unknown): value is WorkerToPanel {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'fields' || type === 'field-state' || type === 'field-removed' || type === 'check-progress' || type === 'check-result' || type === 'tone' || type === 'config';
}

export function connectPanelPort(opts: ConnectOptions = {}): PanelPort {
  const name = opts.name ?? PANEL_PORT_NAME;
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF;
  const maxQueue = opts.maxQueue ?? 50;
  const messageHandlers = new Set<(msg: WorkerToPanel) => void>();
  const statusHandlers = new Set<(status: PortStatus) => void>();
  const queue: PanelToWorker[] = [];
  let raw: chrome.runtime.Port | null = null;
  let status: PortStatus = 'connecting';
  let attempts = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: PortStatus): void => {
    if (status === next) return;
    status = next;
    for (const handler of statusHandlers) {
      try {
        handler(next);
      } catch (err) {
        console.debug('[jammarly] port status handler failed', err);
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (closed || timer) return;
    const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 1000;
    attempts += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  const flush = (): void => {
    if (!raw) return;
    while (queue.length > 0 && raw) {
      const next = queue.shift();
      if (next) post(next);
    }
  };

  const post = (msg: PanelToWorker): void => {
    if (!raw) return;
    try {
      raw.postMessage(msg);
    } catch (err) {
      console.debug('[jammarly] postMessage failed, reconnecting', err);
      dropPort();
      queue.unshift(msg);
      scheduleReconnect();
    }
  };

  const dropPort = (): void => {
    raw = null;
    setStatus(closed ? 'closed' : 'connecting');
  };

  const api: PanelPort = {
    send(msg) {
      if (raw && status === 'open') {
        post(msg);
        return;
      }
      if (queue.length >= maxQueue) queue.shift();
      queue.push(msg);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    get status() {
      return status;
    },
    get attempts() {
      return attempts;
    },
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const p = raw;
      raw = null;
      try {
        p?.disconnect();
      } catch {
        // already gone
      }
      setStatus('closed');
    },
  };

  const connect = (): void => {
    if (closed) return;
    const runtime = chromeApi()?.runtime;
    if (!runtime?.connect) {
      setStatus('connecting');
      scheduleReconnect();
      return;
    }
    let port: chrome.runtime.Port;
    try {
      port = runtime.connect({ name });
    } catch (err) {
      console.debug('[jammarly] connect failed', err);
      setStatus('connecting');
      scheduleReconnect();
      return;
    }
    raw = port;
    port.onMessage.addListener((msg: unknown) => {
      if (raw !== port) return;
      if (!isWorkerToPanel(msg)) return;
      for (const handler of messageHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.debug('[jammarly] port message handler failed', err);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError marks it as checked; otherwise Chrome logs "Unchecked runtime.lastError" as a console error.
      void runtime.lastError;
      if (raw !== port) return;
      dropPort();
      scheduleReconnect();
    });
    attempts = 0;
    setStatus('open');
    try {
      opts.onOpen?.(api);
    } catch (err) {
      console.debug('[jammarly] onOpen failed', err);
    }
    flush();
  };

  connect();
  return api;
}
