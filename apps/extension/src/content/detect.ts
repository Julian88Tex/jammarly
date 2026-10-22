/**
 * Field detection and eligibility (ARCHITECTURE §3.4, research 04 §8, 09 §1.6).
 *
 * `findEditable` turns whatever a focus/selection event points at (an element, a Text node, a document, a
 * shadow root or the window) into the field Jammarly would attach to: the textarea/input itself, or the
 * contenteditable root (editing host). `classify` then applies every eligibility rule and names the first one
 * that fails, so the floating button can show an honest "unsupported" state.
 *
 * Pure DOM, no chrome.* and no layout dependency: jsdom lacks `isContentEditable`, so editability is derived
 * from the `contenteditable` attribute chain when the native property is unavailable, and the size gate reads
 * `clientWidth`/`clientHeight` (which tests mock).
 */
import type { FieldKind } from '@jammarly/shared/types';
import type { IneligibleReason, SiteProfile } from './field-adapter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every kind must be at least this large (AI chat prompt boxes start at 24–36 px; Grammarly's 38 px gate is not used). */
export const MIN_FIELD_WIDTH = 120;
export const MIN_FIELD_HEIGHT = 24;
/** Fields shorter than this get the floating button anchored just outside their bottom-right corner. */
export const SMALL_FIELD_HEIGHT = 40;
/** An input whose maxlength is at or below this holds a code or a token, not prose. */
export const MAX_SHORT_INPUT_LENGTH = 8;

export const ELIGIBLE_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'url']);
const SENSITIVE_INPUT_TYPES: ReadonlySet<string> = new Set(['email', 'tel', 'number']);
const SENSITIVE_INPUTMODES: ReadonlySet<string> = new Set(['numeric', 'decimal', 'tel']);
const PASSWORD_AUTOCOMPLETE_RE = /(^|\s)(current-password|new-password)(\s|$)/;
const SENSITIVE_AUTOCOMPLETE_RE = /(^|\s)(cc-[a-z-]+|one-time-code)(\s|$)/;

/** Code editors (CodeMirror 5/6, Monaco, Ace, CKEditor source mode, editable code blocks): never checked. */
export const CODE_EDITOR_SELECTORS: readonly string[] = [
  '.cm-editor',
  '.cm-content',
  '.CodeMirror',
  '.monaco-editor',
  'textarea.inputarea',
  '.ace_editor',
  'textarea.ace_text-input',
  '[aria-roledescription="editor"]',
  '.ck-source-editing-area',
  'pre[contenteditable]',
  'code[contenteditable]',
];
const CODE_EDITOR_SELECTOR = CODE_EDITOR_SELECTORS.join(', ');

/** Google Docs' hidden key-event sink lives in this iframe; kix-* elements are the canvas editor's own DOM. */
const GDOCS_SINK_FRAME_CLASS = 'docs-texteventtarget-iframe';
const GDOCS_SINK_SELECTOR = '.docs-texteventtarget-iframe, [class^="kix-"], [class*=" kix-"]';

const OPT_OUT_PRESENCE_ATTRS = ['data-gramm', 'data-gramm_editor', 'data-jammarly'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** Global user setting "Check fields that sites disabled". */
  checkOptedOutFields: boolean;
  /** Site profile or per-host "Check here anyway": honour the field despite an opt-out attribute. */
  ignoreSiteOptOut: boolean;
}

export type Classification = { ok: true; kind: FieldKind } | { ok: false; reason: IneligibleReason };

export type OptOutState = 'opted-in' | 'opted-out' | 'none';

export type FieldLabel = 'Message body' | 'Subject' | 'Comment' | 'Reply' | 'Post' | 'Search' | 'Text field';

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

export function isTextarea(el: Element): el is HTMLTextAreaElement {
  return el.tagName.toUpperCase() === 'TEXTAREA';
}

