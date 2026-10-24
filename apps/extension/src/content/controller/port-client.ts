/**
 * Typed long-lived port to the service worker (ARCHITECTURE §3.1): `chrome.runtime.connect({ name: 'jammarly-content' })`,
 * ContentToWorker out, WorkerToContent in. Reconnects with exponential backoff on `onDisconnect` and on `pageshow`
 * (bfcache restore), calling `onConnected` on every (re)connect so the registry re-sends `hello`, `field-attached`
 * and outstanding checks. Pings every 20 s while any request is outstanding (keeps the worker alive, research 03
 * §2.3). When the extension context is gone (`chrome.runtime.id` undefined, connect throws) it tears down instead
 * of retrying.
 */
import type { ContentToWorker, WorkerToContent } from '@jammarly/shared/types';
import { realTimers, safeRuntime, type PortLike, type RuntimeLike, type Timers } from './util';

export const CONTENT_PORT_NAME = 'jammarly-content';
export const PING_INTERVAL_MS = 20_000;
export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000, 30_000];

const WORKER_TYPES: ReadonlySet<string> = new Set(['config', 'check-progress', 'check-result', 'tone', 'panel-action', 'ping']);

/** Structural check for an incoming WorkerToContent message. */
export function isWorkerToContent(value: unknown): value is WorkerToContent {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && WORKER_TYPES.has(type);
}

export interface PortClientOptions {
  /** Resolves `chrome.runtime`; undefined when the extension context is invalidated. */
  runtime?: () => RuntimeLike | undefined;
  name?: string;
  onMessage(msg: WorkerToContent): void;
  /** Fired after every successful connect; `reconnect` is false for the first one. */
  onConnected(reconnect: boolean): void;
  /** The extension was updated/removed: tear everything down. */
  onInvalidated(): void;
  backoffMs?: readonly number[];
  pingIntervalMs?: number;
  timers?: Timers;
  /** Window for the `pageshow` listener (null to skip). */
  win?: Window | null;
}

export type PortState = 'idle' | 'connected' | 'reconnecting' | 'invalidated' | 'disposed';

export class PortClient {
  private port: PortLike | null = null;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private attempts = 0;
  private everConnected = false;
  private stateValue: PortState = 'idle';
  private readonly outstanding = new Set<string>();
  private readonly timers: Timers;
  private readonly runtime: () => RuntimeLike | undefined;
  private readonly backoff: readonly number[];
  private readonly pingInterval: number;
  private readonly name: string;
  private readonly win: Window | null;
  private readonly onPageShow = (ev: Event): void => {
    const persisted = (ev as PageTransitionEvent).persisted;
    if (!persisted || this.stateValue === 'disposed' || this.stateValue === 'invalidated') return;
    if (this.port === null) {
      this.clearReconnect();
      this.connect();
    }
  };

  constructor(private readonly opts: PortClientOptions) {
    this.timers = opts.timers ?? realTimers;
    this.runtime = opts.runtime ?? safeRuntime;
    this.backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
    this.pingInterval = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.name = opts.name ?? CONTENT_PORT_NAME;
    this.win = opts.win === undefined ? (typeof window === 'undefined' ? null : window) : opts.win;
    this.win?.addEventListener('pageshow', this.onPageShow);
  }

  get state(): PortState {
    return this.stateValue;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  get reconnectAttempts(): number {
    return this.attempts;
  }

  get outstandingCount(): number {
    return this.outstanding.size;
  }

  connect(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'invalidated' || this.port !== null) return;
    const rt = this.runtime();
    if (!rt || !rt.id) {
      this.invalidate();
      return;
    }
    let port: PortLike;
    try {
      port = rt.connect({ name: this.name });
    } catch {
      this.invalidate();
      return;
    }
    this.port = port;
    this.stateValue = 'connected';
    const onMessage = (msg: unknown): void => {
      if (this.port !== port) return;
      this.attempts = 0;
      if (isWorkerToContent(msg)) this.opts.onMessage(msg);
    };
    const onDisconnect = (): void => {
      if (this.port !== port) return;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      this.port = null;
      this.stopPing();
      const live = this.runtime();
      if (!live || !live.id) {
        this.invalidate();
        return;
      }
      this.scheduleReconnect();
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    const reconnect = this.everConnected;
    this.everConnected = true;
    this.opts.onConnected(reconnect);
    if (this.outstanding.size > 0) this.startPing();
  }

  /** Posts a message; false when there is no live port (the registry re-sends state on reconnect). */
  send(msg: ContentToWorker): boolean {
    const port = this.port;
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch {
      this.port = null;
      this.stopPing();
      const live = this.runtime();
      if (!live || !live.id) this.invalidate();
      else this.scheduleReconnect();
      return false;
    }
  }

  /** Marks a request outstanding (pings run while the set is non-empty). */
  setOutstanding(key: string, outstanding: boolean): void {
    if (outstanding) this.outstanding.add(key);
    else this.outstanding.delete(key);
    if (this.outstanding.size > 0 && this.port) this.startPing();
    else if (this.outstanding.size === 0) this.stopPing();
  }

  dispose(): void {
    if (this.stateValue === 'disposed') return;
    this.stateValue = 'disposed';
    this.clearReconnect();
    this.stopPing();
    this.win?.removeEventListener('pageshow', this.onPageShow);
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // already gone
    }
  }

  private scheduleReconnect(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'invalidated' || this.reconnectTimer !== null) return;
    this.stateValue = 'reconnecting';
    const delay = this.backoff[Math.min(this.attempts, this.backoff.length - 1)]!;
    this.attempts++;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = this.timers.setInterval(() => {
      if (this.outstanding.size === 0) {
        this.stopPing();
        return;
      }
      this.send({ type: 'ping' });
    }, this.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private invalidate(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'invalidated') return;
    this.stateValue = 'invalidated';
    this.clearReconnect();
    this.stopPing();
    this.port = null;
    this.win?.removeEventListener('pageshow', this.onPageShow);
    this.opts.onInvalidated();
  }
}
