/**
 * The floating button (one per field): a 28 px disc at the field's bottom-right inner corner (inset 8 px), or just
 * outside the corner for fields under 40 px tall (24 px chat prompt boxes are first-class). It follows setFieldBox,
 * hides only when the field is off-screen, collapses to a 6 px dot while typing (expands 600 ms after typing stops),
 * shows a tone chip beside it from 150 characters, and reveals a power button on hover.
 *
 * States: setup · idle · checking · count · clean · collapsed · off · error (glyph + tooltip by CheckError code) ·
 * unsupported.
 */
import type { AcceptAllCounts } from './overlay-api';
import type { CheckError, CheckErrorCode, CheckPass, FieldStatus, ToneAnalysis } from '@jammarly/shared/types';
import { TONE_EMOJI, TONE_EMOJI_FALLBACK } from '@jammarly/shared/types';
import { h, isolatePointerEvents, keepHostSelection, setChildren, svgIcon, type IconName } from './dom';
import { placeAbove } from './menu';
import { isRectVisible, type RectLike, type Viewport } from './underlines';

export const BUTTON_SIZE = 28;
export const BUTTON_INSET = 8;
export const COLLAPSED_SIZE = 6;
/** Fields at least this tall get the button inside their bottom-right corner; shorter fields get it outside. */
export const INSIDE_MIN_HEIGHT = 40;
export const OUTSIDE_GAP = 4;
export const EXPAND_DELAY_MS = 600;
export const TONE_MIN_CHARS = 150;
export const COUNT_CAP = 99;
/** Grammarly's own widget sits in the same corner (about 48 px wide); with Grammarly running, ours moves left of it. */
export const GRAMMARLY_CLEARANCE = 56;

/** True when the Grammarly extension (or its desktop app) has injected into this page. */
export function grammarlyPresent(doc: Document = document): boolean {
  return doc.querySelector('grammarly-extension, grammarly-desktop-integration, grammarly-popups') !== null;
}

export type ButtonVisualState = 'setup' | 'idle' | 'checking' | 'count' | 'clean' | 'collapsed' | 'off' | 'error' | 'unsupported';

export type ButtonAnchor = 'inside' | 'right' | 'below' | 'above';

export interface ButtonPosition {
  left: number;
  top: number;
  anchor: ButtonAnchor;
  /** False when the field is off-screen (the button hides). */
  visible: boolean;
}

export interface ButtonCallbacks {
  /** Click in any state except setup. */
  onClick(): void;
  /** Click in the setup state. */
  onOpenSetup(): void;
  onToggleField(duration: 'session' | 'forever'): void;
}

/** Pure placement: inside the bottom-right corner for fields >= 40 px tall, otherwise just outside it. */
export function computeButtonPosition(box: RectLike, viewport: Viewport, size = BUTTON_SIZE): ButtonPosition {
  const visible = isRectVisible(box, viewport);
  if (box.height >= INSIDE_MIN_HEIGHT) {
    return { left: box.right - BUTTON_INSET - size, top: box.bottom - BUTTON_INSET - size, anchor: 'inside', visible };
  }
  // Small field: to the right of the bottom-right corner when there is room, else below it, else above it.
  const rightLeft = box.right + OUTSIDE_GAP;
  if (rightLeft + size <= viewport.width - OUTSIDE_GAP) {
    return { left: rightLeft, top: box.bottom - size, anchor: 'right', visible };
  }
  const left = Math.min(box.right - size, viewport.width - size - OUTSIDE_GAP);
  if (box.bottom + OUTSIDE_GAP + size <= viewport.height) {
    return { left, top: box.bottom + OUTSIDE_GAP, anchor: 'below', visible };
  }
  return { left, top: box.top - OUTSIDE_GAP - size, anchor: 'above', visible };
}

export function formatCount(n: number): string {
  return n > COUNT_CAP ? `${COUNT_CAP}+` : String(Math.max(0, Math.floor(n)));
}

