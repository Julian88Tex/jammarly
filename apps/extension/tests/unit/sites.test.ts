import { afterEach, describe, expect, it } from 'vitest';
import {
  FRAMEWORKS,
  SITE_PROFILES,
  defineProfile,
  detectFramework,
  discord,
  discordDocHint,
  facebook,
  facebookDocHint,
  generic,
  genericDocHint,
  genericFor,
  github,
  githubDocHint,
  gmail,
  gmailDocHint,
  gutenberg,
  hostContext,
  hostMatchesPattern,
  linkedin,
  linkedinDocHint,
  normalizeHost,
  notion,
  notionDocHint,
  profileForHost,
  prosemirror,
  prosemirrorChat,
  prosemirrorDocHint,
  reddit,
  redditDocHint,
  resolveProfile,
  slack,
  slackDocHint,
  slashy,
  slashyDocHint,
  superhuman,
  superhumanDocHint,
  twitter,
  twitterDocHint,
  withContext,
  wordpressDocHint,
} from '../../src/content/sites';

const mounted: Element[] = [];

function el(html: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  mounted.push(wrap);
  return (wrap.querySelector('[data-root]') ?? wrap.firstElementChild) as HTMLElement;
}

function loc(url: string): Location {
  return new URL(url) as unknown as Location;
}

afterEach(() => {
  for (const e of mounted.splice(0)) e.remove();
});

const plain = () => el('<div contenteditable="true">x</div>');

