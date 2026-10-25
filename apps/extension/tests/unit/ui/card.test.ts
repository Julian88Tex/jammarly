import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_TAG } from '../../../src/content/ui/overlay';
import { EXPLANATION_COLLAPSE_AT, INTRO_TEXT, isSpellingRule, optionList, tierBadge, truncateExplanation } from '../../../src/content/ui/card';
import { FAKE_TIMER_APIS, cardEl, cardOpen, fakeAdapter, harness, item, key, makeSuggestion, opts, rect, text, type Harness } from './helpers';
import type { FieldOverlay } from '../../../src/content/ui/overlay-api';

let h: Harness;
let f: FieldOverlay;

const R = rect(100, 100, 60, 18);

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMER_APIS] });
  h = harness();
  f = h.overlay.attach('f1', fakeAdapter(), opts());
});

afterEach(() => {
  h.overlay.dispose();
  vi.useRealTimers();
  for (const el of Array.from(document.querySelectorAll(HOST_TAG))) el.remove();
  document.body.textContent = '';
});

function open(s: ReturnType<typeof makeSuggestion>, focus = false): HTMLElement {
  f.setUnderlines([item(s, R)]);
  if (focus) f.focusSuggestion(s.id);
  else f.openCard(s.id, R);
  return cardEl(h);
}