export function isInput(el: Element): el is HTMLInputElement {
  return el.tagName.toUpperCase() === 'INPUT';
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function safeClosest(el: Element, selector: string): Element | null {
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

function safeComputedStyle(el: Element): CSSStyleDeclaration | null {
  const view = el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  try {
    return view.getComputedStyle(el);
  } catch {
    return null;
  }
}

/** The innermost focused element, descending through open shadow roots (document.activeElement retargets to the host). */
export function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Descend from a (possibly retargeted) shadow host to the element that really has focus inside it. */
function descendActive(el: Element): Element {
  let cur = el;
  while (cur.shadowRoot && cur.shadowRoot.activeElement) cur = cur.shadowRoot.activeElement;
  return cur;
}

/**
 * Whether `el` is editable. Uses the native `isContentEditable` when the engine implements it and otherwise
 * derives the answer from the `contenteditable` attribute chain ("" / "true" / "plaintext-only" turn editing on,
 * "false" turns it off, anything else inherits), which is what jsdom needs.
 */
export function isEditableElement(el: Element): boolean {
  const native = (el as HTMLElement).isContentEditable as boolean | undefined;
  if (typeof native === 'boolean') return native;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const attr = n.getAttribute('contenteditable');
    if (attr === null) continue;
    const v = attr.trim().toLowerCase();
    if (v === '' || v === 'true' || v === 'plaintext-only') return true;
    if (v === 'false') return false;
  }
  return false;
}

/**
 * The editing host that owns `el`: the topmost contiguous editable ancestor (the closest editable element,
 * then up while the parent is still editable). A click inside a `contenteditable="false"` chip resolves to the
 * surrounding editor; a nested editable island inside such a chip is its own host.
 */
export function editingHost(el: Element): HTMLElement | null {
  let n: Element | null = el;
  while (n && !isEditableElement(n)) n = n.parentElement;
  if (!n) return null;
  let host: Element = n;
  for (let p = host.parentElement; p && isEditableElement(p); p = p.parentElement) host = p;
  return host as HTMLElement;
}

function resolveElement(target: EventTarget | null): Element | null {
  if (!target) return null;
  const maybeWindow = target as Partial<Window>;
  if (maybeWindow.window === target && maybeWindow.document && (maybeWindow.document as Node).nodeType === DOCUMENT_NODE) {
    return deepActiveElement(maybeWindow.document);
  }
  const node = target as Node;
  if (typeof node.nodeType !== 'number') return null;
  if (node.nodeType === DOCUMENT_NODE) return deepActiveElement(node as Document);
  if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
    const active = (node as ShadowRoot).activeElement;
    return active ? descendActive(active) : null;
  }
  if (node.nodeType === ELEMENT_NODE) return descendActive(node as Element);
  return node.parentElement ? descendActive(node.parentElement) : null;
}

/**
 * The field behind an event target: a textarea or input itself, or the contenteditable root that contains
 * the target. Accepts an element (including a shadow host, which is descended through `shadowRoot.activeElement`),
 * a Text node, a ShadowRoot, a Document or a Window (resolved to the deep active element). Returns null when
 * nothing editable is involved.
 */
export function findEditable(target: EventTarget | null): HTMLElement | null {
  const el = resolveElement(target);
  if (!el) return null;
  if (isTextarea(el) || isInput(el)) return el;
  return editingHost(el);
}

/** `findEditable` on the real (composed) target of an event, so focus inside open shadow roots is seen. */
export function editableFromEvent(ev: Event): HTMLElement | null {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  return findEditable(path[0] ?? ev.target);
}

// ---------------------------------------------------------------------------
// Kind and eligibility rules
// ---------------------------------------------------------------------------

/** The adapter kind an element would get, or null when it is not an editable field at all. */
export function kindOf(el: Element): FieldKind | null {
  if (isTextarea(el)) return 'textarea';
  if (isInput(el)) return 'input';
  if (isEditableElement(el)) return 'contenteditable';
  return null;
}

export function isEligibleKind(el: Element): boolean {
  return kindOf(el) !== null;
}

