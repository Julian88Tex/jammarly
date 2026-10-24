/**
 * Gmail (mail.google.com). Plain contenteditable compose body detected by `[g_editable="true"]` (the aria-label is
 * localized); the subject is `input[name="subjectbox"]`. Gmail ignores synthetic beforeinput (input-events#185), so
 * the ladder is execCommand → paste → splice. Quoted replies, signatures and Smart Compose ghost text are protected.
 * Gmail has single-letter shortcuts, so the card runs in shortcut-safe mode.
 */
import { defineProfile, firstMatch, hostIs } from './base';

export const GMAIL_BODY_SELECTOR = '[g_editable="true"][contenteditable]';
export const GMAIL_SUBJECT_SELECTOR = 'input[name="subjectbox"]';

const COMPOSE_RE = /[?&#]compose=([^&#]+)/;
/** Thread view: "#inbox/FMfcgzQbfVxxLq..." or "#label/My+Label/FMfc..." — the last long segment. */
const THREAD_RE = /\/([A-Za-z0-9_-]{12,})(?:\?|$)/;

/** Pure: the stable compose draft id (or thread id) from the URL hash/query, else "". "compose=new" is not stable. */
export function gmailDocHint(hash: string, search: string): string {
  const compose = firstMatch(hash, [COMPOSE_RE]) || firstMatch(search, [COMPOSE_RE]);
  if (compose && compose !== 'new') return `gmail:compose:${compose}`;
  const hashPath = hash.split('?')[0] ?? '';
  const thread = firstMatch(hashPath, [THREAD_RE]);
  return thread ? `gmail:thread:${thread}` : '';
}

export const gmail = defineProfile({
  id: 'gmail',
  matches: hostIs('mail.google.com'),
  context: 'email',
  shortcutSafe: true,
  ladder: ['execCommand', 'paste', 'splice'],
  protectedSelectors: ['.gmail_quote', '.gmail_signature', '[data-smartmail]'],
  bodySelectors: [GMAIL_BODY_SELECTOR],
  docHint: (location) => gmailDocHint(location.hash, location.search),
});