describe('card anatomy', () => {
  it('replace: category dot + label, title, struck original, bold clickable replacement, explanation, actions', () => {
    const s = makeSuggestion({ id: 's1', original: 'teh', replacement: 'the', title: 'Correct the spelling', explanation: 'This word is misspelled.' });
    const card = open(s);
    expect(cardOpen(h)).toBe(true);
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-labelledby')).toBe(h.q('[data-jm="card-title"]').id);
    expect(card.dataset.category).toBe('correctness');
    expect(card.dataset.kind).toBe('replace');
    expect(h.q('.jm-dot').dataset.category).toBe('correctness');
    expect(text(h.q('[data-jm="card-category"]'))).toBe('Correctness');
    expect(text(h.q('[data-jm="card-title"]'))).toBe('Correct the spelling');
    const original = h.q('[data-jm="card-original"]');
    expect(original.tagName).toBe('S');
    expect(text(original)).toBe('teh');
    const replacement = h.q<HTMLButtonElement>('[data-jm="replacement"]');
    expect(replacement.tagName).toBe('BUTTON');
    expect(text(replacement)).toBe('the');
    expect(text(h.q('[data-jm="explanation"]'))).toBe('This word is misspelled.');
    expect(h.root.querySelector('[data-jm="learn-more"]')).toBeNull();
    expect(text(h.q('[data-jm="accept"]'))).toBe('Accept');
    expect(h.q('[data-jm="dismiss"]').getAttribute('aria-label')).toBe('Dismiss');
    expect(h.q('[data-jm="more"]').getAttribute('aria-label')).toBe('More');
    expect(h.q('[data-jm="card-close"]').getAttribute('aria-label')).toBe('Close');
    // anatomy order
    const order = Array.from(card.children).map((c) => (c as HTMLElement).dataset.jm);
    expect(order).toEqual(['card-head', 'accept-zone', 'actions', 'more-panel', 'card-footer']);
    const zone = Array.from(h.q('[data-jm="accept-zone"]').children).map((c) => (c as HTMLElement).dataset.jm);
    expect(zone).toEqual(['card-title', 'card-content', 'explanation']);
    expect(h.root.querySelector('[data-jm="options"]')).toBeNull();
    expect(h.events.onCardShown).toHaveBeenCalledWith('f1', 's1');
    // tier A badge
    expect(text(h.q('[data-jm="card-badge"]'))).toBe('Auto');
  });

  it('delete: struck original and a "Remove" action', () => {
    const s = makeSuggestion({ id: 'd1', kind: 'delete', original: 'the', replacement: '', rule: 'repeated_word', title: 'Remove the repeated word' });
    open(s);
    expect(text(h.q('[data-jm="card-original"]'))).toBe('the');
    expect(text(h.q('[data-jm="replacement"]'))).toBe('Remove');
    h.q<HTMLButtonElement>('[data-jm="replacement"]').click();
    expect(h.events.onAccept).toHaveBeenCalledWith('f1', 'd1', undefined);
    expect(cardOpen(h)).toBe(false);
  });

  it('flag: original shown without a replacement or Accept button', () => {
    const s = makeSuggestion({ id: 'fl1', kind: 'flag', category: 'delivery', tier: 'C', original: 'very unique', replacement: 'very unique', rule: 'hedging', title: 'Consider this wording' });
    const card = open(s);
    expect(card.dataset.kind).toBe('flag');
    expect(text(h.q('[data-jm="card-original"]'))).toBe('very unique');
    expect(h.root.querySelector('[data-jm="replacement"]')).toBeNull();
    expect(h.root.querySelector('[data-jm="accept"]')).toBeNull();
    expect(h.root.querySelector('[data-jm="dismiss"]')).not.toBeNull();
    expect(text(h.q('[data-jm="card-badge"]'))).toBe('Needs review');
    // 'a' does nothing for a flag
    card.focus();
    const ev = key(card, 'a');
    expect(h.events.onAccept).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('rewrite: full replacement sentence, "Rewrite" badge, alternatives as options 1-9', () => {
    const s = makeSuggestion({
      id: 'rw1',
      kind: 'rewrite',
      category: 'clarity',
      tier: 'C',
      rule: 'hard_to_read',
      original: 'It is the case that we should of went earlier.',
      replacement: 'We should have gone earlier.',
      alternatives: ['We ought to have left earlier.', 'Leaving earlier would have been better.'],
      title: 'Rewrite for clarity',
    });
    const card = open(s);
    expect(card.dataset.kind).toBe('rewrite');
    expect(text(h.q('[data-jm="replacement"]'))).toBe('We should have gone earlier.');
    expect(text(h.q('[data-jm="card-badge"]'))).toBe('Rewrite');
    expect(text(h.q('[data-jm="accept"]'))).toBe('Accept rewrite');
    const options = h.qAll<HTMLButtonElement>('[data-jm="option"]');
    expect(options.length).toBe(3);
    expect(options.map((o) => o.dataset.index)).toEqual(['1', '2', '3']);
    expect(text(options[0]!)).toContain('We should have gone earlier.');
    expect(options[0]!.getAttribute('aria-current')).toBe('true');
    options[2]!.click();
    expect(h.events.onAccept).toHaveBeenCalledWith('f1', 'rw1', 1);
  });

  it('stale rewrite shows "Sentence changed"', () => {
    const s = makeSuggestion({ id: 'rw2', kind: 'rewrite', category: 'clarity', tier: 'C', stale: true, original: 'a b c.', replacement: 'A, b and c.' });
    open(s);
    const badge = h.q('[data-jm="card-badge"]');
    expect(text(badge)).toBe('Sentence changed');
    expect(badge.dataset.stale).toBe('true');
  });

  it('tier B suggestions carry no badge', () => {
    const s = makeSuggestion({ id: 'b1', category: 'clarity', tier: 'B', rule: 'wordy_phrase', original: 'in order to', replacement: 'to' });
    open(s);
    expect(h.root.querySelector('[data-jm="card-badge"]')).toBeNull();
    expect(tierBadge(s)).toBeNull();
    expect(tierBadge(makeSuggestion({ id: 'x', tier: 'A' }))?.text).toBe('Auto');
  });

  it('clicking the title or explanation accepts; Learn more and flags do not', () => {
    const long = 'The first sentence of this explanation is fairly long and detailed. The second sentence adds even more words so the whole thing passes the collapse threshold of one hundred and forty characters.';
    open(makeSuggestion({ id: 'z1', category: 'clarity', tier: 'C', original: 'It', replacement: 'The venue', title: 'Clarify what this refers to', explanation: long }));
    h.q<HTMLButtonElement>('[data-jm="learn-more"]').click();
    expect(h.events.onAccept).not.toHaveBeenCalled();
    h.q('[data-jm="card-title"]').click();
    expect(h.events.onAccept).toHaveBeenCalledWith('f1', 'z1', undefined);
    h.q('[data-jm="explanation"]').click();
    expect(h.events.onAccept).toHaveBeenCalledTimes(2);
  });

  it('collapses long explanations behind "Learn more"', () => {
    const long = 'The first sentence of this explanation is fairly long and detailed. The second sentence adds even more words so the whole thing passes the collapse threshold of one hundred and forty characters.';
    expect(long.length).toBeGreaterThan(EXPLANATION_COLLAPSE_AT);
    const s = makeSuggestion({ id: 'e1', explanation: long });
    open(s);
    const expl = h.q('[data-jm="explanation"]');
    expect(expl.dataset.expanded).toBe('false');
    const learn = h.q<HTMLButtonElement>('[data-jm="learn-more"]');
    expect(text(learn)).toBe('Learn more');
    expect(text(expl)).not.toContain('one hundred and forty');
    expect(text(expl).length).toBeLessThan(long.length);
    learn.click();
    expect(expl.dataset.expanded).toBe('true');
    expect(text(expl)).toBe(long);
    expect(h.root.querySelector('[data-jm="learn-more"]')).toBeNull();
    // helper
    expect(truncateExplanation('Short.')).toBe('Short.');
    expect(truncateExplanation(long).endsWith('.') || truncateExplanation(long).endsWith('…')).toBe(true);
    expect(truncateExplanation(long).length).toBeLessThanOrEqual(EXPLANATION_COLLAPSE_AT + 1);
  });

  it('shows the first-run footer until the first accept or dismiss', () => {
    const s1 = makeSuggestion({ id: 'i1' });
    open(s1);
    expect(text(h.q('[data-jm="card-footer"]'))).toBe(INTRO_TEXT);
    h.q<HTMLButtonElement>('[data-jm="dismiss"]').click();
    expect(h.events.onDismiss).toHaveBeenCalledWith('f1', 'i1', undefined);
    expect(cardOpen(h)).toBe(false);
    const s2 = makeSuggestion({ id: 'i2' });
    open(s2);
    expect(h.root.querySelector('[data-jm="card-footer"]')).toBeNull();
    expect(h.debug().introSeen).toBe(true);
  });

  it('Add to dictionary appears for spelling rules only and sends the word', () => {
    open(makeSuggestion({ id: 'sp1', rule: 'spelling', original: 'Jammarly', replacement: 'Jam' }));
    const dict = h.q<HTMLButtonElement>('[data-jm="add-to-dictionary"]');
    expect(text(dict)).toBe('Add to dictionary');
    dict.click();
    expect(h.events.onAddToDictionary).toHaveBeenCalledWith('f1', 'Jammarly');
    expect(cardOpen(h)).toBe(false);
    open(makeSuggestion({ id: 'g1', rule: 'subject_verb_agreement', original: 'was', replacement: 'were' }));
    expect(h.root.querySelector('[data-jm="add-to-dictionary"]')).toBeNull();
    expect(isSpellingRule('spelling_dialect')).toBe(true);
    expect(isSpellingRule('comma')).toBe(false);
  });

  it('More reveals report, mute (site / everywhere) and dismiss-reason chips', () => {
    open(makeSuggestion({ id: 'm1', rule: 'comma' }));
    const panel = h.q('[data-jm="more-panel"]');
    expect(panel.hidden).toBe(true);
    const more = h.q<HTMLButtonElement>('[data-jm="more"]');
    more.click();
    expect(panel.hidden).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const reasons = h.qAll<HTMLButtonElement>('[data-jm="dismiss-reason"]');
    expect(reasons.map((r) => r.dataset.reason)).toEqual(['not_error', 'meant_this', 'not_here']);
    expect(reasons.map((r) => text(r))).toEqual(['Not an error', 'I meant this', 'Not here']);
    h.q<HTMLButtonElement>('[data-jm="mute-host"]').click();
    expect(h.events.onMuteRule).toHaveBeenCalledWith('f1', 'comma', 'host');
    expect(cardOpen(h)).toBe(false);

    open(makeSuggestion({ id: 'm2', rule: 'comma' }));
    h.q<HTMLButtonElement>('[data-jm="more"]').click();
    h.q<HTMLButtonElement>('[data-jm="mute-global"]').click();
    expect(h.events.onMuteRule).toHaveBeenCalledWith('f1', 'comma', 'global');

    open(makeSuggestion({ id: 'm3', rule: 'comma' }));
    h.q<HTMLButtonElement>('[data-jm="more"]').click();
    h.q<HTMLButtonElement>('[data-jm="report-incorrect"]').click();
    expect(h.events.onReportIncorrect).toHaveBeenCalledWith('f1', 'm3');

    open(makeSuggestion({ id: 'm4', rule: 'comma' }));
    h.q<HTMLButtonElement>('[data-jm="more"]').click();
    h.qAll<HTMLButtonElement>('[data-jm="dismiss-reason"]').find((r) => r.dataset.reason === 'meant_this')!.click();
    expect(h.events.onDismiss).toHaveBeenCalledWith('f1', 'm4', 'meant_this');
    expect(cardOpen(h)).toBe(false);
  });

  it('accepts by clicking the replacement and reports hidden after accept', () => {
    open(makeSuggestion({ id: 'a1' }));
    h.q<HTMLButtonElement>('[data-jm="replacement"]').click();
    expect(h.events.onAccept).toHaveBeenCalledWith('f1', 'a1', undefined);
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 'a1');
    expect(cardOpen(h)).toBe(false);
  });

  it('closes with the × button and Esc', () => {
    const card = open(makeSuggestion({ id: 'c1' }));
    h.q<HTMLButtonElement>('[data-jm="card-close"]').click();
    expect(cardOpen(h)).toBe(false);
    open(makeSuggestion({ id: 'c1' }), true);
    const ev = key(card, 'Escape');
    expect(cardOpen(h)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('only one card at a time: opening a second suggestion replaces the first', () => {
    f.setUnderlines([item(makeSuggestion({ id: 'o1' }), R), item(makeSuggestion({ id: 'o2', original: 'recieve', replacement: 'receive' }), rect(300, 100, 60, 18))]);
    f.openCard('o1', R);
    f.openCard('o2', rect(300, 100, 60, 18));
    expect(h.qAll('[data-jm="card"]').length).toBe(1);
    expect(cardEl(h).dataset.suggestionId).toBe('o2');
    expect(text(h.q('[data-jm="replacement"]'))).toBe('receive');
    expect(h.events.onCardHidden).toHaveBeenCalledWith('f1', 'o1');
  });

  it('places the card below the anchor and flips above near the bottom', () => {
    const card = open(makeSuggestion({ id: 'p1' }));
    expect(card.dataset.placement).toBe('below');
    expect(card.style.top).toBe(`${118 + 8}px`);
    expect(card.style.left).toBe('100px');
    f.openCard('p1', rect(100, window.innerHeight - 20, 60, 18));
    expect(card.dataset.placement).toBe('above');
  });

  it('re-renders in place when the suggestion changes and repositions on updateRects', () => {
    const s = makeSuggestion({ id: 'u1', kind: 'rewrite', tier: 'C', category: 'clarity', original: 'a.', replacement: 'A.' });
    open(s);
    expect(h.root.querySelector('[data-jm="card-badge"]')!.textContent).toBe('Rewrite');
    f.updateRects([item({ ...s, stale: true }, rect(200, 300, 60, 18))]);
    expect(cardOpen(h)).toBe(true);
    expect(h.root.querySelector('[data-jm="card-badge"]')!.textContent).toBe('Sentence changed');
    expect(cardEl(h).style.left).toBe('200px');
    expect(h.events.onCardShown).toHaveBeenCalledTimes(1);
  });

  it('optionList puts the primary replacement first and caps at 9', () => {
    const s = makeSuggestion({ id: 'ol', replacement: 'r0', alternatives: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'] });
    const list = optionList(s);
    expect(list.length).toBe(9);
    expect(list[0]).toEqual({ label: 'r0', alternativeIndex: undefined });
    expect(list[8]).toEqual({ label: 'a8', alternativeIndex: 7 });
    expect(optionList(makeSuggestion({ id: 'none' }))).toEqual([]);
  });
});

describe('card keyboard', () => {
  const docKeys: string[] = [];
  const docListener = (ev: Event) => docKeys.push((ev as KeyboardEvent).key);
  beforeEach(() => {
    docKeys.length = 0;
    document.addEventListener('keydown', docListener);
  });
  afterEach(() => document.removeEventListener('keydown', docListener));

  it('normal mode: a accepts, d dismisses, 1-9 pick options, Esc closes; handled keys are prevented and stopped', () => {
    const s = makeSuggestion({ id: 'k1', replacement: 'the', alternatives: ['then'] });
    let card = open(s, true);
    expect(card.contains(h.root.activeElement)).toBe(true);
    let ev = key(card, 'a');
    expect(h.events.onAccept).toHaveBeenLastCalledWith('f1', 'k1', undefined);
    expect(ev.defaultPrevented).toBe(true);
    expect(docKeys).toEqual([]); // propagation stopped

    card = open(s, true);
    ev = key(card, 'D');
    expect(h.events.onDismiss).toHaveBeenLastCalledWith('f1', 'k1', undefined);
    expect(ev.defaultPrevented).toBe(true);

    card = open(s, true);
    ev = key(card, '2');
    expect(h.events.onAccept).toHaveBeenLastCalledWith('f1', 'k1', 0);
    expect(ev.defaultPrevented).toBe(true);

    card = open(s, true);
    ev = key(card, '5'); // no such option: unhandled
    expect(ev.defaultPrevented).toBe(false);
    expect(docKeys).toEqual(['5']);
    expect(cardOpen(h)).toBe(true);

    ev = key(card, 'Enter'); // Enter on the card root accepts
    expect(h.events.onAccept).toHaveBeenLastCalledWith('f1', 'k1', undefined);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('never claims keys it does not handle (modifiers, other letters)', () => {
    const card = open(makeSuggestion({ id: 'k2' }), true);
    const ev1 = key(card, 'x');
    const ev2 = key(card, 'a', { ctrlKey: true });
    const ev3 = key(card, 'z', { metaKey: true });
    expect(ev1.defaultPrevented).toBe(false);
    expect(ev2.defaultPrevented).toBe(false);
    expect(ev3.defaultPrevented).toBe(false);
    expect(docKeys).toEqual(['x', 'a', 'z']);
    expect(h.events.onAccept).not.toHaveBeenCalled();
    expect(cardOpen(h)).toBe(true);
  });

  it('shortcutSafe mode: single letters and digits are ignored and never prevented; Enter/Esc/arrows still work', () => {
    h.overlay.setOptions({ shortcutSafe: true });
    const s = makeSuggestion({ id: 'k3', alternatives: ['then'] });
    const card = open(s, true);
    expect(card.dataset.shortcutSafe).toBe('true');
    for (const k of ['a', 'd', '1', '2', 'e', 'j']) {
      const ev = key(card, k);
      expect(ev.defaultPrevented, k).toBe(false);
    }
    expect(docKeys).toEqual(['a', 'd', '1', '2', 'e', 'j']);
    expect(h.events.onAccept).not.toHaveBeenCalled();
    expect(h.events.onDismiss).not.toHaveBeenCalled();
    expect(h.root.querySelector('[data-jm="accept"]')!.getAttribute('aria-keyshortcuts')).toBe('Enter');

    const down = key(card, 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(h.root.activeElement).toBe(h.q('[data-jm="card-close"]'));
    card.focus();
    const enter = key(card, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(h.events.onAccept).toHaveBeenCalledWith('f1', 'k3', undefined);
    const card2 = open(s, true);
    const esc = key(card2, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(cardOpen(h)).toBe(false);
  });

  it('Tab cycles through the card controls only while the card has focus', () => {
    const card = open(makeSuggestion({ id: 'k4', rule: 'spelling' }), true);
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      const ev = key(card, 'Tab');
      expect(ev.defaultPrevented).toBe(true);
      order.push((h.root.activeElement as HTMLElement).dataset.jm ?? '?');
    }
    expect(order).toEqual(['card-close', 'replacement', 'accept', 'dismiss', 'add-to-dictionary', 'more', 'card-close']);
    key(card, 'Tab', { shiftKey: true });
    expect((h.root.activeElement as HTMLElement).dataset.jm).toBe('more');
    expect(docKeys).toEqual([]);
  });

  it('returns focus to the previously focused element when a focused card closes', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const card = open(makeSuggestion({ id: 'k5' }), true);
    expect(document.activeElement).toBe(h.host);
    key(card, 'Escape');
    expect(document.activeElement).toBe(input);
  });
});
