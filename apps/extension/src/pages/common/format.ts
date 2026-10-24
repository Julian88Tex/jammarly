/**
 * Formatting helpers for the pages: money, counts, durations, relative times, hostnames.
 */

/** Two-decimal dollars: "$0.04", "$2.00". Negative or NaN input renders as "$0.00". */
export function formatUsd(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  return `$${n.toFixed(2)}`;
}

/** Four-decimal dollars for tiny per-request costs: "$0.0123". Values of a dollar or more use two decimals. */
export function formatUsdPrecise(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** Thousands-separated integer: 1234 -> "1,234". */
export function formatCount(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return n.toLocaleString('en-US');
}

/** "1 word" / "12 words". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Reading time copy from seconds: "< 1 min read", "3 min read". */
export function formatReadingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min read';
  if (seconds < 60) return '< 1 min read';
  return `${Math.round(seconds / 60)} min read`;
}

/** Relative time: "just now", "3 min ago", "2 h ago", "yesterday", "5 days ago", else a short date. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const diff = Math.max(0, now - t);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 14 * day) return `${Math.floor(diff / day)} days ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Absolute date for consent timestamps and tables: "Oct 21, 2026, 10:04 AM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  return new Date(t).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Hostname of an http(s) URL, or null for anything else (chrome://, file:, extension pages, invalid). */
export function hostFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

/** Normalizes user-typed host input ("https://Mail.Google.com/x" -> "mail.google.com"); null when nothing usable. */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/^www\./, '');
    if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
    return host;
  } catch {
    return null;
  }
}

/** Cuts a string to `max` characters with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Shows whitespace-only or empty originals/replacements legibly. */
export function visibleText(value: string): string {
  if (value === '') return '∅';
  if (/^\s+$/.test(value)) return value.length === 1 ? '␣' : `␣×${value.length}`;
  return value;
}
