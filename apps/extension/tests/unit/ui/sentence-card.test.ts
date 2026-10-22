import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Suggestion } from '@jammarly/shared/types';
import { HOST_TAG, HOVER_INTENT_MS, LEAVE_GRACE_MS } from '../../../src/content/ui/overlay';
import { isGroupable, sentenceGroupFor, sentencePieces, sentenceTitle } from '../../../src/content/ui/sentence';
import { selectAcceptAll } from '../../../src/content/controller/store';
import type { FieldOverlay, UnderlineItem } from '../../../src/content/ui/overlay-api';
import { FAKE_TIMER_APIS, cardEl, cardOpen, fakeAdapter, harness, item, key, makeSuggestion, opts, pointerDown, pointerMove, rect, text, type Harness } from './helpers';

const TEXT = 'Their going to teh store tomorow. I think that in order to succeed we should start now.';

/** A suggestion over the `nth` occurrence of `original` in `text`. */
function at(text: string, id: string, original: string, partial: Partial<Suggestion> = {}, nth = 0): Suggestion {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = text.indexOf(original, start + 1);
  if (start < 0) throw new Error(`"${original}" not in text`);
  return makeSuggestion({ id, original, range: { start, end: start + original.length }, ...partial });
}

function insertAt(id: string, offset: number, replacement: string, partial: Partial<Suggestion> = {}): Suggestion {
  return makeSuggestion({ id, kind: 'insert', original: '', replacement, range: { start: offset, end: offset }, highlight: { start: Math.max(0, offset - 3), end: offset }, ...partial });
}

const S1 = () => at(TEXT, 's1', 'teh', { replacement: 'the' });
const S2 = () => at(TEXT, 's2', 'tomorow', { replacement: 'tomorrow', rule: 'spelling_dialect' });
const S3 = () => at(TEXT, 's3', 'in order to', { replacement: 'to', category: 'clarity', tier: 'B', rule: 'wordy_phrase', title: 'Reduce wordiness' });

const R1 = rect(100, 100, 30, 18);
const R2 = rect(200, 100, 60, 18);
const R3 = rect(100, 140, 80, 18);
const R4 = rect(300, 140, 40, 18);

describe('sentence grouping', () => {
  it('groups the pending span suggestions of the hovered sentence in reading order', () => {
    const items = [item(S2(), R2), item(S1(), R1), item(S3(), R3)];
    const g = sentenceGroupFor(items, TEXT, 's2')!;
    expect(g).not.toBeNull();
    expect(g.members.map((m) => m.id)).toEqual(['s1', 's2']);
    expect(g.hovered.id).toBe('s2');
    expect(g.text).toBe('Their going to teh store tomorow.');
    expect(g.sentence).toEqual({ start: 0, end: 33 });
    // the second sentence has a single suggestion: no group, single card
    expect(sentenceGroupFor(items, TEXT, 's3')).toBeNull();
  });

  it('never groups a suggestion whose range crosses a sentence boundary', () => {
    const crossing = at(TEXT, 'x', 'tomorow. I', { replacement: 'tomorrow. I' });
    const items = [item(S1(), R1), item(crossing, R2), item(S3(), R3)];
    expect(sentenceGroupFor(items, TEXT, 's1')).toBeNull(); // s1 alone once the crossing one is excluded
    expect(sentenceGroupFor(items, TEXT, 'x')).toBeNull();
    const withS2 = [...items, item(S2(), R4)];
    expect(sentenceGroupFor(withS2, TEXT, 's1')!.members.map((m) => m.id)).toEqual(['s1', 's2']);
  });

  it('excludes stale, rewrite, flag, tier C, meaning-changing and inexact tier A suggestions', () => {
    const base = [item(S1(), R1)];
    const variants: Partial<Suggestion>[] = [
      { stale: true },
      { kind: 'rewrite', tier: 'C' },
      { kind: 'flag', tier: 'C', replacement: 'tomorow' },
      { tier: 'C' },
      { meaningPreserving: false },
      { tier: 'A', anchor: 'normalized' },
    ];
    for (const v of variants) {
      const other = at(TEXT, 'o', 'tomorow', { replacement: 'tomorrow', ...v });
      expect(isGroupable(other), JSON.stringify(v)).toBe(false);
      expect(sentenceGroupFor([...base, item(other, R2)], TEXT, 's1'), JSON.stringify(v)).toBeNull();
      expect(sentenceGroupFor([...base, item(other, R2)], TEXT, 'o'), JSON.stringify(v)).toBeNull();
    }
    expect(isGroupable(at(TEXT, 'b', 'tomorow', { tier: 'B', anchor: 'normalized' }))).toBe(true); // tier B needs no exact anchor
  });

  it('falls back to the single card when the hovered suggestion is alone in its sentence', () => {
    expect(sentenceGroupFor([item(S1(), R1), item(S3(), R3)], TEXT, 's1')).toBeNull();
    expect(sentenceGroupFor([item(S1(), R1)], TEXT, 'missing')).toBeNull();
  });

  it('ignores suggestions whose offsets no longer match the text', () => {
    const shifted = makeSuggestion({ id: 'sh', original: 'tomorow', replacement: 'tomorrow', range: { start: 26, end: 33 } });
    expect(sentenceGroupFor([item(S1(), R1), item(shifted, R2)], TEXT, 's1')).toBeNull();
  });

  it('pieces render strikes and replacements in order; the title depends on the categories', () => {
    const g = sentenceGroupFor([item(S1(), R1), item(S2(), R2)], TEXT, 's1')!;
    expect(sentencePieces(g).map((p) => (p.type === 'text' ? `[${p.text}]` : `-${p.original}+${p.replacement}`))).toEqual([
      '[Their going to ]',
      '-teh+the',
      '[ store ]',
      '-tomorow+tomorrow',
      '[.]',
    ]);
    expect(sentenceTitle(g.members)).toBe('Correct the sentence');
    expect(sentenceTitle([S1(), S3()])).toBe('Improve the sentence');
  });
});