describe('resolveProfile by host', () => {
  it('picks the dedicated profile for every supported host (www and subdomains included)', () => {
    const cases: [string, string][] = [
      ['mail.google.com', 'gmail'],
      ['mail.superhuman.com', 'superhuman'],
      ['www.slashy.com', 'slashy'],
      ['slashy.com', 'slashy'],
      ['app.slack.com', 'slack'],
      ['discord.com', 'discord'],
      ['canary.discord.com', 'discord'],
      ['ptb.discord.com', 'discord'],
      ['x.com', 'twitter'],
      ['twitter.com', 'twitter'],
      ['mobile.twitter.com', 'twitter'],
      ['www.facebook.com', 'facebook'],
      ['m.facebook.com', 'facebook'],
      ['www.threads.net', 'facebook'],
      ['www.threads.com', 'facebook'],
      ['www.instagram.com', 'facebook'],
      ['www.messenger.com', 'facebook'],
      ['www.linkedin.com', 'linkedin'],
      ['www.notion.so', 'notion'],
      ['acme.notion.site', 'notion'],
      ['claude.ai', 'prosemirror-chat'],
      ['chatgpt.com', 'prosemirror-chat'],
      ['chat.openai.com', 'prosemirror-chat'],
      ['acme.atlassian.net', 'prosemirror'],
      ['newsletter.substack.com', 'prosemirror'],
      ['myblog.wordpress.com', 'gutenberg'],
      ['www.reddit.com', 'reddit'],
      ['old.reddit.com', 'reddit'],
      ['github.com', 'github'],
      ['gist.github.com', 'github'],
    ];
    for (const [host, id] of cases) {
      expect(resolveProfile(host, plain()).id, host).toBe(id);
      expect(profileForHost(host)?.id, host).toBe(id);
    }
  });

  it('carries the designed contexts, shortcut safety, opt-out policy and multipliers', () => {
    expect(gmail.context).toBe('email');
    expect(gmail.shortcutSafe).toBe(true);
    expect(gmail.ladder).toEqual(['execCommand', 'paste', 'splice']);
    expect(gmail.protectedSelectors).toEqual(['.gmail_quote', '.gmail_signature', '[data-smartmail]']);

    expect(superhuman.context).toBe('email');
    expect(superhuman.shortcutSafe).toBe(true);
    expect(superhuman.fastPassMultiplier).toBe(1);
    expect(superhuman.deepPassMultiplier).toBe(1.2);
    expect(superhuman.ladder).toEqual(['execCommand', 'paste', 'beforeinput', 'splice']);

    expect(slashy.context).toBe('email');
    expect(slashy.shortcutSafe).toBe(true);
    expect(slashy.fastPassMultiplier).toBe(1);
    expect(slashy.deepPassMultiplier).toBe(1.2);
    expect(slashy.ladder).toEqual(['execCommand', 'beforeinput', 'paste', 'splice']);

    expect(slack.context).toBe('chat');
    expect(slack.ignoreOptOut).toBe(true);
    expect(slack.ladder).toEqual(['beforeinput', 'execCommand', 'paste', 'splice']);
    expect(slack.protectedSelectors).toEqual(['[contenteditable="false"]']);

    expect(discord.context).toBe('chat');
    expect(discord.ladder).toEqual(['beforeinput', 'paste', 'splice']);
    expect(discord.protectedSelectors).toEqual(['[data-slate-void]', '[data-slate-zero-width]']);

    expect(twitter.context).toBe('social');
    expect(twitter.ladder).toEqual(['execCommand', 'paste', 'splice']);

    expect(facebook.context).toBe('social');
    expect(facebook.ladder).toEqual(['beforeinput', 'paste', 'splice']);
    expect(facebook.protectedSelectors).toEqual(['[data-lexical-decorator]']);

    expect(linkedin.context).toBe('social');
    expect(linkedin.ladder).toEqual(slack.ladder);
    expect(linkedin.ignoreOptOut).toBe(true);

    expect(notion.context).toBe('doc');
    expect(notion.ladder).toEqual(['execCommand', 'paste', 'splice']);
    expect(notion.fastPassMultiplier).toBe(1.2);
    expect(notion.deepPassMultiplier).toBe(1.3);

    expect(prosemirror.context).toBe('doc');
    expect(prosemirrorChat.context).toBe('chat');
    expect(prosemirror.ladder).toEqual(['execCommand', 'paste', 'splice']);
    expect(prosemirror.protectedSelectors).toEqual(['.ProseMirror-widget', '.ProseMirror-trailingBreak', '.ProseMirror-separator']);

    expect(gutenberg.ladder).toEqual(['execCommand', 'splice']);
    expect(reddit.context).toBe('social');
    expect(reddit.ladder).toEqual(['beforeinput', 'paste', 'splice']);
    expect(github.context).toBe('code');
    expect(generic.context).toBe('other');
    expect(generic.ladder).toEqual(['execCommand', 'beforeinput', 'paste', 'splice']);

    for (const p of SITE_PROFILES) {
      expect(p.fastPassMultiplier).toBeGreaterThan(0);
      expect(p.deepPassMultiplier).toBeGreaterThan(0);
      expect(p.ladder.length).toBeGreaterThan(0);
      expect(p.ladder[p.ladder.length - 1]).toBe('splice');
    }
  });

  it('falls back to generic with the host-map context when the host has no profile', () => {
    const outlook = resolveProfile('outlook.live.com', plain());
    expect(outlook.id).toBe('generic');
    expect(outlook.context).toBe('email');
    expect(outlook.ladder).toEqual(generic.ladder);
    expect(resolveProfile('outlook.live.com', plain())).toBe(outlook); // stable identity per context

    const unknown = resolveProfile('example.org', plain());
    expect(unknown).toBe(generic);
    expect(unknown.context).toBe('other');
    expect(resolveProfile('teams.microsoft.com', plain()).context).toBe('chat');
    expect(resolveProfile('coda.io', plain()).context).toBe('doc');
    expect(resolveProfile('bsky.app', plain()).context).toBe('social');
    expect(resolveProfile('gitlab.com', plain()).context).toBe('code');
  });
});

