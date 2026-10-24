/**
 * The accept-all menu anchored above the floating button (one per overlay).
 *
 * Live counts come from the controller's setStatus: "Accept all grammar (n)", "Accept all style and tone (n)",
 * "Accept everything (n)" (with "k rewrites need your choice"), Undo last, Open review panel, Check now, Check here
 * anyway (opt-out hosts), Turn off on <host>, Turn off this field. Hovering an accept-all item shows a preview of up
 * to 8 "original → replacement" rows with category dots.
 */
import type { AcceptAllCounts, UnderlineItem } from './overlay-api';
import type { AcceptAllScope, Suggestion } from '@jammarly/shared/types';
import { categoryDot, focusableWithin, h, isolatePointerEvents, keepHostSelection, setChildren, svgIcon } from './dom';
import type { RectLike } from './underlines';

export const PREVIEW_ROWS = 8;
export const MENU_GAP = 8;
export const MENU_PAD = 8;

export interface PreviewRow {
  category: Suggestion['category'];
  original: string;
  replacement: string;
  kind: Suggestion['kind'];
}

export interface MenuContext {
  fieldId: string;
  host: string;
  counts: AcceptAllCounts;
  /** Transaction id of the last apply, when the controller reported one through toast(); enables "Undo last". */
  undoTransactionId: string | null;
  /** The field is unsupported because the site opted out: offer "Check here anyway". */
  showCheckHereAnyway: boolean;
  /** Current suggestions, for the hover preview (tier A -> grammar, tier B -> style). */
  items: UnderlineItem[];
}

export interface MenuCallbacks {
  onAcceptAll(scope: AcceptAllScope): void;
  onUndo(transactionId: string): void;
  onOpenPanel(): void;
  onRecheck(): void;
  onCheckHereAnyway(): void;
  onToggleHost(): void;
  onToggleField(): void;
  onClose(): void;
}

export type MenuAction =
  | 'accept-grammar'
  | 'accept-style'
  | 'accept-all'
  | 'undo'
  | 'open-panel'
  | 'recheck'
  | 'check-here-anyway'
  | 'toggle-host'
  | 'toggle-field';

/** Rows shown in the preview for an accept-all group. */
export function previewRowsFor(items: UnderlineItem[], group: AcceptAllScope['group']): PreviewRow[] {
  const tiers = group === 'grammar' ? ['A'] : group === 'style' ? ['B'] : ['A', 'B'];
  return items
    .map((i) => i.suggestion)
    .filter((s) => tiers.includes(s.tier))
    .sort((a, b) => a.range.start - b.range.start)
    .map((s) => ({ category: s.category, original: s.original, replacement: s.replacement, kind: s.kind }));
}

/** Place a box above an anchor (right-aligned), flipping below when there is no room; clamp ±8 px. */
export function placeAbove(anchor: RectLike, size: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number; placement: 'above' | 'below' } {
  let placement: 'above' | 'below' = 'above';
  let top = anchor.top - MENU_GAP - size.height;
  if (top < MENU_PAD) {
    placement = 'below';
    top = anchor.bottom + MENU_GAP;
  }
  top = Math.max(MENU_PAD, Math.min(top, viewport.height - size.height - MENU_PAD));
  let left = anchor.right - size.width;
  left = Math.max(MENU_PAD, Math.min(left, viewport.width - size.width - MENU_PAD));
  return { top, left, placement };
}

export function supportsPopoverApi(): boolean {
  return typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype && typeof (HTMLElement.prototype as unknown as { showPopover?: unknown }).showPopover === 'function';
}