/** Glyph and tooltip for the error state, by CheckError code. */
export function errorPresentation(error: CheckError | undefined): { icon: IconName; tooltip: string } {
  const code: CheckErrorCode | undefined = error?.code;
  switch (code) {
    case 'auth':
      return { icon: 'key', tooltip: 'Check your API key' };
    case 'no-api-key':
      return { icon: 'key', tooltip: 'Add your API key' };
    case 'consent-required':
      return { icon: 'dot', tooltip: 'Finish setting up Jammarly' };
    case 'rate-limit':
      return { icon: 'hourglass', tooltip: 'Rate limited, retrying' };
    case 'spend-cap':
      return { icon: 'wallet', tooltip: 'Anthropic spend cap reached' };
    case 'budget':
      return { icon: 'wallet', tooltip: 'Daily budget reached, Haiku only until midnight' };
    case 'network':
      return { icon: 'wifi-off', tooltip: 'Offline' };
    default:
      return { icon: 'warning', tooltip: error?.message?.trim() || 'Something went wrong' };
  }
}

/** Emoji + label for the tone chip (TONE_EMOJI[label] ?? fallback). */
export function toneChipText(tone: ToneAnalysis): { emoji: string; label: string } | null {
  const first = tone.labels[0];
  if (!first) return null;
  const label = first.label.trim();
  if (!label) return null;
  const emoji = TONE_EMOJI[label.toLowerCase()] ?? TONE_EMOJI_FALLBACK;
  return { emoji, label: label.charAt(0).toUpperCase() + label.slice(1) };
}

export class FloatingButton {
  readonly wrap: HTMLDivElement;
  readonly button: HTMLButtonElement;
  readonly tone: HTMLSpanElement;
  readonly power: HTMLButtonElement;
  readonly powerMenu: HTMLDivElement;

