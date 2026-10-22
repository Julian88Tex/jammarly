import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackEventInput, VoiceSample, WritingContext } from '@jammarly/shared/types';
import { FLUSH_INTERVAL_MS, FeedbackTracker, locateByContext, voiceContextFor } from '../../../src/content/controller/feedback';
import { TextModel } from '../../../src/content/controller/text-model';
import { FAKE_TIMER_APIS, sugAt } from './helpers';

const TEXT = 'Please email bob@example.com about teh report. Thanks a lot.';

function make(opts: { snippets?: boolean; ctx?: WritingContext } = {}) {
  const sent: FeedbackEventInput[][] = [];
  const voice: VoiceSample[][] = [];
  let snippets = opts.snippets ?? true;
  let ctx: WritingContext = opts.ctx ?? 'email';
  const tracker = new FeedbackTracker({
    fieldId: 'f1',
    host: 'mail.example.com',
    ctx: () => ctx,
    docKey: () => 'dockey1234567890',
    snippetsAllowed: () => snippets,
    send: (events) => {
      sent.push(events);
    },
    sendVoice: (samples) => {
      voice.push(samples);
    },
  });
  return {
    tracker,
    sent,
    voice,
    events: () => [...sent.flat(), ...tracker.pending],
    setSnippets: (v: boolean) => {
      snippets = v;
    },
    setCtx: (c: WritingContext) => {
      ctx = c;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FeedbackTracker', () => {
  it('emits shown once per suggestion id with the typed word count, then ignore after a long undecided dwell', () => {
    const { tracker, events } = make();
    const s = sugAt(TEXT, 'teh', { id: 's1' });
    tracker.cardShown(s, TEXT);
    tracker.cardHidden(s, 's1', TEXT); // closed right away: no ignore
    tracker.cardShown(s, TEXT);
    expect(events().filter((e) => e.kind === 'shown')).toHaveLength(1);
    expect(events()[0]).toEqual(expect.objectContaining({ kind: 'shown', suggestionId: 's1', fieldId: 'f1', docKey: 'dockey1234567890', host: 'mail.example.com', ctx: 'email', rule: 'spelling', category: 'correctness', spanLen: 3, wordCountTyped: 9 }));
    vi.advanceTimersByTime(1600);
    tracker.cardHidden(s, 's1', TEXT);
    const ignore = events().find((e) => e.kind === 'ignore')!;
    expect(ignore.dwellMs).toBe(1600);
    expect(tracker.wasShown('s1')).toBe(true);
  });

  it('accept carries via, dwell and redacted, capped snippets; dismiss carries the reason', () => {
    const { tracker, events } = make();
    const s = sugAt(TEXT, 'teh', { id: 's1' });
    tracker.cardShown(s, TEXT);
    vi.advanceTimersByTime(800);
    const after = TEXT.replace('teh', 'the');
    tracker.accept(s, 'card', after, 'the', { version: 1, range: { start: 35, end: 38 } });
    const accept = events().find((e) => e.kind === 'accept')!;
    expect(accept).toEqual(expect.objectContaining({ via: 'card', dwellMs: 800, original: 'teh', replacement: 'the', sentenceLen: 46 }));
    expect(accept.sentence).toBe('Please email ‹email› about the report.');
    expect(accept.sentence!.length).toBeLessThanOrEqual(280);

    const d = sugAt(TEXT, 'a lot', { id: 's2', category: 'clarity', replacement: 'much' });
    tracker.dismiss(d, 'not_error', 'panel', TEXT);
    expect(events().find((e) => e.kind === 'dismiss')).toEqual(expect.objectContaining({ via: 'panel', reason: 'not_error', suggestionId: 's2' }));
    // a decided suggestion never produces ignore
    tracker.cardShown(d, TEXT);
    vi.advanceTimersByTime(5000);
    tracker.cardHidden(d, 's2', TEXT);
    expect(events().filter((e) => e.kind === 'ignore')).toHaveLength(0);
  });

  it('omits every snippet when snippet storage is off (counters stay)', () => {
    const { tracker, events } = make({ snippets: false });
    const s = sugAt(TEXT, 'teh', { id: 's1' });
    tracker.accept(s, 'keyboard', TEXT, 'the', { version: 0, range: s.range });
    const ev = events()[0]!;
    expect(ev.original).toBeUndefined();
    expect(ev.replacement).toBeUndefined();
    expect(ev.sentence).toBeUndefined();
    expect(ev.spanLen).toBe(3);
    expect(ev.sentenceLen).toBeGreaterThan(0);
    expect(ev.via).toBe('keyboard');
  });

  it('emits invalidated only for suggestions that were shown', () => {
    const { tracker, events } = make();
    const shown = sugAt(TEXT, 'teh', { id: 'shown' });
    const hidden = sugAt(TEXT, 'a lot', { id: 'hidden' });
    tracker.cardShown(shown, TEXT);
    tracker.invalidated(shown, TEXT);
    tracker.invalidated(hidden, TEXT);
    expect(events().filter((e) => e.kind === 'invalidated').map((e) => e.suggestionId)).toEqual(['shown']);
  });

  it('accepted_by_typing when the user types the replacement within 60 s; self_corrected when they fix it another way', () => {
    const { tracker, events } = make();
    const s = sugAt(TEXT, 'teh', { id: 's1' });
    tracker.cardShown(s, TEXT);
    tracker.trackDropped(s, TEXT);
    tracker.onIdle(TEXT.replace('teh', 'the'));
    const typed = events().find((e) => e.kind === 'accepted_by_typing')!;
    expect(typed).toEqual(expect.objectContaining({ via: 'typing', suggestionId: 's1', replacement: 'the' }));

    const s2 = sugAt(TEXT, 'a lot', { id: 's2', category: 'clarity', replacement: 'much' });
    tracker.trackDropped(s2, TEXT);
    tracker.onIdle(TEXT.replace('a lot', 'so much'));
    const corrected = events().find((e) => e.kind === 'self_corrected')!;
    expect(corrected).toEqual(expect.objectContaining({ suggestionId: 's2', final: 'so much' }));

    const s3 = sugAt(TEXT, 'report', { id: 's3', replacement: 'reports' });
    tracker.trackDropped(s3, TEXT);
    vi.advanceTimersByTime(61_000);
    tracker.onIdle(TEXT.replace('report', 'reports'));
    expect(events().filter((e) => e.suggestionId === 's3')).toHaveLength(0);
    expect(locateByContext('abc XYZ def', 'abc ', ' def')).toEqual({ start: 4, end: 7 });
    expect(locateByContext('nothing here', 'abc ', ' def')).toBeNull();
  });

  it('edit_after_accept carries the final text when the applied span is edited within 60 s', () => {
    const { tracker, events } = make();
    const s = sugAt(TEXT, 'teh', { id: 's1' });
    const after = TEXT.replace('teh', 'the');
    const model = new TextModel(after);
    tracker.accept(s, 'card', after, 'the', { version: 0, range: { start: 35, end: 38 } });
    model.update(after.replace('the report', 'these reports'), 'insertText');
    tracker.onTextChanged(model);
    tracker.onIdle(model.text);
    const ev = events().find((e) => e.kind === 'edit_after_accept')!;
    expect(ev).toEqual(expect.objectContaining({ suggestionId: 's1', final: 'these', replacement: 'the' }));
    // an edit elsewhere does not count
    const s2 = sugAt(model.text, 'a lot', { id: 's2', replacement: 'much' });
    const applied = model.text.replace('a lot', 'much');
    model.update(applied, { provenance: 'jammarly' });
    tracker.accept(s2, 'card', applied, 'much', { version: model.version, range: { start: applied.indexOf('much'), end: applied.indexOf('much') + 4 } });
    model.update('X' + model.text, 'insertText');
    tracker.onTextChanged(model);
    tracker.onIdle(model.text);
    expect(events().filter((e) => e.kind === 'edit_after_accept')).toHaveLength(1);
  });

  it('batches events: 20 flush immediately, fewer flush after 5 s, dispose flushes', () => {
    const { tracker, sent } = make();
    for (let i = 0; i < 20; i++) tracker.cardShown(sugAt(TEXT, 'teh', { id: `s${i}` }), TEXT);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(20);
    tracker.cardShown(sugAt(TEXT, 'teh', { id: 'extra' }), TEXT);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    tracker.cardShown(sugAt(TEXT, 'teh', { id: 'last' }), TEXT);
    tracker.dispose();
    expect(sent).toHaveLength(3);
    expect(tracker.pending).toHaveLength(0);
  });

  it('samples only fully typed, completed, long-enough sentences, redacted and de-duplicated', () => {
    const { tracker, voice, setSnippets, setCtx } = make();
    const model = new TextModel('Hello there friend. ');
    const typed = 'I really think this plan will work out well for everyone involved.';
    model.update(model.text + typed, 'insertText');
    model.update(model.text + ' Call me at 415-555-2671 when you can please.', 'insertText');
    model.update(model.text + ' Pasted sentence with more than six words inside it.', 'insertFromPaste');
    model.update(model.text + ' Short typed one.', 'insertText');
    model.update(model.text + ' And an unfinished typed sentence that goes on', 'insertText');
    const samples = tracker.sampleVoice(model.text, model, []);
    expect(samples.map((s) => s.sentence)).toEqual([typed, 'Call me at ‹phone› when you can please.']);
    expect(samples[0]).toEqual(expect.objectContaining({ host: 'mail.example.com', ctx: 'email', voiceContext: 'messages', t: '2026-10-21T10:00:00.000Z' }));
    expect(voice).toHaveLength(1);
    expect(tracker.sampleVoice(model.text, model, [])).toEqual([]); // de-duplicated
    setCtx('code');
    expect(voiceContextFor('code')).toBeNull();
    const m2 = new TextModel('');
    m2.update('Another perfectly typed sentence that is long enough.', 'insertText');
    expect(tracker.sampleVoice(m2.text, m2, [])).toEqual([]);
    setCtx('doc');
    expect(tracker.sampleVoice(m2.text, m2, [])[0]!.voiceContext).toBe('documents');
    setSnippets(false);
    const m3 = new TextModel('');
    m3.update('Yet another perfectly typed sentence that is long enough.', 'insertText');
    expect(tracker.sampleVoice(m3.text, m3, [])).toEqual([]);
    expect(voiceContextFor('chat')).toBe('messages');
    expect(voiceContextFor('other')).toBe('documents');
  });

  it('never samples a sentence that intersects a protected or masked range', () => {
    const { tracker } = make();
    const model = new TextModel('');
    model.update('See https://example.com for the details we discussed earlier today.', 'insertText');
    expect(tracker.sampleVoice(model.text, model, [{ start: 4, end: 23 }])).toEqual([]);
  });
});
