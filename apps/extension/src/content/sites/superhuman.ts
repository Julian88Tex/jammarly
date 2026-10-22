/**
 * Superhuman (mail.superhuman.com). The compose editor is Squire (research 09 §1.4): the DOM is the model, Squire's
 * `beforeinput` handler leaves insertText/insertReplacementText alone and it has its own paste handler and undo
 * stack, so plain execCommand persists; paste is the fallback. Keyboard-driven product: shortcut-safe, slower
 * cadence (fast ×1.3, deep ×1.6).
 */
import { defineProfile, firstMatch, hostIs } from './base';

const THREAD_PATTERNS: readonly RegExp[] = [/\/thread\/([A-Za-z0-9_-]{6,})/, /[?&]thread(?:Id)?=([A-Za-z0-9_-]{6,})/];

/** Pure: thread id from the URL, else "". */
export function superhumanDocHint(pathname: string, search: string): string {
  const id = firstMatch(pathname, THREAD_PATTERNS) || firstMatch(search, THREAD_PATTERNS);
  return id ? `superhuman:thread:${id}` : '';
}

export const superhuman = defineProfile({
  id: 'superhuman',
  matches: hostIs('mail.superhuman.com'),
  context: 'email',
  shortcutSafe: true,
  fastPassMultiplier: 1.3,
  deepPassMultiplier: 1.6,
  ladder: ['execCommand', 'paste', 'beforeinput', 'splice'],
  protectedSelectors: ['blockquote', '[contenteditable="false"]'],
  bodySelectors: ['[contenteditable="true"][role="textbox"]', '[contenteditable="true"][aria-multiline="true"]'],
  docHint: (location) => superhumanDocHint(location.pathname, location.search),
});