describe('sentence card', () => {
  let h: Harness;
  let f: FieldOverlay;
  let adapterEl: HTMLTextAreaElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
    h = harness();
    const adapter = fakeAdapter();
    adapterEl = adapter.element as HTMLTextAreaElement;
    adapterEl.value = TEXT;
    f = h.overlay.attach('f1', adapter, opts());
  });

  afterEach(() => {
    h.overlay.dispose();
    vi.useRealTimers();
    for (const el of Array.from(document.querySelectorAll(HOST_TAG))) el.remove();
    document.body.textContent = '';
  });

  function hover(x: number, y: number): void {
    pointerMove(x, y);
    vi.advanceTimersByTime(HOVER_INTENT_MS + 20);
  }

  function setItems(items: UnderlineItem[]): void {
    f.setUnderlines(items);
  }

  it('hovering any underline of a two-fix sentence opens one card for the whole sentence', () => {
    setItems([item(S1(), R1), item(S2(), R2), item(S3(), R3)]);
    hover(210, 110); // s2
    expect(cardOpen(h)).toBe(true);
    const card = cardEl(h);
    expect(card.dataset.mode).toBe('sentence');
    expect(card.dataset.suggestionId).toBe('s2');
    expect(card.dataset.suggestionIds).toBe('s1 s2');
    expect(text(h.q('[data-jm="card-title"]'))).toBe('Correct the sentence');
    expect(h.q('.jm-dot').dataset.category).toBe('correctness');
    expect(text(h.q('[data-jm="card-badge"]'))).toBe('Auto');
    const content = h.q<HTMLButtonElement>('[data-jm="sentence-content"]');
    expect(content.tagName).toBe('BUTTON');
    expect(text(content)).toBe('Their going to tehthe store tomorowtomorrow.');
    const marks = Array.from(content.querySelectorAll<HTMLElement>('s, strong')).map((el) => `${el.tagName}:${el.textContent}`);
    expect(marks).toEqual(['S:teh', 'STRONG:the', 'S:tomorow', 'STRONG:tomorrow']);
    expect(content.getAttribute('aria-label')).toBe('Accept 2 changes: Their going to the store tomorrow.');
    const order = Array.from(card.children).map((c) => (c as HTMLElement).dataset.jm);
    expect(order).toEqual(['card-head', 'sentence-content', 'actions', 'more-panel', 'card-footer']);
    expect(text(h.q('[data-jm="accept"]'))).toBe('Accept');
    expect(text(h.q('[data-jm="one-at-a-time"]'))).toBe('Show one at a time');
    expect(h.q('[data-jm="dismiss"]').getAttribute('aria-label')).toBe('Dismiss all');
    // both grouped underlines are in the active state (3 px + tint), the other sentence's is not
    const active = h.qAll<HTMLElement>('[data-jm="underline"].jm-ul-active').map((el) => el.dataset.suggestionId).sort();
    expect(active).toEqual(['s1', 's2']);
    expect(h.qAll('[data-jm="underline-tint"]').length).toBe(2);
    expect(h.events.onCardShown).toHaveBeenCalledWith('f1', 's1');
    expect(h.events.onCardShown).toHaveBeenCalledWith('f1', 's2');
    expect(h.debug().cardMode).toBe('sentence');
  });

  it('"Improve the sentence" when a member is not correctness; Auto only when all are tier A', () => {
    const t = 'I think that in order to succeed we shuold start now.';
    adapterEl.value = t;
    const a = at(t, 'a', 'in order to', { replacement: 'to', category: 'clarity', tier: 'B', rule: 'wordy_phrase' });
    const b = at(t, 'b', 'shuold', { replacement: 'should' });
    setItems([item(a, R1), item(b, R2)]);
    hover(210, 110);
    expect(text(h.q('[data-jm="card-title"]'))).toBe('Improve the sentence');
    expect(h.root.querySelector('[data-jm="card-badge"]')).toBeNull();
    expect(h.q('.jm-dot').dataset.category).toBe('correctness'); // mixed: the hovered suggestion's category
  });

  it('clicking the content or Accept applies every grouped suggestion via onAcceptAll with the exact ids', () => {
    setItems([item(S1(), R1), item(S2(), R2), item(S3(), R3)]);
    hover(110, 110);
    h.q<HTMLButtonElement>('[data-jm="sentence-content"]').click();
    expect(h.events.onAcceptAll).toHaveBeenCalledTimes(1);
    expect(h.events.onAcceptAll).toHaveBeenLastCalledWith('f1', { group: 'all', suggestionIds: ['s1', 's2'] });
    expect(h.events.onAccept).not.toHaveBeenCalled();
    expect(cardOpen(h)).toBe(false);
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's1');
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's2');
    // only the underline still under the pointer keeps its hover state
    expect(h.qAll<HTMLElement>('[data-jm="underline-tint"]').map((el) => el.dataset.suggestionId)).toEqual(['s1']);

    pointerMove(600, 600);
    vi.advanceTimersByTime(20);
    hover(110, 110);
    h.q<HTMLButtonElement>('[data-jm="accept"]').click();
    expect(h.events.onAcceptAll).toHaveBeenCalledTimes(2);
    expect(h.events.onAcceptAll).toHaveBeenLastCalledWith('f1', { group: 'all', suggestionIds: ['s1', 's2'] });
    // the first accept hides the first-run footer
    pointerMove(600, 600);
    vi.advanceTimersByTime(20);
    hover(110, 110);
    expect(h.root.querySelector('[data-jm="card-footer"]')).toBeNull();
  });

  it('the trash dismisses every grouped suggestion', () => {
    setItems([item(S1(), R1), item(S2(), R2)]);
    hover(110, 110);
    h.q<HTMLButtonElement>('[data-jm="dismiss"]').click();
    expect(h.events.onDismiss).toHaveBeenCalledTimes(2);
    expect(h.events.onDismiss).toHaveBeenNthCalledWith(1, 'f1', 's1');
    expect(h.events.onDismiss).toHaveBeenNthCalledWith(2, 'f1', 's2');
    expect(cardOpen(h)).toBe(false);
  });

  it('"Show one at a time" switches to the single card for the hovered suggestion and sticks for the field', () => {
    setItems([item(S1(), R1), item(S2(), R2)]);
    hover(210, 110);
    h.q<HTMLButtonElement>('[data-jm="one-at-a-time"]').click();
    expect(cardOpen(h)).toBe(true);
    let card = cardEl(h);
    expect(card.dataset.mode).toBe('single');
    expect(card.dataset.suggestionId).toBe('s2');
    expect(text(h.q('[data-jm="card-original"]'))).toBe('tomorow');
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's1');
    expect(h.qAll('[data-jm="underline-tint"]').length).toBe(1);
    // leave and hover the other member: still a single card
    pointerMove(600, 600);
    vi.advanceTimersByTime(LEAVE_GRACE_MS + 20);
    expect(cardOpen(h)).toBe(false);
    hover(110, 110);
    card = cardEl(h);
    expect(card.dataset.mode).toBe('single');
    expect(card.dataset.suggestionId).toBe('s1');
    // single-card Accept still goes through onAccept
    h.q<HTMLButtonElement>('[data-jm="accept"]').click();
    expect(h.events.onAccept).toHaveBeenCalledWith('f1', 's1', undefined);
    expect(h.events.onAcceptAll).not.toHaveBeenCalled();
  });

  it('the ⋯ menu reports and mutes the hovered suggestion and its rule', () => {
    setItems([item(S1(), R1), item(S2(), R2)]);
    hover(210, 110);
    h.q<HTMLButtonElement>('[data-jm="more"]').click();
    expect(h.q('[data-jm="more-panel"]').hidden).toBe(false);
    expect(h.root.querySelector('[data-jm="dismiss-reason"]')).toBeNull();
    h.q<HTMLButtonElement>('[data-jm="mute-host"]').click();
    expect(h.events.onMuteRule).toHaveBeenCalledWith('f1', 'spelling_dialect', 'host');
    hover(210, 110);
    h.q<HTMLButtonElement>('[data-jm="more"]').click();
    h.q<HTMLButtonElement>('[data-jm="report-incorrect"]').click();
    expect(h.events.onReportIncorrect).toHaveBeenCalledWith('f1', 's2');
  });

  it('deletions show the struck original only, insertions the bold inserted text only', () => {
    const t = 'We went to the the store yesterday';
    adapterEl.value = t;
    const del = at(t, 'del', ' the', { kind: 'delete', replacement: '', rule: 'repeated_word', title: 'Remove the repeated word' }, 1);
    const ins = insertAt('ins', t.length, '.', { rule: 'punctuation' });
    setItems([item(del, R1), item(ins, R2)]);
    hover(110, 110);
    expect(cardEl(h).dataset.mode).toBe('sentence');
    const changes = h.qAll<HTMLElement>('[data-jm="sentence-change"]');
    expect(changes.map((c) => c.dataset.suggestionId)).toEqual(['del', 'ins']);
    expect(changes[0]!.querySelector('s')?.textContent).toBe(' the');
    expect(changes[0]!.querySelector('strong')).toBeNull();
    expect(changes[1]!.querySelector('s')).toBeNull();
    expect(changes[1]!.querySelector('strong')?.textContent).toBe('.');
    expect(h.q('[data-jm="sentence-content"]').getAttribute('aria-label')).toBe('Accept 2 changes: We went to the store yesterday.');
  });

  it('rewrites and flags keep their own cards and never join a group', () => {
    const rw = at(TEXT, 'rw', 'Their going to teh store tomorow.', { kind: 'rewrite', tier: 'C', category: 'delivery', replacement: "They're going to the store tomorrow.", rule: 'tone_rewrite' });
    setItems([item(rw, rect(60, 100, 400, 18)), item(S1(), R1), item(S2(), R2)]);
    hover(420, 110); // only the rewrite fragment is there
    expect(cardEl(h).dataset.mode).toBe('single');
    expect(cardEl(h).dataset.suggestionId).toBe('rw');
    pointerMove(600, 600);
    vi.advanceTimersByTime(LEAVE_GRACE_MS + 20);
    hover(110, 110); // s1 sits on top of the rewrite
    expect(cardEl(h).dataset.mode).toBe('sentence');
    expect(cardEl(h).dataset.suggestionIds).toBe('s1 s2');
  });

  it('programmatic opens (openCard, focusSuggestion) keep the single card', () => {
    setItems([item(S1(), R1), item(S2(), R2)]);
    f.openCard('s1', R1);
    expect(cardEl(h).dataset.mode).toBe('single');
    f.focusSuggestion('s2');
    expect(cardEl(h).dataset.mode).toBe('single');
    expect(cardEl(h).dataset.suggestionId).toBe('s2');
  });

  it('re-renders when setUnderlines removes a member and falls back to the single card at one', () => {
    const t = 'Their going to teh store tomorow, and i dont think so.';
    adapterEl.value = t;
    const a = at(t, 'a', 'teh');
    const b = at(t, 'b', 'tomorow', { replacement: 'tomorrow' });
    const c = at(t, 'c', 'dont', { replacement: "don't", rule: 'apostrophe' });
    setItems([item(a, R1), item(b, R2), item(c, R4)]);
    hover(110, 110);
    expect(cardEl(h).dataset.suggestionIds).toBe('a b c');
    setItems([item(a, R1), item(c, R4)]);
    expect(cardOpen(h)).toBe(true);
    expect(cardEl(h).dataset.mode).toBe('sentence');
    expect(cardEl(h).dataset.suggestionIds).toBe('a c');
    expect(h.qAll('[data-jm="sentence-change"]').map((el) => el.dataset.suggestionId)).toEqual(['a', 'c']);
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 'b');
    setItems([item(a, R1)]);
    expect(cardOpen(h)).toBe(true);
    expect(cardEl(h).dataset.mode).toBe('single');
    expect(cardEl(h).dataset.suggestionId).toBe('a');
    setItems([]);
    expect(cardOpen(h)).toBe(false);
  });

  it('the floating toast still shows with the floating button hidden', () => {
    h.overlay.setOptions({ showFloatingButton: false });
    f.toast('Applied 2 changes', { undoTransactionId: 'tx1' });
    const toast = h.q('[data-jm="toast"]');
    expect(text(toast)).toContain('Applied 2 changes');
    h.q<HTMLButtonElement>('[data-jm="toast-undo"]').click();
    expect(h.events.onUndo).toHaveBeenCalledWith('f1', 'tx1');
  });

  describe('keyboard', () => {
    const docKeys: string[] = [];
    const docListener = (ev: Event) => docKeys.push((ev as KeyboardEvent).key);
    beforeEach(() => {
      docKeys.length = 0;
      document.addEventListener('keydown', docListener);
    });
    afterEach(() => document.removeEventListener('keydown', docListener));

    function openFocused(): HTMLElement {
      setItems([item(S1(), R1), item(S2(), R2)]);
      pointerMove(700, 700); // re-entering the underline is what re-opens a closed card
      vi.advanceTimersByTime(20);
      hover(110, 110);
      const card = cardEl(h);
      card.focus();
      expect(card.contains(h.root.activeElement)).toBe(true);
      return card;
    }

    it('normal mode: a and Enter accept all, d dismisses all, digits are not claimed, Esc closes', () => {
      let card = openFocused();
      let ev = key(card, 'a');
      expect(ev.defaultPrevented).toBe(true);
      expect(h.events.onAcceptAll).toHaveBeenLastCalledWith('f1', { group: 'all', suggestionIds: ['s1', 's2'] });
      expect(docKeys).toEqual([]);
      card = openFocused();
      ev = key(card, 'Enter');
      expect(ev.defaultPrevented).toBe(true);
      expect(h.events.onAcceptAll).toHaveBeenCalledTimes(2);
      card = openFocused();
      ev = key(card, 'd');
      expect(ev.defaultPrevented).toBe(true);
      expect(h.events.onDismiss.mock.calls).toEqual([
        ['f1', 's1'],
        ['f1', 's2'],
      ]);
      card = openFocused();
      ev = key(card, '1');
      expect(ev.defaultPrevented).toBe(false);
      expect(docKeys).toEqual(['1']);
      ev = key(card, 'Escape');
      expect(ev.defaultPrevented).toBe(true);
      expect(cardOpen(h)).toBe(false);
      expect(h.events.onAccept).not.toHaveBeenCalled();
    });

    it('shortcut-safe mode leaves letters alone; Enter accepts all and Esc closes', () => {
      h.overlay.setOptions({ shortcutSafe: true });
      const card = openFocused();
      expect(card.dataset.shortcutSafe).toBe('true');
      for (const k of ['a', 'd', '1', 'x']) {
        const ev = key(card, k);
        expect(ev.defaultPrevented, k).toBe(false);
      }
      expect(docKeys).toEqual(['a', 'd', '1', 'x']);
      expect(h.events.onAcceptAll).not.toHaveBeenCalled();
      expect(h.events.onDismiss).not.toHaveBeenCalled();
      expect(h.q('[data-jm="accept"]').getAttribute('aria-keyshortcuts')).toBe('Enter');
      expect(key(card, 'Enter').defaultPrevented).toBe(true);
      expect(h.events.onAcceptAll).toHaveBeenCalledWith('f1', { group: 'all', suggestionIds: ['s1', 's2'] });
      const again = openFocused();
      expect(key(again, 'Escape').defaultPrevented).toBe(true);
      expect(cardOpen(h)).toBe(false);
    });
  });

  describe('adversarial', () => {
    it('overlapping suggestions: only the overlap winner is grouped; the loser gets its single card', () => {
      const t = 'We should of went to the store tomorow.';
      adapterEl.value = t;
      const long = at(t, 'long', 'should of went', { replacement: 'should have gone', rule: 'confusable_word' });
      const short = at(t, 'short', 'should of', { replacement: 'should have', rule: 'confusable_word', confidence: 0.5 });
      const sp = at(t, 'sp', 'tomorow', { replacement: 'tomorrow' });
      const items = [item(long, rect(100, 100, 120, 18)), item(short, rect(100, 100, 70, 18)), item(sp, R4)];
      const winner = sentenceGroupFor(items, t, 'sp')!;
      expect(winner.members).toHaveLength(2);
      const winnerIds = winner.members.map((m) => m.id);
      const loser = winnerIds.includes('long') ? 'short' : 'long';
      expect(sentenceGroupFor(items, t, loser)).toBeNull();
      // grouped ids are exactly what the controller's accept-all selects for them
      const all = items.map((i) => i.suggestion);
      expect(selectAcceptAll(all, { group: 'all', suggestionIds: winnerIds }).selected.map((s) => s.id).sort()).toEqual([...winnerIds].sort());
      setItems(items);
      hover(150, 110); // the shorter span sits on top
      expect(cardEl(h).dataset.mode).toBe(loser === 'short' ? 'single' : 'sentence');
    });

    it('a sentence hard-wrapped over two lines: all fragments go active and the card anchors to the hovered line', () => {
      const a = S1();
      const b = S2();
      // b wraps: two fragments on two lines
      setItems([item(a, rect(400, 100, 30, 18)), item(b, rect(480, 100, 40, 18), rect(20, 124, 30, 18))]);
      hover(30, 130); // the second-line fragment of b
      const card = cardEl(h);
      expect(card.dataset.mode).toBe('sentence');
      expect(h.qAll('[data-jm="underline"].jm-ul-active')).toHaveLength(3);
      expect(h.qAll('[data-jm="underline-tint"]')).toHaveLength(3);
      expect(parseInt(card.style.top, 10)).toBeGreaterThanOrEqual(124 + 18 + 8);
      expect(parseInt(card.style.left, 10)).toBe(20);
    });

    it('a deletion at the sentence start and an insertion at the sentence end group together', () => {
      const t = 'So we left early. Then we came back';
      adapterEl.value = t;
      const del = at(t, 'del', 'Then ', { kind: 'delete', replacement: '', rule: 'filler', category: 'clarity', tier: 'B' });
      const ins = insertAt('ins', t.length, '.', { rule: 'punctuation' });
      const other = at(t, 'o', 'early', { replacement: 'earlier', tier: 'B', category: 'clarity' });
      const g = sentenceGroupFor([item(other, R3), item(ins, R2), item(del, R1)], t, 'ins')!;
      expect(g.members.map((m) => m.id)).toEqual(['del', 'ins']);
      expect(g.text).toBe('Then we came back');
      expect(sentencePieces(g).map((p) => (p.type === 'text' ? p.text : `<${p.original}|${p.replacement}>`)).join('')).toBe('<Then |>we came back<|.>');
    });

    it('NBSP and emoji inside the sentence keep offsets and render verbatim', () => {
      const t = 'Great news 🎉 teh team shipped it tomorow.';
      adapterEl.value = t;
      const a = at(t, 'a', 'teh');
      const b = at(t, 'b', 'tomorow', { replacement: 'tomorrow' });
      // an original written with a plain space still matches NBSP text (same tolerance as the controller)
      const c = makeSuggestion({ id: 'c', original: 'Great news', replacement: 'Great news!', tier: 'B', category: 'engagement', range: { start: 0, end: 10 } });
      setItems([item(a, R1), item(b, R2), item(c, R3)]);
      hover(110, 110);
      expect(cardEl(h).dataset.suggestionIds).toBe('c a b');
      const content = h.q('[data-jm="sentence-content"]');
      expect(content.textContent).toBe('Great newsGreat news! 🎉 tehthe team shipped it tomorowtomorrow.');
      expect(h.qAll('[data-jm="sentence-original"]')[0]!.textContent).toBe('Great news');
    });

    it('a member removed while the card is open, including the hovered one, re-groups around a survivor', () => {
      const t = 'Their going to teh store tomorow, and i dont think so.';
      adapterEl.value = t;
      const a = at(t, 'a', 'teh');
      const b = at(t, 'b', 'tomorow', { replacement: 'tomorrow' });
      const c = at(t, 'c', 'dont', { replacement: "don't" });
      setItems([item(a, R1), item(b, R2), item(c, R4)]);
      hover(110, 110); // hovered a
      setItems([item(b, R2), item(c, R4)]);
      expect(cardOpen(h)).toBe(true);
      expect(cardEl(h).dataset.mode).toBe('sentence');
      expect(cardEl(h).dataset.suggestionIds).toBe('b c');
      // hovered gone and only one left: close rather than show an unrelated single card
      setItems([item(c, R4)]);
      expect(cardOpen(h)).toBe(false);
      setItems([item(a, R1), item(b, R2)]);
      hover(110, 110);
      const hovered = cardEl(h).dataset.suggestionId!;
      setItems([item(hovered === 'a' ? b : a, hovered === 'a' ? R2 : R1)]);
      expect(cardOpen(h)).toBe(false);
    });

    it('rapid hover between two sentences never shows a stale group', () => {
      const t = 'Their going to teh store tomorow. We was hoping you could of came with us.';
      adapterEl.value = t;
      const a = at(t, 'a', 'teh');
      const b = at(t, 'b', 'tomorow', { replacement: 'tomorrow' });
      const c = at(t, 'c', 'We was', { replacement: 'We were', rule: 'subject_verb_agreement' });
      const d = at(t, 'd', 'of came', { replacement: 'have come', rule: 'verb_form' });
      setItems([item(a, R1), item(b, R2), item(c, R3), item(d, R4)]);
      pointerMove(110, 110); // sentence 1
      vi.advanceTimersByTime(40);
      pointerMove(110, 150); // sentence 2 before the intent delay
      vi.advanceTimersByTime(HOVER_INTENT_MS + 20);
      expect(cardEl(h).dataset.suggestionIds).toBe('c d');
      expect(h.events.onCardShown).not.toHaveBeenCalledWith('f1', 'a');
      pointerMove(110, 110);
      vi.advanceTimersByTime(HOVER_INTENT_MS + 20);
      expect(cardEl(h).dataset.suggestionIds).toBe('a b');
      expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 'c');
      expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 'd');
      const active = h.qAll<HTMLElement>('[data-jm="underline"].jm-ul-active').map((el) => el.dataset.suggestionId).sort();
      expect(active).toEqual(['a', 'b']);
    });

    it('hovering another member of the open card keeps the card (no re-target, no flicker)', () => {
      setItems([item(S1(), R1), item(S2(), R2)]);
      hover(110, 110);
      h.q<HTMLButtonElement>('[data-jm="more"]').click();
      const shown = h.events.onCardShown.mock.calls.length;
      hover(210, 110);
      expect(cardEl(h).dataset.suggestionId).toBe('s1');
      expect(h.q('[data-jm="more-panel"]').hidden).toBe(false);
      expect(h.events.onCardShown.mock.calls.length).toBe(shown);
      // a click on the other member does not re-target either
      pointerDown(210, 110);
      expect(cardEl(h).dataset.suggestionId).toBe('s1');
      // leaving the second member for empty space still starts the grace (once focus left the ⋯ panel)
      (h.root.activeElement as HTMLElement | null)?.blur();
      pointerMove(700, 700);
      vi.advanceTimersByTime(LEAVE_GRACE_MS + 20);
      expect(cardOpen(h)).toBe(false);
    });

    it('text edited under the underlines (offsets stale) shows the single card', () => {
      setItems([item(S1(), R1), item(S2(), R2)]);
      adapterEl.value = 'X' + TEXT;
      hover(110, 110);
      expect(cardEl(h).dataset.mode).toBe('single');
    });

    it('toggling shortcut-safe mode while the sentence card is open keeps the sentence card', () => {
      setItems([item(S1(), R1), item(S2(), R2)]);
      hover(110, 110);
      h.overlay.setOptions({ shortcutSafe: true });
      expect(cardEl(h).dataset.mode).toBe('sentence');
      expect(cardEl(h).dataset.shortcutSafe).toBe('true');
      expect(h.q('[data-jm="accept"]').getAttribute('aria-keyshortcuts')).toBe('Enter');
    });

    it('a 3-member group sends every id once, in reading order, even when items arrive unordered', () => {
      const t = 'Their going to teh store tomorow, and i dont think so.';
      adapterEl.value = t;
      const a = at(t, 'a', 'teh');
      const b = at(t, 'b', 'tomorow', { replacement: 'tomorrow' });
      const c = at(t, 'c', 'dont', { replacement: "don't" });
      setItems([item(c, R4), item(a, R1), item(b, R2), item(a, R1)]);
      hover(310, 150);
      h.q<HTMLButtonElement>('[data-jm="accept"]').click();
      expect(h.events.onAcceptAll).toHaveBeenCalledWith('f1', { group: 'all', suggestionIds: ['a', 'b', 'c'] });
    });

    it('the shown card never claims success itself: no toast until the controller sends one', () => {
      setItems([item(S1(), R1), item(S2(), R2)]);
      hover(110, 110);
      h.q<HTMLButtonElement>('[data-jm="accept"]').click();
      expect(h.qAll('[data-jm="toast"]')).toHaveLength(0);
      expect(h.debug().toasts).toBe(0);
    });

    it('detaching the field while a sentence card is open closes it and clears the hidden events', () => {
      setItems([item(S1(), R1), item(S2(), R2)]);
      hover(110, 110);
      h.overlay.detach('f1');
      expect(cardOpen(h)).toBe(false);
      expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's1');
      expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 's2');
    });
  });
});

