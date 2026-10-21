/**
 * Underline layer: one 2 px div per line-fragment rect of a suggestion's highlight range, drawn in viewport
 * coordinates inside the shadow host (pointer-events: none). Hit testing runs against the fragment rects, not the
 * elements, because the host does not take pointer events.
 *
 * - Longer spans render below shorter ones (DOM order + z-index), so a spelling error inside a rewrite stays on top.
 * - Fragments outside the viewport are hidden.
 * - A re-layout with more than ~200 fragments applies the first chunk synchronously and the rest across
 *   requestAnimationFrame frames (Grammarly's 2025 fix for input lag).
 * - Active (hovered or card open) fragments grow to 3 px and get an 18 % tint behind the text.
 */
import type { SuggestionCategory } from '@jammarly/shared/types';
import { CATEGORY_PATTERNS, type UnderlineItem } from './overlay-api';
import { h } from './dom';

export const UNDERLINE_HEIGHT = 2;
export const UNDERLINE_ACTIVE_HEIGHT = 3;
/** Above this many fragments, re-layout continues in rAF chunks. */
export const CHUNK_THRESHOLD = 200;
export const CHUNK_SIZE = 200;
/** Vertical slop (px) added to a fragment rect when hit-testing, so the bar itself is hoverable. */
export const HIT_SLOP = 2;

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FragmentPlan {
  suggestionId: string;
  category: SuggestionCategory;
  /** highlight length in code units: longer spans are drawn first (below). */
  length: number;
  rect: RectLike;
}

export interface Fragment extends FragmentPlan {
  el: HTMLDivElement;
  tint: HTMLDivElement | null;
  visible: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export function viewportSize(): Viewport {
  return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
}

/** A rect intersects the viewport (fragments with no size are treated as invisible). */
export function isRectVisible(rect: RectLike, viewport: Viewport): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width;
}

export function pointInRect(x: number, y: number, rect: RectLike, slopY = HIT_SLOP): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top - slopY && y <= rect.bottom + slopY;
}

/** Longest highlight first, ties by start offset, so shorter (nested) spans end up on top. */
export function sortBySpanLength(items: UnderlineItem[]): UnderlineItem[] {
  return [...items].sort((a, b) => {
    const la = a.suggestion.highlight.end - a.suggestion.highlight.start;
    const lb = b.suggestion.highlight.end - b.suggestion.highlight.start;
    if (lb !== la) return lb - la;
    return a.suggestion.highlight.start - b.suggestion.highlight.start;
  });
}

/** Flatten items to a draw plan (one entry per rect, longest spans first). */
export function planFragments(items: UnderlineItem[]): FragmentPlan[] {
  const plan: FragmentPlan[] = [];
  for (const item of sortBySpanLength(items)) {
    const s = item.suggestion;
    const length = Math.max(0, s.highlight.end - s.highlight.start);
    for (const rect of item.rects) {
      plan.push({ suggestionId: s.id, category: s.category, length, rect: toRectLike(rect) });
    }
  }
  return plan;
}

export function toRectLike(r: RectLike | DOMRect): RectLike {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

/** Z-index for a fragment: shorter spans above longer ones (minimum 1). */
export function zIndexForLength(length: number): number {
  return Math.max(1, 10000 - Math.min(9999, length));
}

type Scheduler = {
  request: (cb: () => void) => number;
  cancel: (id: number) => void;
};

const defaultScheduler: Scheduler = {
  request: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : (setTimeout(cb, 16) as unknown as number)),
  cancel: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)),
};

