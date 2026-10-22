/**
 * Service-worker keepalive while model requests are in flight (ARCHITECTURE §3.1, research 03 §2.3): every 20 s an
 * extension API call (`chrome.runtime.getPlatformInfo`) resets Chrome's 30 s idle timer; content scripts also
 * ping over their ports. The interval runs only while at least one request is active.
 */
export interface KeepaliveRuntime {
  getPlatformInfo(): Promise<unknown> | void;
}

export interface Keepalive {
  begin(): void;
  end(): void;
  /** One immediate API call (answering a content-script ping). */
  tick(): void;
  readonly active: number;
  readonly running: boolean;
}

export const KEEPALIVE_INTERVAL_MS = 20_000;

export function createKeepalive(runtime: KeepaliveRuntime | undefined, intervalMs: number = KEEPALIVE_INTERVAL_MS): Keepalive {
  let active = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const call = (): void => {
    try {
      const r = runtime?.getPlatformInfo();
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // not available (tests without a runtime)
    }
  };
  return {
    begin() {
      active++;
      if (timer === null) timer = setInterval(call, intervalMs);
    },
    end() {
      active = Math.max(0, active - 1);
      if (active === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick() {
      call();
    },
    get active() {
      return active;
    },
    get running() {
      return timer !== null;
    },
  };
}
