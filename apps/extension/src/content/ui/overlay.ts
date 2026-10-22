/**
 * Overlay host + registry: implements `CreateOverlay` from ./overlay-api.
 *
 * One <jammarly-root data-jammarly-shadow-root> per document, appended to <html> with an open shadow root,
 * `position: fixed; inset: 0; pointer-events: none; z-index: 2147483646`. Everything the user can touch (card, menu,
 * button, toasts) opts back in with `pointer-events: auto` and stops pointerdown/mousedown/click so host dialogs do
 * not treat our clicks as outside clicks.
 *
 * Hit testing: because the host takes no pointer events, a throttled capture-phase `pointermove` listener on the
 * document tests the pointer against the underline fragment rects. 100 ms hover intent opens the card, 250 ms grace
 * on leave closes it, a click on a fragment opens it immediately. One card and one menu exist per overlay.
 */
import type { CheckError, CheckPass, DismissReason, FieldStatus, Suggestion, ToneAnalysis } from '@jammarly/shared/types';
import type { FieldAdapter } from '../field-adapter';
import type { AcceptAllCounts, CreateOverlay, FieldOverlay, Overlay, OverlayEvents, OverlayOptions, UnderlineItem } from './overlay-api';
import { FloatingButton } from './button';
import { SuggestionCard } from './card';
import { h } from './dom';
import { AcceptMenu, type MenuContext } from './menu';
import { applyStyles, type StyleMode } from './styles';
import { ToastStack } from './toast';
import { UnderlineLayer, toRectLike, type RectLike } from './underlines';

export const HOST_TAG = 'jammarly-root';
export const HOST_ATTR = 'data-jammarly-shadow-root';
export const HOVER_INTENT_MS = 100;
export const LEAVE_GRACE_MS = 250;

export const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
  theme: { colorblindMode: false },
  shortcutSafe: false,
  showFloatingButton: true,
  showUnderlines: true,
};

/** The setUnsupported reason the controller passes when a site opted out (any phrasing containing "opt"). */
export function isOptOutReason(reason: string): boolean {
  return /\bopt(?:ed|s)?[-\s]?out\b|disabled by (?:the|this) site/i.test(reason);
}

export interface OverlayDebugInfo {
  hostCount: number;
  styleMode: StyleMode;
  fields: number;
  underlines: number;
  visibleUnderlines: number;
  cardOpen: boolean;
  cardSuggestionId: string | null;
  menuOpen: boolean;
  toasts: number;
  pointerInside: boolean;
  hoverSuggestionId: string | null;
  introSeen: boolean;
  colorblind: boolean;
}

let live: OverlayImpl | null = null;

export const createOverlay: CreateOverlay = (events) => {
  if (live) live.dispose();
  const overlay = new OverlayImpl(events);
  live = overlay;
  return overlay;
};

/** Build the host element (exported for tests). */
export function createHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(HOST_TAG);
  host.setAttribute(HOST_ATTR, '');
  host.setAttribute('aria-hidden', 'false');
  for (const [prop, value] of [
    ['position', 'fixed'],
    ['inset', '0'],
    ['pointer-events', 'none'],
    ['z-index', '2147483646'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
  ] as const) {
    host.style.setProperty(prop, value, 'important');
  }
  const root = host.attachShadow({ mode: 'open' });
  return { host, root };
}

interface FieldRecord {
  fieldId: string;
  adapter: FieldAdapter;
  opts: OverlayOptions;
  layer: UnderlineLayer;
  button: FloatingButton;
  items: UnderlineItem[];
  byId: Map<string, UnderlineItem>;
  counts: AcceptAllCounts;
  status: FieldStatus;
  checkedBy: CheckPass;
  error: CheckError | undefined;
  lastUndoTransactionId: string | null;
  unsupportedReason: string;
  optedOut: boolean;
  box: RectLike | null;
  api: FieldOverlay;
}

