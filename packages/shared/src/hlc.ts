/**
 * Hybrid logical clocks (HLC) for the profile document's LWW registers and OR-sets.
 *
 * Wire format: `wallMs(13 digits)-counter(1-6 digits)-deviceId`, e.g. `1760870400000-0-d_8f3a`.
 * Plain string comparison is NOT a correct ordering because the counter has a variable width
 * (`...-10-x` must sort after `...-9-x`); always use {@link compareHlc}.
 *
 * `ZERO_HLC` (`0000000000000-0-init`, exported from ./profile) parses like any other clock and sorts
 * before every real timestamp, so defaults never win a merge against a real write.
 *
 * No DOM, no chrome.*, no side effects at import.
 */
import type { Hlc } from './profile';
import { ZERO_HLC } from './profile';

export interface ParsedHlc {
  wallMs: number;
  counter: number;
  deviceId: string;
}

/** Strict wire pattern: 13-digit wall clock, 1-6 digit counter, device id. */
export const HLC_PATTERN = /^(\d{13})-(\d{1,6})-([A-Za-z0-9_-]{1,64})$/;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Largest counter that still fits the 6-digit field. */
export const HLC_MAX_COUNTER = 999_999;
/** Largest wall value that fits 13 digits (year 2286). */
export const HLC_MAX_WALL_MS = 9_999_999_999_999;

export function parseHlc(value: unknown): ParsedHlc | null {
  if (typeof value !== 'string') return null;
  const m = HLC_PATTERN.exec(value);
  if (!m) return null;
  const wall = m[1];
  const counter = m[2];
  const deviceId = m[3];
  if (wall === undefined || counter === undefined || deviceId === undefined) return null;
  return { wallMs: Number(wall), counter: Number(counter), deviceId };
}

export function isHlc(value: unknown): value is Hlc {
  return parseHlc(value) !== null;
}

/** True for `ZERO_HLC` and any other clock with wall 0 and counter 0 (a "never written" marker). */
export function isZeroHlc(value: unknown): boolean {
  const p = parseHlc(value);
  return p !== null && p.wallMs === 0 && p.counter === 0;
}

export function formatHlc(parts: ParsedHlc): Hlc {
  if (!DEVICE_ID_PATTERN.test(parts.deviceId)) {
    throw new TypeError(`invalid HLC device id: ${JSON.stringify(parts.deviceId)}`);
  }
  const wall = clampInt(parts.wallMs, 0, HLC_MAX_WALL_MS);
  const counter = clampInt(parts.counter, 0, HLC_MAX_COUNTER);
  return `${String(wall).padStart(13, '0')}-${counter}-${parts.deviceId}`;
}

/**
 * Total order: wall (numeric) -> counter (numeric) -> device id (lexical). Two unparsable strings fall
 * back to lexical order; a parsable clock always sorts after an unparsable one.
 */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a === b) return 0;
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (pa === null || pb === null) {
    if (pa !== null) return 1;
    if (pb !== null) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (pa.wallMs !== pb.wallMs) return pa.wallMs < pb.wallMs ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  if (pa.deviceId !== pb.deviceId) return pa.deviceId < pb.deviceId ? -1 : 1;
  return 0;
}

/** The greater of two clocks; `a` on a tie. */
export function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}

/** Wall-clock milliseconds of a clock, 0 when it cannot be parsed. */
export function hlcWallMs(value: Hlc): number {
  return parseHlc(value)?.wallMs ?? 0;
}

/** ISO-8601 rendering of a clock's wall time (the epoch for ZERO_HLC or garbage). */
export function hlcToIso(value: Hlc): string {
  return new Date(hlcWallMs(value)).toISOString();
}

export interface HlcClockOptions {
  /**
   * Remote clocks further than this ahead of the local wall clock are ignored by `receive()` so one
   * device with a broken clock cannot drag every other device into the future. Default 24 h.
   */
  maxDriftMs?: number;
}

export interface HlcClock {
  readonly deviceId: string;
  /** Issue a new clock strictly greater than every clock this instance issued or received. */
  next(): Hlc;
  /**
   * Observe a clock from elsewhere (a merged document, a remote op). Afterwards `next()` is guaranteed
   * to be greater than it. Returns false when the value was ignored (unparsable or beyond maxDriftMs).
   */
  receive(remote: Hlc): boolean;
  /** The last clock issued or adopted, or ZERO_HLC when nothing happened yet. */
  last(): Hlc;
}

/**
 * Create a clock for one device. `now` is injectable for tests and for environments without a
 * trustworthy Date (the clock stays monotonic even when `now()` goes backwards: the wall is held and
 * the counter increments; the counter resets to 0 whenever the wall advances).
 */
export function createClock(deviceId: string, now: () => number = Date.now, options: HlcClockOptions = {}): HlcClock {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError(`invalid HLC device id: ${JSON.stringify(deviceId)}`);
  }
  const maxDriftMs = options.maxDriftMs ?? 24 * 60 * 60 * 1000;
  let lastWall = 0;
  let counter = -1; // nothing issued yet

  const safeNow = (): number => {
    const v = now();
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return clampInt(v, 0, HLC_MAX_WALL_MS);
  };

  const tick = (wall: number): void => {
    if (wall > lastWall) {
      lastWall = wall;
      counter = 0;
      return;
    }
    counter += 1;
    if (counter > HLC_MAX_COUNTER) {
      // 10^6 events inside one millisecond: borrow a millisecond so the order is preserved.
      lastWall = Math.min(lastWall + 1, HLC_MAX_WALL_MS);
      counter = 0;
    }
  };

  return {
    deviceId,
    next(): Hlc {
      tick(safeNow());
      return formatHlc({ wallMs: lastWall, counter, deviceId });
    },
    receive(remote: Hlc): boolean {
      const p = parseHlc(remote);
      if (p === null) return false;
      if (p.wallMs > safeNow() + maxDriftMs) return false;
      if (p.wallMs > lastWall || (p.wallMs === lastWall && p.counter > counter)) {
        lastWall = p.wallMs;
        counter = p.counter;
      }
      return true;
    },
    last(): Hlc {
      return counter < 0 ? ZERO_HLC : formatHlc({ wallMs: lastWall, counter, deviceId });
    },
  };
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
