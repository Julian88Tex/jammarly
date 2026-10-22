/**
 * Browser-side harness for the overlay UI e2e spec. Bundled at test time by `bundleFixtureScript` (see
 * tests/e2e/fixtures.ts) into tests/fixtures/_build/overlay-harness.js and loaded by overlay-harness.html.
 *
 * It wires `createOverlay` to a fake adapter over the fixture's contenteditable, derives suggestions from the
 * `<span data-err>` markers (rects from `getClientRects()`), and records every OverlayEvents callback on
 * `window.__jm.events` so the spec can assert what the controller would have received.
 */
import type { Suggestion, SuggestionCategory, SuggestionKind, SuggestionTier, CheckError, CheckPass, FieldStatus } from '@jammarly/shared/types';
import type { FieldAdapter } from '../../../src/content/field-adapter';
import type { FieldOverlay, Overlay, OverlayEvents, OverlayOptions, UnderlineItem } from '../../../src/content/ui/overlay-api';
import { createOverlay } from '../../../src/content/ui';

interface LoggedEvent {
  name: string;
  args: unknown[];
}

interface HarnessApi {
  overlay: Overlay;
  field: FieldOverlay;
  events: LoggedEvent[];
  layout(): void;
  debug(): unknown;
  setStatus(status: FieldStatus, grammar: number, style: number, rewrites: number, pass?: CheckPass, error?: CheckError): void;
  setTyping(typing: boolean): void;
  toast(message: string, tx?: string): void;
  setOptions(opts: Partial<OverlayOptions>): void;
  attachInput(id: string): void;
  openCard(id: string): void;
  focusSuggestion(id: string): void;
}

declare global {
  interface Window {
    __jm: HarnessApi;
  }
}

const events: LoggedEvent[] = [];
const log =
  (name: string) =>
  (...args: unknown[]) => {
    events.push({ name, args });
  };

const overlayEvents: OverlayEvents = {
  onAccept: log('onAccept'),
  onDismiss: log('onDismiss'),
  onAcceptAll: log('onAcceptAll'),
  onUndo: log('onUndo'),
  onAddToDictionary: log('onAddToDictionary'),
  onMuteRule: log('onMuteRule'),
  onReportIncorrect: log('onReportIncorrect'),
  onOpenPanel: log('onOpenPanel'),
  onToggleHost: log('onToggleHost'),
  onToggleField: log('onToggleField'),
  onOpenSetup: log('onOpenSetup'),
  onCheckHereAnyway: log('onCheckHereAnyway'),
  onRecheck: log('onRecheck'),
  onCardShown: log('onCardShown'),
  onCardHidden: log('onCardHidden'),
};

function adapterFor(element: HTMLElement, kind: FieldAdapter['kind']): FieldAdapter {
  return {
    kind,
    element,
    getLabel: () => 'Harness',
    getDocHint: () => '',
    getText: () => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? ''),
    getRangeRects: () => [],
    getProtectedRanges: () => [],
    applyEdit: async () => ({ status: 'unsupported', rung: null, text: '' }),
    applyEdits: async () => ({ applied: [], skipped: [], text: '', nativeUndoSteps: 0 }),
    getSelection: () => null,
    setSelection: () => {},
    isComposing: () => false,
    isFocused: () => document.activeElement === element,
    focus: () => element.focus(),
    onChange: () => () => {},
    onLayout: () => () => {},
    onFocusChange: () => () => {},
    getBox: () => element.getBoundingClientRect(),
    dispose: () => {},
  };
}

const OPTIONS: OverlayOptions = { theme: { colorblindMode: false }, shortcutSafe: false, showFloatingButton: true, showUnderlines: true };

const editor = document.getElementById('editor') as HTMLElement;
const overlay = createOverlay(overlayEvents);
const field = overlay.attach('f1', adapterFor(editor, 'contenteditable'), OPTIONS);

