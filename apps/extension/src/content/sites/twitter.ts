/**
 * X / Twitter (x.com, twitter.com). Draft.js composer (`.public-DraftEditor-content`): the adapter syncs the DOM
 * selection (selectionchange + animation frames) before execCommand, which Draft reads back per leaf; synthetic
 * beforeinput is not handled, paste is the fallback. Hashtags/mentions are decorator leaves (not separately protected).
 */
import { defineProfile, firstMatch, hostIs } from './base';

const STATUS_RE = /\/status(?:es)?\/(\d+)/;

/** Pure: the post being replied to or quoted, else "" (a fresh compose). */
export function twitterDocHint(pathname: string, search: string): string {
  const id = firstMatch(pathname, [STATUS_RE]) || firstMatch(search, [/[?&](?:in_reply_to|quote)=(\d+)/]);
  return id ? `x:status:${id}` : '';
}

export const twitter = defineProfile({
  id: 'twitter',
  matches: hostIs('x.com', '*.x.com', 'twitter.com', '*.twitter.com'),
  context: 'social',
  ladder: ['execCommand', 'paste', 'splice'],
  protectedSelectors: [],
  bodySelectors: ['.public-DraftEditor-content'],
  docHint: (location) => twitterDocHint(location.pathname, location.search),
});
