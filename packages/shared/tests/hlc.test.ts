import { describe, expect, it } from 'vitest';
import { ZERO_HLC } from '../src/profile';
import {
  compareHlc,
  createClock,
  formatHlc,
  HLC_MAX_COUNTER,
  HLC_MAX_WALL_MS,
  hlcToIso,
  hlcWallMs,
  isHlc,
  isZeroHlc,
  maxHlc,
  parseHlc,
} from '../src/hlc';

/** Deterministic LCG so property-style tests are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const h = (wallMs: number, counter: number, deviceId: string): string => formatHlc({ wallMs, counter, deviceId });

describe('parseHlc / isHlc', () => {
  it('parses the wire format with a variable-width counter', () => {
    expect(parseHlc('1760870400000-0-d_8f3a')).toEqual({ wallMs: 1760870400000, counter: 0, deviceId: 'd_8f3a' });
    expect(parseHlc('1760870400000-123456-web')).toEqual({ wallMs: 1760870400000, counter: 123456, deviceId: 'web' });
    expect(parseHlc('0000000000000-0000-init')).toEqual({ wallMs: 0, counter: 0, deviceId: 'init' });
    expect(isHlc('1760870400000-7-cron')).toBe(true);
    // hyphens are legal inside device ids: the first two separators delimit wall and counter
    expect(parseHlc('1760870400000-0-x-y')).toEqual({ wallMs: 1760870400000, counter: 0, deviceId: 'x-y' });
  });

  it('rejects malformed clocks', () => {
    const bad: unknown[] = [
      '',
      '176087040000-0-x', // 12-digit wall
      '17608704000000-0-x', // 14-digit wall
      '1760870400000--x', // empty counter
      '1760870400000-1234567-x', // 7-digit counter
      '1760870400000-0-', // empty device
      '1760870400000-0-bad id', // space in device id
      '1760870400000-a-x',
      ' 1760870400000-0-x',
      1760870400000,
      null,
      undefined,
      {},
    ];
    for (const b of bad) {
      expect(parseHlc(b), String(b)).toBeNull();
      expect(isHlc(b), String(b)).toBe(false);
    }
  });

  it('treats both spellings of the zero clock as zero', () => {
    expect(isZeroHlc(ZERO_HLC)).toBe(true);
    expect(isZeroHlc('0000000000000-0-init')).toBe(true);
    expect(compareHlc('0000000000000-0-init', ZERO_HLC)).toBe(0);
    expect(isZeroHlc('0000000000001-0-init')).toBe(false);
    expect(isZeroHlc('0000000000000-1-init')).toBe(false);
    expect(isZeroHlc('garbage')).toBe(false);
  });
});

describe('compareHlc', () => {
  it('orders by wall, then counter numerically, then device id lexically', () => {
    expect(compareHlc(h(1000, 5, 'b'), h(1001, 0, 'a'))).toBe(-1);
    expect(compareHlc(h(1001, 0, 'a'), h(1000, 5, 'b'))).toBe(1);
    expect(compareHlc(h(1000, 2, 'z'), h(1000, 3, 'a'))).toBe(-1);
    expect(compareHlc(h(1000, 3, 'a'), h(1000, 3, 'b'))).toBe(-1);
    expect(compareHlc(h(1000, 3, 'b'), h(1000, 3, 'a'))).toBe(1);
    expect(compareHlc(h(1000, 3, 'a'), h(1000, 3, 'a'))).toBe(0);
  });

  it('is not plain string order (variable-width counters)', () => {
    const nine = '1760870400000-9-dev';
    const ten = '1760870400000-10-dev';
    expect(nine < ten).toBe(false); // string comparison gets it wrong
    expect(compareHlc(nine, ten)).toBe(-1);
    expect(compareHlc(ten, nine)).toBe(1);
    expect(compareHlc('1760870400000-999999-dev', '1760870400001-0-dev')).toBe(-1);
  });

  it('sorts the zero clock before every real clock', () => {
    expect(compareHlc(ZERO_HLC, h(1, 0, 'a'))).toBe(-1);
    expect(compareHlc('0000000000000-0-init', h(1, 0, 'a'))).toBe(-1);
    expect(compareHlc(h(1, 0, 'a'), ZERO_HLC)).toBe(1);
    expect(compareHlc(ZERO_HLC, '0000000000000-0-aaa')).toBe(1); // same instant, device id decides
  });

  it('sorts unparsable strings before parsable ones and lexically among themselves', () => {
    expect(compareHlc('garbage', h(1, 0, 'a'))).toBe(-1);
    expect(compareHlc(h(1, 0, 'a'), 'garbage')).toBe(1);
    expect(compareHlc('a', 'b')).toBe(-1);
    expect(compareHlc('b', 'a')).toBe(1);
    expect(compareHlc('', '')).toBe(0);
  });

  it('maxHlc returns the greater clock and a on ties', () => {
    expect(maxHlc(h(1, 0, 'a'), h(2, 0, 'a'))).toBe(h(2, 0, 'a'));
    expect(maxHlc(h(2, 0, 'a'), h(1, 0, 'a'))).toBe(h(2, 0, 'a'));
    expect(maxHlc(h(1, 2, 'a'), h(1, 2, 'a'))).toBe(h(1, 2, 'a'));
  });

  it('property: agrees with tuple order, is antisymmetric and transitive', () => {
    const rng = makeRng(42);
    const devices = ['a', 'b', 'd_8f3a', 'web', 'cron'];
    const rand = () => ({
      wallMs: Math.floor(rng() * 3) * 1000 + 1760870400000,
      counter: Math.floor(rng() * 12),
      deviceId: devices[Math.floor(rng() * devices.length)] ?? 'a',
    });
    const tuple = (p: { wallMs: number; counter: number; deviceId: string }, q: typeof p): number =>
      p.wallMs !== q.wallMs ? Math.sign(p.wallMs - q.wallMs) : p.counter !== q.counter ? Math.sign(p.counter - q.counter) : p.deviceId < q.deviceId ? -1 : p.deviceId > q.deviceId ? 1 : 0;
    for (let i = 0; i < 500; i++) {
      const p = rand();
      const q = rand();
      const r = rand();
      const [a, b, c] = [formatHlc(p), formatHlc(q), formatHlc(r)];
      expect(compareHlc(a, b)).toBe(tuple(p, q));
      expect(compareHlc(b, a)).toBe(-compareHlc(a, b) || 0);
      if (compareHlc(a, b) <= 0 && compareHlc(b, c) <= 0) expect(compareHlc(a, c)).toBeLessThanOrEqual(0);
    }
  });
});

describe('formatHlc / hlcWallMs / hlcToIso', () => {
  it('pads the wall to 13 digits and keeps the counter unpadded', () => {
    expect(h(5, 0, 'd')).toBe('0000000000005-0-d');
    expect(h(1760870400000, 42, 'd')).toBe('1760870400000-42-d');
  });

  it('clamps out-of-range parts and rejects bad device ids', () => {
    expect(h(-5, -1, 'd')).toBe('0000000000000-0-d');
    expect(h(1e20, 10_000_000, 'd')).toBe(`${HLC_MAX_WALL_MS}-${HLC_MAX_COUNTER}-d`);
    expect(() => h(1, 0, 'has space')).toThrow(TypeError);
    expect(() => h(1, 0, '')).toThrow(TypeError);
  });

  it('exposes the wall time', () => {
    expect(hlcWallMs(h(1760870400000, 3, 'd'))).toBe(1760870400000);
    expect(hlcWallMs('garbage')).toBe(0);
    expect(hlcToIso(h(1760870400000, 3, 'd'))).toBe('2025-10-19T10:40:00.000Z');
    expect(hlcToIso(ZERO_HLC)).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('createClock', () => {
  it('increments the counter while the wall is frozen and resets it when the wall advances', () => {
    let now = 1000;
    const clock = createClock('dev', () => now);
    expect(clock.next()).toBe('0000000001000-0-dev');
    expect(clock.next()).toBe('0000000001000-1-dev');
    expect(clock.next()).toBe('0000000001000-2-dev');
    now = 1001;
    expect(clock.next()).toBe('0000000001001-0-dev');
    expect(clock.last()).toBe('0000000001001-0-dev');
  });

  it('stays monotonic when the wall clock goes backwards', () => {
    let now = 5000;
    const clock = createClock('dev', () => now);
    const a = clock.next();
    now = 4000;
    const b = clock.next();
    const c = clock.next();
    now = 4500;
    const d = clock.next();
    expect(b).toBe('0000000005000-1-dev');
    expect(c).toBe('0000000005000-2-dev');
    expect(d).toBe('0000000005000-3-dev');
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(compareHlc(c, d)).toBe(-1);
    now = 6000;
    expect(clock.next()).toBe('0000000006000-0-dev');
  });

  it('receive() keeps the clock ahead of observed remote values', () => {
    const clock = createClock('me', () => 1000);
    expect(clock.receive('0000000005000-7-other')).toBe(true);
    const n = clock.next();
    expect(n).toBe('0000000005000-8-me');
    expect(compareHlc(n, '0000000005000-7-other')).toBe(1);
    // an older remote does not move the clock back
    expect(clock.receive('0000000004000-99-other')).toBe(true);
    expect(clock.next()).toBe('0000000005000-9-me');
    // same wall, higher counter is adopted
    expect(clock.receive('0000000005000-20-other')).toBe(true);
    expect(clock.next()).toBe('0000000005000-21-me');
  });

  it('receive() ignores garbage, the zero clock and far-future values', () => {
    const clock = createClock('me', () => 1000);
    expect(clock.receive('garbage')).toBe(false);
    expect(clock.receive(ZERO_HLC)).toBe(true); // valid but older: no effect
    expect(clock.receive(h(1000 + 24 * 3600 * 1000 + 1, 0, 'broken'))).toBe(false);
    expect(clock.next()).toBe('0000000001000-0-me');
    const lenient = createClock('me', () => 1000, { maxDriftMs: 10 ** 12 });
    expect(lenient.receive(h(1000 + 24 * 3600 * 1000 + 1, 0, 'broken'))).toBe(true);
  });

  it('last() is the zero clock before anything happened', () => {
    const clock = createClock('me', () => 1000);
    expect(clock.last()).toBe(ZERO_HLC);
    expect(clock.deviceId).toBe('me');
  });

  it('rejects invalid device ids and survives a broken now()', () => {
    expect(() => createClock('bad id')).toThrow(TypeError);
    expect(() => createClock('')).toThrow(TypeError);
    const clock = createClock('me', () => Number.NaN);
    expect(clock.next()).toBe('0000000000000-0-me');
    expect(clock.next()).toBe('0000000000000-1-me');
  });

  it('borrows a millisecond when the counter overflows', () => {
    const clock = createClock('d', () => 5);
    let last = clock.next();
    for (let i = 0; i < HLC_MAX_COUNTER; i++) last = clock.next();
    expect(last).toBe(`0000000000005-${HLC_MAX_COUNTER}-d`);
    const over = clock.next();
    expect(over).toBe('0000000000006-0-d');
    expect(compareHlc(over, last)).toBe(1);
  });

  it('property: every issued clock is strictly greater than the previous one under wall jitter and remote input', () => {
    const rng = makeRng(7);
    let now = 1_000_000;
    const clock = createClock('me', () => now);
    let prev = clock.next();
    for (let i = 0; i < 2000; i++) {
      now += Math.floor(rng() * 7) - 3; // jitter including backwards steps
      if (rng() < 0.2) clock.receive(h(now + Math.floor(rng() * 5), Math.floor(rng() * 4), 'other'));
      const next = clock.next();
      expect(compareHlc(next, prev)).toBe(1);
      prev = next;
    }
  });
});
