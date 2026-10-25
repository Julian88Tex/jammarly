import { describe, expect, it } from 'vitest';
import {
  isSensitiveHost,
  normalizeHost,
  redactSentence,
  redactSnippet,
  redactText,
  REDACTION_TOKENS,
  SENTENCE_MAX,
  shouldStoreSnippet,
  SNIPPET_MAX,
  truncateAtWord,
} from '../src/redact';

const { email, url, phone, num } = REDACTION_TOKENS;

describe('redactSnippet: e-mail addresses', () => {
  it('redacts addresses inside parentheses and with plus tags', () => {
    expect(redactSnippet('Contact me (jane.doe+tag@example.co.uk) tomorrow.')).toBe(`Contact me (${email}) tomorrow.`);
  });
  it('redacts several addresses and keeps surrounding punctuation', () => {
    expect(redactSnippet('cc: a.b@x.io, c_d@y-z.org; thanks')).toBe(`cc: ${email}, ${email}; thanks`);
  });
  it('redacts unicode local parts', () => {
    expect(redactSnippet('mail josé@münchen.de now')).toBe(`mail ${email} now`);
  });
  it('leaves lone @ handles alone', () => {
    expect(redactSnippet('ping @julian about it')).toBe('ping @julian about it');
  });
});

describe('redactSnippet: URLs', () => {
  it('redacts scheme URLs with query strings and fragments, keeping trailing punctuation', () => {
    expect(redactSnippet('See https://example.com/path?q=1&x=2#frag, then more.')).toBe(`See ${url}, then more.`);
    expect(redactSnippet('Go to http://foo.bar/baz?x=y.')).toBe(`Go to ${url}.`);
  });
  it('redacts www. and bare domains', () => {
    expect(redactSnippet('then www.foo.org/a and foo.bar.io.')).toBe(`then ${url} and ${url}.`);
  });
  it('does not treat ordinary sentences with periods as domains', () => {
    expect(redactSnippet('I agree.Thanks for asking.')).toBe('I agree.Thanks for asking.');
    expect(redactSnippet('Version 1.2.3 is out.')).toBe('Version 1.2.3 is out.');
  });
  it('redacts mailto links', () => {
    expect(redactSnippet('write to mailto:bob@example.com please')).toBe(`write to ${url} please`);
  });
});

describe('redactSnippet: phone numbers', () => {
  it('handles international, US and UK formats', () => {
    expect(redactSnippet('Call +1 (415) 555-2671 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call 415-555-2671 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call 415.555.2671 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call (415) 555 2671 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call (020) 7946 0958 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call +44 20 7946 0958 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call +91 98765 43210 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call 98765 43210 today')).toBe(`Call ${phone} today`);
    expect(redactSnippet('Call +919876543210 today')).toBe(`Call ${phone} today`);
  });
  it('leaves times, short numbers and dates alone', () => {
    expect(redactSnippet('Mr. Smith arrived at 10:30 am on 12/05/2024.')).toBe('Mr. Smith arrived at 10:30 am on 12/05/2024.');
    expect(redactSnippet('Room 4 opens at 9 and 10.')).toBe('Room 4 opens at 9 and 10.');
  });
});

describe('redactSnippet: account numbers and digit runs', () => {
  it('redacts IBANs with and without spaces', () => {
    expect(redactSnippet('IBAN GB82 WEST 1234 5698 7654 32 and DE89370400440532013000.')).toBe(`IBAN ${num} and ${num}.`);
  });
  it('redacts card numbers with spaces, dashes or none', () => {
    expect(redactSnippet('Card 4111 1111 1111 1111 and 4111-1111-1111-1111 and 4111111111111111.')).toBe(`Card ${num} and ${num} and ${num}.`);
  });
  it('redacts runs of six or more digits but keeps five', () => {
    expect(redactSnippet('Order #123456 shipped; ref 12345 stays.')).toBe(`Order #${num} shipped; ref 12345 stays.`);
    expect(redactSnippet('The year 2024 and 12.5% and 3,000 items.')).toBe('The year 2024 and 12.5% and 3,000 items.');
  });
});

describe('redactSnippet: mixed input, unicode and whitespace', () => {
  it('redacts every shape in one sentence', () => {
    const out = redactSnippet('Bob (bob@x.com) said see https://x.com/a?b=1 or call +1 415 555 2671, acct 123456789.');
    expect(out).toBe(`Bob (${email}) said see ${url} or call ${phone}, acct ${num}.`);
  });
  it('preserves unicode, emoji and typographic punctuation', () => {
    const s = 'Café naïve 😀 résumé — colour “quoted” ‘x’ ünïcödé über straße';
    expect(redactSnippet(s)).toBe(s);
  });
  it('collapses whitespace and strips control characters', () => {
    expect(redactSnippet('  a\n\n b\t c\u0007 d  ')).toBe('a b c d');
  });
  it('redactText keeps whitespace and does not truncate', () => {
    expect(redactText('a\n\nb@c.io  ')).toBe(`a\n\n${email}  `);
    expect(redactText('x'.repeat(500)).length).toBe(500);
  });
});

