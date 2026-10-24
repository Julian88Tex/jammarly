/**
 * Shared fixtures for the overlay UI unit tests (jsdom).
 */
import { vi } from 'vitest';
import type { Suggestion, SuggestionCategory, SuggestionKind, SuggestionTier } from '@jammarly/shared/types';
import type { FieldAdapter } from '../../../src/content/field-adapter';
import type { Overlay, OverlayEvents, OverlayOptions, UnderlineItem } from '../../../src/content/ui/overlay-api';
import { createOverlay } from '../../../src/content/ui';

export const FAKE_TIMER_APIS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;

export function makeSuggestion(partial: Partial<Suggestion> & { id: string }): Suggestion {
  const original = partial.original ?? 'teh';
  const replacement = partial.replacement ?? 'the';
  const start = partial.range?.start ?? 0;
  const end = partial.range?.end ?? start + original.length;
  const kind: SuggestionKind = partial.kind ?? 'replace';
  const category: SuggestionCategory = partial.category ?? 'correctness';
  const tier: SuggestionTier = partial.tier ?? (category === 'correctness' ? 'A' : kind === 'rewrite' || kind === 'flag' ? 'C' : 'B');
  return {
    id: partial.id,
    category,
    rule: partial.rule ?? 'spelling',
    severity: partial.severity ?? 'error',
    kind,
    source: partial.source ?? 'llm',
    tier,
    anchor: partial.anchor ?? 'exact',
    range: { start, end },
    highlight: partial.highlight ?? { start, end },
    original,
    replacement,
    alternatives: partial.alternatives ?? [],
    title: partial.title ?? 'Correct the spelling',
    explanation: partial.explanation ?? 'This word is misspelled.',
    confidence: partial.confidence ?? 0.95,
    meaningPreserving: partial.meaningPreserving ?? true,
    autoApplySafe: partial.autoApplySafe ?? true,
    blockId: partial.blockId ?? 'b0',
    blockHash: partial.blockHash ?? 'h0',
    conflictsWith: partial.conflictsWith ?? [],
    stale: partial.stale ?? false,
    promptVersion: partial.promptVersion ?? 'v1',
    fingerprint: partial.fingerprint ?? `fp-${partial.id}`,
    learnedState: partial.learnedState ?? 'active',
    ...(partial.model ? { model: partial.model } : {}),
  };
}

export function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

export function item(s: Suggestion, ...rects: DOMRect[]): UnderlineItem {
  return { suggestion: s, rects: rects.length ? rects : [rect(100, 100, 60, 18)] };
}

export function fakeAdapter(box: DOMRect = rect(50, 50, 500, 200)): FieldAdapter {
  const element = document.createElement('textarea');
  document.body.appendChild(element);
  return {
    kind: 'textarea',
    element,
    getLabel: () => 'Message body',
    getDocHint: () => '',
    getText: () => element.value,
    getRangeRects: () => [],
    getProtectedRanges: () => [],
    applyEdit: async () => ({ status: 'applied', rung: 'native', text: element.value }),
    applyEdits: async () => ({ applied: [], skipped: [], text: element.value, nativeUndoSteps: 0 }),
    getSelection: () => null,
    setSelection: () => {},
    isComposing: () => false,
    isFocused: () => document.activeElement === element,
    focus: () => element.focus(),
    onChange: () => () => {},
    onLayout: () => () => {},
    onFocusChange: () => () => {},
    getBox: () => box,
    dispose: () => element.remove(),
  };
}

export type SpyEvents = { [K in keyof OverlayEvents]: ReturnType<typeof vi.fn> } & OverlayEvents;

export function spyEvents(): SpyEvents {
  return {
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    onAcceptAll: vi.fn(),
    onUndo: vi.fn(),
    onAddToDictionary: vi.fn(),
    onMuteRule: vi.fn(),
    onReportIncorrect: vi.fn(),
    onOpenPanel: vi.fn(),
    onToggleHost: vi.fn(),
    onToggleField: vi.fn(),
    onOpenSetup: vi.fn(),
    onCheckHereAnyway: vi.fn(),
    onRecheck: vi.fn(),
    onCardShown: vi.fn(),
    onCardHidden: vi.fn(),
  } as SpyEvents;
}

export const DEFAULT_OPTS: OverlayOptions = {
  theme: { colorblindMode: false },
  shortcutSafe: false,
  showFloatingButton: true,
  showUnderlines: true,
};

export function opts(partial: Partial<OverlayOptions> = {}): OverlayOptions {
  return { ...DEFAULT_OPTS, ...partial, theme: { ...DEFAULT_OPTS.theme, ...(partial.theme ?? {}) } };
}

export interface Harness {
  overlay: Overlay;
  events: SpyEvents;
  host: HTMLElement;
  root: ShadowRoot;
  q<T extends Element = HTMLElement>(selector: string): T;
  qAll<T extends Element = HTMLElement>(selector: string): T[];
  debug(): Record<string, unknown>;
}

export function harness(): Harness {
  const events = spyEvents();
  const overlay = createOverlay(events);
  const host = document.querySelector<HTMLElement>('jammarly-root');
  if (!host || !host.shadowRoot) throw new Error('host not created');
  const root = host.shadowRoot;
  return {
    overlay,
    events,
    host,
    root,
    q: <T extends Element = HTMLElement>(sel: string) => {
      const el = root.querySelector<T>(sel);
      if (!el) throw new Error(`not found in shadow root: ${sel}`);
      return el;
    },
    qAll: <T extends Element = HTMLElement>(sel: string) => Array.from(root.querySelectorAll<T>(sel)),
    debug: () => (overlay as unknown as { __debug: () => Record<string, unknown> }).__debug(),
  };
}

export function pointerMove(x: number, y: number, target: EventTarget = document.body): void {
  target.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, composed: true, pointerType: 'mouse' }));
}

export function pointerDown(x: number, y: number, target: EventTarget = document.body): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true, pointerType: 'mouse', button: 0 }));
}

export function click(x: number, y: number, target: EventTarget = document.body): void {
  target.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true, button: 0 }));
}

export function key(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

export function cardEl(h: Harness): HTMLElement {
  return h.q('[data-jm="card"]');
}

export function cardOpen(h: Harness): boolean {
  const el = h.root.querySelector<HTMLElement>('[data-jm="card"]');
  return !!el && el.dataset.open === 'true' && !el.hasAttribute('hidden');
}

export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
