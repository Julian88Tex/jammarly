/**
 * The hover suggestion card (one per overlay; one suggestion at a time).
 *
 * Anatomy (research 01 §4, §10.4): category dot + label · title · struck original followed by the clickable bold
 * replacement · options 1–9 · explanation (Learn more past 140 chars) · actions (Accept, Dismiss, Add to dictionary
 * for spelling, ⋯ More) · first-run footer. role=dialog with aria-labelledby; Tab is trapped only while the card has
 * focus; `a` / `d` / `1–9` only in normal mode; in shortcut-safe mode (Gmail, Superhuman, Slashy) only Enter, Esc and
 * arrows are claimed and unhandled keys are never preventDefault-ed or stopped.
 *
 * Rendered as `popover="manual"` (top layer) when the Popover API exists, else as a positioned div.
 */
import type { DismissReason, Suggestion } from '@jammarly/shared/types';
import { CATEGORY_LABELS, placeCard } from './overlay-api';
import { categoryDot, focusableWithin, h, isolatePointerEvents, keepHostSelection, setChildren, svgIcon, uid } from './dom';
import type { RectLike } from './underlines';

export const INTRO_TEXT = 'Jammarly helps you write clearly and mistake-free.';
export const EXPLANATION_COLLAPSE_AT = 140;
export const CARD_DEFAULT_WIDTH = 320;
export const CARD_DEFAULT_HEIGHT = 180;
export const MAX_OPTIONS = 9;

export interface CardCallbacks {
  onAccept(fieldId: string, suggestionId: string, alternativeIndex?: number): void;
  onDismiss(fieldId: string, suggestionId: string, reason?: DismissReason): void;
  onAddToDictionary(fieldId: string, word: string): void;
  onMuteRule(fieldId: string, rule: string, scope: 'host' | 'global'): void;
  onReportIncorrect(fieldId: string, suggestionId: string): void;
  /** The user closed the card (Esc or the × button). */
  onRequestClose(): void;
  onShown(fieldId: string, suggestionId: string): void;
  onHidden(fieldId: string, suggestionId: string): void;
  onPointerEnter(): void;
  onPointerLeave(): void;
}

export interface CardShowOptions {
  fieldId: string;
  suggestion: Suggestion;
  anchor: RectLike;
  shortcutSafe: boolean;
  showIntro: boolean;
  /** Move keyboard focus into the card (panel navigation / commands). */
  focus?: boolean;
}

/** Spelling rules get the "Add to dictionary" action (rule ids from the engine contract: spelling, spelling_dialect). */
export function isSpellingRule(rule: string): boolean {
  return /^spelling/.test(rule);
}

/** The options list: option 1 is the primary replacement, 2..n the alternatives (alternativeIndex = n - 2). */
export function optionList(s: Suggestion): { label: string; alternativeIndex: number | undefined }[] {
  if (s.alternatives.length === 0) return [];
  const out: { label: string; alternativeIndex: number | undefined }[] = [{ label: s.replacement, alternativeIndex: undefined }];
  s.alternatives.forEach((alt, i) => {
    if (out.length < MAX_OPTIONS) out.push({ label: alt, alternativeIndex: i });
  });
  return out;
}

/** Short form of an explanation: first sentence if it fits, else a word-boundary cut with an ellipsis. */
export function truncateExplanation(text: string, max = EXPLANATION_COLLAPSE_AT): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const firstSentence = /^[^.!?]*[.!?]/.exec(t)?.[0];
  if (firstSentence && firstSentence.length <= max && firstSentence.length >= 20) return firstSentence;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '') + '…';
}

/** Badge text for the header: Auto (tier A), Rewrite (tier C), Sentence changed (stale). */
export function tierBadge(s: Suggestion): { text: string; tier?: 'A' | 'C'; stale?: boolean } | null {
  if (s.stale) return { text: 'Sentence changed', stale: true };
  if (s.tier === 'A') return { text: 'Auto', tier: 'A' };
  if (s.tier === 'C') return { text: s.kind === 'rewrite' ? 'Rewrite' : 'Needs review', tier: 'C' };
  return null;
}

