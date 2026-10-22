/**
 * Editor-framework fingerprints (research 04 §5) and the ladder each framework accepts (04 §4.5–4.6, 05 fact 10).
 * A framework profile is used when the host has no dedicated profile but the field carries a known marker.
 */
import type { WritingContext } from '@jammarly/shared/types';
import type { SiteProfile } from '../field-adapter';
import { defineProfile, genericDocHint, type Ladder } from './base';

export type FrameworkId = 'draftjs' | 'slate' | 'lexical' | 'quill' | 'prosemirror' | 'gutenberg';

export interface FrameworkSpec {
  id: FrameworkId;
  /** Selector that identifies the editable root (or an ancestor of it). */
  marker: string;
  ladder: Ladder;
  protectedSelectors: string[];
}

export const PROSEMIRROR_PROTECTED: readonly string[] = ['.ProseMirror-widget', '.ProseMirror-trailingBreak', '.ProseMirror-separator'];

export const FRAMEWORKS: Record<FrameworkId, FrameworkSpec> = {
  // Draft.js reads the DOM back per leaf after `input`; synthetic beforeinput is not handled. Selection must be
  // synced first (the adapter does that when it sees this marker).
  draftjs: { id: 'draftjs', marker: '.public-DraftEditor-content', ladder: ['execCommand', 'paste', 'splice'], protectedSelectors: [] },
  // Slate ignores execCommand (no DOM reconciliation on desktop); everything goes through beforeinput.
  slate: { id: 'slate', marker: '[data-slate-editor="true"]', ladder: ['beforeinput', 'paste', 'splice'], protectedSelectors: ['[data-slate-void]', '[data-slate-zero-width]'] },
  // Lexical reverts foreign DOM writes within ~100 ms but takes beforeinput insertReplacementText.
  lexical: { id: 'lexical', marker: '[data-lexical-editor="true"]', ladder: ['beforeinput', 'paste', 'splice'], protectedSelectors: ['[data-lexical-decorator]'] },
  // Quill's Input module takes beforeinput with a non-collapsed target range; otherwise its MutationObserver reads execCommand.
  quill: { id: 'quill', marker: '.ql-editor', ladder: ['beforeinput', 'execCommand', 'paste', 'splice'], protectedSelectors: ['[contenteditable="false"]'] },
  // ProseMirror re-parses DOM changes (readDOMChange) and handles synthetic paste; it ignores synthetic beforeinput.
  prosemirror: { id: 'prosemirror', marker: '.ProseMirror', ladder: ['execCommand', 'paste', 'splice'], protectedSelectors: [...PROSEMIRROR_PROTECTED] },
  // Gutenberg RichText re-reads the DOM on `input`; beforeinput insertReplacementText only opens an undo level.
  gutenberg: { id: 'gutenberg', marker: '.block-editor-rich-text__editable', ladder: ['execCommand', 'splice'], protectedSelectors: [] },
};

/** Detection order matters only where markers could co-exist; the specific ones come first. */
const DETECTION_ORDER: readonly FrameworkId[] = ['draftjs', 'slate', 'lexical', 'quill', 'gutenberg', 'prosemirror'];

function closestSafe(el: Element, selector: string): Element | null {
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

/** The framework whose marker is on `el` or an ancestor (never crosses a shadow boundary), or null. */
export function detectFramework(el: Element): FrameworkId | null {
  for (const id of DETECTION_ORDER) {
    if (closestSafe(el, FRAMEWORKS[id].marker)) return id;
  }
  return null;
}

export function isDraftJsRoot(el: Element): boolean {
  return closestSafe(el, FRAMEWORKS.draftjs.marker) !== null;
}

const cache = new Map<string, SiteProfile>();

/** A host-agnostic profile for a framework, in the given context. Instances are cached per (framework, context). */
export function frameworkProfile(id: FrameworkId, context: WritingContext): SiteProfile {
  const key = `${id}:${context}`;
  let profile = cache.get(key);
  if (!profile) {
    const spec = FRAMEWORKS[id];
    profile = defineProfile({
      id,
      matches: () => false,
      context,
      ladder: spec.ladder,
      protectedSelectors: spec.protectedSelectors,
      bodySelectors: [spec.marker],
      docHint: (location) => genericDocHint(location),
    });
    cache.set(key, profile);
  }
  return profile;
}