  private status: FieldStatus = 'idle';
  private counts: AcceptAllCounts = { grammar: 0, style: 0, rewrites: 0 };
  private checkedBy: CheckPass = 'rules';
  private error: CheckError | undefined;
  private unsupportedReason = '';
  private collapsed = false;
  private expandTimer: ReturnType<typeof setTimeout> | null = null;
  private box: RectLike | null = null;
  private position: ButtonPosition | null = null;
  private shown = true;
  private powerMenuOpen = false;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    readonly fieldId: string,
    private readonly cb: ButtonCallbacks,
  ) {
    this.wrap = h('div', { class: 'jm-btn-wrap', 'data-jm': 'button-wrap', 'data-field-id': fieldId });
    this.tone = h('span', { class: 'jm-tone', 'data-jm': 'tone', hidden: true, role: 'status' });
    this.power = h('button', {
      type: 'button',
      class: 'jm-power',
      'data-jm': 'power',
      'aria-label': 'Turn off Jammarly in this field',
      title: 'Turn off in this field',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: () => this.togglePowerMenu(),
    });
    this.power.appendChild(svgIcon('power', 13));
    this.button = h('button', {
      type: 'button',
      class: 'jm-btn',
      'data-jm': 'button',
      'data-state': 'idle',
      'aria-haspopup': 'menu',
      onclick: () => {
        if (this.status === 'setup') this.cb.onOpenSetup();
        else this.cb.onClick();
      },
    });
    this.powerMenu = h('div', { class: 'jm-power-menu', 'data-jm': 'power-menu', role: 'menu', 'aria-label': 'Turn off Jammarly', hidden: true });
    setChildren(
      this.powerMenu,
      this.powerItem('session', 'Turn off in this field until next visit'),
      this.powerItem('forever', 'Turn off in this field forever'),
    );
    this.wrap.append(this.tone, this.power, this.button);
    for (const el of [this.button, this.power, this.tone]) {
      isolatePointerEvents(el);
      keepHostSelection(el);
    }
    isolatePointerEvents(this.powerMenu);
    this.wrap.addEventListener('pointerenter', () => this.wrap.classList.add('jm-hover'));
    this.wrap.addEventListener('pointerleave', () => {
      if (!this.powerMenuOpen) this.wrap.classList.remove('jm-hover');
    });
    this.powerMenu.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        this.closePowerMenu();
        this.power.focus({ preventScroll: true });
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    parent.append(this.wrap, this.powerMenu);
    this.render();
  }

  state(): ButtonVisualState {
    if (this.collapsed) return 'collapsed';
    return this.baseState();
  }

  setStatus(status: FieldStatus, counts: AcceptAllCounts, checkedBy: CheckPass, error?: CheckError): void {
    this.status = status;
    this.counts = counts;
    this.checkedBy = checkedBy;
    this.error = error;
    this.render();
  }

  setUnsupported(reason: string): void {
    this.unsupportedReason = reason;
    this.status = 'unsupported';
    this.render();
  }

  /** Collapse while typing; expand 600 ms after typing stops. */
  setTyping(typing: boolean): void {
    if (this.expandTimer) {
      clearTimeout(this.expandTimer);
      this.expandTimer = null;
    }
    if (typing) {
      if (!this.collapsed) {
        this.collapsed = true;
        this.closePowerMenu();
        this.render();
      }
      return;
    }
    if (!this.collapsed) return;
    this.expandTimer = setTimeout(() => {
      this.expandTimer = null;
      this.collapsed = false;
      this.render();
    }, EXPAND_DELAY_MS);
  }

  setFieldBox(box: RectLike): void {
    this.box = box;
    this.reposition();
  }

  /** Re-apply the last box (viewport resize/zoom). */
  reposition(): void {
    if (!this.box) return;
    const viewport: Viewport = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
    const pos = computeButtonPosition(this.box, viewport);
    // Never hide under Grammarly's corner widget: people run both while comparing them.
    if (pos.anchor === 'inside' && grammarlyPresent()) pos.left = Math.max(this.box.left + BUTTON_INSET, pos.left - GRAMMARLY_CLEARANCE);
    this.position = pos;
    // The wrap grows leftwards from the button (translateX(-100%)), so its right edge is the button's right edge
    // plus the wrap padding.
    this.wrap.style.left = `${Math.round(pos.left + BUTTON_SIZE + 2)}px`;
    this.wrap.style.top = `${Math.round(pos.top - 2)}px`;
    this.wrap.dataset.anchor = pos.anchor;
    this.applyVisibility();
    if (this.powerMenuOpen) this.placePowerMenu();
  }

  setTone(tone: ToneAnalysis | undefined, charCount: number): void {
    const chip = tone && charCount >= TONE_MIN_CHARS ? toneChipText(tone) : null;
    if (!chip) {
      this.tone.hidden = true;
      setChildren(this.tone);
      return;
    }
    setChildren(this.tone, h('span', { class: 'jm-tone-emoji', 'aria-hidden': 'true' }, chip.emoji), ' ', h('span', { class: 'jm-tone-label' }, chip.label));
    this.tone.title = tone?.summary || `Sounds ${chip.label.toLowerCase()}`;
    this.tone.setAttribute('aria-label', `Tone: ${chip.label}`);
    this.tone.hidden = false;
  }

  /** showFloatingButton option. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.applyVisibility();
  }

  /** Viewport rect of the disc (menu anchor). */
  anchorRect(): RectLike {
    const r = this.button.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    const pos = this.position ?? { left: 0, top: 0 };
    return { left: pos.left, top: pos.top, right: pos.left + BUTTON_SIZE, bottom: pos.top + BUTTON_SIZE, width: BUTTON_SIZE, height: BUTTON_SIZE };
  }

  isPowerMenuOpen(): boolean {
    return this.powerMenuOpen;
  }

  closePowerMenu(): void {
    if (!this.powerMenuOpen) return;
    this.powerMenuOpen = false;
    this.powerMenu.hidden = true;
    this.power.setAttribute('aria-expanded', 'false');
    this.wrap.classList.remove('jm-hover');
  }

  dispose(): void {
    this.disposed = true;
    if (this.expandTimer) clearTimeout(this.expandTimer);
    this.expandTimer = null;
    this.wrap.remove();
    this.powerMenu.remove();
  }

  // ---------------------------------------------------------------------- internals

  private baseState(): ButtonVisualState {
    switch (this.status) {
      case 'setup':
        return 'setup';
      case 'checking':
        return 'checking';
      case 'suggestions':
        return 'count';
      case 'clean':
        return 'clean';
      case 'off':
        return 'off';
      case 'error':
        return 'error';
      case 'unsupported':
        return 'unsupported';
      default:
        return 'idle';
    }
  }

  private total(): number {
    return this.counts.grammar + this.counts.style + this.counts.rewrites;
  }

  private render(): void {
    if (this.disposed) return;
    const state = this.state();
    const btn = this.button;
    btn.dataset.state = state;
    btn.dataset.status = this.status;
    btn.dataset.checkedBy = this.checkedBy;
    if (this.error?.code) btn.dataset.errorCode = this.error.code;
    else delete btn.dataset.errorCode;

    let tooltip: string;
    let glyph: Node;
    switch (this.baseState()) {
      case 'setup':
        tooltip = 'Finish setting up Jammarly';
        glyph = svgIcon('dot', 14);
        break;
      case 'checking':
        tooltip = 'Checking…';
        glyph = svgIcon('spinner', 18);
        break;
      case 'count': {
        const n = this.total();
        tooltip = `${n} suggestion${n === 1 ? '' : 's'}`;
        const text = formatCount(n);
        glyph = h('span', { class: `jm-count${text.length > 2 ? ' jm-count-wide' : ''}`, 'data-jm': 'count' }, text);
        break;
      }
      case 'clean':
        tooltip = 'No suggestions';
        glyph = svgIcon('check', 16);
        break;
      case 'off':
        tooltip = 'Jammarly is off here';
        glyph = svgIcon('power', 14);
        break;
      case 'error': {
        const p = errorPresentation(this.error);
        tooltip = p.tooltip;
        glyph = svgIcon(p.icon, 15);
        break;
      }
      case 'unsupported':
        tooltip = this.unsupportedReason || "Jammarly can't check this field";
        glyph = svgIcon('slash', 16);
        break;
      default:
        tooltip = 'Jammarly';
        glyph = svgIcon('j', 16);
    }
    btn.title = tooltip;
    btn.setAttribute('aria-label', state === 'collapsed' ? `${tooltip} (collapsed while typing)` : tooltip);
    // Collapsed: a bare 6 px dot, no glyph.
    if (state === 'collapsed') setChildren(btn);
    else setChildren(btn, glyph);
  }

  private applyVisibility(): void {
    const visible = this.shown && (this.position?.visible ?? false);
    if (visible) this.wrap.removeAttribute('hidden');
    else {
      this.wrap.setAttribute('hidden', '');
      this.closePowerMenu();
    }
  }

  private powerItem(duration: 'session' | 'forever', label: string): HTMLButtonElement {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'jm-mi',
        role: 'menuitem',
        'data-jm': 'power-item',
        'data-duration': duration,
        onclick: () => {
          this.closePowerMenu();
          this.cb.onToggleField(duration);
        },
      },
      svgIcon('power', 14),
      label,
    );
    keepHostSelection(btn);
    return btn;
  }

  private togglePowerMenu(): void {
    if (this.powerMenuOpen) {
      this.closePowerMenu();
      return;
    }
    this.powerMenuOpen = true;
    this.powerMenu.hidden = false;
    this.power.setAttribute('aria-expanded', 'true');
    this.wrap.classList.add('jm-hover');
    this.placePowerMenu();
    const first = this.powerMenu.querySelector<HTMLElement>('button');
    first?.focus({ preventScroll: true });
  }

  private placePowerMenu(): void {
    const anchor = this.anchorRect();
    const r = this.powerMenu.getBoundingClientRect();
    const size = { width: r.width > 0 ? r.width : 240, height: r.height > 0 ? r.height : 80 };
    const pos = placeAbove(anchor, size, { width: window.innerWidth || 1024, height: window.innerHeight || 768 });
    this.powerMenu.style.left = `${Math.round(pos.left)}px`;
    this.powerMenu.style.top = `${Math.round(pos.top)}px`;
  }
}
