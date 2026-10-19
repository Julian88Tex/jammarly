/**
 * Content-script abstraction over a host text field. Lives in the extension (not the shared package)
 * because it references DOM types. Implementations: TextareaAdapter (textarea + input), ContentEditableAdapter
 * (generic plus site/framework profiles), GoogleDocsAdapter (annotated-canvas bridge).
 *
 * Offsets are always into getText()'s plain-text serialization (UTF-16 code units).
 * See docs/ARCHITECTURE.md §3.4 for the edit ladder, verification windows and undo semantics.
 */
import type { BatchEditOutcome, Edit, EditOutcome, FieldKind, TextRange } from '@jammarly/shared/types';

export interface FieldAdapter {
  readonly kind: FieldKind;
  readonly element: HTMLElement;
  /** Short human label for the panel ("Message body", "Comment", "Subject"). */
  getLabel(): string;
  /** Stable per-document hint when the host exposes one (Gmail draft id, thread id in the URL), else "". */
  getDocHint(): string;
  getText(): string;
  /** Viewport-relative rects covering the text in `range` (one per line fragment), merged per line. */
  getRangeRects(range: TextRange): DOMRect[];
  /** Union of non-editable islands, zero-width characters, quoted replies, signatures and chips. */
  getProtectedRanges(): TextRange[];
  /**
   * Apply one edit through the adapter's ladder. Each rung is verified immediately, at the next animation frame and
   * at +150 ms (NBSP-normalized); a rung is never re-run. Returns 'composing' while an IME composition is active.
   */
  applyEdit(edit: Edit): Promise<EditOutcome>;
  /**
   * Apply many non-overlapping edits right-to-left against one snapshot, verifying after each; aborts on the first
   * mismatch and reports what was applied.
   */
  applyEdits(edits: Edit[]): Promise<BatchEditOutcome>;
  getSelection(): TextRange | null;
  setSelection(range: TextRange): void;
  isComposing(): boolean;
  isFocused(): boolean;
  focus(): void;
  /** Subscribe to text changes; the callback receives the new text and the input type that caused it (if known). */
  onChange(cb: (text: string, inputType: string | null) => void): () => void;
  /** Subscribe to layout changes that require re-drawing overlays (scroll, resize, reflow, font load). */
  onLayout(cb: () => void): () => void;
  /** Subscribe to focus/blur of the field. */
  onFocusChange(cb: (focused: boolean) => void): () => void;
  /** The element's bounding box in viewport coordinates (for the floating button). */
  getBox(): DOMRect;
  dispose(): void;
}

/** Why a candidate element was rejected, for diagnostics and the "unsupported" button state. */
export type IneligibleReason =
  | 'not-editable'
  | 'too-small'
  | 'readonly'
  | 'password'
  | 'sensitive-input'
  | 'opted-out'
  | 'code-editor'
  | 'gdocs-input-sink'
  | 'hidden';

export interface SiteProfile {
  /** Stable id, e.g. "gmail", "superhuman", "slashy", "slack", "generic". */
  id: string;
  /** Hostname test. */
  matches(host: string): boolean;
  /** Default writing context for the host. */
  context: 'email' | 'chat' | 'doc' | 'social' | 'code' | 'other';
  /** The card never claims single-letter shortcuts and never swallows unhandled keys. */
  shortcutSafe: boolean;
  /** Honour fields even when the site sets an opt-out attribute (Slack sets data-gramm="false"). */
  ignoreOptOut: boolean;
  /** Multipliers applied to the configured debounce for the fast and deep passes. */
  fastPassMultiplier: number;
  deepPassMultiplier: number;
  /** Ordered rungs to try for contenteditable edits on this host. */
  ladder: ('execCommand' | 'beforeinput' | 'paste' | 'splice')[];
  /** CSS selectors (within the field) whose text must never be flagged or edited. */
  protectedSelectors: string[];
  /** Selectors that identify the primary compose body, to label it and prefer it. */
  bodySelectors: string[];
  /** Extract a stable document hint from the location (draft id, thread id). */
  docHint(location: Location, element: HTMLElement): string;
}
