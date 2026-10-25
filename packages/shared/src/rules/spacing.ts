/**
 * Rule `spacing`: multiple spaces between words, a space before punctuation, a missing space after
 * punctuation, and trailing whitespace before a line break.
 */
import type { RuleContext } from './context';
import { ABBREVIATIONS, CLOSERS, PLACEHOLDER, isDigit, isLetter, isLower, isUpper, isWordChar, isWs } from './context';

const MULTI_SPACE_RE = /[  ]{2,}/g;
const SENTENCE_END_RE = /[.!?]["'”’)\]]*$/;
// The run-start lookbehinds keep these linear: without them a long whitespace run that is not followed
// by punctuation (or a line break) is re-scanned from every position inside it (quadratic).
const SPACE_BEFORE_PUNCT_RE = /(?<![ \u00a0\u202f])([ \u00a0\u202f]+)([,.;:!?])/g;
const MISSING_SPACE_RE = /(?<=\p{L})([.,;:!?])(?=\p{L})/gu;
const TRAILING_WS_RE = /(?<![ \t\u00a0])[ \t\u00a0]+(?=\r\n|\n|\r)/g;
const NBSP_ONLY_RE = /^[  ]+$/;
const LOWER_WORD_RE = /^\p{Ll}+$/u;
const CAMEL_RE = /\p{Ll}\p{Lu}/u;
const HAS_DIGIT_RE = /\p{N}/u;
const PUNCT_RUN = new Set([',', '.', ';', ':', '!', '?']);

/** Lower-cased file extensions that follow a period with no space ("report.pdf"). */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs',
  'php', 'sql', 'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'map', 'wasm',
  'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'xml', 'md', 'txt', 'rtf', 'csv', 'tsv', 'log', 'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'pages', 'key', 'numbers', 'epub',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'heic', 'psd', 'ai',
  'mp3', 'mp4', 'wav', 'flac', 'mov', 'avi', 'mkv', 'webm', 'ogg', 'm4a',
  'zip', 'tar', 'gz', 'tgz', 'rar', 'bz2', 'xz', 'exe', 'dll', 'dmg', 'iso', 'apk', 'deb', 'rpm', 'msi', 'bak', 'tmp',
  'com', 'org', 'net', 'io', 'dev', 'co', 'edu', 'gov', 'ai', 'app', 'me', 'us', 'uk', 'ca', 'de', 'fr', 'info', 'biz', 'ly', 'tv', 'xyz',
]);

/** Characters that mark the preceding/following token as a path, identifier or code. */
const CODEY_BEFORE = '/\\_-$@#~.';
const CODEY_AFTER = '(/\\_[=';

