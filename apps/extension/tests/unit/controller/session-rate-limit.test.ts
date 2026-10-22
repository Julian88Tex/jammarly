import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMER_APIS, installFakeChrome, makeResult, makeSession, type FakeChrome } from './helpers';

let chromeMock: FakeChrome;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  chromeMock = installFakeChrome();
});

afterEach(() => {
  vi.useRealTimers();
  chromeMock.uninstall();
});

const TEXT = 'Their going to the store tomorow and i think its fine.';

function firstCheck(h: ReturnType<typeof makeSession>) {
  h.session.recheck();
  vi.advanceTimersByTime(3000);
  const checks = h.messages('check');
  expect(checks.length).toBeGreaterThan(0);
  return checks[checks.length - 1]!.request;
}

describe('field session: rate limits', () => {
  it('re-sends a rate-limited check after the cooldown when the text is unchanged', () => {
    const h = makeSession({ text: TEXT });
    const req = firstCheck(h);
    const before = h.messages('check').length;
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [], { pass: req.pass, error: { code: 'rate-limit', message: 'slow', retryable: true, retryAfterMs: 6000 } }) });
    expect(h.session.status()).toBe('error');
    vi.advanceTimersByTime(5000);
    expect(h.messages('check').length).toBe(before);
    vi.advanceTimersByTime(1500);
    const after = h.messages('check');
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.request.version).toBe(req.version);
    h.session.dispose();
  });

  it('does not re-send after the field is disposed', () => {
    const h = makeSession({ text: TEXT });
    const req = firstCheck(h);
    const before = h.messages('check').length;
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [], { pass: req.pass, error: { code: 'rate-limit', message: 'slow', retryable: true, retryAfterMs: 5000 } }) });
    h.session.dispose();
    vi.advanceTimersByTime(60_000);
    expect(h.messages('check').length).toBe(before);
  });

  it('stops after three rate-limited attempts in a row', () => {
    const h = makeSession({ text: TEXT });
    let req = firstCheck(h);
    const start = h.messages('check').length;
    for (let i = 0; i < 5; i++) {
      h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [], { pass: req.pass, error: { code: 'rate-limit', message: 'slow', retryable: true, retryAfterMs: 5000 } }) });
      vi.advanceTimersByTime(61_000);
      const checks = h.messages('check');
      req = checks[checks.length - 1]!.request;
    }
    expect(h.messages('check').length - start).toBe(3);
    h.session.dispose();
  });
});
