/**
 * TODO(integration): local fallback for `@jammarly/shared/learner` (foldEvents, resolveRuleStates, promotedRules,
 * applyLearnedState, dictionaryCandidates, buildLearningSummary, LEARNER_CONSTANTS), which another agent is
 * finishing. Implements ARCHITECTURE §3.7 and research 08 §8.2 with the reviewer corrections (N_MIN_SCOPE,
 * promotion as an orthogonal flag). Swap the re-export in ../shared-engine.ts once the shared module lands.
 */
import type { LearnedRuleState, ProfileDocument, RuleStats } from '@jammarly/shared/profile';
import type { FeedbackEvent, LearningSummary, RateBlock, TrendValue } from '@jammarly/shared/learning';
import type { Suggestion, SuggestionCategory, WritingContext } from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';

type Learning = ProfileDocument['learning'];

export const LEARNER_CONSTANTS = {
  Z: 1.96,
  N_MIN_SCOPE: 8,
  N_MIN_SUPPRESS: 8,
  UB_SUPPRESS: 0.35,
  N_MIN_DEMOTE: 6,
  UB_DEMOTE: 0.5,
  IGNORE_RATE_DEMOTE: 0.8,
  N_MIN_IGNORE: 20,
  N_MIN_PROMOTE: 10,
  LB_PROMOTE: 0.8,
  REPORT_WEIGHT: 2,
  CONFIDENCE_FLOOR: 0.9,
  PROMOTED_TIER_A_CONFIDENCE: 0.7,
  MAX_SUPPRESSED_SHARE: 0.3,
  CORE_CORRECTNESS: [
    'spelling', 'subject_verb_agreement', 'verb_form', 'confusable_word', 'repeated_word', 'apostrophe',
    'capitalization', 'capitalization_sentence_start', 'terminal_punctuation', 'missing_word',
  ] as readonly string[],
} as const;

export interface LearnedStateView {
  ruleStates: Record<string, LearnedRuleState>;
  /** Rule ids with eligibleForBulk (correctness, global scope). */
  promoted: string[];
  /** Live rules.muted values: plain rule ids or "<rule>@<host>". */
  manualOff: string[];
}

export interface WilsonBounds {
  lb: number;
  ub: number;
}

export function wilson(pos: number, n: number, z = LEARNER_CONSTANTS.Z): WilsonBounds {
  if (n <= 0) return { lb: 0, ub: 1 };
  const p = pos / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lb: Math.max(0, (centre - margin) / denom), ub: Math.min(1, (centre + margin) / denom) };
}

export function statsKey(scope: 'global' | 'ctx' | 'host', scopeKey: string, rule: string): string {
  return `${scope}|${scopeKey}|${rule}`;
}

function parseKey(key: string): { scope: 'global' | 'ctx' | 'host'; scopeKey: string; rule: string } | null {
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  const [scope, scopeKey, rule] = parts as [string, string, string];
  if (scope !== 'global' && scope !== 'ctx' && scope !== 'host') return null;
  return { scope, scopeKey, rule };
}

function emptyStats(): RuleStats {
  return { shown: 0, accepted: 0, dismissed: 0, ignored: 0, reported: 0, lastSeen: '' };
}

/** Folds decision events into per-(scope, rule) counters. Pure: returns a new learning section. */
export function foldEvents(learning: Learning, events: readonly FeedbackEvent[]): Learning {
  const stats: Record<string, RuleStats> = { ...learning.stats };
  let cursor = learning.lastEventCursor;
  for (const e of events) {
    if (typeof e.rule !== 'string' || e.rule.length === 0) continue;
    const scopes: [('global' | 'ctx' | 'host'), string][] = [['host', e.host], ['ctx', e.ctx], ['global', '']];
    for (const [scope, scopeKey] of scopes) {
      const key = statsKey(scope, scopeKey, e.rule);
      const s = { ...(stats[key] ?? emptyStats()) };
      switch (e.kind) {
        case 'shown':
          s.shown += 1;
          break;
        case 'accept':
        case 'accepted_by_typing':
          s.accepted += 1;
          break;
        case 'dismiss':
          s.dismissed += 1;
          break;
        case 'ignore':
          s.ignored += 1;
          break;
        case 'report_incorrect':
          s.reported += 1;
          break;
        default:
          continue;
      }
      if (e.t > s.lastSeen) s.lastSeen = e.t;
      stats[key] = s;
    }
    if (e.t > cursor) cursor = e.t;
  }
  return { ...learning, stats, lastEventCursor: cursor };
}