describe('resolveProfile by framework marker', () => {
  it('recognises every framework marker on the root or an ancestor', () => {
    expect(detectFramework(el('<div class="public-DraftEditor-content" contenteditable="true"></div>'))).toBe('draftjs');
    expect(detectFramework(el('<div data-slate-editor="true" contenteditable="true"></div>'))).toBe('slate');
    expect(detectFramework(el('<div data-lexical-editor="true" contenteditable="true"></div>'))).toBe('lexical');
    expect(detectFramework(el('<div class="ql-editor" contenteditable="true"></div>'))).toBe('quill');
    expect(detectFramework(el('<div class="ProseMirror" contenteditable="true"></div>'))).toBe('prosemirror');
    expect(detectFramework(el('<div class="block-editor-rich-text__editable" contenteditable="true"></div>'))).toBe('gutenberg');
    expect(detectFramework(el('<div class="ql-container"><div data-root class="ql-editor" contenteditable="true"></div></div>'))).toBe('quill');
    expect(detectFramework(el('<div class="ProseMirror"><p data-root contenteditable="true"></p></div>'))).toBe('prosemirror');
    expect(detectFramework(plain())).toBeNull();
  });

  it('uses the framework ladder with the host context on unknown hosts', () => {
    const lexical = resolveProfile('example.com', el('<div data-lexical-editor="true" contenteditable="true"></div>'));
    expect(lexical.id).toBe('lexical');
    expect(lexical.context).toBe('other');
    expect(lexical.ladder).toEqual(FRAMEWORKS.lexical.ladder);
    expect(lexical.protectedSelectors).toEqual(['[data-lexical-decorator]']);

    const slate = resolveProfile('chat.example.com', el('<div data-slate-editor="true" contenteditable="true"></div>'));
    expect(slate.id).toBe('slate');
    expect(slate.ladder).toEqual(['beforeinput', 'paste', 'splice']);

    const quill = resolveProfile('example.com', el('<div class="ql-editor" contenteditable="true"></div>'));
    expect(quill.id).toBe('quill');
    expect(quill.ladder).toEqual(['beforeinput', 'execCommand', 'paste', 'splice']);

    const draft = resolveProfile('example.com', el('<div class="public-DraftEditor-content" contenteditable="true"></div>'));
    expect(draft.id).toBe('draftjs');
    expect(draft.ladder).toEqual(['execCommand', 'paste', 'splice']);

    const wp = resolveProfile('myblog.example', el('<div class="block-editor-rich-text__editable" contenteditable="true"></div>'));
    expect(wp.id).toBe('gutenberg');
    expect(wp.ladder).toEqual(['execCommand', 'splice']);
  });

  it('maps ProseMirror on chat hosts to the chat variant and keeps the doc default elsewhere', () => {
    const pm = el('<div class="ProseMirror" contenteditable="true"></div>');
    expect(resolveProfile('gemini.google.com', pm)).toBe(prosemirrorChat);
    const doc = resolveProfile('docs.example.com', pm);
    expect(doc.id).toBe('prosemirror');
    expect(doc.context).toBe('other');
    expect(resolveProfile('medium.com', pm).context).toBe('doc');
    // Host profiles win over markers.
    expect(resolveProfile('app.slack.com', pm)).toBe(slack);
  });

  it('caches framework profiles per (framework, context)', () => {
    const a = resolveProfile('example.com', el('<div data-slate-editor="true" contenteditable="true"></div>'));
    const b = resolveProfile('example.net', el('<div data-slate-editor="true" contenteditable="true"></div>'));
    expect(a).toBe(b);
  });
});

describe('hostContext and host matching', () => {
  it('normalizes hosts and matches wildcards', () => {
    expect(normalizeHost('WWW.Example.com.')).toBe('example.com');
    expect(hostMatchesPattern('www.facebook.com', 'facebook.com')).toBe(true);
    expect(hostMatchesPattern('m.facebook.com', 'facebook.com')).toBe(false);
    expect(hostMatchesPattern('m.facebook.com', '*.facebook.com')).toBe(true);
    expect(hostMatchesPattern('facebook.com', '*.facebook.com')).toBe(true);
    expect(hostMatchesPattern('notfacebook.com', '*.facebook.com')).toBe(false);
  });

  it('maps hosts to contexts per the 08 §8.2 table plus the 09 additions', () => {
    const cases: [string, string][] = [
      ['mail.google.com', 'email'],
      ['mail.superhuman.com', 'email'],
      ['outlook.office.com', 'email'],
      ['app.hey.com', 'email'],
      ['mail.proton.me', 'email'],
      ['www.slashy.com', 'email'],
      ['app.slack.com', 'chat'],
      ['discord.com', 'chat'],
      ['teams.microsoft.com', 'chat'],
      ['web.whatsapp.com', 'chat'],
      ['web.telegram.org', 'chat'],
      ['messages.google.com', 'chat'],
      ['claude.ai', 'chat'],
      ['chatgpt.com', 'chat'],
      ['docs.google.com', 'doc'],
      ['www.notion.so', 'doc'],
      ['acme.atlassian.net', 'doc'],
      ['docs.superhuman.com', 'doc'],
      ['coda.io', 'doc'],
      ['quip.com', 'doc'],
      ['www.linkedin.com', 'social'],
      ['x.com', 'social'],
      ['twitter.com', 'social'],
      ['www.facebook.com', 'social'],
      ['www.reddit.com', 'social'],
      ['bsky.app', 'social'],
      ['www.threads.net', 'social'],
      ['github.com', 'code'],
      ['gitlab.com', 'code'],
      ['bitbucket.org', 'code'],
      ['example.com', 'other'],
      ['slack.com', 'other'],
    ];
    for (const [host, ctx] of cases) expect(hostContext(host), host).toBe(ctx);
  });
});

