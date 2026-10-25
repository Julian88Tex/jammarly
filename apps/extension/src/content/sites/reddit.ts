/**
 * Reddit. The rich composer is a Lexical editor inside the `<shreddit-composer>` shadow root (detection walks open
 * shadow roots; the marker is on the root itself); "Switch to Markdown Editor" and old.reddit.com use a plain
 * textarea, which the textarea adapter handles regardless of this ladder.
 */
import { defineProfile, firstMatch, hostIs } from './base';

/** Pure: the post id from "/r/<sub>/comments/<id>/...", else "". */
export function redditDocHint(pathname: string): string {
  const id = firstMatch(pathname, [/\/comments\/([a-z0-9]{4,})/i]);
  return id ? `reddit:${id.toLowerCase()}` : '';
}

export const reddit = defineProfile({
  id: 'reddit',
  matches: hostIs('reddit.com', '*.reddit.com'),
  context: 'social',
  ladder: ['beforeinput', 'paste', 'splice'],
  protectedSelectors: ['[data-lexical-decorator]'],
  bodySelectors: ['[data-lexical-editor="true"]', 'textarea[name="text"]', 'textarea[name="body"]'],
  docHint: (location) => redditDocHint(location.pathname),
});