/** Input-specific rules: type, autocomplete tokens and inputmode. Null when the input passes. */
export function inputEligibility(el: HTMLInputElement): IneligibleReason | null {
  const type = (el.type || 'text').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') ?? '').trim().toLowerCase();
  if (type === 'password') return 'password';
  // A revealed password field keeps its autocomplete token while its type is toggled to "text".
  if (PASSWORD_AUTOCOMPLETE_RE.test(autocomplete)) return 'password';
  if (SENSITIVE_INPUT_TYPES.has(type)) return 'sensitive-input';
  if (!ELIGIBLE_INPUT_TYPES.has(type)) return 'not-editable';
  if (SENSITIVE_AUTOCOMPLETE_RE.test(autocomplete)) return 'sensitive-input';
  const inputmode = (el.getAttribute('inputmode') ?? '').trim().toLowerCase();
  if (SENSITIVE_INPUTMODES.has(inputmode)) return 'sensitive-input';
  return null;
}

export function isReadOnly(el: Element): boolean {
  if (isTextarea(el) || isInput(el)) {
    if (el.readOnly || el.disabled) return true;
    if (safeMatches(el, ':disabled')) return true;
  }
  return el.getAttribute('aria-readonly') === 'true';
}

function frameElementOf(doc: Document): Element | null {
  try {
    return (doc.defaultView?.frameElement as Element | null | undefined) ?? null;
  } catch {
    return null; // cross-origin parent
  }
}

/** Google Docs' hidden contenteditable key sink (inside `iframe.docs-texteventtarget-iframe`) and kix internals. */
export function isGoogleDocsSink(el: Element): boolean {
  const frame = frameElementOf(el.ownerDocument);
  if (frame && frame.classList.contains(GDOCS_SINK_FRAME_CLASS)) return true;
  return safeClosest(el, GDOCS_SINK_SELECTOR) !== null;
}

/** Code editors by selector (self or ancestor), plus elements bound to an EditContext (their DOM is not the model). */
export function isCodeEditor(el: Element): boolean {
  if (safeClosest(el, CODE_EDITOR_SELECTOR)) return true;
  const withEditContext = el as Element & { editContext?: unknown };
  return 'editContext' in withEditContext && withEditContext.editContext != null;
}

function attrIsTrue(v: string | null): boolean {
  return v !== null && v.trim().toLowerCase() === 'true';
}

function attrIsFalse(v: string | null): boolean {
  return v !== null && v.trim().toLowerCase() === 'false';
}

function hasOptOutAttribute(el: Element): boolean {
  for (const name of OPT_OUT_PRESENCE_ATTRS) {
    const v = el.getAttribute(name);
    if (v !== null && !attrIsTrue(v)) return true;
  }
  return attrIsFalse(el.getAttribute('data-enable-grammarly')) || attrIsFalse(el.getAttribute('data-lt-active'));
}

function hasOptInAttribute(el: Element): boolean {
  return attrIsTrue(el.getAttribute('data-enable-grammarly')) || attrIsTrue(el.getAttribute('data-jammarly'));
}

/**
 * The opt-out union (research 09 §1.6): walking from the field upward (never looking at `<html>`, which
 * carries Jammarly's own instance markers), the closest element with a decisive marker wins. Opt-in markers
 * (`data-enable-grammarly="true"`, `data-jammarly="true"`) beat opt-out markers on the same element.
 * `spellcheck="false"` is never an opt-out.
 */
export function optOutState(el: Element): OptOutState {
  const docEl = el.ownerDocument.documentElement;
  for (let n: Element | null = el; n && n !== docEl; n = n.parentElement) {
    if (hasOptInAttribute(n)) return 'opted-in';
    if (hasOptOutAttribute(n)) return 'opted-out';
  }
  return 'none';
}

export function isOptedOut(el: Element): boolean {
  return optOutState(el) === 'opted-out';
}

/** Size of the field's client box, falling back to the bounding box for inline boxes (clientWidth is 0 for them). */
export function fieldSize(el: Element): { width: number; height: number } {
  let width = el.clientWidth;
  let height = el.clientHeight;
  if (width === 0 && height === 0 && typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    width = r.width;
    height = r.height;
  }
  return { width, height };
}

export function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  const cs = safeComputedStyle(el);
  if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
  const { width, height } = fieldSize(el);
  return width === 0 && height === 0;
}

