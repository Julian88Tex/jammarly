/**
 * Slashy (www.slashy.com / slashy.com, path-based app; research 09 §1.5). Gmail-compatible single-letter shortcuts
 * (shortcut-safe), compose editor technology unknown (generic ladder), email context, slower cadence like Superhuman.
 */
import { defineProfile, firstMatch, GENERIC_LADDER, hostIs } from './base';

// The id must not itself be one of the path keywords ("/mail/thread/<id>" names the thread, not "thread").
const THREAD_PATTERNS: readonly RegExp[] = [
  /\/(?:threads?|conversations?|mail|messages?)\/(?!(?:threads?|conversations?|mail|messages?)(?:[/?#]|$))([A-Za-z0-9_-]{6,})/,
  /[?&](?:thread|threadId|conversation|id)=([A-Za-z0-9_-]{6,})/,
];

/** Pure: thread id from the URL, else "". */
export function slashyDocHint(pathname: string, search: string): string {
  const id = firstMatch(pathname, THREAD_PATTERNS) || firstMatch(search, THREAD_PATTERNS);
  return id ? `slashy:thread:${id}` : '';
}

export const slashy = defineProfile({
  id: 'slashy',
  matches: hostIs('slashy.com', '*.slashy.com'),
  context: 'email',
  shortcutSafe: true,
  fastPassMultiplier: 1.3,
  deepPassMultiplier: 1.6,
  ladder: GENERIC_LADDER,
  protectedSelectors: ['blockquote', '[contenteditable="false"]'],
  bodySelectors: ['[contenteditable="true"][role="textbox"]'],
  docHint: (location) => slashyDocHint(location.pathname, location.search),
});
