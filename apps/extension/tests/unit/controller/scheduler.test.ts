import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, autoDeepPass, countSentences, endsSentence, passFor, type PassTrigger, type RequestedPass } from '../../../src/content/controller/scheduler';
import { FAKE_TIMER_APIS } from './helpers';

function make(mode: 'hybrid' | 'quality' | 'economy' = 'hybrid') {
  const runRules = vi.fn();
  const requestPass = vi.fn<(pass: RequestedPass, trigger: PassTrigger) => void>();
  const scheduler = new Scheduler({ runRules, requestPass }, { mode, fastPassIdleMs: 700, deepPassIdleMs: 2500 });
  return { scheduler, runRules, requestPass };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('maps intents per engine mode', () => {
    expect(passFor('fast', 'hybrid')).toBe('fast');
    expect(passFor('deep', 'hybrid')).toBe('deep');
    expect(passFor('fast', 'quality')).toBe('deep');
    expect(passFor('deep', 'economy')).toBe('fast');
    expect(autoDeepPass('hybrid')).toBe('fast');
    expect(autoDeepPass('quality')).toBe('deep');
  });

  it('hybrid: fast after fastPassIdleMs idle and no automatic deep pass; typing resets the timer', () => {
    const { scheduler, requestPass } = make();
    scheduler.noteChange({ inserted: 'a', inputType: 'insertText', own: false });
    vi.advanceTimersByTime(500);
    scheduler.noteChange({ inserted: 'b', inputType: 'insertText', own: false });
    vi.advanceTimersByTime(600);
    expect(requestPass).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(requestPass).toHaveBeenCalledTimes(1);
    expect(requestPass).toHaveBeenLastCalledWith('fast', 'idle');
    vi.advanceTimersByTime(5000);
    expect(requestPass).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPendingPass()).toBe(false);
  });

  it('sentence-ending punctuation or a newline requests the fast pass immediately', () => {
    const { scheduler, requestPass } = make();
    scheduler.noteChange({ inserted: '.', inputType: 'insertText', own: false });
    expect(requestPass).toHaveBeenCalledWith('fast', 'sentence-end');
    vi.advanceTimersByTime(700);
    expect(requestPass).toHaveBeenCalledTimes(1); // no second fast from the idle timer
    vi.advanceTimersByTime(1800);
    expect(requestPass).toHaveBeenCalledTimes(1);
    scheduler.noteChange({ inserted: '\n', inputType: 'insertParagraph', own: false });
    expect(requestPass).toHaveBeenLastCalledWith('fast', 'sentence-end');
    expect(endsSentence('?"')).toBe(true);
    expect(endsSentence('. ')).toBe(true);
    expect(endsSentence(' ')).toBe(false);
    expect(endsSentence('word')).toBe(false);
  });

  it('a paste of two or more sentences requests a check immediately (fast in hybrid); one sentence does not', () => {
    const { scheduler, requestPass } = make();
    scheduler.noteChange({ inserted: 'Just one sentence here', inputType: 'insertFromPaste', own: false });
    expect(requestPass).not.toHaveBeenCalled();
    scheduler.noteChange({ inserted: 'First sentence. Second sentence.', inputType: 'insertFromPaste', own: false });
    expect(requestPass).toHaveBeenCalledWith('fast', 'paste');
    expect(countSentences('First sentence. Second sentence.')).toBe(2);
    scheduler.noteChange({ inserted: 'First sentence. Second sentence.', inputType: 'insertFromDrop', own: false });
    expect(requestPass).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(requestPass).toHaveBeenCalledTimes(2); // timers were cleared by the paste
  });

  it('quality mode sends deep at the fast idle and arms no second deep timer', () => {
    const { scheduler, requestPass } = make('quality');
    scheduler.noteChange({ inserted: 'a', inputType: 'insertText', own: false });
    vi.advanceTimersByTime(700);
    expect(requestPass).toHaveBeenCalledTimes(1);
    expect(requestPass).toHaveBeenLastCalledWith('deep', 'idle');
    vi.advanceTimersByTime(5000);
    expect(requestPass).toHaveBeenCalledTimes(1);
    scheduler.noteChange({ inserted: '.', inputType: 'insertText', own: false });
    expect(requestPass).toHaveBeenLastCalledWith('deep', 'sentence-end');
  });

  it('economy mode turns every deep intent into fast (blur, paste, idle)', () => {
    const { scheduler, requestPass } = make('economy');
    scheduler.blur();
    expect(requestPass).toHaveBeenLastCalledWith('fast', 'blur');
    scheduler.noteChange({ inserted: 'One. Two. Three.', inputType: 'insertFromPaste', own: false });
    expect(requestPass).toHaveBeenLastCalledWith('fast', 'paste');
    scheduler.noteChange({ inserted: 'x', inputType: 'insertText', own: false });
    vi.advanceTimersByTime(700);
    expect(requestPass).toHaveBeenLastCalledWith('fast', 'idle');
    vi.advanceTimersByTime(3000);
    expect(requestPass).toHaveBeenCalledTimes(3);
  });

  it('blur requests a check right away (fast in hybrid) and cancels pending timers', () => {
    const { scheduler, requestPass } = make();
    scheduler.noteChange({ inserted: 'a', inputType: 'insertText', own: false });
    scheduler.blur();
    expect(requestPass).toHaveBeenCalledWith('fast', 'blur');
    expect(scheduler.hasPendingPass()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(requestPass).toHaveBeenCalledTimes(1);
  });

  it('coalesces rules runs to one per 150 ms', () => {
    const { scheduler, runRules } = make();
    for (let i = 0; i < 5; i++) scheduler.noteChange({ inserted: 'a', inputType: 'insertText', own: false });
    expect(runRules).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20); // next frame
    expect(runRules).toHaveBeenCalledTimes(1);
    scheduler.noteChange({ inserted: 'b', inputType: 'insertText', own: false });
    scheduler.noteChange({ inserted: 'c', inputType: 'insertText', own: false });
    vi.advanceTimersByTime(100);
    expect(runRules).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    expect(runRules).toHaveBeenCalledTimes(2);
    scheduler.runRulesNow();
    expect(runRules).toHaveBeenCalledTimes(3);
  });

  it("Jammarly's own changes never trigger sentence-end or paste passes, only the idle re-check", () => {
    const { scheduler, requestPass } = make();
    scheduler.noteChange({ inserted: 'Done. Really.', inputType: 'insertFromPaste', own: true });
    scheduler.noteChange({ inserted: '.', inputType: null, own: true });
    expect(requestPass).not.toHaveBeenCalled();
    scheduler.afterApply();
    vi.advanceTimersByTime(700);
    expect(requestPass).toHaveBeenCalledWith('fast', 'idle');
  });

  it('attach(true) checks existing text right away; only checkNow runs deep in hybrid; dispose stops everything', () => {
    const { scheduler, requestPass } = make();
    scheduler.attach(false);
    expect(requestPass).not.toHaveBeenCalled();
    scheduler.attach(true);
    expect(requestPass).toHaveBeenLastCalledWith('fast', 'attach');
    vi.advanceTimersByTime(2500);
    expect(requestPass).toHaveBeenCalledTimes(1);
    scheduler.checkNow();
    expect(requestPass).toHaveBeenLastCalledWith('deep', 'manual');
    scheduler.noteChange({ inserted: 'a', inputType: 'insertText', own: false });
    scheduler.dispose();
    vi.advanceTimersByTime(5000);
    expect(requestPass).toHaveBeenCalledTimes(2);
  });
});