function decisions(s: RuleStats): { pos: number; n: number } {
  const neg = s.dismissed + LEARNER_CONSTANTS.REPORT_WEIGHT * s.reported;
  return { pos: s.accepted, n: s.accepted + neg };
}

function stateFor(s: RuleStats): 'active' | 'demoted' | 'suppressed' | null {
  const { pos, n } = decisions(s);
  const C = LEARNER_CONSTANTS;
  if (n < C.N_MIN_SCOPE) {
    if (s.shown >= C.N_MIN_IGNORE && s.ignored / s.shown >= C.IGNORE_RATE_DEMOTE) return 'demoted';
    return null;
  }
  const { ub } = wilson(pos, n);
  if (n >= C.N_MIN_SUPPRESS && ub < C.UB_SUPPRESS) return 'suppressed';
  if (ub < C.UB_DEMOTE) return 'demoted';
  if (s.shown >= C.N_MIN_IGNORE && s.ignored / s.shown >= C.IGNORE_RATE_DEMOTE) return 'demoted';
  return 'active';
}

const SCOPE_ORDER: Record<'host' | 'ctx' | 'global', number> = { host: 0, ctx: 1, global: 2 };

/**
 * Resolves one visibility state per rule: the most specific scope with enough decisions decides. Core correctness
 * rules are never suppressed (they are only ever demoted or active). `eligibleForBulk` is computed on the global
 * scope for correctness rules (n >= 10 and Wilson LB >= 0.80).
 */
export function resolveRuleStates(learning: Learning, categoryOf: (rule: string) => SuggestionCategory | undefined = () => undefined): Record<string, LearnedRuleState> {
  const byRule = new Map<string, { key: ReturnType<typeof parseKey> & object; stats: RuleStats }[]>();
  for (const [key, stats] of Object.entries(learning.stats)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const list = byRule.get(parsed.rule) ?? [];
    list.push({ key: parsed, stats });
    byRule.set(parsed.rule, list);
  }
  const now = new Date().toISOString();
  const out: Record<string, LearnedRuleState> = {};
  for (const [rule, entries] of byRule) {
    entries.sort((a, b) => SCOPE_ORDER[a.key.scope] - SCOPE_ORDER[b.key.scope] || a.key.scopeKey.localeCompare(b.key.scopeKey));
    const previous = learning.ruleStates[rule];
    let chosen: { scope: 'global' | 'ctx' | 'host'; scopeKey: string; state: 'active' | 'demoted' | 'suppressed' } | null = null;
    for (const { key, stats } of entries) {
      const st = stateFor(stats);
      if (st === null) continue;
      if (st === 'suppressed' && LEARNER_CONSTANTS.CORE_CORRECTNESS.includes(rule)) {
        chosen = { scope: key.scope, scopeKey: key.scopeKey, state: 'demoted' };
        break;
      }
      chosen = { scope: key.scope, scopeKey: key.scopeKey, state: st };
      break;
    }
    const global = entries.find((e) => e.key.scope === 'global')?.stats;
    let eligibleForBulk = false;
    if (global) {
      const { pos, n } = decisions(global);
      const cat = categoryOf(rule);
      if ((cat === undefined || cat === 'correctness') && n >= LEARNER_CONSTANTS.N_MIN_PROMOTE && wilson(pos, n).lb >= LEARNER_CONSTANTS.LB_PROMOTE) eligibleForBulk = true;
    }
    const state = chosen ?? { scope: 'global' as const, scopeKey: '', state: 'active' as const };
    const same = previous && previous.state === state.state && previous.scope === state.scope && previous.scopeKey === state.scopeKey;
    out[rule] = {
      state: state.state,
      eligibleForBulk,
      scope: state.scope,
      scopeKey: state.scopeKey,
      since: same ? previous.since : now,
      reprobeStage: previous?.reprobeStage ?? 0,
    };
  }
  return out;
}

