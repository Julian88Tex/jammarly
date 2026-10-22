/**
 * Grammarly-parity benchmark for the local rules engine (fixtures/grammarly-parity.ts): recall on the labelled cases
 * must stay at or above 85%, the clean sentences must produce no suggestion at all, and a 5,000-word email must be
 * checked in under 30 ms. The scores are printed so a regression is visible in the test log.
 */
import { describe, expect, it } from 'vitest';
import { RULE_CATEGORIES, RULE_IDS, RULE_TITLES, hitsToSuggestions, runRules, type RuleHit, type RuleOptions } from '../src/rules';
import { ENGINE_RULE_IDS, categoryForRule } from '../src/prompts/vocabulary';
import { splitParagraphs, stripUrlsAndCode } from '../src/text';
import { CLEAN_SENTENCES, PARITY_CASES, type ParityCase } from './fixtures/grammarly-parity';

const RECALL_THRESHOLD = 0.85;
/** 30 ms locally; shared CI runners are several times slower, so CI only guards against large regressions. */
const ON_CI = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI);
const BUDGET_MS = ON_CI ? 120 : 30;

const BASE: RuleOptions = {
  dialect: 'en-US',
  context: 'email',
  formality: 'neutral',
  protectedTerms: [],
  styleDecisions: {},
  masked: [],
  typing: false,
  mutedRules: [],
};

function run(text: string, partial: Partial<RuleOptions> = {}): RuleHit[] {
  return runRules(text, { ...BASE, ...partial, masked: stripUrlsAndCode(text).masked });
}

function matches(c: ParityCase, h: RuleHit): boolean {
  return h.rule === c.rule && h.original === c.original && (c.replacement === null || h.replacement === c.replacement);
}

function describeHit(h: RuleHit): string {
  return `${h.rule}:${JSON.stringify(h.original)}→${JSON.stringify(h.replacement)}`;
}

