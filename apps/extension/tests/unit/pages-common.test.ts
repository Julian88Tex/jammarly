import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeResponse } from '@jammarly/shared/types';
import { CATEGORY_COLORS, CATEGORY_COLORS_COLORBLIND, CATEGORY_COLORS_DARK, BRAND_COLOR, INTERACTIVE_COLOR } from '../../src/content/ui/overlay-api';
import { h, clear, preserveFocus, isTypingTarget, cssEscape } from '../../src/pages/common/dom';
import { icon, scoreRing } from '../../src/pages/common/icons';
import { request, requestAs, isRuntimeResponse, describeFailure, recentRpcErrors } from '../../src/pages/common/rpc';
import { connectPanelPort, PANEL_PORT_NAME, isWorkerToPanel } from '../../src/pages/common/port';
import { createStore } from '../../src/pages/common/store';
import { formatUsd, formatUsdPrecise, formatCount, relativeTime, hostFromUrl, normalizeHost, formatReadingTime, plural, visibleText, truncate } from '../../src/pages/common/format';
import { applyTheme } from '../../src/pages/common/theme';
import { button, switchControl, segmented, createToastHost } from '../../src/pages/common/ui';
import { installChromeMock, type ChromeMock } from '../../src/pages/testing/chrome-mock';

const extRoot = path.resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|css|html)$/.test(name)) out.push(full);
  }
  return out;
}

let mock: ChromeMock | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('source hygiene', () => {
  it('pages never use HTML string sinks (innerHTML / outerHTML / insertAdjacentHTML / document.write)', () => {
    const files = ['src/pages', 'src/sidepanel', 'src/options', 'src/popup'].flatMap((d) => walk(path.join(extRoot, d)));
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Allow the words in comments that explicitly say "never"; flag any real use.
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
      if (/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\(/.test(stripped)) offenders.push(path.relative(extRoot, file));
    }
    expect(offenders).toEqual([]);
  });

  it('the three page stylesheets carry the shared token block verbatim', () => {
    const tokens = readFileSync(path.join(extRoot, 'src/pages/common/theme.css'), 'utf8').trim();
    for (const css of ['public/sidepanel/sidepanel.css', 'public/popup/popup.css', 'public/options/options.css']) {
      const text = readFileSync(path.join(extRoot, css), 'utf8');
      expect(text.startsWith(tokens), `${css} should start with the token block`).toBe(true);
      expect(text).toContain(`--jm-correctness: ${CATEGORY_COLORS.correctness}`);
      expect(text).toContain(`--jm-correctness: ${CATEGORY_COLORS_DARK.correctness}`);
      expect(text).toContain(`--jm-brand: ${BRAND_COLOR}`);
    }
  });

  it('html shells keep the #app root and link their own stylesheet and script', () => {
    for (const page of ['sidepanel', 'popup', 'options']) {
      const html = readFileSync(path.join(extRoot, `public/${page}/${page}.html`), 'utf8');
      expect(html).toContain(`id="app" data-page="${page}"`);
      expect(html).toContain(`${page}.css`);
      expect(html).toContain(`${page}.js`);
    }
  });
});

