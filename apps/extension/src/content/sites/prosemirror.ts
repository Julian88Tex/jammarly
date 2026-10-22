/**
 * ProseMirror / Tiptap hosts: Atlassian (Jira, Confluence), Substack, and the AI chat prompts of claude.ai and
 * ChatGPT (`#prompt-textarea` is a ProseMirror). PM re-parses DOM changes made by execCommand (readDOMChange) and
 * handles synthetic text/plain paste; it ignores synthetic beforeinput. Widgets, trailing breaks and separators are
 * protected. Documents by default; the chat hosts get the chat context.
 */
import type { WritingContext } from '@jammarly/shared/types';
import type { SiteProfile } from '../field-adapter';
import { defineProfile, firstMatch, hostIs, withContext } from './base';
import { PROSEMIRROR_PROTECTED } from './frameworks';

export const PROSEMIRROR_DOC_HOSTS: readonly string[] = ['*.atlassian.net', 'substack.com', '*.substack.com'];
export const PROSEMIRROR_CHAT_HOSTS: readonly string[] = ['claude.ai', 'chatgpt.com', 'chat.openai.com'];

const PATTERNS: readonly [RegExp, string][] = [
  [/\/browse\/([A-Z][A-Z0-9_]+-\d+)/, 'jira'],
  [/[?&]selectedIssue=([A-Z][A-Z0-9_]+-\d+)/, 'jira'],
  [/\/wiki\/.*\/pages\/(\d+)/, 'confluence'],
  [/\/(?:chat|c)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i, 'chat'],
  [/\/publish\/post\/(\d+)/, 'substack'],
];

/** Pure: Jira issue key, Confluence page id, chat conversation id or Substack post id, else "". */
export function prosemirrorDocHint(pathname: string, search: string): string {
  for (const [re, kind] of PATTERNS) {
    const id = firstMatch(pathname, [re]) || firstMatch(search, [re]);
    if (id) return `${kind}:${kind === 'chat' ? id.toLowerCase() : id}`;
  }
  return '';
}

const shared = {
  ladder: ['execCommand', 'paste', 'splice'] as SiteProfile['ladder'],
  protectedSelectors: [...PROSEMIRROR_PROTECTED],
  bodySelectors: ['.ProseMirror[contenteditable="true"]'],
  docHint: (location: Location) => prosemirrorDocHint(location.pathname, location.search),
};

export const prosemirror = defineProfile({
  id: 'prosemirror',
  matches: hostIs(...PROSEMIRROR_DOC_HOSTS),
  context: 'doc',
  ...shared,
});

export const prosemirrorChat = defineProfile({
  id: 'prosemirror-chat',
  matches: hostIs(...PROSEMIRROR_CHAT_HOSTS),
  context: 'chat',
  ...shared,
});

/** The ProseMirror profile for a context inferred from the host (chat hosts → the chat variant). */
export function prosemirrorFor(context: WritingContext): SiteProfile {
  if (context === 'chat') return prosemirrorChat;
  return withContext(prosemirror, context);
}
