/**
 * Device-side redaction of feedback-event snippets (research 08 §8.1). Runs before anything is
 * buffered: e-mail addresses, URLs, phone numbers, long digit runs and IBAN/card-shaped strings are
 * replaced by fixed tokens, then the text is cut on a word boundary with an ellipsis.
 *
 * Pure string functions: no DOM, no chrome.*, no side effects at import.
 */
import type { FieldKind } from './types';

export const REDACTION_TOKENS = {
  email: '‹email›',
  url: '‹url›',
  phone: '‹phone›',
  num: '‹num›',
} as const;

export const SNIPPET_MAX = 200;
export const SENTENCE_MAX = 280;

// Order matters: scheme URLs first (they may contain @ and digits), then e-mails, then bare domains,
// then account-number shapes, then phones, then any remaining long digit run.
const SCHEME_URL_RE = /(?:https?:\/\/|ftps?:\/\/|mailto:|www\.)[^\s<>"'‹›()[\]{}]+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const BARE_DOMAIN_RE =
  /(?<![\p{L}\p{N}@/.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:com|org|net|io|dev|co|edu|gov|app|ai|me|info|biz|uk|de|fr|ca|au|in|us|ly|to|tv|xyz|sh|gg|so|ch|nl|se|no|es|it|jp|cn|br|ru|eu)(?![\p{L}\p{N}-])(?:\/[^\s<>"'‹›()[\]{}]*)?/giu;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const CARD_RE = /\b(?:\d[ -]?){12}\d{1,7}\b/g;
const PHONE_RES: readonly RegExp[] = [
  /\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){5,12}/g, // +1 (415) 555-2671, +44 20 7946 0958, +919876543210
  /\(\d{2,5}\)[\s.-]?\d(?:[\s.-]?\d){5,10}/g, // (415) 555-2671
  /\b\d{2,5}[\s.-]\d{3,5}[\s.-]\d{3,5}\b/g, // 415-555-2671, 020 7946 0958, 415.555.2671
  /\b\d{5}[\s.-]\d{5}\b/g, // 98765 43210
];
const DIGIT_RUN_RE = /\d{6,}/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TRAILING_URL_PUNCT_RE = /[.,;:!?]+$/u;

/** Replace every sensitive shape in `text` with its token. No truncation, no whitespace changes. */
export function redactText(text: string): string {
  let out = text.replace(CONTROL_RE, '');
  out = out.replace(SCHEME_URL_RE, (m) => {
    const trailing = TRAILING_URL_PUNCT_RE.exec(m)?.[0] ?? '';
    return REDACTION_TOKENS.url + trailing;
  });
  out = out.replace(EMAIL_RE, REDACTION_TOKENS.email);
  out = out.replace(BARE_DOMAIN_RE, (m) => {
    const trailing = TRAILING_URL_PUNCT_RE.exec(m)?.[0] ?? '';
    return REDACTION_TOKENS.url + trailing;
  });
  out = out.replace(IBAN_RE, REDACTION_TOKENS.num);
  out = out.replace(CARD_RE, REDACTION_TOKENS.num);
  for (const re of PHONE_RES) {
    out = out.replace(re, (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 7 && digits <= 15 ? REDACTION_TOKENS.phone : m;
    });
  }
  out = out.replace(DIGIT_RUN_RE, REDACTION_TOKENS.num);
  return out;
}

/**
 * Cut `text` to at most `max` characters, preferring a word boundary, never splitting a surrogate
 * pair or a `‹token›`, and appending an ellipsis when something was removed.
 */
export function truncateAtWord(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const limit = Math.max(1, max - ellipsis.length);
  let cut = text.slice(0, limit);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  const ws = cut.lastIndexOf(' ');
  if (ws >= Math.floor(limit / 2)) cut = cut.slice(0, ws);
  const open = cut.lastIndexOf('‹');
  const close = cut.lastIndexOf('›');
  if (open > close) cut = cut.slice(0, open);
  cut = cut.replace(/[\s,;:.!?\-–—(\[{"'‘“«]+$/u, '');
  if (cut.length === 0) cut = text.slice(0, limit).trimEnd();
  return cut + ellipsis;
}

/** Collapse whitespace, redact, truncate: the form every `original` / `replacement` / `final` snippet takes. */
export function redactSnippet(text: string, max = SNIPPET_MAX): string {
  const collapsed = text.replace(CONTROL_RE, '').replace(/\s+/gu, ' ').trim();
  return truncateAtWord(redactText(collapsed), max);
}

/** Same as redactSnippet with the sentence budget (280 chars). */
export function redactSentence(text: string, max = SENTENCE_MAX): string {
  return redactSnippet(text, max);
}

/** Lowercase, strip scheme / path / port / leading dots and wildcards. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.replace(/[/?#].*$/, '');
  h = h.replace(/:\d+$/, '');
  h = h.replace(/^\*?\.+/, '');
  h = h.replace(/\.+$/, '');
  return h;
}

/**
 * Suffix match against the user's private-site list: `mail.google.com` matches `google.com` and
 * `mail.google.com`, never `gle.com`. Entries may carry a scheme, a port, a path or a `*.` prefix.
 */
export function isSensitiveHost(host: string, privateSites: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (h.length === 0) return false;
  for (const site of privateSites) {
    const s = normalizeHost(site);
    if (s.length === 0) continue;
    if (h === s || h.endsWith(`.${s}`)) return true;
  }
  return false;
}

/** Input types whose contents are never stored (08 §8.1). */
export const SENSITIVE_INPUT_TYPES: ReadonlySet<string> = new Set(['password', 'email', 'tel', 'number', 'url', 'hidden']);
/** autocomplete tokens whose contents are never stored. */
export const SENSITIVE_AUTOCOMPLETE_PREFIXES: readonly string[] = ['cc-', 'one-time-code', 'current-password', 'new-password', 'tel', 'email'];

export interface ShouldStoreSnippetOptions {
  storeSnippets: boolean;
  host: string;
  privateSites: readonly string[];
  fieldKind: FieldKind;
  inputType?: string;
  autocomplete?: string;
}

/**
 * Whether a feedback event from this field may carry text snippets. Counters are always kept; this
 * only decides whether `original`, `replacement`, `final` and `sentence` are populated.
 */
export function shouldStoreSnippet(opts: ShouldStoreSnippetOptions): boolean {
  if (!opts.storeSnippets) return false;
  if (isSensitiveHost(opts.host, opts.privateSites)) return false;
  const inputType = opts.inputType?.trim().toLowerCase() ?? '';
  if (inputType.length > 0 && SENSITIVE_INPUT_TYPES.has(inputType)) return false;
  const autocomplete = opts.autocomplete?.trim().toLowerCase() ?? '';
  if (autocomplete.length > 0) {
    for (const token of autocomplete.split(/\s+/)) {
      for (const prefix of SENSITIVE_AUTOCOMPLETE_PREFIXES) {
        if (token === prefix || token.startsWith(prefix)) return false;
      }
    }
  }
  return true;
}
