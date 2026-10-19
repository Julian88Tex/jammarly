/** Rule `consistency_hyphenation`: the dash used between words (`--`, `—`, ` — `, ` – `, ` - `). */
import type { RuleContext } from './context';
import { isDigit } from './context';

type DashStyle = 'em_closed' | 'em_spaced' | 'en_spaced' | 'hyphen_spaced' | 'double_hyphen';

const DASH_RE = /(?<=[\p{L}\p{N}”’"')\]])( -- |--| — |—| – | - )(?=[\p{L}\p{N}“‘"'(\[])/gu;
const STYLE_OF: Record<string, DashStyle> = {
  ' -- ': 'double_hyphen',
  '--': 'double_hyphen',
  ' — ': 'em_spaced',
  '—': 'em_closed',
  ' – ': 'en_spaced',
  ' - ': 'hyphen_spaced',
};
const TEXT_OF: Record<DashStyle, string> = {
  em_closed: '—',
  em_spaced: ' — ',
  en_spaced: ' – ',
  hyphen_spaced: ' - ',
  double_hyphen: ' -- ',
};
const LABEL: Record<DashStyle, string> = {
  em_closed: 'a closed em dash',
  em_spaced: 'a spaced em dash',
  en_spaced: 'a spaced en dash',
  hyphen_spaced: 'a spaced hyphen',
  double_hyphen: 'a double hyphen',
};

function isDashStyle(s: string | undefined): s is DashStyle {
  return s !== undefined && s in TEXT_OF;
}

export function dashRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  const found: { start: number; end: number; style: DashStyle }[] = [];
  const counts = new Map<DashStyle, number>();
  for (const m of work.matchAll(DASH_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (isDigit(work.charAt(start - 1)) && isDigit(work.charAt(end))) continue; // "5 - 3", "9–5"
    const style = STYLE_OF[m[0]];
    if (style === undefined) continue;
    found.push({ start, end, style });
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  if (found.length === 0) return;

  const decision = opts.styleDecisions['dash'];
  let target: DashStyle;
  let confidence: number;
  let autoApplySafe: boolean;
  if (isDashStyle(decision)) {
    target = decision;
    confidence = 0.9;
    autoApplySafe = true;
  } else {
    if (counts.size < 2) return;
    let best: DashStyle | null = null;
    let bestCount = 0;
    let tie = false;
    for (const [style, count] of counts) {
      if (count > bestCount) {
        best = style;
        bestCount = count;
        tie = false;
      } else if (count === bestCount) tie = true;
    }
    if (best === null || tie) return;
    target = best;
    confidence = 0.8;
    autoApplySafe = false;
  }
  for (const f of found) {
    if (f.style === target) continue;
    ctx.emit({
      rule: 'consistency_hyphenation',
      severity: 'suggestion',
      kind: 'replace',
      start: f.start,
      end: f.end,
      replacement: TEXT_OF[target],
      explanation: isDashStyle(decision)
        ? `Your style uses ${LABEL[target]} between words.`
        : `This document mostly uses ${LABEL[target]}; keep one style.`,
      confidence,
      autoApplySafe,
    });
  }
}