export class UnderlineLayer {
  readonly container: HTMLDivElement;
  private fragments: Fragment[] = [];
  private activeId: string | null = null;
  private hoverId: string | null = null;
  private pendingIds = new Set<string>();
  private pendingPlan: FragmentPlan[] | null = null;
  private pendingIndex = 0;
  private rafId: number | null = null;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    readonly fieldId: string,
    private readonly scheduler: Scheduler = defaultScheduler,
  ) {
    this.container = h('div', { class: 'jm-ul-field', 'data-jm': 'underline-field', 'data-field-id': fieldId });
    parent.appendChild(this.container);
  }

  /** Replace every fragment (new suggestion set). */
  setItems(items: UnderlineItem[]): void {
    this.applyPlan(planFragments(items));
  }

  /** Same suggestion set, fresh rects (scroll/resize/reflow). */
  updateRects(items: UnderlineItem[]): void {
    this.applyPlan(planFragments(items));
  }

  /** The suggestion whose card is open: 3 px and tinted. */
  setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.refreshStates();
  }

  /** The suggestion under the pointer (also drawn in the active style). */
  setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.refreshStates();
  }

  /** Suggestions being applied fade out until the next set. */
  setPending(ids: Iterable<string>): void {
    this.pendingIds = new Set(ids);
    this.refreshStates();
  }

  /** Topmost suggestion whose fragment contains the point (viewport coordinates), or null. */
  hitTest(x: number, y: number): string | null {
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const f = this.fragments[i];
      if (!f || !f.visible) continue;
      if (pointInRect(x, y, f.rect)) return f.suggestionId;
    }
    return null;
  }

  /** Current rects for one suggestion (empty when it has none). */
  rectsFor(id: string): RectLike[] {
    return this.fragments.filter((f) => f.suggestionId === id).map((f) => f.rect);
  }

  /** Rects for every suggestion keyed by id (for the controller-free hit tests in the overlay). */
  suggestionIds(): string[] {
    return Array.from(new Set(this.fragments.map((f) => f.suggestionId)));
  }

  count(): number {
    return this.fragments.length;
  }

  visibleCount(): number {
    return this.fragments.filter((f) => f.visible).length;
  }

  /** True while a chunked re-layout is still pending. */
  hasPendingWork(): boolean {
    return this.pendingPlan !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.fragments = [];
    this.container.remove();
  }

  // ---------------------------------------------------------------------- internals

  private applyPlan(plan: FragmentPlan[]): void {
    if (this.disposed) return;
    this.cancelPending();
    this.syncPoolSize(plan.length);
    if (plan.length > CHUNK_THRESHOLD) {
      this.pendingPlan = plan;
      this.pendingIndex = 0;
      this.runChunk();
    } else {
      for (let i = 0; i < plan.length; i++) this.applyFragment(i, plan[i]!);
    }
  }

  private runChunk(): void {
    const plan = this.pendingPlan;
    if (!plan) return;
    const end = Math.min(plan.length, this.pendingIndex + CHUNK_SIZE);
    for (let i = this.pendingIndex; i < end; i++) this.applyFragment(i, plan[i]!);
    this.pendingIndex = end;
    if (end < plan.length) {
      this.rafId = this.scheduler.request(() => {
        this.rafId = null;
        this.runChunk();
      });
    } else {
      this.pendingPlan = null;
    }
  }

  private cancelPending(): void {
    if (this.rafId !== null) {
      this.scheduler.cancel(this.rafId);
      this.rafId = null;
    }
    this.pendingPlan = null;
    this.pendingIndex = 0;
  }

  /** Grow or shrink the element pool to `n` fragments. */
  private syncPoolSize(n: number): void {
    while (this.fragments.length > n) {
      const f = this.fragments.pop();
      if (f) {
        f.el.remove();
        f.tint?.remove();
      }
    }
    while (this.fragments.length < n) {
      const el = h('div', { class: 'jm-ul', 'data-jm': 'underline' });
      this.container.appendChild(el);
      this.fragments.push({
        suggestionId: '',
        category: 'correctness',
        length: 0,
        rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        el,
        tint: null,
        visible: false,
      });
    }
  }

  private applyFragment(index: number, p: FragmentPlan): void {
    const f = this.fragments[index];
    if (!f) return;
    f.suggestionId = p.suggestionId;
    f.category = p.category;
    f.length = p.length;
    f.rect = p.rect;
    f.visible = isRectVisible(p.rect, viewportSize());
    const el = f.el;
    el.dataset.suggestionId = p.suggestionId;
    el.dataset.category = p.category;
    el.dataset.pattern = CATEGORY_PATTERNS[p.category];
    el.style.left = `${p.rect.left}px`;
    el.style.width = `${Math.max(0, p.rect.width)}px`;
    el.style.top = `${p.rect.bottom - UNDERLINE_HEIGHT}px`;
    el.style.zIndex = String(zIndexForLength(p.length));
    if (f.visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
    this.applyState(f);
  }

  private refreshStates(): void {
    for (const f of this.fragments) this.applyState(f);
  }

  private applyState(f: Fragment): void {
    const active = f.suggestionId !== '' && (f.suggestionId === this.activeId || f.suggestionId === this.hoverId);
    const pending = this.pendingIds.has(f.suggestionId);
    f.el.classList.toggle('jm-ul-active', active);
    f.el.classList.toggle('jm-ul-pending', pending);
    if (active) {
      f.el.style.top = `${f.rect.bottom - UNDERLINE_ACTIVE_HEIGHT}px`;
      const tint = f.tint ?? this.createTint(f);
      tint.dataset.category = f.category;
      tint.dataset.suggestionId = f.suggestionId;
      tint.style.left = `${f.rect.left}px`;
      tint.style.top = `${f.rect.top}px`;
      tint.style.width = `${Math.max(0, f.rect.width)}px`;
      tint.style.height = `${Math.max(0, f.rect.height)}px`;
      tint.style.zIndex = String(zIndexForLength(f.length) - 1);
      if (f.visible) tint.removeAttribute('hidden');
      else tint.setAttribute('hidden', '');
    } else {
      f.el.style.top = `${f.rect.bottom - UNDERLINE_HEIGHT}px`;
      if (f.tint) {
        f.tint.remove();
        f.tint = null;
      }
    }
  }

  private createTint(f: Fragment): HTMLDivElement {
    const tint = h('div', { class: 'jm-ul-tint', 'data-jm': 'underline-tint' });
    // The tint sits behind the text visually only in the sense of a translucent wash over it; insert before the
    // bar so the bar paints on top of it within the same stacking order.
    this.container.insertBefore(tint, f.el);
    f.tint = tint;
    return tint;
  }
}