describe('truncation', () => {
  it('cuts at a word boundary with an ellipsis and respects max', () => {
    const words = 'word '.repeat(60).trim();
    const out = redactSnippet(words);
    expect(out.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(out.endsWith('word…')).toBe(true);
    expect(out.includes('wor…')).toBe(false);
  });
  it('hard-cuts a single long token', () => {
    const out = redactSnippet('a'.repeat(300));
    expect(out.length).toBe(SNIPPET_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
  it('never splits a surrogate pair or a redaction token', () => {
    const emoji = '😀'.repeat(150);
    const out = truncateAtWord(emoji, 51);
    expect(out.length).toBeLessThanOrEqual(51);
    for (let i = 0; i < out.length - 1; i++) {
      const c = out.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) expect(out.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
    }
    const withToken = `${'x'.repeat(190)} ${email} tail`;
    const cut = redactSnippet(withToken);
    expect(cut.includes('‹') && !cut.includes('›')).toBe(false);
    expect(cut.length).toBeLessThanOrEqual(SNIPPET_MAX);
  });
  it('returns short input unchanged and honours a custom max', () => {
    expect(redactSnippet('short text')).toBe('short text');
    expect(redactSnippet('one two three four', 10)).toBe('one two…');
    expect(redactSnippet('anything', 0)).toBe('');
  });
  it('redactSentence uses the 280-character budget', () => {
    expect(redactSentence('x'.repeat(290)).length).toBe(SENTENCE_MAX);
    expect(redactSnippet('x'.repeat(290)).length).toBe(SNIPPET_MAX);
    expect(redactSentence('x'.repeat(280))).toBe('x'.repeat(280));
    expect(redactSentence('mail a@b.co')).toBe(`mail ${email}`);
  });
});

describe('isSensitiveHost', () => {
  it('matches the host and its subdomains, never a partial label', () => {
    expect(isSensitiveHost('mail.google.com', ['google.com'])).toBe(true);
    expect(isSensitiveHost('google.com', ['google.com'])).toBe(true);
    expect(isSensitiveHost('gle.com', ['google.com'])).toBe(false);
    expect(isSensitiveHost('notgoogle.com', ['google.com'])).toBe(false);
    expect(isSensitiveHost('google.com.evil.io', ['google.com'])).toBe(false);
    expect(isSensitiveHost('docs.google.com', ['mail.google.com'])).toBe(false);
  });
  it('normalises case, schemes, ports, paths and wildcards on both sides', () => {
    expect(isSensitiveHost('MAIL.GOOGLE.COM', ['https://google.com/'])).toBe(true);
    expect(isSensitiveHost('https://bank.example.com:8443/login', ['example.com'])).toBe(true);
    expect(isSensitiveHost('google.com', ['*.google.com'])).toBe(true);
    expect(isSensitiveHost('a.b.c', ['.b.c'])).toBe(true);
    expect(normalizeHost('HTTPS://Mail.Google.com:443/x?y')).toBe('mail.google.com');
  });
  it('handles empty inputs', () => {
    expect(isSensitiveHost('', ['google.com'])).toBe(false);
    expect(isSensitiveHost('a.com', [])).toBe(false);
    expect(isSensitiveHost('a.com', ['', '   '])).toBe(false);
  });
});

describe('shouldStoreSnippet', () => {
  const base = { storeSnippets: true, host: 'docs.example.com', privateSites: ['bank.com'], fieldKind: 'textarea' as const };
  it('allows ordinary fields when storage is on', () => {
    expect(shouldStoreSnippet(base)).toBe(true);
    expect(shouldStoreSnippet({ ...base, fieldKind: 'contenteditable' })).toBe(true);
    expect(shouldStoreSnippet({ ...base, fieldKind: 'input', inputType: 'text', autocomplete: 'name' })).toBe(true);
  });
  it('refuses when snippet storage is off', () => {
    expect(shouldStoreSnippet({ ...base, storeSnippets: false })).toBe(false);
  });
  it('refuses on private sites (suffix match)', () => {
    expect(shouldStoreSnippet({ ...base, host: 'online.bank.com' })).toBe(false);
    expect(shouldStoreSnippet({ ...base, host: 'bank.com' })).toBe(false);
    expect(shouldStoreSnippet({ ...base, host: 'notbank.com' })).toBe(true);
  });
  it('refuses sensitive input types', () => {
    for (const t of ['password', 'email', 'tel', 'number', 'url', 'hidden', 'EMAIL', ' tel ']) {
      expect(shouldStoreSnippet({ ...base, fieldKind: 'input', inputType: t }), t).toBe(false);
    }
    expect(shouldStoreSnippet({ ...base, fieldKind: 'input', inputType: 'search' })).toBe(true);
  });
  it('refuses sensitive autocomplete tokens', () => {
    for (const a of ['cc-number', 'section-blue cc-exp', 'one-time-code', 'current-password', 'new-password', 'tel-national', 'email', 'shipping tel']) {
      expect(shouldStoreSnippet({ ...base, fieldKind: 'input', autocomplete: a }), a).toBe(false);
    }
    expect(shouldStoreSnippet({ ...base, fieldKind: 'input', autocomplete: 'street-address' })).toBe(true);
    expect(shouldStoreSnippet({ ...base, fieldKind: 'input', autocomplete: 'off' })).toBe(true);
  });
});
