/**
 * Contract between the field controller (content/controller) and the overlay UI (content/ui).
 * The controller owns state and decisions; the UI only renders and reports user intent.
 * Both sides are implemented in parallel against this file; do not change it without updating both.
 */
import type { AcceptAllScope, CheckError, CheckPass, DismissReason, FieldStatus, Suggestion, SuggestionCategory, TextRange, ToneAnalysis } from '@jammarly/shared/types';
import type { FieldAdapter } from '../field-adapter';

export interface OverlayTheme {
  colorblindMode: boolean;
}

export interface OverlayOptions {
  theme: OverlayTheme;
  /** Shortcut-safe mode: no single-letter shortcuts; never swallow unhandled keys. */
  shortcutSafe: boolean;
  showFloatingButton: boolean;
  showUnderlines: boolean;
}

export interface UnderlineItem {
  suggestion: Suggestion;
  /** Viewport-relative rects for suggestion.highlight, one per line fragment. */
  rects: DOMRect[];
}

export interface AcceptAllCounts {
  grammar: number;
  style: number;
  rewrites: number;
}

/** Events the UI raises; the controller decides what happens. */
export interface OverlayEvents {
  onAccept(fieldId: string, suggestionId: string, alternativeIndex?: number): void;
  onDismiss(fieldId: string, suggestionId: string, reason?: DismissReason): void;
  onAcceptAll(fieldId: string, scope: AcceptAllScope): void;
  onUndo(fieldId: string, transactionId?: string): void;
  onAddToDictionary(fieldId: string, word: string): void;
  onMuteRule(fieldId: string, rule: string, scope: 'host' | 'global'): void;
  onReportIncorrect(fieldId: string, suggestionId: string): void;
  onOpenPanel(fieldId: string): void;
  onToggleHost(enabled: boolean): void;
  /** duration 'session' = until the next visit (default), 'forever' = remembered for this field path. */
  onToggleField(fieldId: string, enabled: boolean, duration?: 'session' | 'forever'): void;
  /** The 'setup' button state was clicked: open the options page (first-run consent / API key). */
  onOpenSetup(fieldId: string): void;
  onCheckHereAnyway(fieldId: string): void;
  onRecheck(fieldId: string): void;
  /** The card opened/closed (for 'shown' and dwell-time feedback events). */
  onCardShown(fieldId: string, suggestionId: string): void;
  onCardHidden(fieldId: string, suggestionId: string): void;
}

export interface FieldOverlay {
  readonly fieldId: string;
  /** Replace all underlines for this field (already filtered to visible suggestions). */
  setUnderlines(items: UnderlineItem[]): void;
  /** Re-measure positions after scroll/resize; the controller passes fresh rects. */
  updateRects(items: UnderlineItem[]): void;
  /** `error` carries the sub-kind for the error state (auth | rate-limit | spend-cap | budget | network ...) and its tooltip. */
  setStatus(status: FieldStatus, counts: AcceptAllCounts, checkedBy: CheckPass, error?: CheckError): void;
  setTone(tone: ToneAnalysis | undefined, charCount: number): void;
  /** Button position follows the field; called on layout changes. */
  setFieldBox(box: DOMRect): void;
  /** Called while the user types: collapse the button, hide the card. */
  setTyping(typing: boolean): void;
  openCard(suggestionId: string, anchorRect: DOMRect): void;
  closeCard(): void;
  /** Keyboard navigation from the panel/commands. */
  focusSuggestion(suggestionId: string): void;
  /** Show the accept-all menu anchored to the button (counts shown live). */
  openMenu(): void;
  closeMenu(): void;
  toast(message: string, options?: { undoTransactionId?: string; durationMs?: number }): void;
  setUnsupported(reason: string): void;
  dispose(): void;
}

export interface Overlay {
  /** Create (or return) the overlay for a field; one per fieldId. */
  attach(fieldId: string, adapter: FieldAdapter, opts: OverlayOptions): FieldOverlay;
  detach(fieldId: string): void;
  setOptions(opts: Partial<OverlayOptions>): void;
  /** True when the pointer or focus is inside overlay UI (card, menu, button). */
  isInteracting(): boolean;
  dispose(): void;
}

export type CreateOverlay = (events: OverlayEvents) => Overlay;

export const CATEGORY_COLORS: Record<SuggestionCategory, string> = {
  correctness: '#E0372C',
  clarity: '#2A7DE1',
  engagement: '#1D9F7A',
  delivery: '#8B5CF6',
};

/** Dark-scheme variants of CATEGORY_COLORS (applied under prefers-color-scheme: dark). */
export const CATEGORY_COLORS_DARK: Record<SuggestionCategory, string> = {
  correctness: '#FF6B61',
  clarity: '#5B9CF6',
  engagement: '#34D3AC',
  delivery: '#B07CF0',
};

/** Interactive/accept color (the bold replacement, primary button) and its dark variant; brand green for the button. */
export const INTERACTIVE_COLOR = '#2551DA';
export const INTERACTIVE_COLOR_DARK = '#7A9BFF';
export const BRAND_COLOR = '#0E9A74';

/** Wong palette for colorblind mode, paired with per-category underline patterns (solid / dashed / dotted / double). */
export const CATEGORY_COLORS_COLORBLIND: Record<SuggestionCategory, string> = {
  correctness: '#D55E00',
  clarity: '#0072B2',
  engagement: '#009E73',
  delivery: '#CC79A7',
};
export const CATEGORY_PATTERNS: Record<SuggestionCategory, 'solid' | 'dashed' | 'dotted' | 'double'> = {
  correctness: 'solid',
  clarity: 'dashed',
  engagement: 'dotted',
  delivery: 'double',
};

export const CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  correctness: 'Correctness',
  clarity: 'Clarity',
  engagement: 'Engagement',
  delivery: 'Delivery',
};

/** Compute a card position: below the anchor with an 8 px gap, flipped above near the bottom, clamped ±8 px. */
export function placeCard(anchor: DOMRect | TextRange & { top: number; bottom: number; left: number }, card: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number; placement: 'below' | 'above' } {
  const gap = 8;
  const pad = 8;
  const a = anchor as { top: number; bottom: number; left: number };
  let placement: 'below' | 'above' = 'below';
  let top = a.bottom + gap;
  if (top + card.height > viewport.height - pad && a.top - gap - card.height >= pad) {
    placement = 'above';
    top = a.top - gap - card.height;
  }
  top = Math.max(pad, Math.min(top, viewport.height - card.height - pad));
  const left = Math.max(pad, Math.min(a.left, viewport.width - card.width - pad));
  return { top, left, placement };
}