export function meetsSizeGate(el: Element): boolean {
  const { width, height } = fieldSize(el);
  return width >= MIN_FIELD_WIDTH && height >= MIN_FIELD_HEIGHT;
}

/** True when an input's maxlength is small enough to mark it as a code/token field. */
export function hasShortMaxLength(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  const raw = el.getAttribute('maxlength');
  if (raw === null) return false;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= MAX_SHORT_INPUT_LENGTH;
}

/** Pure: the floating button is anchored outside fields shorter than SMALL_FIELD_HEIGHT. */
export function isSmallField(box: { height: number }): boolean {
  return box.height < SMALL_FIELD_HEIGHT;
}

/**
 * Apply every eligibility rule in order (cheap and permanent reasons first, so a Monaco textarea reports
 * "code-editor" rather than "too-small" and the Docs sink reports "gdocs-input-sink" rather than "hidden"):
 * kind → input type/autocomplete → readonly → Docs sink → code editor → opt-out → hidden → size gate.
 */
export function classify(el: HTMLElement, opts: ClassifyOptions): Classification {
  const kind = kindOf(el);
  if (!kind) return { ok: false, reason: 'not-editable' };
  if (kind === 'input') {
    const reason = inputEligibility(el as HTMLInputElement);
    if (reason) return { ok: false, reason };
  }
  if (isReadOnly(el)) return { ok: false, reason: 'readonly' };
  if (isGoogleDocsSink(el)) return { ok: false, reason: 'gdocs-input-sink' };
  if (isCodeEditor(el)) return { ok: false, reason: 'code-editor' };
  if (!opts.checkOptedOutFields && !opts.ignoreSiteOptOut && isOptedOut(el)) return { ok: false, reason: 'opted-out' };
  if (isHidden(el)) return { ok: false, reason: 'hidden' };
  if (!meetsSizeGate(el)) return { ok: false, reason: 'too-small' };
  if (kind === 'input' && hasShortMaxLength(el as HTMLInputElement)) return { ok: false, reason: 'too-small' };
  return { ok: true, kind };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Classify a field's descriptive text (aria-label, placeholder, name, labels) into the panel's short labels. Pure. */
export function classifyLabelText(text: string, searchHint = false): FieldLabel {
  const t = text.toLowerCase();
  if (/\bsubject/.test(t)) return 'Subject';
  if (searchHint || /\bsearch/.test(t)) return 'Search';
  if (/\brepl(y|ies|ying)\b/.test(t)) return 'Reply';
  if (/\bcomment/.test(t)) return 'Comment';
  if (/\bpost\b|\btweet\b|what'?s on your mind|what'?s happening|what is happening|share an update|start a post/.test(t)) return 'Post';
  if (/\b(message|body|compose|email|mail)\b/.test(t)) return 'Message body';
  return 'Text field';
}

function describingText(el: HTMLElement): string {
  const parts: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && v.trim()) parts.push(v.trim());
  };
  push(el.getAttribute('aria-label'));
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      if (!id) continue;
      const ref = el.ownerDocument.getElementById(id);
      push(ref?.textContent);
    }
  }
  push(el.getAttribute('placeholder'));
  push(el.getAttribute('aria-placeholder'));
  push(el.getAttribute('data-placeholder'));
  push(el.getAttribute('title'));
  push(el.getAttribute('name'));
  push(el.id);
  const labels = (el as HTMLTextAreaElement | HTMLInputElement).labels;
  if (labels) for (const label of Array.from(labels)) push(label.textContent);
  return parts.join(' ');
}

/**
 * Short human label for the panel: "Message body" for the profile's body selectors, then "Subject", "Search",
 * "Reply", "Comment", "Post" or "Message body" from the field's descriptive text, else "Text field".
 */
export function fieldLabel(el: HTMLElement, profile?: Pick<SiteProfile, 'bodySelectors'> | null): FieldLabel {
  if (profile) {
    for (const selector of profile.bodySelectors) if (safeMatches(el, selector)) return 'Message body';
  }
  if (isInput(el) && el.type === 'search') return 'Search';
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  if (role === 'searchbox') return 'Search';
  return classifyLabelText(describingText(el), role === 'combobox');
}
