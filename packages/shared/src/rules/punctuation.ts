/** Rule `terminal_punctuation`: doubled `!! ?? ,, ;; ..` (an ellipsis of three or more dots is fine). */
import type { RuleContext } from './context';
import { isDigit, isLetter, isWs } from './context';

const DOUBLED_RE = /([!?,;.])\1+/g;

export function terminalPunctuationRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const casual = opts.formality === 'informal' || opts.context === 'chat' || opts.context === 'social';
  const severity = casual ? 'suggestion' : 'warning';
  for (const m of work.matchAll(DOUBLED_RE)) {
    const ch = m[1] ?? '';
    const run = m[0];
    const start = m.index;
    const end = start + run.length;
    if (ch === '.' && run.length >= 3) continue; // ellipsis
    const before = start > 0 ? work.charAt(start - 1) : '';
    const after = work.charAt(end);
    if (isLetter(after) || isDigit(after)) continue; // "!!x", "1..5", "a,,b" look like code or ranges
    if (before === '' || isWs(before)) continue; // standalone "??", "!!", "../"
    if (ch === '.' && (after === '/' || before === '/')) continue; // relative paths
    if (ch === ',' && isDigit(before)) continue;
    ctx.emit({
      rule: 'terminal_punctuation',
      severity,
      kind: 'replace',
      start,
      end,
      replacement: ch,
      explanation: `One "${ch}" is enough here.`,
      confidence: 0.9,
      autoApplySafe: !casual,
    });
  }
}
