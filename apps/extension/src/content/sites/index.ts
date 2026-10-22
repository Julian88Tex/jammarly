/**
 * Site profiles (ARCHITECTURE §3.4): `resolveProfile` picks the host-specific profile first, then a framework
 * profile from DOM markers on the field or its ancestors, then the generic fallback, with the writing context
 * inferred from the host map when the profile itself does not fix it.
 */
import type { SiteProfile } from '../field-adapter';
import { hostContext, normalizeHost } from './base';
import { discord } from './discord';
import { facebook } from './facebook';
import { detectFramework, frameworkProfile } from './frameworks';
import { generic, genericFor } from './generic';
import { github } from './github';
import { gmail } from './gmail';
import { linkedin } from './linkedin';
import { notion } from './notion';
import { prosemirror, prosemirrorChat, prosemirrorFor } from './prosemirror';
import { reddit } from './reddit';
import { slack } from './slack';
import { slashy } from './slashy';
import { superhuman } from './superhuman';
import { twitter } from './twitter';
import { gutenberg } from './wordpress';

export { GENERIC_LADDER, HOST_CONTEXTS, defineProfile, genericDocHint, hostContext, hostIs, hostMatchesPattern, normalizeHost, withContext } from './base';
export { FRAMEWORKS, PROSEMIRROR_PROTECTED, detectFramework, frameworkProfile, isDraftJsRoot, type FrameworkId } from './frameworks';
export { gmail, GMAIL_BODY_SELECTOR, GMAIL_SUBJECT_SELECTOR, gmailDocHint } from './gmail';
export { superhuman, superhumanDocHint } from './superhuman';
export { slashy, slashyDocHint } from './slashy';
export { slack, slackDocHint } from './slack';
export { discord, discordDocHint } from './discord';
export { twitter, twitterDocHint } from './twitter';
export { facebook, facebookDocHint } from './facebook';
export { linkedin, linkedinDocHint } from './linkedin';
export { notion, notionDocHint } from './notion';
export { prosemirror, prosemirrorChat, prosemirrorDocHint, prosemirrorFor, PROSEMIRROR_CHAT_HOSTS, PROSEMIRROR_DOC_HOSTS } from './prosemirror';
export { gutenberg, wordpressDocHint } from './wordpress';
export { reddit, redditDocHint } from './reddit';
export { github, githubDocHint } from './github';
export { generic, genericFor } from './generic';

/** Host-specific profiles in match order (the first whose `matches(host)` is true wins). */
export const SITE_PROFILES: readonly SiteProfile[] = [
  gmail,
  superhuman,
  slashy,
  slack,
  discord,
  twitter,
  facebook,
  linkedin,
  notion,
  prosemirrorChat,
  prosemirror,
  gutenberg,
  reddit,
  github,
];

/** The host-specific profile for `host`, or null. */
export function profileForHost(host: string): SiteProfile | null {
  const h = normalizeHost(host);
  for (const p of SITE_PROFILES) if (p.matches(h)) return p;
  return null;
}

/**
 * Host-specific profile → framework profile from markers on `el`/ancestors (context from the host map) →
 * generic (context from the host map, else "other").
 */
export function resolveProfile(host: string, el: HTMLElement): SiteProfile {
  const byHost = profileForHost(host);
  if (byHost) return byHost;
  const context = hostContext(host);
  const framework = detectFramework(el);
  if (framework === 'prosemirror') return prosemirrorFor(context);
  if (framework) return frameworkProfile(framework, context);
  return context === 'other' ? generic : genericFor(context);
}