describe('Grammarly parity benchmark', () => {
  it('has at least 150 labelled cases and 60 clean sentences', () => {
    expect(PARITY_CASES.length).toBeGreaterThanOrEqual(150);
    expect(CLEAN_SENTENCES.length).toBeGreaterThanOrEqual(60);
    for (const c of PARITY_CASES) {
      expect(c.text.includes(c.original), c.text).toBe(true);
      expect(RULE_IDS as readonly string[], c.rule).toContain(c.rule);
    }
  });

  it(`recall on the labelled cases is at least ${RECALL_THRESHOLD * 100}%`, () => {
    let found = 0;
    const misses: string[] = [];
    const byRule = new Map<string, { found: number; total: number }>();
    for (const c of PARITY_CASES) {
      const hits = run(c.text);
      const ok = hits.some((h) => matches(c, h));
      const row = byRule.get(c.rule) ?? { found: 0, total: 0 };
      row.total++;
      if (ok) {
        found++;
        row.found++;
      } else {
        misses.push(`  ${JSON.stringify(c.text)} wants ${c.rule}:${JSON.stringify(c.original)}→${JSON.stringify(c.replacement)}; got [${hits.map(describeHit).join(', ')}]`);
      }
      byRule.set(c.rule, row);
    }
    const recall = found / PARITY_CASES.length;
    const breakdown = [...byRule.entries()].map(([rule, r]) => `${rule} ${r.found}/${r.total}`).join(', ');
    console.log(`[grammarly-parity] recall ${found}/${PARITY_CASES.length} = ${(recall * 100).toFixed(1)}% (${breakdown})`);
    if (misses.length > 0) console.log(`[grammarly-parity] misses:\n${misses.join('\n')}`);
    expect(recall).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });

  it('produces zero suggestions on the clean sentences', () => {
    const falsePositives: string[] = [];
    for (const text of CLEAN_SENTENCES) {
      for (const h of run(text)) falsePositives.push(`  ${JSON.stringify(text)}: ${describeHit(h)}`);
    }
    console.log(`[grammarly-parity] false positives on ${CLEAN_SENTENCES.length} clean sentences: ${falsePositives.length}`);
    if (falsePositives.length > 0) console.log(falsePositives.join('\n'));
    expect(falsePositives).toEqual([]);
  });

  it('labelled cases raise no hit outside the labelled span, except other genuine issues listed here', () => {
    // Extra hits are allowed only when they are another real issue in the same snippet (e.g. a hedge next to a
    // missing comma); this list keeps them visible and reviewed.
    const ALLOWED_EXTRA = new Set<string>([
      'did you get a chance to review it.', // the lowercase sentence start is flagged too
    ]);
    const extras: string[] = [];
    for (const c of PARITY_CASES) {
      const other = run(c.text).filter((h) => !matches(c, h) && !(h.range.start < c.text.indexOf(c.original) + c.original.length && h.range.end > c.text.indexOf(c.original)));
      if (other.length > 0 && !ALLOWED_EXTRA.has(c.text)) extras.push(`  ${JSON.stringify(c.text)}: ${other.map(describeHit).join(', ')}`);
    }
    console.log(`[grammarly-parity] extra hits on labelled cases: ${extras.length}`);
    if (extras.length > 0) console.log(extras.join('\n'));
    expect(extras).toEqual([]);
  });

  it('every local rule id is an engine-vocabulary id with the same category, so muting and learning are shared', () => {
    for (const id of RULE_IDS) {
      expect(ENGINE_RULE_IDS as readonly string[], id).toContain(id);
      expect(RULE_CATEGORIES[id] ?? 'correctness', id).toBe(categoryForRule(id));
    }
  });

  it('every hit follows the engine contract: vocabulary category, a title, plain-word copy, tiers', () => {
    const texts = [...PARITY_CASES.map((c) => c.text), ...CLEAN_SENTENCES];
    for (const text of texts) {
      const hits = run(text);
      for (const h of hits) {
        expect(h.category, h.rule).toBe(RULE_CATEGORIES[h.rule] ?? 'correctness');
        const vocab = categoryForRule(h.rule);
        if (vocab !== undefined) expect(h.category, h.rule).toBe(vocab);
        expect(Object.values(RULE_TITLES)).toContain(h.title);
        expect(h.title + h.explanation).not.toMatch(/—/);
        expect(h.explanation.length).toBeLessThanOrEqual(140);
        if (h.category !== 'correctness') expect(h.autoApplySafe, describeHit(h)).toBe(false);
        expect(h.original).toBe(text.slice(h.range.start, h.range.end));
      }
      for (const s of hitsToSuggestions(hits, { blocks: splitParagraphs(text), promptVersion: 'v' })) {
        if (!s.meaningPreserving) expect(s.tier).toBe('C');
        else if (s.category === 'correctness' && s.autoApplySafe) expect(s.tier).toBe('A');
        else expect(s.tier).toBe('B');
      }
    }
  });

  it('style rules keep the capitalization of a sentence-initial phrase and fix the article before a replacement', () => {
    const fix = (text: string, rule: string): string[] => run(text).filter((h) => h.rule === rule).map((h) => `${h.original}→${h.replacement}`);
    expect(fix('It was a very easy fix.', 'intensifier')).toEqual(['a very easy→an effortless']);
    expect(fix('An end result like this is rare.', 'redundancy')).toEqual(['An end result→A result']);
    expect(fix('Very good work, team.', 'intensifier')).toEqual(['Very good→Excellent']);
    expect(fix('In order to win, we must ship.', 'wordy_phrase')).toEqual(['In order to→To']);
    expect(fix('TOMOROW works.', 'spelling')).toEqual(['TOMOROW→TOMORROW']);
  });

  it(`checks a 5,000-word email in under ${BUDGET_MS} ms`, () => {
    const pieces = [...PARITY_CASES.map((c) => c.text), ...CLEAN_SENTENCES];
    let text = '';
    let words = 0;
    for (let i = 0; words < 5000; i++) {
      const piece = pieces[(i * 7) % pieces.length] ?? '';
      text += (i % 6 === 5 ? '\n\n' : ' ') + piece;
      words += piece.split(/\s+/).length;
    }
    const o: RuleOptions = { ...BASE, masked: stripUrlsAndCode(text).masked };
    runRules(text, o); // warm up: lexicons, phrase trie, JIT
    // The median of a batch of runs; up to three batches, so a burst of load from parallel test workers does not fail
    // the budget while a real slowdown (slow in every batch) still does.
    let median = Infinity;
    let best = Infinity;
    for (let batch = 0; batch < 3 && median >= BUDGET_MS; batch++) {
      const times: number[] = [];
      for (let k = 0; k < 7; k++) {
        const t0 = performance.now();
        runRules(text, o);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      median = Math.min(median, times[3] ?? Infinity);
      best = Math.min(best, times[0] ?? Infinity);
    }
    console.log(`[grammarly-parity] 5,000 words (${text.length} chars): median ${median.toFixed(2)} ms, best ${best.toFixed(2)} ms`);
    expect(median).toBeLessThan(BUDGET_MS);
  });
});
