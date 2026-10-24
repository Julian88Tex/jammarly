/**
 * LinkedIn. Posts and comments use Quill (`.ql-editor`), messaging a plain contenteditable
 * (`.msg-form__contenteditable`). Same ladder and opt-out policy as Slack, social context.
 */
import { defineProfile, firstMatch, hostIs } from './base';

const PATTERNS: readonly [RegExp, string][] = [
  [/\/messaging\/thread\/([A-Za-z0-9_=-]{6,})/, 'thread'],
  [/\/feed\/update\/urn:li:(?:activity|share|ugcPost):(\d+)/, 'activity'],
  [/\/posts\/([A-Za-z0-9_-]{6,})/, 'post'],
  [/\/pulse\/([A-Za-z0-9_-]{6,})/, 'article'],
];

/** Pure: message thread / activity / post id from the URL, else "". */
export function linkedinDocHint(pathname: string): string {
  for (const [re, kind] of PATTERNS) {
    const id = firstMatch(pathname, [re]);
    if (id) return `linkedin:${kind}:${id}`;
  }
  return '';
}

export const linkedin = defineProfile({
  id: 'linkedin',
  matches: hostIs('linkedin.com', '*.linkedin.com'),
  context: 'social',
  ignoreOptOut: true,
  ladder: ['beforeinput', 'execCommand', 'paste', 'splice'],
  protectedSelectors: ['[contenteditable="false"]', '.ql-mention'],
  bodySelectors: ['.ql-editor[contenteditable="true"]', '.msg-form__contenteditable'],
  docHint: (location) => linkedinDocHint(location.pathname),
});