class OverlayImpl implements Overlay {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly styleMode: StyleMode;
  private readonly underlineLayer: HTMLDivElement;
  private readonly buttonLayer: HTMLDivElement;
  private readonly popupLayer: HTMLDivElement;
  private readonly card: SuggestionCard;
  private readonly menu: AcceptMenu;
  private readonly toasts: ToastStack;
  private readonly fields = new Map<string, FieldRecord>();
  private options: OverlayOptions = { ...DEFAULT_OVERLAY_OPTIONS, theme: { ...DEFAULT_OVERLAY_OPTIONS.theme } };
  private introSeen = false;
  private pointerInside = false;
  private hover: { fieldId: string; suggestionId: string } | null = null;
  private intentTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPointer = { x: 0, y: 0 };
  private frameScheduled = false;
  private pointerDirty = false;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly events: OverlayEvents) {
    // Single instance per document: remove stale hosts (an orphaned instance that did not tear down).
    for (const stale of Array.from(document.querySelectorAll(HOST_TAG))) stale.remove();
    const { host, root } = createHost();
    this.host = host;
    this.root = root;
    this.styleMode = applyStyles(root);
    this.underlineLayer = h('div', { class: 'jm-layer jm-layer-underlines', 'data-jm': 'layer-underlines' });
    this.buttonLayer = h('div', { class: 'jm-layer jm-layer-buttons', 'data-jm': 'layer-buttons' });
    this.popupLayer = h('div', { class: 'jm-layer jm-layer-popups', 'data-jm': 'layer-popups' });
    root.append(this.underlineLayer, this.buttonLayer, this.popupLayer);
    this.toasts = new ToastStack(this.popupLayer);
    this.menu = new AcceptMenu(root, this.popupLayer);
    this.card = new SuggestionCard(root, this.popupLayer, {
      onAccept: (fieldId, suggestionId, alternativeIndex) => {
        this.introSeen = true;
        this.closeCard();
        this.events.onAccept(fieldId, suggestionId, alternativeIndex);
      },
      onDismiss: (fieldId, suggestionId, reason?: DismissReason) => {
        this.introSeen = true;
        this.closeCard();
        this.events.onDismiss(fieldId, suggestionId, reason);
      },
      onAddToDictionary: (fieldId, word) => {
        this.introSeen = true;
        this.closeCard();
        this.events.onAddToDictionary(fieldId, word);
      },
      onMuteRule: (fieldId, rule, scope) => {
        this.closeCard();
        this.events.onMuteRule(fieldId, rule, scope);
      },
      onReportIncorrect: (fieldId, suggestionId) => {
        this.closeCard();
        this.events.onReportIncorrect(fieldId, suggestionId);
        this.toasts.show('Reported. Thanks for the feedback.', { durationMs: 4000 });
      },
      onRequestClose: () => this.closeCard(),
      onShown: (fieldId, suggestionId) => {
        this.fields.get(fieldId)?.layer.setActive(suggestionId);
        this.events.onCardShown(fieldId, suggestionId);
      },
      onHidden: (fieldId, suggestionId) => {
        const f = this.fields.get(fieldId);
        if (f && this.card.currentTarget()?.suggestionId !== suggestionId) f.layer.setActive(null);
        this.events.onCardHidden(fieldId, suggestionId);
      },
      onPointerEnter: () => {
        this.pointerInside = true;
        this.cancelGrace();
      },
      onPointerLeave: () => {
        this.pointerInside = false;
        if (this.card.isOpen() && !this.card.hasFocus()) this.startGrace();
      },
    });

    const parent = document.documentElement ?? document.body;
    if (!parent) throw new Error('Jammarly overlay: document has no root element');
    parent.appendChild(host);

    this.listen(document, 'pointermove', (ev) => this.onPointerMove(ev as PointerEvent), { capture: true, passive: true });
    this.listen(document, 'pointerdown', (ev) => this.onPointerDown(ev as PointerEvent), { capture: true, passive: true });
    this.listen(document, 'click', (ev) => this.onDocumentClick(ev as MouseEvent), { capture: true, passive: true });
    this.listen(document, 'keydown', (ev) => this.onDocumentKeydown(ev as KeyboardEvent), { capture: true });
    this.listen(root, 'pointerover', () => {
      this.pointerInside = true;
    });
    this.listen(root, 'pointerout', (ev) => {
      const related = (ev as PointerEvent).relatedTarget as Node | null;
      if (!related || !this.root.contains(related)) this.pointerInside = false;
    });
    this.listen(window, 'resize', () => this.realign());
    const vv = (window as unknown as { visualViewport?: EventTarget | null }).visualViewport;
    if (vv) {
      this.listen(vv, 'resize', () => this.realign());
      this.listen(vv, 'scroll', () => this.realign());
    }

    (this as unknown as { __debug: () => OverlayDebugInfo }).__debug = () => this.debug();
  }

  // ---------------------------------------------------------------------- Overlay API

  attach(fieldId: string, adapter: FieldAdapter, opts: OverlayOptions): FieldOverlay {
    const existing = this.fields.get(fieldId);
    if (existing) {
      existing.opts = cloneOptions(opts);
      this.applyTheme(opts);
      this.applyFieldOptions(existing);
      return existing.api;
    }
    this.options = cloneOptions(opts);
    this.applyTheme(opts);
    const layer = new UnderlineLayer(this.underlineLayer, fieldId);
    const button = new FloatingButton(this.buttonLayer, fieldId, {
      onClick: () => this.toggleMenu(fieldId),
      onOpenSetup: () => this.events.onOpenSetup(fieldId),
      onToggleField: (duration) => this.events.onToggleField(fieldId, false, duration),
    });
    const record: FieldRecord = {
      fieldId,
      adapter,
      opts: cloneOptions(opts),
      layer,
      button,
      items: [],
      byId: new Map(),
      counts: { grammar: 0, style: 0, rewrites: 0 },
      status: 'idle',
      checkedBy: 'rules',
      error: undefined,
      lastUndoTransactionId: null,
      unsupportedReason: '',
      optedOut: false,
      box: null,
      api: null as unknown as FieldOverlay,
    };
    record.api = this.makeFieldApi(record);
    this.fields.set(fieldId, record);
    this.applyFieldOptions(record);
    try {
      const box = adapter.getBox();
      if (box) record.api.setFieldBox(box);
    } catch {
      /* adapters without layout (tests) */
    }
    return record.api;
  }

  detach(fieldId: string): void {
    const f = this.fields.get(fieldId);
    if (!f) return;
    this.fields.delete(fieldId);
    if (this.card.currentTarget()?.fieldId === fieldId) this.closeCard();
    if (this.menu.currentFieldId() === fieldId) this.menu.close();
    if (this.hover?.fieldId === fieldId) this.clearHover();
    f.layer.dispose();
    f.button.dispose();
  }

  setOptions(opts: Partial<OverlayOptions>): void {
    this.options = mergeOptions(this.options, opts);
    this.applyTheme(this.options);
    for (const f of this.fields.values()) {
      f.opts = mergeOptions(f.opts, opts);
      this.applyFieldOptions(f);
    }
    const target = this.card.currentTarget();
    if (target) {
      const f = this.fields.get(target.fieldId);
      const item = f?.byId.get(target.suggestionId);
      if (f && item) this.showCard(f, item, undefined, false);
    }
  }

  isInteracting(): boolean {
    if (this.pointerInside) return true;
    const active = this.root.activeElement;
    return active !== null && active !== undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIntent();
    this.cancelGrace();
    for (const id of Array.from(this.fields.keys())) this.detach(id);
    this.card.dispose();
    this.menu.dispose();
    this.toasts.dispose();
    for (const c of this.cleanups.splice(0)) c();
    this.host.remove();
    if (live === this) live = null;
  }

  // ---------------------------------------------------------------------- field API

  private makeFieldApi(f: FieldRecord): FieldOverlay {
    const overlay = this;
    const api: FieldOverlay = {
      fieldId: f.fieldId,
      setUnderlines(items) {
        overlay.applyItems(f, items);
      },
      updateRects(items) {
        overlay.applyItems(f, items);
      },
      setStatus(status, counts, checkedBy, error) {
        f.status = status;
        f.counts = counts;
        f.checkedBy = checkedBy;
        f.error = error;
        f.button.setStatus(status, counts, checkedBy, error);
        if (status === 'unsupported' && f.unsupportedReason) f.button.setUnsupported(f.unsupportedReason);
        if (overlay.menu.currentFieldId() === f.fieldId) overlay.menu.refresh(overlay.menuContext(f));
      },
      setTone(tone, charCount) {
        f.button.setTone(tone, charCount);
      },
      setFieldBox(box) {
        f.box = toRectLike(box);
        f.button.setFieldBox(f.box);
        if (overlay.menu.currentFieldId() === f.fieldId) overlay.menu.reposition(f.button.anchorRect());
      },
      setTyping(typing) {
        f.button.setTyping(typing);
        if (typing && overlay.card.currentTarget()?.fieldId === f.fieldId) overlay.closeCard();
      },
      openCard(suggestionId, anchorRect) {
        const item = f.byId.get(suggestionId);
        if (!item) return;
        overlay.showCard(f, item, toRectLike(anchorRect), false);
      },
      closeCard() {
        if (overlay.card.currentTarget()?.fieldId === f.fieldId) overlay.closeCard();
      },
      focusSuggestion(suggestionId) {
        const item = f.byId.get(suggestionId);
        if (!item) return;
        overlay.showCard(f, item, undefined, true);
      },
      openMenu() {
        overlay.openMenu(f);
      },
      closeMenu() {
        if (overlay.menu.currentFieldId() === f.fieldId) overlay.menu.close();
      },
      toast(message, options) {
        const tx = options?.undoTransactionId;
        if (tx) f.lastUndoTransactionId = tx;
        overlay.toasts.show(message, {
          durationMs: options?.durationMs,
          onUndo: tx ? () => overlay.events.onUndo(f.fieldId, tx) : undefined,
        });
        if (overlay.menu.currentFieldId() === f.fieldId) overlay.menu.refresh(overlay.menuContext(f));
      },
      setUnsupported(reason) {
        f.unsupportedReason = reason;
        f.optedOut = isOptOutReason(reason);
        f.status = 'unsupported';
        f.button.setUnsupported(reason);
      },
      dispose() {
        overlay.detach(f.fieldId);
      },
    };
    return api;
  }

  private applyItems(f: FieldRecord, items: UnderlineItem[]): void {
    f.items = items;
    f.byId = new Map(items.map((i) => [i.suggestion.id, i]));
    f.layer.updateRects(f.opts.showUnderlines ? items : []);
    const target = this.card.currentTarget();
    if (target && target.fieldId === f.fieldId) {
      const item = f.byId.get(target.suggestionId);
      if (!item) this.closeCard();
      else this.showCard(f, item, firstRect(item) ?? undefined, false);
    }
    if (this.hover && this.hover.fieldId === f.fieldId && !f.byId.has(this.hover.suggestionId)) this.clearHover();
    if (this.menu.currentFieldId() === f.fieldId) this.menu.refresh({ items });
  }

  private applyFieldOptions(f: FieldRecord): void {
    f.button.setShown(f.opts.showFloatingButton);
    f.layer.updateRects(f.opts.showUnderlines ? f.items : []);
  }

  private applyTheme(opts: OverlayOptions | Partial<OverlayOptions>): void {
    const colorblind = opts.theme?.colorblindMode ?? this.options.theme.colorblindMode;
    this.options.theme.colorblindMode = colorblind;
    this.host.classList.toggle('jm-colorblind', colorblind);
    this.host.dataset.colorblind = String(colorblind);
  }

  // ---------------------------------------------------------------------- card

  private showCard(f: FieldRecord, item: UnderlineItem, anchor: RectLike | undefined, focus: boolean): void {
    const rect = anchor ?? firstRect(item) ?? f.box ?? { left: 8, top: 8, right: 8, bottom: 8, width: 0, height: 0 };
    this.clearIntent();
    this.cancelGrace();
    if (this.menu.isOpen()) this.menu.close();
    this.card.show({
      fieldId: f.fieldId,
      suggestion: item.suggestion,
      anchor: rect,
      shortcutSafe: f.opts.shortcutSafe,
      showIntro: !this.introSeen,
      focus,
    });
  }

  private closeCard(): void {
    this.clearIntent();
    this.cancelGrace();
    this.card.hide();
  }

  // ---------------------------------------------------------------------- menu

  private menuContext(f: FieldRecord): MenuContext {
    return {
      fieldId: f.fieldId,
      host: typeof location !== 'undefined' ? location.hostname : '',
      counts: f.counts,
      undoTransactionId: f.lastUndoTransactionId,
      showCheckHereAnyway: f.status === 'unsupported' && f.optedOut,
      items: f.items,
    };
  }

  private openMenu(f: FieldRecord): void {
    this.closeCard();
    f.button.closePowerMenu();
    this.menu.open(
      f.button.anchorRect(),
      this.menuContext(f),
      {
        onAcceptAll: (scope) => this.events.onAcceptAll(f.fieldId, scope),
        onUndo: (tx) => this.events.onUndo(f.fieldId, tx),
        onOpenPanel: () => this.events.onOpenPanel(f.fieldId),
        onRecheck: () => this.events.onRecheck(f.fieldId),
        onCheckHereAnyway: () => this.events.onCheckHereAnyway(f.fieldId),
        onToggleHost: () => this.events.onToggleHost(false),
        onToggleField: () => this.events.onToggleField(f.fieldId, false, 'session'),
        onClose: () => {
          /* nothing to do */
        },
      },
      f.button.button,
    );
  }

  private toggleMenu(fieldId: string): void {
    const f = this.fields.get(fieldId);
    if (!f) return;
    if (this.menu.currentFieldId() === fieldId) this.menu.close();
    else this.openMenu(f);
  }

  // ---------------------------------------------------------------------- pointer handling

  private isInsideOverlay(ev: Event): boolean {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    return path.includes(this.host);
  }

  private onPointerMove(ev: PointerEvent): void {
    if (this.disposed) return;
    if (this.isInsideOverlay(ev)) {
      this.pointerInside = true;
      this.cancelGrace();
      return;
    }
    this.pointerInside = false;
    this.lastPointer = { x: ev.clientX, y: ev.clientY };
    if (this.frameScheduled) {
      this.pointerDirty = true;
      return;
    }
    this.processPointer();
    this.frameScheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
    raf(() => {
      this.frameScheduled = false;
      if (this.pointerDirty) {
        this.pointerDirty = false;
        this.processPointer();
      }
    });
  }

  private findHit(x: number, y: number): { field: FieldRecord; suggestionId: string; rect: RectLike } | null {
    for (const f of this.fields.values()) {
      const hit = f.layer.hitTestFragment(x, y);
      if (hit) return { field: f, suggestionId: hit.suggestionId, rect: hit.rect };
    }
    return null;
  }

  private processPointer(): void {
    if (this.disposed) return;
    const { x, y } = this.lastPointer;
    const hit = this.findHit(x, y);
    if (hit) {
      const same = this.hover && this.hover.fieldId === hit.field.fieldId && this.hover.suggestionId === hit.suggestionId;
      if (!same) {
        this.clearHover();
        this.hover = { fieldId: hit.field.fieldId, suggestionId: hit.suggestionId };
        hit.field.layer.setHover(hit.suggestionId);
        const target = this.card.currentTarget();
        const alreadyOpen = target && target.fieldId === hit.field.fieldId && target.suggestionId === hit.suggestionId;
        if (!alreadyOpen) {
          const { field, suggestionId, rect } = hit;
          this.intentTimer = setTimeout(() => {
            this.intentTimer = null;
            const item = field.byId.get(suggestionId);
            if (item && this.fields.has(field.fieldId)) this.showCard(field, item, rect, false);
          }, HOVER_INTENT_MS);
        }
      }
      this.cancelGrace();
      return;
    }
    if (this.hover) this.clearHover();
    if (this.card.isOpen() && !this.card.hasFocus() && !this.pointerInside) this.startGrace();
  }

  private onPointerDown(ev: PointerEvent): void {
    if (this.disposed || this.isInsideOverlay(ev)) return;
    for (const f of this.fields.values()) f.button.closePowerMenu();
    const hit = this.findHit(ev.clientX, ev.clientY);
    if (hit) {
      const item = hit.field.byId.get(hit.suggestionId);
      if (item) {
        this.showCard(hit.field, item, hit.rect, false);
        return;
      }
    }
    // Click outside: close the card and the menu.
    this.closeCard();
    if (this.menu.isOpen()) this.menu.close();
  }

  private onDocumentClick(ev: MouseEvent): void {
    if (this.disposed || this.isInsideOverlay(ev)) return;
    const hit = this.findHit(ev.clientX, ev.clientY);
    if (!hit) return;
    const item = hit.field.byId.get(hit.suggestionId);
    if (item) this.showCard(hit.field, item, hit.rect, false);
  }

  private onDocumentKeydown(ev: KeyboardEvent): void {
    if (this.disposed || ev.key !== 'Escape' || this.isInsideOverlay(ev)) return;
    // Esc typed in the page closes our popups without claiming the key.
    if (this.card.isOpen()) this.closeCard();
    if (this.menu.isOpen()) this.menu.close();
  }

  private clearHover(): void {
    if (!this.hover) return;
    this.fields.get(this.hover.fieldId)?.layer.setHover(null);
    this.hover = null;
    this.clearIntent();
  }

  private clearIntent(): void {
    if (this.intentTimer) {
      clearTimeout(this.intentTimer);
      this.intentTimer = null;
    }
  }

  private startGrace(): void {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.card.isOpen() || this.card.hasFocus() || this.pointerInside) return;
      const target = this.card.currentTarget();
      if (target && this.hover && this.hover.suggestionId === target.suggestionId && this.hover.fieldId === target.fieldId) return;
      this.closeCard();
    }, LEAVE_GRACE_MS);
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  // ---------------------------------------------------------------------- layout

  private realign(): void {
    if (this.disposed) return;
    for (const f of this.fields.values()) f.button.reposition();
    const target = this.card.currentTarget();
    if (target) {
      const f = this.fields.get(target.fieldId);
      const item = f?.byId.get(target.suggestionId);
      const rect = item ? firstRect(item) : null;
      this.card.reposition(rect ?? undefined);
    }
    const menuField = this.menu.currentFieldId();
    if (menuField) {
      const f = this.fields.get(menuField);
      if (f) this.menu.reposition(f.button.anchorRect());
    }
  }

  private listen(target: EventTarget, type: string, handler: (ev: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  private debug(): OverlayDebugInfo {
    let underlines = 0;
    let visible = 0;
    for (const f of this.fields.values()) {
      underlines += f.layer.count();
      visible += f.layer.visibleCount();
    }
    return {
      hostCount: document.querySelectorAll(HOST_TAG).length,
      styleMode: this.styleMode,
      fields: this.fields.size,
      underlines,
      visibleUnderlines: visible,
      cardOpen: this.card.isOpen(),
      cardSuggestionId: this.card.currentTarget()?.suggestionId ?? null,
      menuOpen: this.menu.isOpen(),
      toasts: this.toasts.count(),
      pointerInside: this.pointerInside,
      hoverSuggestionId: this.hover?.suggestionId ?? null,
      introSeen: this.introSeen,
      colorblind: this.options.theme.colorblindMode,
    };
  }
}

function firstRect(item: UnderlineItem): RectLike | null {
  const r = item.rects[0];
  return r ? toRectLike(r) : null;
}

function cloneOptions(o: OverlayOptions): OverlayOptions {
  return { ...o, theme: { ...o.theme } };
}

function mergeOptions(base: OverlayOptions, patch: Partial<OverlayOptions>): OverlayOptions {
  return {
    ...base,
    ...patch,
    theme: { ...base.theme, ...(patch.theme ?? {}) },
  };
}

export type { Suggestion, ToneAnalysis };