export function promotedRules(ruleStates: Record<string, LearnedRuleState>): string[] {
  return Object.entries(ruleStates)
    .filter(([, s]) => s.eligibleForBulk)
    .map(([rule]) => rule)
    .sort();
}

export interface ApplyLearnedOptions {
  ruleStates: Record<string, LearnedRuleState>;
  promoted: readonly string[];
  /** Live rules.muted values: plain rule ids (global) or "<rule>@<host>". */
  manualOff: readonly string[];
  host: string;
  ctx: WritingContext;
  /** Resolved muted rules for this host (plain ids), including learner suppressions already resolved by config. */
  mutedRules?: readonly string[];
}

/** Whether a learned state applies to this host/context (host and ctx scopes only match their own key). */
export function learnedStateApplies(state: LearnedRuleState, host: string, ctx: WritingContext): boolean {
  if (state.scope === 'global') return true;
  if (state.scope === 'ctx') return state.scopeKey === ctx;
  return state.scopeKey === host;
}

/**
 * Hides manually muted and learned-suppressed rules, marks demoted ones, and lets promoted correctness rules reach
 * Tier A at confidence >= 0.70. Core correctness errors at confidence >= 0.90 are never learned away (manual mute
 * still hides them).
 */
export function applyLearnedState(suggestions: readonly Suggestion[], opts: ApplyLearnedOptions): Suggestion[] {
  const manual = new Set<string>();
  for (const m of opts.manualOff) {
    const at = m.indexOf('@');
    if (at === -1) manual.add(m);
    else if (m.slice(at + 1) === opts.host) manual.add(m.slice(0, at));
  }
  for (const m of opts.mutedRules ?? []) manual.add(m);
  const promoted = new Set(opts.promoted);
  const out: Suggestion[] = [];
  for (const s of suggestions) {
    if (manual.has(s.rule)) continue;
    const floor = s.category === 'correctness' && s.severity === 'error' && s.confidence >= LEARNER_CONSTANTS.CONFIDENCE_FLOOR;
    const learned = opts.ruleStates[s.rule];
    let learnedState: Suggestion['learnedState'] = 'active';
    if (learned && !floor && learnedStateApplies(learned, opts.host, opts.ctx)) {
      if (learned.state === 'suppressed') continue;
      if (learned.state === 'demoted') learnedState = 'demoted';
      if (learned.state === 'probing') learnedState = 'probe';
    }
    let tier = s.tier;
    if (
      promoted.has(s.rule) &&
      s.category === 'correctness' &&
      s.severity === 'error' &&
      s.autoApplySafe &&
      s.meaningPreserving &&
      s.anchor === 'exact' &&
      (s.kind === 'replace' || s.kind === 'delete' || s.kind === 'insert') &&
      s.confidence >= LEARNER_CONSTANTS.PROMOTED_TIER_A_CONFIDENCE
    ) {
      tier = 'A';
    }
    out.push(learnedState === s.learnedState && tier === s.tier ? s : { ...s, learnedState, tier });
  }
  return out;
}

