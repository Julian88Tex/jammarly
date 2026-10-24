import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMER_APIS, flushPromises, installFakeChrome, makeResult, makeSession, sugAt, type FakeChrome } from './helpers';

let chromeMock: FakeChrome;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  chromeMock = installFakeChrome();
});

afterEach(() => {
  vi.useRealTimers();
  chromeMock.uninstall();
});

const TEXT = 'We are planning a review of the new design next week.';

function lastCheck(h: ReturnType<typeof makeSession>) {
  const checks = h.messages('check');
  expect(checks.length).toBeGreaterThan(0);
  return checks[checks.length - 1]!.request;
}

function firstCheck(h: ReturnType<typeof makeSession>) {
  h.session.recheck();
  vi.advanceTimersByTime(3000);
  // Answer every check but the last with nothing, so none is left in flight for Accept everything to wait on.
  const checks = h.messages('check');
  for (const c of checks.slice(0, -1)) h.emit({ type: 'check-result', result: makeResult('f1', c.request.version, c.request.text, [], { pass: c.request.pass }) });
  return lastCheck(h);
}

const style = { category: 'clarity' as const, rule: 'wordy_phrase', title: 'Improve wording', autoApplySafe: false };

describe('field session: Accept everything sweeps', () => {
  it('applies, re-checks the new text, applies that round too, and reports one total', async () => {
    const h = makeSession({ text: TEXT });
    let req = firstCheck(h);
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [sugAt(TEXT, 'are planning', { id: 's1', replacement: 'plan', ...style })], { pass: req.pass }) });

    const checksBefore = h.messages('check').length;
    await h.session.acceptAll({ group: 'all' });
    await flushPromises();
    const round1 = h.adapter.getText();
    expect(round1).toBe('We plan a review of the new design next week.');
    // The re-check goes out right away for the changed text, without waiting for the idle timers.
    expect(h.messages('check').length).toBe(checksBefore + 1);
    req = lastCheck(h);
    expect(req.text).toBe(round1);
    // No toast mid-sweep: one toast reports the total when it ends.
    expect(h.ui.toasts).toHaveLength(0);

    h.emit({ type: 'check-result', result: makeResult('f1', req.version, round1, [sugAt(round1, 'a review of', { id: 's2', replacement: 'to review', ...style })], { pass: req.pass }) });
    await flushPromises(6);
    const round2 = h.adapter.getText();
    expect(round2).toBe('We plan to review the new design next week.');
    req = lastCheck(h);
    expect(req.text).toBe(round2);

    h.emit({ type: 'check-result', result: makeResult('f1', req.version, round2, [], { pass: req.pass }) });
    await flushPromises(6);
    expect(h.adapter.getText()).toBe(round2);
    expect(h.ui.toasts).toHaveLength(1);
    const done = h.ui.toasts.at(-1)!;
    expect(done.message).toBe('Fixed 2 issues in 2 rounds');

    // The toast's Undo reverts every round, not only the last one.
    expect(done.options?.undoTransactionId).toBeTruthy();
    const reverted = await h.session.undo(done.options!.undoTransactionId);
    await flushPromises(6);
    expect(reverted).toBe(2);
    expect(h.adapter.getText()).toBe(TEXT);
    h.session.dispose();
  });

  it('stops after the round limit even when every re-check finds more', async () => {
    const h = makeSession({ text: TEXT });
    let req = firstCheck(h);
    let text = TEXT;
    const words = ['planning', 'scheduling', 'arranging', 'setting up', 'booking', 'holding', 'running', 'leading'];
    const swaps = words.slice(0, -1).map((w, i): [string, string] => [w, words[i + 1]!]);
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, text, [sugAt(text, swaps[0]![0], { id: 'r0', replacement: swaps[0]![1], ...style })], { pass: req.pass }) });
    await h.session.acceptAll({ group: 'all' });
    await flushPromises();
    for (let i = 1; i < swaps.length; i++) {
      text = h.adapter.getText();
      req = lastCheck(h);
      h.emit({ type: 'check-result', result: makeResult('f1', req.version, text, [sugAt(text, swaps[i]![0], { id: `r${i}`, replacement: swaps[i]![1], ...style })], { pass: req.pass }) });
      await flushPromises(6);
    }
    expect(h.adapter.getText()).toBe('We are running a review of the new design next week.');
    expect(h.ui.toasts.at(-1)?.message).toBe('Fixed 6 issues in 6 rounds');
    h.session.dispose();
  });

  it('a sentence card accept (explicit ids) applies once and does not sweep', async () => {
    const h = makeSession({ text: TEXT });
    const req = firstCheck(h);
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [sugAt(TEXT, 'are planning', { id: 's1', replacement: 'plan', ...style })], { pass: req.pass }) });
    const checksBefore = h.messages('check').length;
    await h.session.acceptAll({ group: 'all', suggestionIds: ['s1'] });
    await flushPromises();
    expect(h.messages('check').length).toBe(checksBefore);
    expect(h.ui.toasts.at(-1)?.message).toBe('Applied 1 change');
    h.session.dispose();
  });

  it('never undoes its own fix in a later round', async () => {
    const h = makeSession({ text: TEXT });
    let req = firstCheck(h);
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [sugAt(TEXT, 'planning', { id: 'a', replacement: 'scheduling', ...style })], { pass: req.pass }) });
    await h.session.acceptAll({ group: 'all' });
    await flushPromises();
    const text = h.adapter.getText();
    req = lastCheck(h);
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, text, [sugAt(text, 'scheduling', { id: 'b', replacement: 'planning', ...style })], { pass: req.pass }) });
    await flushPromises(6);
    expect(h.adapter.getText()).toBe('We are scheduling a review of the new design next week.');
    expect(h.ui.toasts.at(-1)?.message).toBe('Applied 1 change');
    h.session.dispose();
  });

  it('waits for a check already under way, so one press gets its findings too', async () => {
    const h = makeSession({ text: TEXT });
    h.session.recheck();
    vi.advanceTimersByTime(3000);
    const checks = h.messages('check');
    const pressed = h.session.acceptAll({ group: 'all' });
    await flushPromises();
    expect(h.adapter.getText()).toBe(TEXT);
    for (const c of checks.slice(0, -1)) h.emit({ type: 'check-result', result: makeResult('f1', c.request.version, c.request.text, [], { pass: c.request.pass }) });
    const deep = checks.at(-1)!.request;
    h.emit({ type: 'check-result', result: makeResult('f1', deep.version, TEXT, [sugAt(TEXT, 'are planning', { id: 's1', replacement: 'plan', ...style })], { pass: deep.pass }) });
    await pressed;
    expect(h.adapter.getText()).toBe('We plan a review of the new design next week.');
    h.session.dispose();
  });

  it('an accept-everything with nothing to apply says so instead of staying silent', async () => {
    const h = makeSession({ text: TEXT });
    const req = firstCheck(h);
    h.emit({ type: 'check-result', result: makeResult('f1', req.version, TEXT, [], { pass: req.pass }) });
    await flushPromises();
    await h.session.acceptAll({ group: 'all' });
    await flushPromises();
    expect(h.ui.toasts.at(-1)?.message).toBe('Nothing left to fix');
    h.session.dispose();
  });
});
