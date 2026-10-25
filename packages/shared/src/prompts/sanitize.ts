/**
 * Text hygiene for everything that is injected into a prompt as *data* (user preferences, voice profiles,
 * samples). Block text itself is handled by ./messages (masking only, never escaping: the model must be able
 * to quote it verbatim for anchoring).
 */

/** C0 controls except tab, LF and CR, plus DEL and the C1 range. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Opening/closing placeholder brackets used for masked spans (never produced by keyboards). */
export const PLACEHOLDER_OPEN = '⟦';
export const PLACEHOLDER_CLOSE = '⟧';

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_RE, '');
}

/**
 * Makes a string safe to embed between XML-style tags in a prompt: control characters are stripped, CR/LF are
 * normalized (collapsed to spaces unless `multiline`), tabs become spaces, `<` and `>` become `‹` and `›` so the
 * text can never open or close a tag, placeholder brackets become plain brackets, and the result is capped at
 * `max` UTF-16 code units. Never used on block text (see module doc).
 */
export function sanitizePromptText(s: string, max: number, opts: { multiline?: boolean } = {}): string {
  let out = stripControlChars(s).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  out = opts.multiline ? out.replace(/\n{3,}/g, '\n\n') : out.replace(/\s*\n\s*/g, ' ');
  out = out.replace(/</g, '‹').replace(/>/g, '›').replace(/⟦/g, '[').replace(/⟧/g, ']');
  out = out.trim();
  return out.length > max ? out.slice(0, max) : out;
}

/** Sanitizes a list: trims, drops empties, de-duplicates (case-sensitive), caps item length and count. */
export function sanitizeList(items: readonly string[] | undefined, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items ?? []) {
    if (typeof raw !== 'string') continue;
    const v = sanitizePromptText(raw, maxLen);
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Caps a string's length (UTF-16 code units) without otherwise changing it. */
export function capLength(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