function suggestionsFromSpans(): UnderlineItem[] {
  const items: UnderlineItem[] = [];
  let offset = 0;
  for (const span of Array.from(editor.querySelectorAll<HTMLElement>('[data-err]'))) {
    const original = span.textContent ?? '';
    const id = span.dataset.err ?? '';
    const category = (span.dataset.category as SuggestionCategory | undefined) ?? 'correctness';
    const kind = (span.dataset.kind as SuggestionKind | undefined) ?? 'replace';
    const tier = (span.dataset.tier as SuggestionTier | undefined) ?? (category === 'correctness' ? 'A' : 'B');
    const start = offset;
    offset += original.length + 10;
    const s: Suggestion = {
      id,
      category,
      rule: span.dataset.rule ?? 'spelling',
      severity: category === 'correctness' ? 'error' : 'suggestion',
      kind,
      source: 'llm',
      tier,
      anchor: 'exact',
      range: { start, end: start + original.length },
      highlight: { start, end: start + original.length },
      original,
      replacement: span.dataset.fix ?? original,
      alternatives: (span.dataset.alts ?? '').split('|').filter(Boolean),
      title: span.dataset.title ?? (category === 'correctness' ? 'Correct the spelling' : 'Consider this change'),
      explanation: span.dataset.explanation ?? 'This word is misspelled.',
      confidence: 0.95,
      meaningPreserving: true,
      autoApplySafe: category === 'correctness',
      blockId: 'b0',
      blockHash: 'h0',
      conflictsWith: [],
      stale: false,
      promptVersion: 'test',
      fingerprint: `fp-${id}`,
      learnedState: 'active',
    };
    items.push({ suggestion: s, rects: Array.from(span.getClientRects()) });
  }
  return items;
}

function counts(items: UnderlineItem[]): { grammar: number; style: number; rewrites: number } {
  let grammar = 0;
  let style = 0;
  let rewrites = 0;
  for (const i of items) {
    if (i.suggestion.tier === 'A') grammar++;
    else if (i.suggestion.tier === 'B') style++;
    else rewrites++;
  }
  return { grammar, style, rewrites };
}

const extraFields = new Map<string, FieldOverlay>();

function layout(): void {
  const items = suggestionsFromSpans();
  field.updateRects(items);
  field.setFieldBox(editor.getBoundingClientRect());
  for (const [id, f] of extraFields) {
    const el = document.getElementById(id);
    if (el) f.setFieldBox(el.getBoundingClientRect());
  }
}

const initial = suggestionsFromSpans();
field.setUnderlines(initial);
field.setFieldBox(editor.getBoundingClientRect());
const c = counts(initial);
field.setStatus('suggestions', c, 'deep');

window.addEventListener('scroll', layout, { capture: true, passive: true });
window.addEventListener('resize', layout);
editor.addEventListener('input', layout);

window.__jm = {
  overlay,
  field,
  events,
  layout,
  debug: () => (overlay as unknown as { __debug: () => unknown }).__debug(),
  setStatus: (status, grammar, style, rewrites, pass = 'deep', error) => field.setStatus(status, { grammar, style, rewrites }, pass, error),
  setTyping: (typing) => field.setTyping(typing),
  toast: (message, tx) => field.toast(message, tx ? { undoTransactionId: tx } : undefined),
  setOptions: (opts) => overlay.setOptions(opts),
  attachInput: (id) => {
    const el = document.getElementById(id) as HTMLInputElement;
    const f = overlay.attach(id, adapterFor(el, 'input'), OPTIONS);
    f.setStatus('idle', { grammar: 0, style: 0, rewrites: 0 }, 'rules');
    f.setFieldBox(el.getBoundingClientRect());
    extraFields.set(id, f);
  },
  openCard: (id) => {
    const item = suggestionsFromSpans().find((i) => i.suggestion.id === id);
    if (item && item.rects[0]) field.openCard(id, item.rects[0]);
  },
  focusSuggestion: (id) => field.focusSuggestion(id),
};
document.documentElement.setAttribute('data-jm-harness', 'ready');
