/**
 * Token/cost ledger (ARCHITECTURE §3.3 "Daily budget"): per local day and per month, with request counts, and the
 * budget decision the engine and the config make from it.
 */
import type { DeviceSettings, TokenUsage, UsageTotals } from '@jammarly/shared/types';
import type { UsageBucket, UsageLedger } from './storage';
import { localDate, localMonth } from './util';

export const EMPTY_BUCKET: UsageBucket = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 };

function add(a: UsageBucket, u: TokenUsage): UsageBucket {
  return {
    inputTokens: a.inputTokens + u.inputTokens,
    outputTokens: a.outputTokens + u.outputTokens,
    cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + u.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + u.costUsd) * 1e9) / 1e9,
    requests: a.requests + 1,
  };
}

/** A new ledger with `usage` recorded at `nowMs`; older days beyond 35 and months beyond 13 are pruned. */
export function recordUsage(ledger: UsageLedger, usage: TokenUsage, nowMs: number): UsageLedger {
  const day = localDate(nowMs);
  const month = localMonth(nowMs);
  const days = { ...ledger.days, [day]: add(ledger.days[day] ?? EMPTY_BUCKET, usage) };
  const months = { ...ledger.months, [month]: add(ledger.months[month] ?? EMPTY_BUCKET, usage) };
  for (const k of Object.keys(days).sort().slice(0, -35)) delete days[k];
  for (const k of Object.keys(months).sort().slice(0, -13)) delete months[k];
  return { days, months };
}

export function todayBucket(ledger: UsageLedger, nowMs: number): UsageBucket {
  return ledger.days[localDate(nowMs)] ?? EMPTY_BUCKET;
}

export function monthBucket(ledger: UsageLedger, nowMs: number): UsageBucket {
  return ledger.months[localMonth(nowMs)] ?? EMPTY_BUCKET;
}

export interface BudgetState {
  /** Today's spend reached the daily budget (deep passes downgrade to the fast model). */
  exhausted: boolean;
  spentToday: number;
  /** 0 = unlimited. */
  limit: number;
}

export function budgetState(settings: Pick<DeviceSettings, 'dailyBudgetUsd'>, ledger: UsageLedger, nowMs: number): BudgetState {
  const limit = settings.dailyBudgetUsd > 0 ? settings.dailyBudgetUsd : 0;
  const spentToday = todayBucket(ledger, nowMs).costUsd;
  return { exhausted: limit > 0 && spentToday >= limit, spentToday, limit };
}

/** Whether a call estimated at `estimateUsd` would push today's spend over the budget. */
export function wouldExceedBudget(budget: BudgetState, estimateUsd: number): boolean {
  return budget.limit > 0 && budget.spentToday + estimateUsd > budget.limit;
}

export function usageTotals(ledger: UsageLedger, nowMs: number): UsageTotals {
  return { today: { ...todayBucket(ledger, nowMs) }, month: { ...monthBucket(ledger, nowMs) } };
}
