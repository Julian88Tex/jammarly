/**
 * Rule `capitalization`: a lowercase first word after `.`/`!`/`?` + whitespace (or at the text start),
 * and the lone pronoun "i" (plus i'm / i've / i'll / i'd).
 */
import type { RuleContext } from './context';
import { isAbbreviationBefore, isDigit, isLetter, isLower, isUpper } from './context';

// The run-start lookbehind keeps a long "!!!!" or "....." run linear (see spacing.ts).
const SENTENCE_BREAK_RE = /(?<![.!?])([.!?]+)(["'\u201d\u2019)\]]*)(\s+)(?=\p{Ll})/gu;
const WORD_TAIL_RE = /^[\p{L}\p{N}'’-]*/u;
const CAMEL_RE = /\p{Ll}\p{Lu}/u;
const HAS_DIGIT_RE = /\p{N}/u;
const LONE_I_RE = /(?<![\p{L}\p{N}'’.\-_])i(?:(['’])(m|ve|ll|d))?(?![\p{L}\p{N}'’.\-_])/gu;
const NO_UPPER_RE = /^[^\p{Lu}]*$/u;
const MATH_BEFORE = '=+-*/<>^(';
const MATH_AFTER = '=+-*/<>^)';
/**
 * A sentence-start word that opens a code statement: the keyword must be followed by a code-shaped
 * continuation ("for i in", "if (", "def f(", "const x ="), so prose such as "return to sender." or
 * "class dismissed." is still checked.
 */
const CODE_START_RE = /^(?:for\s+\w+\s+in\s|for\s*\(|if\s*\(|while\s*\(|switch\s*\(|def\s+\w+\s*\(|class\s+\w+\s*[(:{]|function\s*\*?\s*\w*\s*\(|(?:const|let|var)\s+[\w{[$]+\s*=|import\s+[\w.{*]+\s*(?:from\s|;|$)|from\s+[\w.]+\s+import\s|print\s*\(|console\.\w+\(|try\s*[:{]|catch\s*\(|elif\s[^\n]*:\s*$|else\s*[:{])/;

/**
 * Lower-case styled names and acronyms that are correct in lowercase at a sentence start, or whose
 * fix is not a simple first-letter capital ("api" → "API"). Camel-cased brands (iPhone, eBay, macOS)
 * are caught by the mixed-case guard.
 */
const LOWER_OK = new Set([
  'iphone', 'ipad', 'ipod', 'imac', 'ios', 'ipados', 'macos', 'watchos', 'tvos', 'icloud', 'itunes', 'imessage', 'ebay',
  'esim', 'mrna', 'ph', 'npm', 'npx', 'pip', 'git', 'sudo', 'nginx', 'systemd', 'kubectl', 'docker', 'k8s', 'bash', 'zsh',
  'api', 'apis', 'url', 'urls', 'html', 'css', 'js', 'ts', 'json', 'yaml', 'xml', 'sql', 'http', 'https', 'ssh', 'cli',
  'sdk', 'ui', 'ux', 'ai', 'ml', 'id', 'ids', 'ip', 'os', 'pr', 'prs', 'ci', 'cd', 'qa', 'db', 'io', 'cpu', 'gpu', 'ram',
  'aws', 'gcp', 'faq', 'pdf', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'mp3', 'mp4', 'usb', 'wifi', 'vpn', 'dns', 'tcp',
  'udp', 'ssl', 'tls', 'oauth', 'jwt', 'cors', 'rest', 'grpc', 'llm', 'llms', 'gpt', 'nlp', 'ocr', 'iot', 'saas', 'crm',
  'erp', 'kpi', 'kpis', 'roi', 'seo', 'ceo', 'cto', 'cfo', 'coo', 'hr', 'pm', 'eod', 'eta', 'fyi', 'asap', 'lol', 'omg',
  'btw', 'imo', 'imho', 'tbh', 'idk', 'afaik', 'iirc', 'nvm', 'brb', 'ttyl', 'thx', 'pls', 'plz', 'ok', 'tl', 'tldr',
  'ps', 'pps', 'rsvp', 'diy', 'tv', 'vip', 'nyc', 'la', 'uk', 'us', 'usa', 'eu', 'un', 'nasa', 'fbi', 'cia', 'nda', 'mvp',
]);
/**
 * Words before a lone "i" that make it a variable or a command flag, not the pronoun: loop/declaration
 * keywords and math, plus package managers whose install shortcut is "i" ("npm i -D vitest").
 */
const MATH_WORDS = new Set(['for', 'let', 'var', 'const', 'int', 'auto', 'each', 'index', 'sum', 'where', 'npm', 'pnpm', 'yarn', 'bun', 'npx']);

export function capitalizationRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const informalChat = opts.context === 'chat' && opts.formality === 'informal';
  // All-lowercase chat style: judged on the masked copy so an uppercase letter inside a URL, an email
  // address or inline code does not make the user's own lowercase prose look deliberate.
  if (opts.context === 'chat' && NO_UPPER_RE.test(work)) return;
  // Informal writing softens the severity (research 02 §6.1: "informal domain → warning not error").
  const severity = informalChat ? 'suggestion' : opts.formality === 'informal' ? 'warning' : 'error';
  const autoApplySafe = !informalChat;

  const candidate = (wordStart: number): void => {
    const tail = WORD_TAIL_RE.exec(work.slice(wordStart, wordStart + 64))?.[0] ?? '';
    if (tail.length === 0) return;
    const word = tail.replace(/['’-].*$/u, ''); // first segment of "don't" / "well-known"
    if (word.length === 0) return;
    const lower = word.toLowerCase();
    if (lower === 'i') return; // lone-i check below
    if (word.length === 1) return; // "x marks the spot", variables
    if (CODE_START_RE.test(work.slice(wordStart, wordStart + 80))) return; // "for i in range(10):", "if (x) {"
    if (CAMEL_RE.test(tail) || HAS_DIGIT_RE.test(tail)) return; // iPhone, macOS, utf8
    if (LOWER_OK.has(lower) || ctx.protectedTerms.has(lower) || ctx.protectedTerms.has(tail.toLowerCase())) return;
    const after = work.charAt(wordStart + tail.length);
    if (after === '(' || after === '/' || after === '\\' || after === '_' || after === '=') return; // code
    if ((after === '.' || after === ':') && isLetter(work.charAt(wordStart + tail.length + 1))) return; // foo.bar
    ctx.emit({
      rule: 'capitalization',
      key: 'capitalization.sentence_start',
      severity,
      kind: 'replace',
      start: wordStart,
      end: wordStart + word.length,
      replacement: word.charAt(0).toUpperCase() + word.slice(1),
      explanation: 'Sentences start with a capital letter.',
      confidence: 0.9,
      autoApplySafe,
    });
  };

  // Text start.
  let k = 0;
  while (k < work.length && /\s/.test(work.charAt(k))) k++;
  if (k < work.length && isLower(work.charAt(k))) candidate(k);

  // After a terminator run + optional closers + whitespace.
  for (const m of work.matchAll(SENTENCE_BREAK_RE)) {
    const run = m[1] ?? '';
    const closers = m[2] ?? '';
    const runStart = m.index;
    const wordStart = runStart + m[0].length;
    if (run.includes('.') && run.length >= 2) continue; // ellipsis "..." or "?.."
    // "Stop!" she yelled. / He left (finally!) and went home. A quoted or bracketed exclamation or
    // question does not end the enclosing sentence; a period inside the closer does ("no." then left).
    if (closers.length > 0 && !run.includes('.')) continue;
    if (run === '.') {
      if (runStart === 0) continue;
      const before = work.charAt(runStart - 1);
      if (!(isLetter(before) || isDigit(before))) continue; // "3. apples" style handled below; ") ." etc.
      if (isAbbreviationBefore(work, runStart, work.charAt(wordStart))) continue; // e.g., Dr., U.S., initials, numbers (list markers)
    }
    candidate(wordStart);
  }

  // Lone "i".
  for (const m of work.matchAll(LONE_I_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    let p = start;
    while (p > 0 && (work.charAt(p - 1) === ' ' || work.charAt(p - 1) === ' ')) p--;
    const prev = work.charAt(p - 1);
    let q = end;
    while (q < work.length && (work.charAt(q) === ' ' || work.charAt(q) === ' ')) q++;
    const next = work.charAt(q);
    if (prev !== '' && MATH_BEFORE.includes(prev)) continue;
    if (next !== '' && MATH_AFTER.includes(next)) continue;
    if (prev === '(' || next === ')') continue; // roman numeral "(i)"
    // "for i in", "let i"
    let pw = p;
    while (pw > 0 && isLetter(work.charAt(pw - 1))) pw--;
    if (MATH_WORDS.has(work.slice(pw, p).toLowerCase())) continue;
    const apostrophe = m[1] ?? '';
    const suffix = m[2] ?? '';
    ctx.emit({
      rule: 'capitalization',
      key: 'capitalization.lone_i',
      severity,
      kind: 'replace',
      start,
      end,
      replacement: `I${apostrophe}${suffix}`,
      explanation: 'The pronoun "I" is always capitalized.',
      confidence: 0.95,
      autoApplySafe,
    });
  }
}
