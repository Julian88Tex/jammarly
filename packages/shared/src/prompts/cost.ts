/**
 * Pricing, cost estimation and per-pass sampling configuration (02 §3.1, reviewer A1/A3/A4).
 */
import type { CheckPass } from '../types';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. */
  cacheWrite: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Price table entry for a model id; dated ids (`claude-opus-5-5-20260601`) match their base id. */
export function priceForModel(model: string): ModelPrice | undefined {
  const exact = MODEL_PRICES[model];
  if (exact !== undefined) return exact;
  let best: ModelPrice | undefined;
  let bestLen = 0;
  for (const [id, price] of Object.entries(MODEL_PRICES)) {
    if (model.startsWith(id) && id.length > bestLen) {
      best = price;
      bestLen = id.length;
    }
  }
  return best;
}

/**
 * Cost in USD of one request from its `usage` block. `inputTokens` are the uncached input tokens (as the API
 * reports them); cache reads and writes are billed separately. Unknown models (including `mock`) cost 0.
 */
export function estimateCostUsd(model: string, usage: UsageTokens): number {
  const price = priceForModel(model);
  if (price === undefined) return 0;
  const n = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
  const usd =
    (n(usage.inputTokens) * price.input +
      n(usage.outputTokens) * price.output +
      n(usage.cacheReadTokens) * price.cacheRead +
      n(usage.cacheWriteTokens) * price.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}

export type Effort = 'low' | 'medium';
export type ThinkingConfig = { type: 'disabled' } | { type: 'adaptive' };

/** Effort is fixed per pass so the prompt cache stays warm (effort is rendered into the cached prefix). */
export function effortFor(pass: Exclude<CheckPass, 'rules'>): Effort {
  return pass === 'fast' ? 'low' : 'medium';
}

/**
 * Thinking configuration per model and pass. Haiku 5.5 may disable thinking at effort <= high, which the
 * fast pass does to minimize latency and billed thinking tokens; Opus 5.5 (and any other model) cannot
 * disable thinking, so it runs adaptive thinking at the pass effort.
 */
export function thinkingFor(model: string, pass: Exclude<CheckPass, 'rules'>): ThinkingConfig {
  if (pass === 'fast' && model.includes('haiku')) return { type: 'disabled' };
  return { type: 'adaptive' };
}