export class AcceptMenu {
  readonly element: HTMLDivElement;
  private readonly preview: HTMLDivElement;
  private readonly popover: boolean;
  private ctx: MenuContext | null = null;
  private cb: MenuCallbacks | null = null;
  private anchor: RectLike | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly root: ShadowRoot,
    parent: HTMLElement,
  ) {
    this.popover = supportsPopoverApi();
    this.element = h('div', { class: 'jm-menu', 'data-jm': 'menu', role: 'menu', 'aria-label': 'Jammarly', tabindex: '-1', 'data-open': 'false' });
    if (this.popover) this.element.setAttribute('popover', 'manual');
    else this.element.setAttribute('hidden', '');
    this.preview = h('div', { class: 'jm-preview', 'data-jm': 'menu-preview', hidden: true, 'aria-hidden': 'true' });
    isolatePointerEvents(this.element);
    this.element.addEventListener('keydown', (ev) => this.onKeydown(ev));
    this.element.addEventListener('pointerleave', () => this.hidePreview());
    parent.appendChild(this.element);
  }

  isOpen(): boolean {
    return this.ctx !== null;
  }

  currentFieldId(): string | null {
    return this.ctx?.fieldId ?? null;
  }

  open(anchor: RectLike, ctx: MenuContext, cb: MenuCallbacks, returnFocus: HTMLElement | null = null): void {
    this.ctx = ctx;
    this.cb = cb;
    this.anchor = anchor;
    this.returnFocus = returnFocus;
    this.render();
    this.element.dataset.open = 'true';
    this.element.dataset.fieldId = ctx.fieldId;
    this.element.removeAttribute('hidden');
    if (this.popover) {
      try {
        if (!this.element.matches(':popover-open')) this.element.showPopover();
      } catch {
        /* not connected or already open */
      }
    }
    this.reposition();
    const first = focusableWithin(this.element)[0];
    (first ?? this.element).focus({ preventScroll: true });
  }

  /** Re-render with fresh counts/items while open. */
  refresh(ctx: Partial<MenuContext>): void {
    if (!this.ctx) return;
    this.ctx = { ...this.ctx, ...ctx };
    const focused = this.root.activeElement as HTMLElement | null;
    const action = focused?.dataset.action;
    this.render();
    if (action) this.element.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
    this.reposition();
  }

  close(): void {
    if (!this.ctx) return;
    const hadFocus = !!this.root.activeElement && this.element.contains(this.root.activeElement);
    this.ctx = null;
    this.cb = null;
    this.hidePreview();
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
    if (hadFocus && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  reposition(anchor?: RectLike): void {
    if (!this.ctx) return;
    if (anchor) this.anchor = anchor;
    if (!this.anchor) return;
    const r = this.element.getBoundingClientRect();
    const size = { width: r.width > 0 ? r.width : 280, height: r.height > 0 ? r.height : 320 };
    const viewport = { width: window.innerWidth || 1024, height: window.innerHeight || 768 };
    const pos = placeAbove(this.anchor, size, viewport);
    this.element.style.left = `${Math.round(pos.left)}px`;
    this.element.style.top = `${Math.round(pos.top)}px`;
    this.element.dataset.placement = pos.placement;
    // Preview opens on the side with more room.
    this.preview.dataset.side = pos.left > viewport.width / 2 ? 'left' : 'right';
  }

  dispose(): void {
    this.close();
    this.element.remove();
  }

  // ---------------------------------------------------------------------- rendering

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { counts } = ctx;
    const everything = counts.grammar + counts.style;
    const items: HTMLElement[] = [];

    items.push(
      h(
        'div',
        { class: 'jm-menu-head', 'data-jm': 'menu-head' },
        h('span', { class: 'jm-brand-dot', 'aria-hidden': 'true' }),
        everything === 0 && counts.rewrites === 0 ? 'Jammarly · no suggestions yet' : `Jammarly · ${everything + counts.rewrites} suggestion${everything + counts.rewrites === 1 ? '' : 's'}`,
      ),
    );

    items.push(this.item('accept-grammar', `Accept all grammar (${counts.grammar})`, { disabled: counts.grammar === 0, preview: 'grammar' }));
    items.push(this.item('accept-style', `Accept all style and tone (${counts.style})`, { disabled: counts.style === 0, preview: 'style' }));
    items.push(
      this.item('accept-all', `Accept everything (${everything})`, {
        disabled: everything === 0,
        preview: 'all',
        sub: counts.rewrites > 0 ? `${counts.rewrites} rewrite${counts.rewrites === 1 ? '' : 's'} need${counts.rewrites === 1 ? 's' : ''} your choice` : undefined,
      }),
    );
    if (ctx.undoTransactionId) items.push(this.item('undo', 'Undo last', { icon: 'undo' }));
    items.push(h('div', { class: 'jm-mi-sep', role: 'separator' }));
    items.push(this.item('open-panel', 'Open review panel'));
    items.push(this.item('recheck', 'Check now'));
    if (ctx.showCheckHereAnyway) items.push(this.item('check-here-anyway', 'Check here anyway'));
    items.push(h('div', { class: 'jm-mi-sep', role: 'separator' }));
    items.push(this.item('toggle-host', `Turn off on ${ctx.host || 'this site'}`, { icon: 'power' }));
    items.push(this.item('toggle-field', 'Turn off this field', { icon: 'power' }));

    setChildren(this.element, items, this.preview);
    this.hidePreview();
  }

  private item(action: MenuAction, label: string, opts: { disabled?: boolean; sub?: string; preview?: AcceptAllScope['group']; icon?: 'undo' | 'power' } = {}): HTMLButtonElement {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'jm-mi',
        role: 'menuitem',
        'data-jm': 'menu-item',
        'data-action': action,
        disabled: opts.disabled === true,
        'aria-disabled': opts.disabled ? 'true' : null,
        onclick: () => {
          if (opts.disabled) return;
          this.activate(action);
        },
      },
      opts.icon ? svgIcon(opts.icon, 14) : null,
      h('span', { class: 'jm-mi-label' }, label),
      opts.sub ? ' ' : null,
      opts.sub ? h('span', { class: 'jm-mi-sub', 'data-jm': 'menu-sub' }, `(${opts.sub})`) : null,
    );
    keepHostSelection(btn);
    if (opts.preview) {
      const group = opts.preview;
      const show = () => {
        if (!opts.disabled) this.showPreview(group);
        else this.hidePreview();
      };
      btn.addEventListener('pointerenter', show);
      btn.addEventListener('focus', show);
    } else {
      btn.addEventListener('pointerenter', () => this.hidePreview());
      btn.addEventListener('focus', () => this.hidePreview());
    }
    return btn;
  }

  private showPreview(group: AcceptAllScope['group']): void {
    if (!this.ctx) return;
    const rows = previewRowsFor(this.ctx.items, group);
    const title = group === 'grammar' ? 'Grammar fixes' : group === 'style' ? 'Style and tone' : 'Everything';
    setChildren(
      this.preview,
      h('p', { class: 'jm-preview-title' }, `${title} · ${rows.length}`),
      rows.slice(0, PREVIEW_ROWS).map((r) =>
        h(
          'div',
          { class: 'jm-preview-row', 'data-jm': 'preview-row' },
          categoryDot(r.category),
          r.original ? h('s', { class: 'jm-original' }, r.original) : null,
          r.original ? ' ' : null,
          r.original ? h('span', { class: 'jm-arrow', 'aria-hidden': 'true' }, '→') : null,
          r.original ? ' ' : null,
          h('span', { class: 'jm-new' }, r.kind === 'delete' ? 'Remove' : r.replacement),
        ),
      ),
      rows.length > PREVIEW_ROWS ? h('div', { class: 'jm-preview-more' }, `+${rows.length - PREVIEW_ROWS} more`) : null,
    );
    this.preview.dataset.group = group;
    this.preview.hidden = rows.length === 0;
  }

  private hidePreview(): void {
    this.preview.hidden = true;
  }

  private activate(action: MenuAction): void {
    const cb = this.cb;
    const ctx = this.ctx;
    if (!cb || !ctx) return;
    this.close();
    switch (action) {
      case 'accept-grammar':
        cb.onAcceptAll({ group: 'grammar' });
        break;
      case 'accept-style':
        cb.onAcceptAll({ group: 'style' });
        break;
      case 'accept-all':
        cb.onAcceptAll({ group: 'all' });
        break;
      case 'undo':
        if (ctx.undoTransactionId) cb.onUndo(ctx.undoTransactionId);
        break;
      case 'open-panel':
        cb.onOpenPanel();
        break;
      case 'recheck':
        cb.onRecheck();
        break;
      case 'check-here-anyway':
        cb.onCheckHereAnyway();
        break;
      case 'toggle-host':
        cb.onToggleHost();
        break;
      case 'toggle-field':
        cb.onToggleField();
        break;
    }
    cb.onClose();
  }

  private onKeydown(ev: KeyboardEvent): void {
    if (!this.ctx) return;
    let handled = false;
    const items = focusableWithin(this.element);
    const active = this.root.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus({ preventScroll: true });
    switch (ev.key) {
      case 'Escape':
        this.close();
        this.cb?.onClose();
        handled = true;
        break;
      case 'ArrowDown':
        focusAt(idx + 1);
        handled = true;
        break;
      case 'ArrowUp':
        focusAt(idx - 1);
        handled = true;
        break;
      case 'Home':
        focusAt(0);
        handled = true;
        break;
      case 'End':
        focusAt(items.length - 1);
        handled = true;
        break;
      case 'Tab':
        focusAt(idx + (ev.shiftKey ? -1 : 1));
        handled = true;
        break;
    }
    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }
}