const TOKEN_RE = /^[\p{L}][\p{L}'’-]{1,99}$/u;

/**
 * Dictionary candidates from spelling / capitalization dismissals (08 §8.2): a token dismissed >= 3 times, or >= 2
 * times in >= 2 distinct documents, or a capitalized token dismissed >= 2 times. Existing dictionary entries are
 * excluded.
 */
export function dictionaryCandidates(events: readonly FeedbackEvent[], exclude: readonly string[] = []): string[] {
  const skip = new Set(exclude.map((w) => w.toLowerCase()));
  const counts = new Map<string, { n: number; docs: Set<string>; capitalized: boolean }>();
  for (const e of events) {
    if (e.kind !== 'dismiss' && e.kind !== 'self_corrected') continue;
    if (e.rule !== 'spelling' && e.rule !== 'capitalization' && e.rule !== 'spelling_dialect') continue;
    const token = (e.original ?? '').trim();
    if (!TOKEN_RE.test(token)) continue;
    const key = token.toLowerCase();
    if (skip.has(key)) continue;
    const c = counts.get(key) ?? { n: 0, docs: new Set<string>(), capitalized: /^\p{Lu}/u.test(token) };
    c.n += 1;
    c.docs.add(e.docKey);
    counts.set(key, c);
  }
  const out: string[] = [];
  for (const [token, c] of counts) {
    if (c.n >= 3 || (c.n >= 2 && c.docs.size >= 2) || (c.capitalized && c.n >= 2)) out.push(token);
  }
  return out.sort();
}

function trend(value: number, prev: number, n: number, pos: number): TrendValue {
  const b = wilson(pos, n);
  return { value, ciLow: n > 0 ? b.lb : 0, ciHigh: n > 0 ? b.ub : 0, prev, delta: value - prev, n };
}

function rateBlock(events: readonly FeedbackEvent[], prevEvents: readonly FeedbackEvent[]): RateBlock {
  const count = (list: readonly FeedbackEvent[]) => {
    let shown = 0;
    let accepted = 0;
    let dismissed = 0;
    let ignored = 0;
    for (const e of list) {
      if (e.kind === 'shown') shown++;
      else if (e.kind === 'accept' || e.kind === 'accepted_by_typing') accepted++;
      else if (e.kind === 'dismiss') dismissed++;
      else if (e.kind === 'ignore') ignored++;
    }
    const n = accepted + dismissed;
    return { shown, accepted, dismissed, ignored, n, acceptance: n > 0 ? accepted / n : 0, dismissRate: n > 0 ? dismissed / n : 0, ignoreRate: shown > 0 ? ignored / shown : 0 };
  };
  const c = count(events);
  const p = count(prevEvents);
  return {
    shown: c.shown,
    accepted: c.accepted,
    dismissed: c.dismissed,
    ignored: c.ignored,
    acceptance: trend(c.acceptance, p.acceptance, c.n, c.accepted),
    dismissRate: trend(c.dismissRate, p.dismissRate, c.n, c.dismissed),
    ignoreRate: trend(c.ignoreRate, p.ignoreRate, c.shown, c.ignored),
  };
}

export interface SummaryInput {
  events: readonly FeedbackEvent[];
  profile: ProfileDocument;
  learning: Learning;
  manualOff: readonly string[];
  now?: number;
  days?: 7 | 14 | 28;
  categoryOf?: (rule: string) => SuggestionCategory | undefined;
}

/** Dashboard summary over the last `days` (default 28) of locally buffered events. */
export function buildLearningSummary(input: SummaryInput): LearningSummary {
  const now = input.now ?? Date.now();
  const days = input.days ?? 28;
  const from = now - days * 86_400_000;
  const prevFrom = from - days * 86_400_000;
  const inWindow = input.events.filter((e) => Date.parse(e.t) >= from);
  const prev = input.events.filter((e) => {
    const t = Date.parse(e.t);
    return t >= prevFrom && t < from;
  });
  const byCategory = {} as LearningSummary['byCategory'];
  for (const cat of CATEGORIES) {
    const cur = inWindow.filter((e) => e.category === cat);
    const words = inWindow.reduce((sum, e) => sum + (e.wordCountTyped ?? 0), 0);
    const shownCur = cur.filter((e) => e.kind === 'shown').length;
    const per100 = words > 0 ? (shownCur * 100) / words : 0;
    byCategory[cat] = { ...rateBlock(cur, prev.filter((e) => e.category === cat)), per100Words: trend(per100, 0, shownCur, shownCur) };
  }
  const byContext: LearningSummary['byContext'] = {};
  for (const ctx of new Set(inWindow.map((e) => e.ctx))) {
    byContext[ctx] = rateBlock(inWindow.filter((e) => e.ctx === ctx), prev.filter((e) => e.ctx === ctx));
  }
  const hosts = new Set(inWindow.map((e) => e.host));
  const byHost = [...hosts].map((host) => ({ host, ...rateBlock(inWindow.filter((e) => e.host === host), prev.filter((e) => e.host === host)) }));

  const manualSet = new Set(input.manualOff);
  const byRule: LearningSummary['byRule'] = [];
  for (const [key, stats] of Object.entries(input.learning.stats)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const { pos, n } = decisions(stats);
    const b = wilson(pos, n);
    const state = input.learning.ruleStates[parsed.rule];
    const cat = input.categoryOf?.(parsed.rule) ?? inWindow.find((e) => e.rule === parsed.rule)?.category ?? 'correctness';
    byRule.push({
      rule: parsed.rule,
      category: cat,
      scope: parsed.scope,
      scopeKey: parsed.scopeKey,
      accepted: stats.accepted,
      dismissed: stats.dismissed,
      shown: stats.shown,
      ignored: stats.ignored,
      wilsonLB: n > 0 ? b.lb : 0,
      wilsonUB: n > 0 ? b.ub : 1,
      state: state && learnedStateApplies(state, parsed.scopeKey, parsed.scopeKey as WritingContext) ? state.state : 'active',
      eligibleForBulk: state?.eligibleForBulk ?? false,
      manualOff: manualSet.has(parsed.rule) || (parsed.scope === 'host' && manualSet.has(`${parsed.rule}@${parsed.scopeKey}`)),
      ...(state?.since ? { since: state.since } : {}),
      ...(state?.nextReprobe ? { nextReprobe: state.nextReprobe } : {}),
    });
  }
  byRule.sort((a, b) => b.shown - a.shown || a.rule.localeCompare(b.rule));

  const states = Object.values(input.learning.ruleStates);
  const dictionaryLive = input.profile.dictionary.filter((e) => !e.removedHlc || e.addedHlc > e.removedHlc);
  const voice: LearningSummary['voice'] = {};
  for (const ctx of ['messages', 'documents'] as const) {
    const p = input.profile.voice.profiles[ctx];
    if (!p) continue;
    voice[ctx] = {
      version: p.version,
      generatedAt: p.generatedAt,
      traits: p.traits.length,
      confidence: p.confidence,
      strength: input.profile.voice.settings.value.strength,
      samples30d: 0,
      decisions30d: inWindow.filter((e) => e.kind === 'accept' || e.kind === 'dismiss').length,
    };
  }
  const oldest = input.events.reduce<string | undefined>((min, e) => (min === undefined || e.t < min ? e.t : min), undefined);
  return {
    window: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    overall: rateBlock(inWindow, prev),
    byCategory,
    byContext,
    byHost,
    byRule,
    learnedState: {
      suppressed: states.filter((s) => s.state === 'suppressed').length,
      demoted: states.filter((s) => s.state === 'demoted').length,
      promoted: states.filter((s) => s.eligibleForBulk).length,
      manualOff: input.manualOff.length,
      dictionaryLearned: input.learning.dictionaryCandidates.length,
      dictionaryManual: dictionaryLive.length,
      ...(input.learning.dialectInferred ? { dialectInferred: input.learning.dialectInferred } : {}),
    },
    voice,
    history: input.learning.history,
    privacy: {
      storeSnippets: input.profile.settings.privacy.value.storeSnippets,
      rawEvents: input.events.length,
      ...(oldest !== undefined ? { oldestEvent: oldest } : {}),
    },
  };
}
