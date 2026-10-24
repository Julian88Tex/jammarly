/**
 * Slack (app.slack.com). Quill composer (`.ql-editor`): beforeinput with a non-collapsed target range is handled by
 * Quill's Input module, otherwise execCommand is read back by its MutationObserver. Slack's composer carries
 * `data-gramm="false"` (w3c/editing#551), so the profile ignores the site opt-out. Mentions, emoji and channel
 * links are `contenteditable="false"` embeds.
 */
import { defineProfile, firstMatch, hostIs } from './base';

const CHANNEL_PATTERNS: readonly RegExp[] = [/\/client\/[A-Z0-9]+\/([A-Z0-9]+)/, /\/archives\/([A-Z0-9]+)/];

/** Pure: channel or conversation id from the URL, else "". */
export function slackDocHint(pathname: string): string {
  const id = firstMatch(pathname, CHANNEL_PATTERNS);
  return id ? `slack:${id}` : '';
}

export const slack = defineProfile({
  id: 'slack',
  matches: hostIs('app.slack.com'),
  context: 'chat',
  ignoreOptOut: true,
  ladder: ['beforeinput', 'execCommand', 'paste', 'splice'],
  protectedSelectors: ['[contenteditable="false"]'],
  bodySelectors: ['.ql-editor[contenteditable="true"]'],
  docHint: (location) => slackDocHint(location.pathname),
});
