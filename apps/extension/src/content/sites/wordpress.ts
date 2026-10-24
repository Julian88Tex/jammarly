/**
 * WordPress Gutenberg (`.block-editor-rich-text__editable`, often inside `iframe[name="editor-canvas"]`): RichText
 * re-reads the DOM on `input`, so execCommand works; synthetic beforeinput only opens an undo level and paste runs
 * through block transforms, so neither is in the ladder. Dedicated profile for wordpress.com; self-hosted sites are
 * caught by the framework marker.
 */
import { defineProfile, firstMatch, hostIs } from './base';

/** Pure: the post id from "post.php?post=123" or "/post/<site>/123", else "". */
export function wordpressDocHint(pathname: string, search: string): string {
  const id = firstMatch(search, [/[?&]post=(\d+)/]) || firstMatch(pathname, [/\/post\/[^/]+\/(\d+)/, /\/page\/[^/]+\/(\d+)/]);
  return id ? `wp:post:${id}` : '';
}

export const gutenberg = defineProfile({
  id: 'gutenberg',
  matches: hostIs('wordpress.com', '*.wordpress.com'),
  context: 'doc',
  ladder: ['execCommand', 'splice'],
  protectedSelectors: [],
  bodySelectors: ['.block-editor-rich-text__editable'],
  docHint: (location) => wordpressDocHint(location.pathname, location.search),
});
