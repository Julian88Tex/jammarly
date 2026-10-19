/**
 * Content-script abstraction over a host text field. Lives in the extension (not the shared package)
 * because it references DOM types. Implementations: TextareaAdapter (textarea + input), ContentEditableAdapter.
 * Offsets are always into getText()'s plain-text serialization (UTF-16 code units).
 */
import type { Edit, FieldKind, TextRange } from '@jammarly/shared/types';

export interface FieldAdapter {
  readonly kind: FieldKind;
  readonly element: HTMLElement;
  getText(): string;
  /** Viewport-relative rects covering the text in `range` (one per line fragment). */
  getRangeRects(range: TextRange): DOMRect[];
  /** Apply a single edit; returns false if `original` no longer matches at `range`. Keeps the host's undo stack when possible. */
  applyEdit(edit: Edit): boolean;
  /** Apply many edits atomically (sorted and applied right-to-left); returns the number applied. */
  applyEdits(edits: Edit[]): number;
  getSelection(): TextRange | null;
  setSelection(range: TextRange): void;
  /** Subscribe to text changes; the callback receives the new text and a version number. */
  onChange(cb: (text: string, version: number) => void): () => void;
  /** Subscribe to layout changes that require re-drawing overlays (scroll, resize, reflow). */
  onLayout(cb: () => void): () => void;
  isFocused(): boolean;
  dispose(): void;
}
