/**
 * GitHub. Comment and description boxes are textareas (markdown); the textarea adapter applies execCommand with
 * the React-safe native-setter splice as fallback. Context "code" means prose fields only (code editors are never
 * eligible; the engine masks fenced code).
 */
import { defineProfile, GENERIC_LADDER, hostIs } from './base';

const ISSUE_RE = /^\/([^/]+)\/([^/]+)\/(?:issues|pull|discussions)\/(\d+)/;

/** Pure: "github:<owner>/<repo>#<number>" for issue/PR/discussion pages, else "". */
export function githubDocHint(pathname: string): string {
  const m = ISSUE_RE.exec(pathname);
  return m && m[1] && m[2] && m[3] ? `github:${m[1]}/${m[2]}#${m[3]}` : '';
}

export const github = defineProfile({
  id: 'github',
  matches: hostIs('github.com', '*.github.com'),
  context: 'code',
  ladder: GENERIC_LADDER,
  protectedSelectors: [],
  bodySelectors: ['textarea[name="comment[body]"]', '#new_comment_field', 'textarea[name="issue[body]"]', 'textarea[name="pull_request[body]"]'],
  docHint: (location) => githubDocHint(location.pathname),
});
