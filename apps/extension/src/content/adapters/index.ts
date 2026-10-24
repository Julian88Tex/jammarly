/**
 * Adapter factory: textarea/input → TextareaAdapter, contenteditable roots → ContentEditableAdapter. Other kinds
 * (Google Docs) register themselves in `adapterFactories` from their own module.
 */
import type { FieldKind } from '@jammarly/shared/types';
import type { FieldAdapter, SiteProfile } from '../field-adapter';
import { kindOf } from '../detect';
import { ContentEditableAdapter } from './contenteditable';
import { TextareaAdapter, type TextField } from './textarea';

export type AdapterFactory = (el: HTMLElement, profile: SiteProfile) => FieldAdapter;

/** Registry hook: the Google Docs module sets `adapterFactories.gdocs` when its bridge is active. */
export const adapterFactories: Partial<Record<FieldKind, AdapterFactory>> = {
  textarea: (el, profile) => new TextareaAdapter(el as TextField, profile),
  input: (el, profile) => new TextareaAdapter(el as TextField, profile),
  contenteditable: (el, profile) => new ContentEditableAdapter(el, profile),
};

/** Build an adapter for a known kind, or null when no factory is registered for it. */
export function createAdapterForKind(kind: FieldKind, el: HTMLElement, profile: SiteProfile): FieldAdapter | null {
  const factory = adapterFactories[kind];
  return factory ? factory(el, profile) : null;
}

/** Build the adapter for an eligible element (textarea, input or contenteditable root). Throws for anything else. */
export function createAdapter(el: HTMLElement, profile: SiteProfile): FieldAdapter {
  const kind = kindOf(el);
  if (!kind) throw new Error('jammarly: element is not an editable field');
  const adapter = createAdapterForKind(kind, el, profile);
  if (!adapter) throw new Error(`jammarly: no adapter registered for field kind "${kind}"`);
  return adapter;
}

export { ContentEditableAdapter, deletionLadder, edgeSpacesToNbsp, elementRange, mergeRanges } from './contenteditable';
export { TextareaAdapter, setNativeValue, translateMirrorRects, MIRROR_PROPERTIES, type MirrorGeometry, type RectLike, type TextField } from './textarea';
export { VERIFY_DELAY_MS, applyEditsRightToLeft, normalizeNbsp, runLadder, verifyWindows, type RunResult, type RungAttempt, type VerifyResult } from './common';