export function spacingRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const n = work.length;
  const keepDouble = opts.styleDecisions['double_space_after_period'] === 'keep';

  // (a) Multiple spaces between words.
  for (const m of work.matchAll(MULTI_SPACE_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start === 0 || end >= n) continue; // leading indentation or end of text
    const before = work.charAt(start - 1);
    const after = work.charAt(end);
    if (isWs(before) || isWs(after)) continue; // indentation (after a line break) or trailing whitespace
    let replacement = ' ';
    if (SENTENCE_END_RE.test(work.slice(Math.max(0, start - 4), start))) {
      if (keepDouble) {
        if (end - start === 2) continue;
        replacement = '  ';
      }
    }
    ctx.emit({
      rule: 'spacing',
      key: 'spacing.double_space',
      severity: 'warning',
      kind: 'replace',
      start,
      end,
      replacement,
      explanation: replacement === '  ' ? 'Use two spaces here, not more.' : 'There is more than one space between these words.',
      confidence: 0.95,
      autoApplySafe: true,
    });
  }

  // (b) Space before , . ; : ! ?
  // Every Dialect value is an English variety, so French-style spacing before ;:!? is out of scope;
  // a run made only of non-breaking spaces is still treated as deliberate typography.
  for (const m of work.matchAll(SPACE_BEFORE_PUNCT_RE)) {
    const spaces = m[1] ?? '';
    const punct = m[2] ?? '';
    const sStart = m.index;
    const pIdx = sStart + spaces.length;
    if (sStart === 0) continue;
    const before = work.charAt(sStart - 1);
    if (!(isLetter(before) || isDigit(before) || CLOSERS.has(before))) continue;
    const next = work.charAt(pIdx + 1);
    let k = pIdx + 1;
    while (k < n && (work.charAt(k) === ' ' || work.charAt(k) === ' ')) k++;
    const nextNonSpace = work.charAt(k);
    if (punct === '.' && (next === '.' || nextNonSpace === '.')) continue; // ellipsis ". . ." / " ..."
    if (NBSP_ONLY_RE.test(spaces) && ';:!?'.includes(punct)) continue;
    if ((punct === ':' || punct === '.') && isDigit(before) && isDigit(nextNonSpace)) continue; // "3 : 2", "3 .5"
    if (next === PLACEHOLDER) continue;
    // A doubled mark standing alone between spaces is an operator ("a ?? b", "x :: y", "a .. b").
    if (next === punct) {
      let r = pIdx;
      while (r < n && work.charAt(r) === punct) r++;
      if (r >= n || isWs(work.charAt(r))) continue;
    }
    let replacement = punct;
    if ((punct === ':' || punct === ';') && next !== '' && !isWs(next)) continue; // ":)", ";)", ":smile:", "::"
    if (next !== '' && !isWs(next) && !CLOSERS.has(next) && !PUNCT_RUN.has(next)) {
      // Something glued to the punctuation: emoticons ":)", emoji codes ":smile:", code "foo .bar".
      if (!(isLetter(next) && (punct === ',' || punct === '!' || punct === '?'))) continue;
      replacement = punct + ' ';
    }
    ctx.emit({
      rule: 'spacing',
      key: 'spacing.before_punctuation',
      severity: 'error',
      kind: 'replace',
      start: sStart,
      end: pIdx + 1,
      replacement,
      explanation: `Remove the space before "${punct}".`,
      confidence: 0.95,
      autoApplySafe: true,
    });
  }

  // (c) Missing space after . , ; : ! ? followed by a letter.
  for (const m of work.matchAll(MISSING_SPACE_RE)) {
    const pIdx = m.index;
    const punct = m[1] ?? '';
    const after = work.charAt(pIdx + 1);
    let ws = pIdx;
    while (ws > 0 && isWordChar(work.charAt(ws - 1))) ws--;
    let we = pIdx + 1;
    while (we < n && isWordChar(work.charAt(we))) we++;
    const prevWord = work.slice(ws, pIdx);
    const nextWord = work.slice(pIdx + 1, we);
    if (prevWord.length < 2 || nextWord.length < 2) continue;
    if (HAS_DIGIT_RE.test(prevWord) || HAS_DIGIT_RE.test(nextWord)) continue; // versions, times, codes
    const beforeWord = ws > 0 ? work.charAt(ws - 1) : '';
    const afterWord = we < n ? work.charAt(we) : '';
    if (beforeWord !== '' && CODEY_BEFORE.includes(beforeWord)) continue; // "e.g.The", "src/foo.ts", "snake_case.x"
    if (afterWord !== '' && CODEY_AFTER.includes(afterWord)) continue; // "a.b(", "x:y="
    if (afterWord === '.' && isLetter(work.charAt(we + 1))) continue; // dotted chains "a.b.c"
    if (punct === ';' && (beforeWord === '&' || beforeWord === '#')) continue; // HTML entities
    if (CAMEL_RE.test(prevWord) || CAMEL_RE.test(nextWord)) continue; // identifiers
    if (punct === '.') {
      if (ABBREVIATIONS.has(prevWord.toLowerCase())) continue;
      if (FILE_EXTENSIONS.has(nextWord.toLowerCase())) continue;
      if (!LOWER_WORD_RE.test(prevWord)) continue; // "System.Out", "HELLO.World"
      if (!(isUpper(after) && isLower(work.charAt(pIdx + 2)))) continue; // need a sentence-like "Xx" start
    } else {
      if (!/\p{Ll}/u.test(prevWord)) continue; // acronyms, headings
      if ((punct === ':' || punct === ';') && !isUpper(after)) continue; // "key:value" is code-like
    }
    const codey = punct === ':' || punct === ';';
    ctx.emit({
      rule: 'spacing',
      key: 'spacing.missing_after_punctuation',
      severity: 'error',
      kind: 'insert',
      start: pIdx,
      end: pIdx + 2,
      replacement: `${punct} ${after}`,
      explanation: `Add a space after "${punct}".`,
      confidence: codey ? 0.8 : 0.9,
      autoApplySafe: !codey,
    });
  }

  // (d) Trailing whitespace before a line break (never in chat or code fields; not for a whitespace-only line).
  if (opts.context !== 'chat' && opts.context !== 'code') {
    for (const m of work.matchAll(TRAILING_WS_RE)) {
      const start = m.index;
      const end = start + m[0].length;
      if (start === 0 || isWs(work.charAt(start - 1))) continue;
      if (m[0] === '  ') continue; // Markdown hard line break
      if (opts.typing && work.slice(end).trim().length === 0) continue; // the user just pressed Enter
      ctx.emit({
        rule: 'spacing',
        key: 'spacing.trailing_whitespace',
        severity: 'suggestion',
        kind: 'delete',
        start,
        end,
        replacement: '',
        explanation: 'Remove the whitespace at the end of the line.',
        confidence: 0.9,
        autoApplySafe: true,
      });
    }
  }
}
