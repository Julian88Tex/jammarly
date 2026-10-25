/**
 * The device's hybrid logical clock (ARCHITECTURE §3.6): seeded from the last persisted clock and from every HLC in
 * the profile document, so a clock issued here is greater than anything this device has seen. `stampOps` fills the
 * empty `hlc` of ops that pages send ('' means "stamp me").
 */
import type { ProfileDocument, ProfileOp } from '@jammarly/shared/profile';
import type { HlcClock } from './shared-engine';
import { createClock, isHlc } from './shared-engine';

export interface DeviceClock {
  readonly deviceId: string;
  /** A fresh clock, greater than everything issued or received. Persists via `onIssue`. */
  next(): string;
  receive(remote: string): boolean;
  /** Observes every HLC inside a profile document (after a merge or a poll). */
  receiveProfile(profile: ProfileDocument): void;
  last(): string;
  /** Copies of `ops` with every '' (or invalid) hlc replaced by a fresh clock, in order. */
  stampOps(ops: readonly ProfileOp[]): ProfileOp[];
}

/** Every HLC string found in a profile document (registers, OR-set elements, learning). */
export function collectHlcs(profile: ProfileDocument): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'hlc' || k === 'addedHlc' || k === 'removedHlc' || k === 'updatedHlc') && typeof x === 'string') out.push(x);
      else visit(x);
    }
  };
  visit(profile);
  return out;
}

export interface DeviceClockOptions {
  /** Called after every issued clock so the caller can persist `last()` (debounced by the caller). */
  onIssue?: (hlc: string) => void;
  now?: () => number;
}

export function createDeviceClock(deviceId: string, persistedLast: string | undefined, profile: ProfileDocument | undefined, opts: DeviceClockOptions = {}): DeviceClock {
  const clock: HlcClock = createClock(deviceId, opts.now ?? Date.now);
  if (persistedLast !== undefined && isHlc(persistedLast)) clock.receive(persistedLast);
  const api: DeviceClock = {
    deviceId,
    next() {
      const h = clock.next();
      opts.onIssue?.(h);
      return h;
    },
    receive(remote) {
      return clock.receive(remote);
    },
    receiveProfile(doc) {
      for (const h of collectHlcs(doc)) clock.receive(h);
    },
    last() {
      return clock.last();
    },
    stampOps(ops) {
      return ops.map((op) => (isHlc(op.hlc) ? { ...op } : { ...op, hlc: api.next() }) as ProfileOp);
    },
  };
  if (profile) api.receiveProfile(profile);
  return api;
}
