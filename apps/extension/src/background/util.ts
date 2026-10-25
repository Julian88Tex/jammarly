/**
 * Small pure helpers for the service worker: stable JSON, random ids, local dates, bounded lists, promises.
 */

/** JSON with object keys sorted recursively, so equal values always serialize identically (cache keys). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** `n` random bytes as lowercase hex (crypto.getRandomValues; Math.random fallback only when crypto is absent). */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

export function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = randomHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A new device id: "d_" + 12 hex characters (matches the HLC device-id pattern). */
export function newDeviceId(): string {
  return `d_${randomHex(6)}`;
}

/** Local calendar date "YYYY-MM-DD" of a timestamp (ms). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local month "YYYY-MM" of a timestamp (ms). */
export function localMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Start of the next local day (ms). */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Appends `items` to `list` keeping at most `max` entries, evicting the oldest (front) first. */
export function appendBounded<T>(list: readonly T[], items: readonly T[], max: number): T[] {
  const out = list.concat(items);
  return out.length > max ? out.slice(out.length - max) : out;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** Lowercases, trims, strips a trailing dot and a leading "www." from a host name. */
export function normalizeHostName(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/** Host name of a URL, '' when the URL cannot be parsed or has no http(s) host. */
export function hostOfUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname;
  } catch {
    return '';
  }
}

/** A debounced trailing-edge function; `flush()` runs a pending call now, `cancel()` drops it. */
export function debounce(fn: () => void, ms: number): { call(): void; flush(): void; cancel(): void; pending(): boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      fn();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    pending() {
      return timer !== null;
    },
  };
}

/** Counting semaphore. */
export class Semaphore {
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  get inUse(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }
  /** Resolves with a release function once a permit is free. Rejects when the signal aborts while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < this.limit) {
        grant();
        return;
      }
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          // Pass the permit along; this waiter is gone.
          const next = this.waiters.shift();
          if (next) next();
          reject(abortError());
          return;
        }
        grant();
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

export function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