describe('docHint parsers', () => {
  it('gmail: compose draft id from hash or query, thread id fallback, never "new"', () => {
    expect(gmailDocHint('#inbox?compose=DmwnWrRttXfLqzJQ', '')).toBe('gmail:compose:DmwnWrRttXfLqzJQ');
    expect(gmailDocHint('#drafts?compose=new', '')).toBe('');
    expect(gmailDocHint('', '?view=cm&compose=abc123')).toBe('gmail:compose:abc123');
    expect(gmailDocHint('#inbox/FMfcgzQbfVxxLqwxWkRtPq', '')).toBe('gmail:thread:FMfcgzQbfVxxLqwxWkRtPq');
    expect(gmailDocHint('#label/My+Label/FMfcgzQbfVxxLqwxWkRtPq?projector=1', '')).toBe('gmail:thread:FMfcgzQbfVxxLqwxWkRtPq');
    expect(gmailDocHint('#inbox', '')).toBe('');
    expect(gmail.docHint(loc('https://mail.google.com/mail/u/0/#inbox?compose=XyZ123'), document.body)).toBe('gmail:compose:XyZ123');
  });

  it('superhuman and slashy: thread ids', () => {
    expect(superhumanDocHint('/inbox/thread/abc123DEF', '')).toBe('superhuman:thread:abc123DEF');
    expect(superhumanDocHint('/', '?thread=qwerty12')).toBe('superhuman:thread:qwerty12');
    expect(superhumanDocHint('/inbox', '')).toBe('');
    expect(slashyDocHint('/mail/thread/abcdef12', '')).toBe('slashy:thread:abcdef12');
    expect(slashyDocHint('/inbox', '?conversation=zz99yy88')).toBe('slashy:thread:zz99yy88');
    expect(slashyDocHint('/inbox', '')).toBe('');
  });

  it('chat apps: channel ids', () => {
    expect(slackDocHint('/client/T0123ABC/C0456DEF')).toBe('slack:C0456DEF');
    expect(slackDocHint('/archives/C0456DEF')).toBe('slack:C0456DEF');
    expect(slackDocHint('/')).toBe('');
    expect(discordDocHint('/channels/123456/789012')).toBe('discord:789012');
    expect(discordDocHint('/channels/@me/555')).toBe('discord:555');
    expect(discordDocHint('/app')).toBe('');
  });

  it('social: post ids', () => {
    expect(twitterDocHint('/someone/status/1234567890', '')).toBe('x:status:1234567890');
    expect(twitterDocHint('/compose/post', '?in_reply_to=42')).toBe('x:status:42');
    expect(twitterDocHint('/home', '')).toBe('');
    expect(facebookDocHint('/groups/x/posts/987654321', '')).toBe('fb:987654321');
    expect(facebookDocHint('/permalink.php', '?story_fbid=123456&id=7')).toBe('fb:123456');
    expect(facebookDocHint('/', '')).toBe('');
    expect(linkedinDocHint('/messaging/thread/2-abcDEF123==/')).toBe('linkedin:thread:2-abcDEF123==');
    expect(linkedinDocHint('/feed/update/urn:li:activity:7123456789/')).toBe('linkedin:activity:7123456789');
    expect(linkedinDocHint('/posts/jane-doe_hello-world-activity-123')).toBe('linkedin:post:jane-doe_hello-world-activity-123');
    expect(linkedinDocHint('/feed/')).toBe('');
    expect(redditDocHint('/r/typescript/comments/1abc2d/title_here/')).toBe('reddit:1abc2d');
    expect(redditDocHint('/r/typescript/')).toBe('');
  });

  it('docs: Notion page ids, Jira keys, Confluence pages, chat conversations, WordPress posts, GitHub issues', () => {
    expect(notionDocHint('/Roadmap-0123456789abcdef0123456789ABCDEF', '')).toBe('notion:0123456789abcdef0123456789abcdef');
    expect(notionDocHint('/workspace', '?p=0123456789abcdef0123456789abcdef&pm=s')).toBe('notion:0123456789abcdef0123456789abcdef');
    expect(notionDocHint('/', '')).toBe('');
    expect(prosemirrorDocHint('/browse/PROJ-123', '')).toBe('jira:PROJ-123');
    expect(prosemirrorDocHint('/jira/software/projects/PROJ/boards/1', '?selectedIssue=PROJ-9')).toBe('jira:PROJ-9');
    expect(prosemirrorDocHint('/wiki/spaces/ENG/pages/123456/Title', '')).toBe('confluence:123456');
    expect(prosemirrorDocHint('/chat/0F1E2D3C-4B5A-6978-8899-AABBCCDDEEFF', '')).toBe('chat:0f1e2d3c-4b5a-6978-8899-aabbccddeeff');
    expect(prosemirrorDocHint('/c/0f1e2d3c-4b5a-6978-8899-aabbccddeeff', '')).toBe('chat:0f1e2d3c-4b5a-6978-8899-aabbccddeeff');
    expect(prosemirrorDocHint('/publish/post/12345', '')).toBe('substack:12345');
    expect(prosemirrorDocHint('/new', '')).toBe('');
    expect(wordpressDocHint('/wp-admin/post.php', '?post=42&action=edit')).toBe('wp:post:42');
    expect(wordpressDocHint('/post/myblog.wordpress.com/77', '')).toBe('wp:post:77');
    expect(wordpressDocHint('/wp-admin/', '')).toBe('');
    expect(githubDocHint('/octo/repo/pull/12')).toBe('github:octo/repo#12');
    expect(githubDocHint('/octo/repo/issues/7')).toBe('github:octo/repo#7');
    expect(githubDocHint('/octo/repo/discussions/3')).toBe('github:octo/repo#3');
    expect(githubDocHint('/octo/repo')).toBe('');
  });

  it('generic: UUIDs and long numeric ids in the path only', () => {
    expect(genericDocHint({ pathname: '/items/0f1e2d3c-4b5a-6978-8899-AABBCCDDEEFF/edit' })).toBe('path:0f1e2d3c-4b5a-6978-8899-aabbccddeeff');
    expect(genericDocHint({ pathname: '/t/123456' })).toBe('path:123456');
    expect(genericDocHint({ pathname: '/v2/settings' })).toBe('');
    expect(genericDocHint({ pathname: '/' })).toBe('');
  });
});

describe('profile helpers', () => {
  it('defineProfile fills defaults and copies arrays', () => {
    const ladder: ('execCommand' | 'splice')[] = ['execCommand', 'splice'];
    const p = defineProfile({ id: 'test', matches: () => true, ladder });
    expect(p.context).toBe('other');
    expect(p.shortcutSafe).toBe(false);
    expect(p.ignoreOptOut).toBe(false);
    expect(p.fastPassMultiplier).toBe(1);
    expect(p.deepPassMultiplier).toBe(1);
    expect(p.protectedSelectors).toEqual([]);
    expect(p.bodySelectors).toEqual([]);
    expect(p.docHint(loc('https://example.com/x'), document.body)).toBe('');
    ladder.push('splice');
    expect(p.ladder).toEqual(['execCommand', 'splice']);
  });

  it('withContext and genericFor keep the id and ladder but change the context', () => {
    const g = genericFor('email');
    expect(g.id).toBe('generic');
    expect(g.context).toBe('email');
    expect(g.ladder).toEqual(generic.ladder);
    expect(genericFor('other')).toBe(generic);
    expect(withContext(gmail, 'email')).toBe(gmail);
    expect(withContext(gmail, 'chat').context).toBe('chat');
  });
});