export function supportsPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype && typeof (HTMLElement.prototype as unknown as { showPopover?: unknown }).showPopover === 'function';
}

interface Current {
  fieldId: string;
  suggestion: Suggestion;
  anchor: RectLike;
  shortcutSafe: boolean;
  showIntro: boolean;
  signature: string;
}

export class SuggestionCard {
  readonly element: HTMLDivElement;
  private readonly titleId = uid('jm-card-title');
  private readonly explId = uid('jm-card-expl');
  private readonly popover: boolean;
  private current: Current | null = null;
  private previousFocus: Element | null = null;
  private moreOpen = false;
  private explanationExpanded = false;

  constructor(
    private readonly root: ShadowRoot,
    parent: HTMLElement,
    private readonly cb: CardCallbacks,
  ) {
    this.popover = supportsPopover();
    this.element = h('div', {
      class: 'jm-card',
      'data-jm': 'card',
      role: 'dialog',
      'aria-labelledby': this.titleId,
      'aria-describedby': this.explId,
      tabindex: '-1',
      'data-open': 'false',
    });
    if (this.popover) this.element.setAttribute('popover', 'manual');
    else this.element.setAttribute('hidden', '');
    isolatePointerEvents(this.element);
    this.element.addEventListener('keydown', (ev) => this.onKeydown(ev));
    this.element.addEventListener('pointerenter', () => this.cb.onPointerEnter());
    this.element.addEventListener('pointerleave', () => this.cb.onPointerLeave());
    parent.appendChild(this.element);
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  currentTarget(): { fieldId: string; suggestionId: string } | null {
    return this.current ? { fieldId: this.current.fieldId, suggestionId: this.current.suggestion.id } : null;
  }

  hasFocus(): boolean {
    const active = this.root.activeElement;
    return !!active && this.element.contains(active);
  }

  focus(): void {
    if (!this.hasFocus()) {
      const outside = document.activeElement;
      if (outside && outside !== this.root.host && outside !== document.body) this.previousFocus = outside;
    }
    this.element.focus({ preventScroll: true });
  }

  show(opts: CardShowOptions): void {
    const signature = signatureOf(opts);
    const prev = this.current;
    const sameSuggestion = prev !== null && prev.suggestion.id === opts.suggestion.id && prev.fieldId === opts.fieldId;
    if (prev && !sameSuggestion) this.cb.onHidden(prev.fieldId, prev.suggestion.id);
    const keepFocus = this.hasFocus();
    if (!prev || !sameSuggestion || prev.signature !== signature) {
      this.moreOpen = sameSuggestion ? this.moreOpen : false;
      this.explanationExpanded = sameSuggestion ? this.explanationExpanded : false;
      this.render(opts);
    }
    this.current = { ...opts, signature };
    this.element.dataset.open = 'true';
    this.element.dataset.suggestionId = opts.suggestion.id;
    this.element.dataset.fieldId = opts.fieldId;
    this.element.dataset.category = opts.suggestion.category;
    this.element.dataset.kind = opts.suggestion.kind;
    this.element.dataset.shortcutSafe = String(opts.shortcutSafe);
    // The `hidden` attribute is the fallback visibility switch; it must never linger in popover mode.
    this.element.removeAttribute('hidden');
    if (this.popover) {
      try {
        if (!this.element.matches(':popover-open')) this.element.showPopover();
      } catch {
        /* not connected or already open: the attribute removal above shows it */
      }
    }
    this.reposition(opts.anchor);
    if (opts.focus || keepFocus) this.focus();
    if (!prev || !sameSuggestion) this.cb.onShown(opts.fieldId, opts.suggestion.id);
  }

  hide(): void {
    const prev = this.current;
    if (!prev) return;
    const hadFocus = this.hasFocus();
    this.current = null;
    this.element.dataset.open = 'false';
    if (this.popover) {
      try {
        if (this.element.matches(':popover-open')) this.element.hidePopover();
      } catch {
        /* already hidden */
      }
    } else {
      this.element.setAttribute('hidden', '');
    }
    if (hadFocus) this.restoreFocus();
    this.cb.onHidden(prev.fieldId, prev.suggestion.id);
  }

  /** Re-place the card against a fresh anchor rect (scroll, resize, zoom). */
  reposition(anchor?: RectLike): void {
    if (!this.current) return;
    if (anchor) this.current.anchor = anchor;
    const a = this.current.anchor;
    const size = this.measure();
    const viewport = { width: window.innerWidth || 1024, height: window.innerHeight || 768 };
    const pos = placeCard(
      { top: a.top, bottom: a.bottom, left: a.left } as DOMRect,
      size,
      viewport,
    );
    this.element.style.left = `${Math.round(pos.left)}px`;
    this.element.style.top = `${Math.round(pos.top)}px`;
    this.element.dataset.placement = pos.placement;
  }

  dispose(): void {
    this.hide();
    this.element.remove();
  }

  // ---------------------------------------------------------------------- rendering

  private measure(): { width: number; height: number } {
    const r = this.element.getBoundingClientRect();
    return {
      width: r.width > 0 ? r.width : CARD_DEFAULT_WIDTH,
      height: r.height > 0 ? r.height : CARD_DEFAULT_HEIGHT,
    };
  }

  private render(opts: CardShowOptions): void {
    const s = opts.suggestion;
    const { fieldId } = opts;
    const accept = (alternativeIndex?: number) => this.cb.onAccept(fieldId, s.id, alternativeIndex);
    const dismiss = (reason?: DismissReason) => this.cb.onDismiss(fieldId, s.id, reason);
    const canAccept = s.kind !== 'flag';

    // Header: dot + category label + tier badge + close
    const badge = tierBadge(s);
    const head = h(
      'div',
      { class: 'jm-card-head', 'data-jm': 'card-head' },
      categoryDot(s.category),
      h('span', { class: 'jm-cat', 'data-jm': 'card-category' }, CATEGORY_LABELS[s.category]),
      badge
        ? h('span', { class: 'jm-chip', 'data-jm': 'card-badge', 'data-tier': badge.tier ?? null, 'data-stale': badge.stale ? 'true' : null }, badge.text)
        : null,
      hostSafeButton(
        { class: 'jm-iconbtn jm-sm jm-card-close', 'data-jm': 'card-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.cb.onRequestClose() },
        svgIcon('close', 14),
      ),
    );

    const title = h('h2', { class: 'jm-title', id: this.titleId, 'data-jm': 'card-title' }, s.title || 'Consider this change');

    // Content: original struck through followed by the clickable bold replacement
    const content = h('div', { class: 'jm-content', 'data-jm': 'card-content', 'data-kind': s.kind });
    const original = s.original;
    if (s.kind === 'flag') {
      content.appendChild(h('span', { class: 'jm-original', 'data-jm': 'card-original' }, original));
    } else {
      if (original.length > 0) {
        content.appendChild(h('s', { class: 'jm-original', 'data-jm': 'card-original' }, original));
        content.appendChild(h('span', { class: 'jm-arrow', 'aria-hidden': 'true' }, s.kind === 'rewrite' ? '' : '→'));
      }
      const label = s.kind === 'delete' ? 'Remove' : s.replacement.trim().length === 0 && s.replacement.length > 0 ? 'Add a space' : s.replacement;
      content.appendChild(
        hostSafeButton(
          {
            class: 'jm-replacement',
            'data-jm': 'replacement',
            title: s.kind === 'delete' ? 'Remove this text' : 'Accept this replacement',
            'aria-label': s.kind === 'delete' ? `Remove “${original}”` : `Replace with “${label}”`,
            onclick: () => accept(),
          },
          label,
        ),
      );
    }

    // Options 1–9
    const options = optionList(s);
    let optionsEl: HTMLOListElement | null = null;
    if (options.length > 0) {
      optionsEl = h('ol', { class: 'jm-options', 'data-jm': 'options', 'aria-label': 'Options' });
      options.forEach((opt, i) => {
        optionsEl!.appendChild(
          h(
            'li',
            null,
            hostSafeButton(
              {
                class: 'jm-option',
                'data-jm': 'option',
                'data-index': String(i + 1),
                'aria-current': i === 0 ? 'true' : null,
                'aria-keyshortcuts': opts.shortcutSafe ? null : String(i + 1),
                onclick: () => accept(opt.alternativeIndex),
              },
              h('span', { class: 'jm-option-key', 'aria-hidden': 'true' }, String(i + 1)),
              h('span', { class: 'jm-option-text' }, opt.label),
            ),
          ),
        );
      });
    }

    // Explanation (+ Learn more)
    const explanation = s.explanation.trim();
    const explEl = h('p', { class: 'jm-explanation', id: this.explId, 'data-jm': 'explanation' });
    const renderExplanation = () => {
      const collapsed = explanation.length > EXPLANATION_COLLAPSE_AT && !this.explanationExpanded;
      setChildren(
        explEl,
        collapsed ? truncateExplanation(explanation) : explanation,
        collapsed ? ' ' : null,
        collapsed
          ? hostSafeButton(
              {
                class: 'jm-learn',
                'data-jm': 'learn-more',
                'aria-expanded': 'false',
                onclick: () => {
                  this.explanationExpanded = true;
                  renderExplanation();
                },
              },
              'Learn more',
            )
          : null,
      );
      explEl.dataset.expanded = String(!collapsed);
    };
    renderExplanation();

    // Actions
    const morePanel = h('div', { class: 'jm-more-panel', 'data-jm': 'more-panel', role: 'group', 'aria-label': 'More actions', hidden: true });
    const moreBtn = hostSafeButton(
      {
        class: 'jm-iconbtn jm-sm',
        'data-jm': 'more',
        'aria-label': 'More',
        title: 'More',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        onclick: () => {
          this.moreOpen = !this.moreOpen;
          morePanel.hidden = !this.moreOpen;
          moreBtn.setAttribute('aria-expanded', String(this.moreOpen));
          if (this.moreOpen) {
            const first = focusableWithin(morePanel)[0];
            (first ?? this.element).focus({ preventScroll: true });
          }
          this.reposition();
        },
      },
      svgIcon('more', 16),
    );
    morePanel.hidden = !this.moreOpen;
    moreBtn.setAttribute('aria-expanded', String(this.moreOpen));

    const actions = h(
      'div',
      { class: 'jm-actions', 'data-jm': 'actions' },
      canAccept
        ? hostSafeButton(
            { class: 'jm-primary', 'data-jm': 'accept', 'aria-keyshortcuts': opts.shortcutSafe ? 'Enter' : 'a Enter', title: opts.shortcutSafe ? 'Accept' : 'Accept (a)', onclick: () => accept() },
            s.kind === 'rewrite' ? 'Accept rewrite' : 'Accept',
          )
        : null,
      hostSafeButton(
        { class: 'jm-iconbtn jm-sm', 'data-jm': 'dismiss', 'aria-label': 'Dismiss', title: opts.shortcutSafe ? 'Dismiss' : 'Dismiss (d)', 'aria-keyshortcuts': opts.shortcutSafe ? null : 'd', onclick: () => dismiss() },
        svgIcon('trash', 15),
      ),
      isSpellingRule(s.rule) && original.trim().length > 0
        ? hostSafeButton(
            { class: 'jm-textbtn', 'data-jm': 'add-to-dictionary', title: `Add “${original.trim()}” to your dictionary`, onclick: () => this.cb.onAddToDictionary(fieldId, original.trim()) },
            svgIcon('book', 14),
            'Add to dictionary',
          )
        : null,
      h('span', { class: 'jm-spacer' }),
      moreBtn,
    );

    // More panel contents
    const reasons: { reason: DismissReason; label: string }[] = [
      { reason: 'not_error', label: 'Not an error' },
      { reason: 'meant_this', label: 'I meant this' },
      { reason: 'not_here', label: 'Not here' },
    ];
    if (s.kind === 'rewrite') reasons.push({ reason: 'dislike_rewrite', label: 'Don’t rewrite this' });
    setChildren(
      morePanel,
      hostSafeButton(
        { class: 'jm-mi', 'data-jm': 'report-incorrect', onclick: () => this.cb.onReportIncorrect(fieldId, s.id) },
        svgIcon('warning', 14),
        'Report incorrect',
      ),
      hostSafeButton(
        { class: 'jm-mi', 'data-jm': 'mute-host', onclick: () => this.cb.onMuteRule(fieldId, s.rule, 'host') },
        svgIcon('slash', 14),
        'Turn off suggestions like this on this site',
      ),
      hostSafeButton(
        { class: 'jm-mi', 'data-jm': 'mute-global', onclick: () => this.cb.onMuteRule(fieldId, s.rule, 'global') },
        svgIcon('slash', 14),
        'Turn off suggestions like this everywhere',
      ),
      h('div', { class: 'jm-mi-sep', role: 'separator' }),
      h(
        'div',
        { class: 'jm-reasons', 'data-jm': 'dismiss-reasons', role: 'group', 'aria-label': 'Dismiss because' },
        h('span', { class: 'jm-reasons-label' }, 'Dismiss:'),
        reasons.map((r) =>
          hostSafeButton({ class: 'jm-reason', 'data-jm': 'dismiss-reason', 'data-reason': r.reason, onclick: () => dismiss(r.reason) }, r.label),
        ),
      ),
    );

    const footer = opts.showIntro ? h('div', { class: 'jm-footer', 'data-jm': 'card-footer' }, INTRO_TEXT) : null;

    setChildren(this.element, head, title, content, optionsEl, explEl, actions, morePanel, footer);
  }

  // ---------------------------------------------------------------------- keyboard

  private onKeydown(ev: KeyboardEvent): void {
    if (!this.current || ev.isComposing) return;
    const mod = ev.ctrlKey || ev.metaKey || ev.altKey;
    const { shortcutSafe, suggestion: s, fieldId } = this.current;
    const target = ev.target as HTMLElement | null;
    const onRoot = target === this.element;
    let handled = false;

    switch (ev.key) {
      case 'Escape':
        if (!mod) {
          this.cb.onRequestClose();
          handled = true;
        }
        break;
      case 'Tab':
        if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          this.cycleFocus(ev.shiftKey ? -1 : 1);
          handled = true;
        }
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        if (!mod) {
          this.cycleFocus(1);
          handled = true;
        }
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        if (!mod) {
          this.cycleFocus(-1);
          handled = true;
        }
        break;
      case 'Enter':
        // Enter on a focused button activates it natively; on the card root it accepts.
        if (!mod && onRoot && s.kind !== 'flag') {
          this.cb.onAccept(fieldId, s.id);
          handled = true;
        }
        break;
      default:
        if (!shortcutSafe && !mod && !ev.shiftKey) {
          const key = ev.key.toLowerCase();
          if (key === 'a' && s.kind !== 'flag') {
            this.cb.onAccept(fieldId, s.id);
            handled = true;
          } else if (key === 'd') {
            this.cb.onDismiss(fieldId, s.id);
            handled = true;
          } else if (/^[1-9]$/.test(key)) {
            const options = optionList(s);
            const opt = options[Number(key) - 1];
            if (opt) {
              this.cb.onAccept(fieldId, s.id, opt.alternativeIndex);
              handled = true;
            }
          }
        }
    }

    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  private cycleFocus(dir: 1 | -1): void {
    const items = focusableWithin(this.element);
    if (items.length === 0) {
      this.element.focus({ preventScroll: true });
      return;
    }
    const active = this.root.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    let next: number;
    if (idx === -1) next = dir === 1 ? 0 : items.length - 1;
    else next = (idx + dir + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }

  private restoreFocus(): void {
    const prev = this.previousFocus as HTMLElement | null;
    this.previousFocus = null;
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
      try {
        prev.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function signatureOf(o: CardShowOptions): string {
  const s = o.suggestion;
  return [s.id, s.stale, s.kind, s.tier, s.title, s.original, s.replacement, s.alternatives.join('\u0001'), s.explanation, s.rule, o.shortcutSafe, o.showIntro].join('\u0002');
}

/** A card button that keeps the host field's selection (mousedown default prevented) and takes the click. */
function hostSafeButton(attrs: Parameters<typeof h>[1], ...children: Parameters<typeof h>[2][]): HTMLButtonElement {
  const btn = h('button', { type: 'button', ...(attrs ?? {}) }, ...children);
  keepHostSelection(btn);
  return btn;
}