describe('adversarial: the controller applies exactly the grouped ids', () => {
  // Imported lazily so the UI suite does not depend on controller internals at module load.
  async function engineFor(text: string, suggestions: Suggestion[]) {
    const { ApplyEngine } = await import('../../../src/content/controller/apply');
    const { SuggestionStore } = await import('../../../src/content/controller/store');
    const { TextModel } = await import('../../../src/content/controller/text-model');
    const { FakeAdapter } = await import('../controller/helpers');
    const adapter = new FakeAdapter(text, 'textarea');
    const model = new TextModel(text);
    const store = new SuggestionStore();
    store.replaceLlm(suggestions);
    let own: Set<string> | null = null;
    let n = 0;
    const sync = (t: string): void => {
      if (t === model.text) return;
      const old = model.text;
      model.update(t, own ? { provenance: 'jammarly' } : 'insertText');
      store.rebase(old, t, own ? { ids: own } : undefined);
    };
    adapter.onChange((t) => sync(t));
    const engine = new ApplyEngine({
      fieldId: 'f1',
      adapter,
      model,
      store,
      beginOwnEdit: (_edits, ids) => {
        own = new Set(ids);
      },
      endOwnEdit: (t) => {
        sync(t);
        own = null;
      },
      now: () => Date.now(),
      newId: () => `tx${++n}`,
    });
    return { adapter, engine, store };
  }

  const T = 'Their going to teh store tomorow, and i dont think so. We was hoping.';
  const all = () => [
    at(T, 'their', 'Their', { replacement: "They're", rule: 'confusable_word' }),
    at(T, 'teh', 'teh', { replacement: 'the' }),
    at(T, 'tom', 'tomorow', { replacement: 'tomorrow' }),
    at(T, 'i', ' i ', { replacement: ' I ', rule: 'capitalization' }),
    at(T, 'dont', 'dont', { replacement: "don't", rule: 'apostrophe' }),
    at(T, 'was', 'We was', { replacement: 'We were', rule: 'subject_verb_agreement' }),
    at(T, 'rw', 'We was hoping.', { kind: 'rewrite', tier: 'C', category: 'delivery', replacement: 'We hoped.' }),
  ];

  it('accepting the group applies every member and nothing outside the sentence', async () => {
    const suggestions = all();
    const g = sentenceGroupFor(suggestions.map((s) => item(s)), T, 'tom')!;
    const ids = g.members.map((m) => m.id);
    expect(ids).toEqual(['their', 'teh', 'tom', 'i', 'dont']);
    const { adapter, engine, store } = await engineFor(T, suggestions);
    const result = await engine.acceptAll({ group: 'all', suggestionIds: ids });
    expect(result.applied.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(result.pendingRewrites.map((s) => s.id)).toEqual([]); // the other sentence's rewrite is not in scope
    expect(adapter.text).toBe("They're going to the store tomorrow, and I don't think so. We was hoping.");
    expect(store.get('was')).toBeDefined();
    expect(result.transaction!.appliedIds.sort()).toEqual([...ids].sort());
  });

  it('when one grouped edit fails to apply, only the rest is reported as applied (the card claims nothing)', async () => {
    const suggestions = all();
    const ids = sentenceGroupFor(suggestions.map((s) => item(s)), T, 'teh')!.members.map((m) => m.id);
    const { adapter, engine } = await engineFor(T, suggestions);
    adapter.failOn = (edit) => edit.original === 'tomorow';
    const result = await engine.acceptAll({ group: 'all', suggestionIds: ids });
    expect(result.applied.length).toBeLessThan(ids.length);
    expect(result.skipped.map((s) => s.id)).toContain('tom');
    expect(adapter.text).toContain('tomorow');
  });
});
