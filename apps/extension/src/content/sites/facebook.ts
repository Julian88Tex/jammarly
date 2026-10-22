/**
 * Facebook, Threads, Instagram, Messenger. Lexical editors (`[data-lexical-editor="true"]`): execCommand is reverted
 * within ~100 ms, beforeinput insertReplacementText is the path Grammarly uses; decorators are opaque.
 */
import { defineProfile, firstMatch, hostIs } from './base';

const POST_PATTERNS: readonly RegExp[] = [/\/(?:posts|post|permalink|t|p|reel|reels|videos)\/([A-Za-z0-9_-]{5,})/];

/** Pure: the post/thread id from the URL, else "" (feed composer). */
export function facebookDocHint(pathname: string, search: string): string {
  const id = firstMatch(pathname, POST_PATTERNS) || firstMatch(search, [/[?&](?:story_fbid|fbid|comment_id)=(\d+)/]);
  return id ? `fb:${id}` : '';
}

export const facebook = defineProfile({
  id: 'facebook',
  matches: hostIs(
    'facebook.com',
    '*.facebook.com',
    'messenger.com',
    '*.messenger.com',
    'threads.net',
    '*.threads.net',
    'threads.com',
    '*.threads.com',
    'instagram.com',
    '*.instagram.com',
  ),
  context: 'social',
  ladder: ['beforeinput', 'paste', 'splice'],
  protectedSelectors: ['[data-lexical-decorator]'],
  bodySelectors: ['[data-lexical-editor="true"]'],
  docHint: (location) => facebookDocHint(location.pathname, location.search),
});
