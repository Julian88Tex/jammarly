/**
 * Shared building blocks for site profiles: defaults, hostname matching, URL-derived document hints and the
 * host → writing-context map (research 08 §8.2 plus the 09 additions).
 */
import type { WritingContext } from '@jammarly/shared/types';
import type { SiteProfile } from '../field-adapter';

export type Ladder = SiteProfile['ladder'];
export type Rung = Ladder[number];

/** The fallback ladder for unknown contenteditable hosts (ARCHITECTURE §3.4). */
export const GENERIC_LADDER: Ladder = ['execCommand', 'beforeinput', 'paste', 'splice'];

type ProfileInit = Pick<SiteProfile, 'id' | 'matches'> & Partial<Omit<SiteProfile, 'id' | 'matches'>>;

/** Fill a profile's defaults; arrays are copied so profiles never share mutable state. */
export function defineProfile(init: ProfileInit): SiteProfile {
  return {
    id: init.id,
    matches: init.matches,
    context: init.context ?? 'other',
    shortcutSafe: init.shortcutSafe ?? false,
    ignoreOptOut: init.ignoreOptOut ?? false,
    fastPassMultiplier: init.fastPassMultiplier ?? 1,
    deepPassMultiplier: init.deepPassMultiplier ?? 1,
    ladder: [...(init.ladder ?? GENERIC_LADDER)],
    protectedSelectors: [...(init.protectedSelectors ?? [])],
    bodySelectors: [...(init.bodySelectors ?? [])],
    docHint: init.docHint ?? (() => ''),
  };
}

/** A copy of `profile` with a different writing context (same id, same ladder). */
export function withContext(profile: SiteProfile, context: WritingContext): SiteProfile {
  return profile.context === context ? profile : { ...defineProfile(profile), context };
}

/** Lower-case, no trailing dot, no leading "www.". */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/** `example.com` matches exactly (after normalization); `*.example.com` matches the apex and every subdomain. */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const apex = p.slice(2);
    return h === apex || h.endsWith('.' + apex);
  }
  return h === p;
}

export function hostIs(...patterns: string[]): (host: string) => boolean {
  return (host: string) => patterns.some((p) => hostMatchesPattern(host, p));
}

/** First capture group of the first pattern that matches, else "". */
export function firstMatch(s: string, patterns: readonly RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(s);
    if (m && m[1]) return m[1];
  }
  return '';
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const LONG_NUMBER_RE = /(?:^|\/)(\d{5,})(?:\/|$)/;

/**
 * Best-effort document hint for hosts without a dedicated profile: a UUID or a long numeric id in the path.
 * Used only to scope dismissal memory; "" means "per field path on this origin".
 */
export function genericDocHint(location: Pick<Location, 'pathname'>): string {
  const path = location.pathname;
  const uuid = UUID_RE.exec(path);
  if (uuid && uuid[1]) return `path:${uuid[1].toLowerCase()}`;
  const num = LONG_NUMBER_RE.exec(path);
  if (num && num[1]) return `path:${num[1]}`;
  return '';
}

/**
 * HOST → CTX defaults (08 §8.2) plus the 09 additions (Slashy is email; AI chat hosts are chat; Threads,
 * Bluesky and Instagram are social). Patterns are matched after `normalizeHost`, so "facebook.com" also
 * covers "www.facebook.com". The first match wins.
 */
export const HOST_CONTEXTS: ReadonlyArray<readonly [pattern: string, context: WritingContext]> = [
  // email
  ['mail.google.com', 'email'],
  ['mail.superhuman.com', 'email'],
  ['outlook.live.com', 'email'],
  ['outlook.office.com', 'email'],
  ['outlook.office365.com', 'email'],
  ['app.hey.com', 'email'],
  ['mail.proton.me', 'email'],
  ['mail.yahoo.com', 'email'],
  ['app.fastmail.com', 'email'],
  ['mail.zoho.com', 'email'],
  ['mail.aol.com', 'email'],
  ['slashy.com', 'email'],
  ['*.slashy.com', 'email'],
  // chat
  ['app.slack.com', 'chat'],
  ['discord.com', 'chat'],
  ['*.discord.com', 'chat'],
  ['teams.microsoft.com', 'chat'],
  ['teams.live.com', 'chat'],
  ['web.whatsapp.com', 'chat'],
  ['web.telegram.org', 'chat'],
  ['messages.google.com', 'chat'],
  ['claude.ai', 'chat'],
  ['chatgpt.com', 'chat'],
  ['chat.openai.com', 'chat'],
  ['gemini.google.com', 'chat'],
  ['perplexity.ai', 'chat'],
  ['chat.mistral.ai', 'chat'],
  ['poe.com', 'chat'],
  ['copilot.microsoft.com', 'chat'],
  ['meta.ai', 'chat'],
  ['chat.deepseek.com', 'chat'],
  ['grok.com', 'chat'],
  // doc
  ['docs.google.com', 'doc'],
  ['notion.so', 'doc'],
  ['*.notion.so', 'doc'],
  ['notion.site', 'doc'],
  ['*.notion.site', 'doc'],
  ['*.atlassian.net', 'doc'],
  ['docs.superhuman.com', 'doc'],
  ['coda.io', 'doc'],
  ['*.coda.io', 'doc'],
  ['paper.dropbox.com', 'doc'],
  ['dropbox.com', 'doc'],
  ['quip.com', 'doc'],
  ['*.quip.com', 'doc'],
  ['wordpress.com', 'doc'],
  ['*.wordpress.com', 'doc'],
  ['medium.com', 'doc'],
  ['substack.com', 'doc'],
  ['*.substack.com', 'doc'],
  // social
  ['linkedin.com', 'social'],
  ['*.linkedin.com', 'social'],
  ['x.com', 'social'],
  ['*.x.com', 'social'],
  ['twitter.com', 'social'],
  ['*.twitter.com', 'social'],
  ['facebook.com', 'social'],
  ['*.facebook.com', 'social'],
  ['messenger.com', 'social'],
  ['reddit.com', 'social'],
  ['*.reddit.com', 'social'],
  ['bsky.app', 'social'],
  ['threads.net', 'social'],
  ['*.threads.net', 'social'],
  ['threads.com', 'social'],
  ['*.threads.com', 'social'],
  ['instagram.com', 'social'],
  ['*.instagram.com', 'social'],
  ['mastodon.social', 'social'],
  ['news.ycombinator.com', 'social'],
  ['tiktok.com', 'social'],
  ['youtube.com', 'social'],
  ['tumblr.com', 'social'],
  ['quora.com', 'social'],
  // code (prose fields only; code editors themselves are never checked)
  ['github.com', 'code'],
  ['*.github.com', 'code'],
  ['gitlab.com', 'code'],
  ['*.gitlab.com', 'code'],
  ['bitbucket.org', 'code'],
];

/** Default writing context for a host; 'other' when unknown. */
export function hostContext(host: string): WritingContext {
  for (const [pattern, context] of HOST_CONTEXTS) if (hostMatchesPattern(host, pattern)) return context;
  return 'other';
}
