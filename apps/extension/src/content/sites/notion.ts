/**
 * Notion (notion.so, notion.site). Custom controlled contenteditable per block (`[data-content-editable-leaf]`):
 * execCommand within one block is re-read by Notion, text/plain paste is the fallback (its paste handler is
 * markdown-aware). Mentions, dates and equations are `contenteditable="false"` chips. Documents: slightly slower
 * cadence (fast ×1.2, deep ×1.3).
 */
import { defineProfile, firstMatch, hostIs } from './base';

const PAGE_PATTERNS: readonly RegExp[] = [/([0-9a-f]{32})(?:[/?#]|$)/i];

/** Pure: the 32-hex page id from the path (or the peek "p=" query), else "". */
export function notionDocHint(pathname: string, search: string): string {
  const id = firstMatch(search, [/[?&]p=([0-9a-f]{32})/i]) || firstMatch(pathname, PAGE_PATTERNS);
  return id ? `notion:${id.toLowerCase()}` : '';
}

export const notion = defineProfile({
  id: 'notion',
  matches: hostIs('notion.so', '*.notion.so', 'notion.site', '*.notion.site'),
  context: 'doc',
  fastPassMultiplier: 1.2,
  deepPassMultiplier: 1.3,
  ladder: ['execCommand', 'paste', 'splice'],
  protectedSelectors: ['[contenteditable="false"]'],
  bodySelectors: ['[data-content-editable-leaf="true"]'],
  docHint: (location) => notionDocHint(location.pathname, location.search),
});
