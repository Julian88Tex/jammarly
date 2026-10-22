/**
 * Overlay UI entry point: `createOverlay` implements `CreateOverlay` from ./overlay-api.
 */
export { createOverlay, HOST_TAG, HOST_ATTR, HOVER_INTENT_MS, LEAVE_GRACE_MS, isOptOutReason } from './overlay';
export type { OverlayDebugInfo } from './overlay';
export type { CreateOverlay, FieldOverlay, Overlay, OverlayEvents, OverlayOptions, OverlayTheme, UnderlineItem, AcceptAllCounts } from './overlay-api';
export { placeCard, CATEGORY_COLORS, CATEGORY_COLORS_DARK, CATEGORY_COLORS_COLORBLIND, CATEGORY_PATTERNS, CATEGORY_LABELS, INTERACTIVE_COLOR, INTERACTIVE_COLOR_DARK, BRAND_COLOR } from './overlay-api';