describe('dom builder', () => {
  it('h() sets attributes, classes, dataset, listeners, boolean props and nested children', () => {
    let clicks = 0;
    const el = h(
      'button',
      { class: ['a', null, 'b'], 'aria-label': 'Go', dataset: { focusKey: 'x', n: 2 }, disabled: true, onclick: () => (clicks += 1), style: 'color: red' },
      'Hello ',
      ['nested', h('b', null, '!')],
      null,
      false,
      3,
    );
    expect(el.className).toBe('a b');
    expect(el.getAttribute('aria-label')).toBe('Go');
    expect(el.dataset.focusKey).toBe('x');
    expect(el.dataset.n).toBe('2');
    expect(el.disabled).toBe(true);
    expect(el.textContent).toBe('Hello nested!3');
    el.disabled = false;
    el.click();
    expect(clicks).toBe(1);
    clear(el);
    expect(el.childNodes.length).toBe(0);
  });

  it('preserveFocus re-focuses the element with the same focus key after a rebuild', () => {
    const root = h('div');
    document.body.appendChild(root);
    const build = (label: string): void => {
      clear(root);
      root.appendChild(h('button', { dataset: { focusKey: 'k' } }, label));
    };
    build('one');
    (root.firstElementChild as HTMLElement).focus();
    expect(document.activeElement?.textContent).toBe('one');
    preserveFocus(root, () => build('two'));
    expect(document.activeElement?.textContent).toBe('two');
  });

  it('isTypingTarget and cssEscape behave', () => {
    expect(isTypingTarget(h('input'))).toBe(true);
    expect(isTypingTarget(h('textarea'))).toBe(true);
    expect(isTypingTarget(h('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(cssEscape('card:a.b')).not.toContain(':a.b');
  });

  it('icons are SVG built from paths and the score ring exposes an accessible label', () => {
    const svg = icon('trash');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(1);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const ring = scoreRing(87);
    expect(ring.getAttribute('aria-label')).toBe('Score 87 out of 100');
    expect(ring.querySelector('.jm-score-value')?.textContent).toBe('87');
    expect(scoreRing(null).getAttribute('aria-label')).toBe('No score yet');
  });

  it('ui widgets: button, switch, segmented control and toast host', () => {
    const btn = button({ label: 'Close', icon: 'x', iconOnly: true, kind: 'ghost' });
    expect(btn.getAttribute('aria-label')).toBe('Close');
    expect(btn.querySelector('.jm-btn-label')).toBeNull();
    let value = false;
    const sw = switchControl({ checked: false, label: 'Thing', onChange: (v) => (value = v) });
    const control = sw.querySelector<HTMLButtonElement>('[role=switch]')!;
    expect(control.getAttribute('aria-checked')).toBe('false');
    control.click();
    expect(value).toBe(true);
    let picked = '';
    const seg = segmented({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a', ariaLabel: 'x', onChange: (v) => (picked = v) });
    const radios = seg.querySelectorAll<HTMLButtonElement>('[role=radio]');
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(picked).toBe('b');
    vi.useFakeTimers();
    const toast = createToastHost();
    toast.show('Saved', { durationMs: 100 });
    expect(toast.element.textContent).toContain('Saved');
    vi.advanceTimersByTime(150);
    expect(toast.element.textContent).toBe('');
  });
});

describe('rpc', () => {
  it('passes well-formed responses through and records nothing', async () => {
    mock = installChromeMock({ respond: () => ({ ok: true, type: 'ok' }) });
    const res = await request({ type: 'ping' });
    expect(res).toEqual({ ok: true, type: 'ok' });
    expect(isRuntimeResponse(res)).toBe(true);
  });

  it('maps undefined, garbage, rejection and thrown errors to ok:false failures', async () => {
    mock = installChromeMock({ respond: () => undefined });
    expect((await request({ type: 'get-usage' })) as RuntimeResponse).toMatchObject({ ok: false, error: { code: 'no-reply' } });
    mock.respond = () => ({ hello: 'world' });
    expect(await request({ type: 'get-usage' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    mock.respond = () => Promise.reject(new Error('Could not establish connection'));
    const rejected = await request({ type: 'get-usage' });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'unavailable', message: 'Could not establish connection' } });
    mock.respond = () => {
      throw new Error('boom');
    };
    expect(await request({ type: 'get-usage' })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(recentRpcErrors().length).toBeGreaterThanOrEqual(4);
    expect(describeFailure({ ok: false, error: { code: 'no-reply', message: '' } })).toMatch(/background service/);
  });

  it('times out after 10 s by default and fails without a chrome runtime', async () => {
    vi.useFakeTimers();
    mock = installChromeMock({ respond: () => new Promise(() => undefined) });
    const pending = request({ type: 'get-settings' });
    vi.advanceTimersByTime(10_001);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
    mock.restore();
    mock = null;
    expect(await request({ type: 'ping' })).toMatchObject({ ok: false, error: { code: 'no-runtime' } });
  });

  it('requestAs narrows to the expected success type', async () => {
    mock = installChromeMock();
    const ok = await requestAs({ type: 'get-settings' }, 'settings');
    expect(ok.ok).toBe(true);
    const wrong = await requestAs({ type: 'get-settings' }, 'usage');
    expect(wrong).toMatchObject({ ok: false, error: { code: 'bad-response' } });
  });
});

describe('panel port', () => {
  it('connects with the panel port name, sends hello via onOpen and ignores garbage messages', () => {
    mock = installChromeMock();
    const received: unknown[] = [];
    const port = connectPanelPort({ onOpen: (p) => p.send({ type: 'hello', role: 'sidepanel', windowId: 3 }) });
    port.onMessage((m) => received.push(m));
    expect(mock.ports[0]?.name).toBe(PANEL_PORT_NAME);
    expect(mock.ports[0]?.sent[0]).toEqual({ type: 'hello', role: 'sidepanel', windowId: 3 });
    mock.ports[0]?.emit('nonsense');
    mock.ports[0]?.emit({ type: 'unknown-type' });
    mock.ports[0]?.emit({ type: 'field-removed', fieldId: 'f1' });
    expect(received).toEqual([{ type: 'field-removed', fieldId: 'f1' }]);
    expect(isWorkerToPanel({ type: 'fields', fields: [] })).toBe(true);
    expect(isWorkerToPanel({ type: 'nope' })).toBe(false);
    port.close();
    expect(port.status).toBe('closed');
  });

  it('reconnects with backoff after a disconnect, re-sends hello and flushes queued messages', () => {
    vi.useFakeTimers();
    mock = installChromeMock();
    const statuses: string[] = [];
    const port = connectPanelPort({ onOpen: (p) => p.send({ type: 'hello', role: 'sidepanel' }), backoffMs: [500, 1000] });
    port.onStatus((s) => statuses.push(s));
    expect(port.status).toBe('open');
    mock.ports[0]!.fireDisconnect();
    expect(port.status).toBe('connecting');
    port.send({ type: 'cancel', fieldId: 'f1' });
    expect(mock.ports.length).toBe(1);
    vi.advanceTimersByTime(499);
    expect(mock.ports.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(mock.ports.length).toBe(2);
    expect(mock.ports[1]!.sent).toEqual([
      { type: 'hello', role: 'sidepanel' },
      { type: 'cancel', fieldId: 'f1' },
    ]);
    expect(statuses).toEqual(['connecting', 'open']);
    // A connect() that throws keeps retrying.
    mock.connectThrows = true;
    mock.ports[1]!.fireDisconnect();
    vi.advanceTimersByTime(500);
    expect(port.status).toBe('connecting');
    expect(port.attempts).toBeGreaterThan(0);
    mock.connectThrows = false;
    vi.advanceTimersByTime(1000);
    expect(port.status).toBe('open');
    port.close();
  });
});

describe('store and format', () => {
  it('store notifies subscribers once per batch and skips identical state', () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.n));
    store.set(store.get());
    store.update((s) => ({ n: s.n + 1 }));
    store.batch(() => {
      store.update((s) => ({ n: s.n + 1 }));
      store.update((s) => ({ n: s.n + 1 }));
    });
    expect(seen).toEqual([1, 3]);
    off();
    store.set({ n: 9 });
    expect(seen).toEqual([1, 3]);
  });

  it('formats money, counts, reading time, relative times and hosts', () => {
    expect(formatUsd(0.04)).toBe('$0.04');
    expect(formatUsd(2)).toBe('$2.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsdPrecise(0.0123)).toBe('$0.0123');
    expect(formatUsdPrecise(1.5)).toBe('$1.50');
    expect(formatCount(1234)).toBe('1,234');
    expect(plural(1, 'word')).toBe('1 word');
    expect(plural(3, 'word')).toBe('3 words');
    expect(formatReadingTime(30)).toBe('< 1 min read');
    expect(formatReadingTime(130)).toBe('2 min read');
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(relativeTime('2026-10-21T11:56:50Z', now)).toBe('3 min ago');
    expect(relativeTime('2026-10-21T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-21T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-20T09:00:00Z', now)).toBe('yesterday');
    expect(relativeTime(null, now)).toBe('never');
    expect(hostFromUrl('https://mail.google.com/mail/u/0/')).toBe('mail.google.com');
    expect(hostFromUrl('chrome://extensions')).toBeNull();
    expect(hostFromUrl('chrome-extension://abc/popup/popup.html')).toBeNull();
    expect(normalizeHost(' https://WWW.Example.com/path ')).toBe('example.com');
    expect(normalizeHost('not a host')).toBeNull();
    expect(visibleText('')).toBe('∅');
    expect(visibleText(' ')).toBe('␣');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
  });
});

describe('theme', () => {
  it('applies the overlay category colors as CSS tokens, with dark and colorblind variants', () => {
    const root = document.createElement('div');
    applyTheme(root, { dark: false });
    expect(root.style.getPropertyValue('--jm-correctness')).toBe(CATEGORY_COLORS.correctness);
    expect(root.style.getPropertyValue('--jm-delivery')).toBe(CATEGORY_COLORS.delivery);
    expect(root.style.getPropertyValue('--jm-interactive')).toBe(INTERACTIVE_COLOR);
    expect(root.style.getPropertyValue('--jm-brand')).toBe(BRAND_COLOR);
    expect(root.dataset.theme).toBe('light');
    applyTheme(root, { dark: true });
    expect(root.style.getPropertyValue('--jm-clarity')).toBe(CATEGORY_COLORS_DARK.clarity);
    expect(root.dataset.theme).toBe('dark');
    applyTheme(root, { dark: false, colorblind: true });
    expect(root.style.getPropertyValue('--jm-engagement')).toBe(CATEGORY_COLORS_COLORBLIND.engagement);
    expect(root.dataset.colorblind).toBe('true');
    applyTheme(root, { dark: false, colorblind: false });
    expect(root.dataset.colorblind).toBeUndefined();
  });
});

describe('adversarial', () => {
  const pageDirs = ['src/pages', 'src/sidepanel', 'src/options', 'src/popup'];

  it('Trusted-Types audit: no bracketed or string-keyed HTML sinks, no eval/Function, no srcdoc/javascript: URLs, no inline handlers in the shells', () => {
    const files = pageDirs.flatMap((d) => walk(path.join(extRoot, d)));
    const offenders: string[] = [];
    const sinks: [RegExp, string][] = [
      [/[\w)\]]\s*\[\s*['"`](innerHTML|outerHTML|insertAdjacentHTML|srcdoc)['"`]\s*\]/, 'bracketed HTML sink'],
      [/\.(innerHTML|outerHTML|srcdoc)\s*[+]?=/, 'HTML sink assignment'],
      [/\binsertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
      [/\bcreateContextualFragment\s*\(/, 'createContextualFragment'],
      [/\bnew\s+DOMParser\b/, 'DOMParser'],
      [/\bdocument\.write(ln)?\s*\(/, 'document.write'],
      [/(^|[^.\w])eval\s*\(/, 'eval'],
      [/\bnew\s+Function\s*\(/, 'new Function'],
      [/\bsetTimeout\s*\(\s*['"`]/, 'string setTimeout'],
      [/\bsetInterval\s*\(\s*['"`]/, 'string setInterval'],
      [/javascript:/i, 'javascript: URL'],
      [/\.setAttribute\s*\(\s*['"`]on\w+['"`]/, 'inline handler attribute'],
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [re, label] of sinks) {
        if (re.test(stripped)) offenders.push(`${path.relative(extRoot, file)}: ${label}`);
      }
    }
    for (const page of ['sidepanel', 'popup', 'options']) {
      const html = readFileSync(path.join(extRoot, `public/${page}/${page}.html`), 'utf8');
      if (/<script(?![^>]*\bsrc=)[^>]*>[^<]*\S[^<]*<\/script>/i.test(html)) offenders.push(`${page}.html: inline script body`);
      if (/\son\w+\s*=/i.test(html)) offenders.push(`${page}.html: inline event handler`);
      if (/javascript:/i.test(html)) offenders.push(`${page}.html: javascript: URL`);
      if (/\bstyle\s*=/i.test(html)) offenders.push(`${page}.html: inline style attribute`);
    }
    expect(offenders).toEqual([]);
  });

  it('h() refuses string event handlers, srcdoc and script-scheme URLs so no attribute can become a script sink', () => {
    const el = h('a', { onclick: 'alert(1)', href: ' JavaScript:alert(1)', srcdoc: '<b>x</b>', 'data-ok': 'fine' });
    expect(el.getAttribute('onclick')).toBeNull();
    expect(el.hasAttribute('href')).toBe(false);
    expect(el.hasAttribute('srcdoc')).toBe(false);
    expect(el.getAttribute('data-ok')).toBe('fine');
    const img = h('img', { src: 'data:text/html,<script>1</script>', alt: 'x' });
    expect(img.hasAttribute('src')).toBe(false);
    const safe = h('a', { href: 'https://example.com/x', onclick: () => undefined });
    expect(safe.getAttribute('href')).toBe('https://example.com/x');
    const hash = h('a', { href: '#welcome' });
    expect(hash.getAttribute('href')).toBe('#welcome');
    const form = h('form', { action: 'vbscript:msgbox', formaction: 'javascript:1' } as Record<string, unknown>);
    expect(form.hasAttribute('action')).toBe(false);
    expect(form.hasAttribute('formaction')).toBe(false);
  });

  it('rpc rejects half-shaped replies: ok without type, ok:false without an error, a non-boolean ok, and an array', async () => {
    mock = installChromeMock({ respond: () => ({ ok: true }) });
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    mock.respond = () => ({ ok: false });
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    mock.respond = () => ({ ok: false, error: { code: 1, message: 'x' } });
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    mock.respond = () => ({ ok: 'yes', type: 'settings' });
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    mock.respond = () => [{ ok: true, type: 'ok' }];
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    mock.respond = () => null;
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'no-reply' } });
    mock.respond = () => 'ok';
    expect(await request({ type: 'get-settings' })).toMatchObject({ ok: false, error: { code: 'bad-response' } });
    // A well-formed failure passes through unchanged and is recorded once per request type.
    mock.respond = () => ({ ok: false, error: { code: 'custom', message: 'm' } });
    const before = recentRpcErrors().length;
    expect(await request({ type: 'ping' })).toEqual({ ok: false, error: { code: 'custom', message: 'm' } });
    expect(recentRpcErrors().length).toBe(Math.min(10, before + 1));
    expect(recentRpcErrors()[0]).toMatchObject({ request: 'ping', code: 'custom' });
    // The ring buffer never exceeds ten entries.
    for (let i = 0; i < 15; i++) await request({ type: 'ping' });
    expect(recentRpcErrors().length).toBe(10);
  });

  it('port: a postMessage that throws on a half-dead port re-queues the message and delivers it after reconnecting', () => {
    vi.useFakeTimers();
    mock = installChromeMock();
    const received: unknown[] = [];
    const port = connectPanelPort({ onOpen: (p) => p.send({ type: 'hello', role: 'sidepanel' }), backoffMs: [200] });
    port.onMessage((m) => received.push(m));
    const first = mock.ports[0]!;
    // Chrome sometimes marks the port dead before onDisconnect fires; postMessage then throws.
    first.disconnected = true;
    port.send({ type: 'cancel', fieldId: 'f1' });
    expect(port.status).toBe('connecting');
    expect(first.sent).toEqual([{ type: 'hello', role: 'sidepanel' }]);
    port.send({ type: 'set-categories', categories: { correctness: true, clarity: true, engagement: true, delivery: true } });
    vi.advanceTimersByTime(200);
    const second = mock.ports[1]!;
    expect(second.sent.map((m) => (m as { type: string }).type)).toEqual(['hello', 'cancel', 'set-categories']);
    // The late onDisconnect from the first port is a no-op now.
    first.fireDisconnect();
    expect(port.status).toBe('open');
    expect(mock.ports.length).toBe(2);
    // A handler that throws does not stop the others or kill the port.
    port.onMessage(() => {
      throw new Error('boom');
    });
    second.emit({ type: 'field-removed', fieldId: 'f9' });
    expect(received).toEqual([{ type: 'field-removed', fieldId: 'f9' }]);
    expect(port.status).toBe('open');
    // The queue is bounded: the oldest message is dropped, never the newest.
    port.close();
    const tiny = connectPanelPort({ backoffMs: [10_000], maxQueue: 2 });
    mock.ports[2]!.fireDisconnect();
    tiny.send({ type: 'cancel', fieldId: 'a' });
    tiny.send({ type: 'cancel', fieldId: 'b' });
    tiny.send({ type: 'cancel', fieldId: 'c' });
    vi.advanceTimersByTime(10_000);
    expect(mock.ports[3]!.sent).toEqual([{ type: 'cancel', fieldId: 'b' }, { type: 'cancel', fieldId: 'c' }]);
    tiny.close();
  });

  it('store: a subscriber that throws does not block other subscribers or corrupt the state; replace() stays silent', () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error('render failed');
    });
    store.subscribe((s) => seen.push(s.n));
    store.update((s) => ({ n: s.n + 1 }));
    expect(seen).toEqual([1]);
    expect(store.get().n).toBe(1);
    store.replace({ n: 5 });
    expect(seen).toEqual([1]);
    expect(store.get().n).toBe(5);
    store.batch(() => {
      store.set({ n: 6 });
      store.batch(() => store.set({ n: 7 }));
    });
    expect(seen).toEqual([1, 7]);
  });
});
