/**
 * The deterministic learner (research 08 §8.2 with the reviewer's corrections 30-36, architecture §3.7).
 *
 * Pipeline, run by the service worker after every feedback batch and by the web app's nightly fold:
 *
 *   foldEvents()        events  -> per-(scope, rule) counters         (idempotent per eventId)
 *   resolveLearning()   counters -> LearnedRuleState per (scope, rule) (+ counter adjustments after reprobes)
 *   applyLearnedState() suggestions -> visible / hidden for one field (host, ctx)
 *
 * Decisions use Wilson 95% bounds on weighted accept / dismiss counts. Promotion is NOT a state: it is the
 * orthogonal `eligibleForBulk` flag from {@link promotedRules}; manual overrides live only in `rules.muted`
 * (see {@link encodeMute}) and in the `manualOff` list {@link foldEvents} returns. One constant,
 * `N_MIN_SCOPE`, decides which scope speaks for a (host, ctx, rule) triple (reviewer item 31). No time decay
 * in v1: counters are folded daily and reprobing re-opens suppressed rules (reviewer item 33).
 *
 * No DOM, no chrome.*, no side effects at import.
 */
import type { Dialect, Suggestion, SuggestionCategory, WritingContext } from './types';
import type { FeedbackEvent, FeedbackKind, LearningSummary, RateBlock, TrendValue, VoiceSample } from './learning';
import type { LearnedRuleState, ProfileDocument, RuleState, RuleStats, VoiceContext } from './profile';
import { categoryForRule, CLARITY_RULES, DELIVERY_RULES, ENGAGEMENT_RULES } from './prompts/vocabulary';
import { orSetLive } from './merge';
import { normalizeHost } from './redact';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEARNER_CONSTANTS = {
  /** z for 95% Wilson bounds. */
  Z: 1.96,
  /** A host/ctx scope speaks for a rule once it holds this many weighted decisions (otherwise fall through). */
  N_MIN_SCOPE: 8,
  /** Minimum weighted decisions before a demotion (Wilson UB < UB_DEMOTE) is allowed. */
  N_MIN_DEMOTE: 6,
  /** Suppress when the Wilson upper bound of acceptance is below this (and n >= N_MIN_SCOPE). */
  UB_SUPPRESS: 0.35,
  /** Demote when the Wilson upper bound of acceptance is below this (and n >= N_MIN_DEMOTE). */
  UB_DEMOTE: 0.5,
  /** Demote when ignored/shown reaches this over at least N_MIN_IGNORE exposures. */
  IGNORE_RATE_DEMOTE: 0.8,
  N_MIN_IGNORE: 20,
  /** Promotion (eligibleForBulk): correctness only, global scope, n >= N_MIN_PROMOTE and Wilson LB >= LB_PROMOTE. */
  N_MIN_PROMOTE: 10,
  LB_PROMOTE: 0.8,
  /** A report_incorrect counts as this many dismissals. */
  REPORT_WEIGHT: 2,
  /** At most this share of style/clarity rule ids may be suppressed per scope; the oldest are demoted instead. */
  MAX_SUPPRESSED_SHARE: 0.3,
  /** Days after (re-)suppression before the next probe cycle, by reprobeStage (capped at the last entry). */
  REPROBE_AFTER_DAYS: [30, 60, 120, 180] as readonly number[],
  /** Exposures shown with learnedState 'probe' per cycle. */
  REPROBE_COUNT: 3,
  /** Probe accepts that un-suppress the rule (counters halved). */
  REPROBE_UNSUPPRESS_ACCEPTS: 2,
  /** Correctness errors at or above this confidence are never learned away (manual mute still hides them). */
  CONFIDENCE_FLOOR: 0.9,
  /** Rules whose "Never" dismissal needs a confirmation before becoming a global manual override. */
  CORE_CORRECTNESS: new Set<string>([
    'spelling',
    'subject_verb_agreement',
    'verb_form',
    'confusable_word',
    'repeated_word',
    'apostrophe',
    'capitalization',
    'capitalization_sentence_start',
    'terminal_punctuation',
    'missing_word',
  ]) as ReadonlySet<string>,
} as const;

/** Style (non-correctness) rule ids of the engine contract; the denominator of the suppression cap. */
export const STYLE_RULE_IDS: readonly string[] = [...CLARITY_RULES, ...ENGAGEMENT_RULES, ...DELIVERY_RULES];

/** Promoted correctness suggestions qualify for Tier A from this confidence (instead of 0.85). */
export const PROMOTED_TIER_A_CONFIDENCE = 0.7;

/** Rules whose dismissals feed dictionary candidates. */
export const DICTIONARY_RULES: ReadonlySet<string> = new Set(['spelling', 'spelling_dialect', 'capitalization']);

const DAY_MS = 86_400_000;
const SPAN_KINDS: ReadonlySet<string> = new Set(['replace', 'delete', 'insert']);
const DECISION_KINDS: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>(['accept', 'accepted_by_typing', 'dismiss', 'report_incorrect']);
const ACCEPT_KINDS: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>(['accept', 'accepted_by_typing']);
const COUNTED_KINDS: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>([
  'shown',
  'accept',
  'accepted_by_typing',
  'dismiss',
  'report_incorrect',
  'ignore',
]);

// ---------------------------------------------------------------------------
// Keys and scopes
// ---------------------------------------------------------------------------

export type StatsScope = 'host' | 'ctx' | 'global';
/** `probe` keys hold the counters of the current reprobe cycle for one (scope, rule) entry. */
export type StatsKeyScope = StatsScope | 'probe';

export interface ParsedStatsKey {
  scope: StatsKeyScope;
  scopeKey: string;
  rule: string;
}

/** "<scope>|<scopeKey>|<rule>"; the global scope always uses an empty scopeKey. */
export function statsKey(scope: StatsScope, scopeKey: string, rule: string): string {
  return `${scope}|${scope === 'global' ? '' : scopeKey}|${rule}`;
}

/** Counters of the running probe cycle of the entry (scope, scopeKey, rule): "probe|<scope>:<scopeKey>|<rule>". */
export function probeKey(scope: StatsScope, scopeKey: string, rule: string): string {
  return `probe|${scope}:${scope === 'global' ? '' : scopeKey}|${rule}`;
}

export function parseStatsKey(key: string): ParsedStatsKey | undefined {
  const first = key.indexOf('|');
  const last = key.lastIndexOf('|');
  if (first < 0 || last === first) return undefined;
  const scope = key.slice(0, first);
  const scopeKey = key.slice(first + 1, last);
  const rule = key.slice(last + 1);
  if (rule.length === 0) return undefined;
  if (scope === 'host' || scope === 'ctx' || scope === 'global' || scope === 'probe') return { scope, scopeKey, rule };
  return undefined;
}

export function emptyRuleStats(): RuleStats {
  return { shown: 0, accepted: 0, dismissed: 0, ignored: 0, reported: 0, lastSeen: '' };
}

/** Weighted decisions of a counter block. */
export function decisionsOf(s: RuleStats): number {
  return s.accepted + s.dismissed;
}

// ---------------------------------------------------------------------------
// Manual overrides (rules.muted encoding)
// ---------------------------------------------------------------------------

export type ManualOff = { scope: 'host'; scopeKey: string; rule: string } | { scope: 'global'; rule: string };

/** rules.muted entry for a rule muted everywhere ("rule") or on one site ("rule@host"). */
export function encodeMute(rule: string, host?: string): string {
  const h = host === undefined ? '' : normalizeHost(host);
  return h.length > 0 ? `${rule}@${h}` : rule;
}

export function decodeMute(entry: string): { rule: string; host?: string } {
  const at = entry.indexOf('@');
  if (at < 0) return { rule: entry };
  return { rule: entry.slice(0, at), host: entry.slice(at + 1) };
}

/** Rule ids muted for `host` (global entries plus entries for this host or a parent domain). */
export function mutedRulesForHost(entries: readonly string[], host: string): string[] {
  const h = normalizeHost(host);
  const out = new Set<string>();
  for (const entry of entries) {
    const m = decodeMute(entry);
    if (m.host === undefined || h === m.host || h.endsWith(`.${m.host}`)) out.add(m.rule);
  }
  return [...out].sort();
}

function isManuallyOff(rule: string, host: string, mutedRules: readonly string[], manualOff: readonly ManualOff[]): boolean {
  const h = normalizeHost(host);
  for (const entry of mutedRules) {
    const m = decodeMute(entry);
    if (m.rule !== rule) continue;
    if (m.host === undefined || h === m.host || h.endsWith(`.${m.host}`)) return true;
  }
  for (const m of manualOff) {
    if (m.rule !== rule) continue;
    if (m.scope === 'global') return true;
    const mh = normalizeHost(m.scopeKey);
    if (h === mh || h.endsWith(`.${mh}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Wilson
// ---------------------------------------------------------------------------

/** Wilson score interval for `pos` successes in `n` trials; `{ lb: 0, ub: 1 }` when n <= 0. */
export function wilson(pos: number, n: number, z: number = LEARNER_CONSTANTS.Z): { lb: number; ub: number } {
  if (!(n > 0)) return { lb: 0, ub: 1 };
  const k = Math.min(Math.max(pos, 0), n);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lb = Math.max(0, (centre - margin) / denom);
  const ub = Math.min(1, (centre + margin) / denom);
  return { lb, ub };
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export interface FoldOptions {
  /** ISO time of the fold; used as lastSeen when an event carries no parsable time. */
  now: string;
  /** Event ids already folded (from an earlier batch); the result's `seen` is this set plus the new ids. */
  seen?: ReadonlySet<string>;
}

export interface FoldResult {
  stats: Record<string, RuleStats>;
  seen: Set<string>;
  /** Immediate manual overrides requested through dismiss reasons ("Not on this site", "Never"). */
  manualOff: ManualOff[];
  /** "Never" on a core correctness rule: hide only after the user confirms. */
  needsConfirm: ManualOff[];
  /** Events whose counters were updated. */
  folded: number;
  /** Events skipped because their eventId was already seen. */
  duplicates: number;
}

function isValidTime(t: unknown): t is string {
  return typeof t === 'string' && t.length > 0 && !Number.isNaN(Date.parse(t));
}

function bumpStats(target: RuleStats, kind: FeedbackKind, t: string): void {
  switch (kind) {
    case 'shown':
      target.shown += 1;
      break;
    case 'accept':
    case 'accepted_by_typing':
      target.accepted += 1;
      break;
    case 'dismiss':
      target.dismissed += 1;
      break;
    case 'report_incorrect':
      target.dismissed += LEARNER_CONSTANTS.REPORT_WEIGHT;
      target.reported += 1;
      break;
    case 'ignore':
      target.ignored += 1;
      break;
    default:
      return;
  }
  if (t > target.lastSeen) target.lastSeen = t;
}

function sameManualOff(a: ManualOff, b: ManualOff): boolean {
  if (a.scope !== b.scope || a.rule !== b.rule) return false;
  return a.scope === 'global' || (b.scope === 'host' && a.scopeKey === b.scopeKey);
}

function pushUnique(list: ManualOff[], item: ManualOff): void {
  if (!list.some((m) => sameManualOff(m, item))) list.push(item);
}

/**
 * Fold events into counters. Pure: returns new stats (untouched entries are shared by reference). Each event
 * updates the host, ctx and global scopes; probe exposures also update the probe counters of each scope.
 */
export function foldEvents(stats: Readonly<Record<string, RuleStats>>, events: readonly FeedbackEvent[], opts: FoldOptions): FoldResult {
  const next: Record<string, RuleStats> = { ...stats };
  const touched = new Set<string>();
  const seen = new Set<string>(opts.seen ?? []);
  const manualOff: ManualOff[] = [];
  const needsConfirm: ManualOff[] = [];
  let folded = 0;
  let duplicates = 0;

  const bump = (key: string, kind: FeedbackKind, t: string): void => {
    let cur = next[key];
    if (cur === undefined || !touched.has(key)) {
      cur = cur === undefined ? emptyRuleStats() : { ...cur };
      next[key] = cur;
      touched.add(key);
    }
    bumpStats(cur, kind, t);
  };

  for (const e of events) {
    if (typeof e !== 'object' || e === null || typeof e.eventId !== 'string' || e.eventId.length === 0) continue;
    if (seen.has(e.eventId)) {
      duplicates += 1;
      continue;
    }
    seen.add(e.eventId);
    if (typeof e.rule !== 'string' || e.rule.length === 0 || !COUNTED_KINDS.has(e.kind)) continue;
    folded += 1;
    const host = normalizeHost(typeof e.host === 'string' ? e.host : '');
    const t = isValidTime(e.t) ? e.t : opts.now;
    const scopes: [StatsScope, string][] = [];
    if (host.length > 0) scopes.push(['host', host]);
    if (typeof e.ctx === 'string' && e.ctx.length > 0) scopes.push(['ctx', e.ctx]);
    scopes.push(['global', '']);
    for (const [scope, scopeKey] of scopes) {
      bump(statsKey(scope, scopeKey, e.rule), e.kind, t);
      if (e.probe === true) bump(probeKey(scope, scopeKey, e.rule), e.kind, t);
    }
    if (e.kind === 'dismiss' && e.reason === 'not_this_site' && host.length > 0) {
      pushUnique(manualOff, { scope: 'host', scopeKey: host, rule: e.rule });
    }
    if (e.kind === 'dismiss' && e.reason === 'never') {
      pushUnique(LEARNER_CONSTANTS.CORE_CORRECTNESS.has(e.rule) ? needsConfirm : manualOff, { scope: 'global', rule: e.rule });
    }
  }

  return { stats: next, seen, manualOff, needsConfirm, folded, duplicates };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type RuleCategories = Readonly<Record<string, SuggestionCategory>>;

function ruleCategory(rule: string, categories?: RuleCategories): SuggestionCategory | undefined {
  return categories?.[rule] ?? categoryForRule(rule);
}

/** Correctness rules with n >= N_MIN_PROMOTE global decisions and Wilson LB >= LB_PROMOTE: eligible for Tier-A bulk accept. */
export function promotedRules(stats: Readonly<Record<string, RuleStats>>, categories?: RuleCategories): Set<string> {
  const out = new Set<string>();
  for (const [key, s] of Object.entries(stats)) {
    const p = parseStatsKey(key);
    if (p === undefined || p.scope !== 'global') continue;
    if (ruleCategory(p.rule, categories) !== 'correctness') continue;
    const n = decisionsOf(s);
    if (n >= LEARNER_CONSTANTS.N_MIN_PROMOTE && wilson(s.accepted, n).lb >= LEARNER_CONSTANTS.LB_PROMOTE) out.add(p.rule);
  }
  return out;
}

export interface ScopeVerdict {
  verdict: 'suppressed' | 'demoted' | 'active';
  n: number;
  lb: number;
  ub: number;
}

/** The learner's verdict for one counter block, before reprobe scheduling and the cap. */
export function evaluateScope(s: RuleStats): ScopeVerdict {
  const C = LEARNER_CONSTANTS;
  const n = decisionsOf(s);
  const { lb, ub } = wilson(s.accepted, n);
  if (n >= C.N_MIN_SCOPE && ub < C.UB_SUPPRESS) return { verdict: 'suppressed', n, lb, ub };
  if (n >= C.N_MIN_DEMOTE && ub < C.UB_DEMOTE) return { verdict: 'demoted', n, lb, ub };
  if (s.shown >= C.N_MIN_IGNORE && s.ignored / s.shown >= C.IGNORE_RATE_DEMOTE) return { verdict: 'demoted', n, lb, ub };
  return { verdict: 'active', n, lb, ub };
}

/** True when a host/ctx counter block carries enough evidence to speak for its scope. */
export function hasScopeEvidence(s: RuleStats): boolean {
  return decisionsOf(s) >= LEARNER_CONSTANTS.N_MIN_SCOPE || s.shown >= LEARNER_CONSTANTS.N_MIN_IGNORE;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

function reprobeDays(stage: number): number {
  const days = LEARNER_CONSTANTS.REPROBE_AFTER_DAYS;
  const last = days[days.length - 1] ?? 180;
  return days[Math.min(Math.max(stage, 0), days.length - 1)] ?? last;
}

function lastStage(): number {
  return LEARNER_CONSTANTS.REPROBE_AFTER_DAYS.length - 1;
}

export interface ResolveOptions {
  /** Category per rule id observed in events; falls back to the engine vocabulary. */
  categories?: RuleCategories;
}

export interface ResolveResult {
  /** Keyed like stats: statsKey(scope, scopeKey, rule). Every rule has a global entry; host/ctx entries exist where evidence suffices. */
  ruleStates: Record<string, LearnedRuleState>;
  /** Counters after reprobe settlement: probe cycles that ended are cleared, un-suppressed entries are halved. */
  stats: Record<string, RuleStats>;
}

/**
 * Resolve learned states from counters. Scope chain host -> ctx -> global: a host or ctx entry exists only
 * when that scope has >= N_MIN_SCOPE decisions (or >= N_MIN_IGNORE exposures, or already existed), so
 * {@link lookupRuleState} picks the most specific scope with enough evidence. Also schedules reprobes,
 * runs the probe cycle state machine, and applies the 30% suppression cap per scope.
 */
export function resolveLearning(
  stats: Readonly<Record<string, RuleStats>>,
  previous: Readonly<Record<string, LearnedRuleState>>,
  now: string,
  manualOff: readonly ManualOff[] = [],
  opts: ResolveOptions = {},
): ResolveResult {
  const C = LEARNER_CONSTANTS;
  const nowMs = Date.parse(now);
  const promoted = promotedRules(stats, opts.categories);

  const keys = new Set<string>();
  const rules = new Set<string>();
  for (const [key, s] of Object.entries(stats)) {
    const p = parseStatsKey(key);
    if (p === undefined || p.scope === 'probe') continue;
    rules.add(p.rule);
    if (p.scope === 'global' || hasScopeEvidence(s) || previous[key] !== undefined) keys.add(key);
  }
  for (const key of Object.keys(previous)) {
    const p = parseStatsKey(key);
    if (p === undefined || p.scope === 'probe') continue;
    rules.add(p.rule);
    keys.add(key);
  }
  for (const rule of rules) keys.add(statsKey('global', '', rule));

  const entries: Record<string, LearnedRuleState> = {};
  const halve = new Set<string>();
  const clearProbe = new Set<string>();

  for (const key of [...keys].sort()) {
    const p = parseStatsKey(key);
    if (p === undefined || p.scope === 'probe') continue;
    const scope = p.scope;
    const s = stats[key] ?? emptyRuleStats();
    const prev = previous[key];
    const manual = isManuallyOff(p.rule, scope === 'host' ? p.scopeKey : '', [], scope === 'host' ? manualOff : manualOff.filter((m) => m.scope === 'global'));
    const pKey = probeKey(scope, p.scopeKey, p.rule);

    let state: RuleState;
    let since = now;
    let reprobeStage = 0;
    let nextReprobe: string | undefined;

    if (prev?.state === 'probing') {
      const pr = stats[pKey] ?? emptyRuleStats();
      const decided = pr.accepted + pr.dismissed + pr.ignored;
      if (pr.accepted >= C.REPROBE_UNSUPPRESS_ACCEPTS) {
        state = 'active';
        halve.add(key);
        clearProbe.add(pKey);
      } else if (decided >= C.REPROBE_COUNT) {
        state = 'suppressed';
        reprobeStage = Math.min(prev.reprobeStage + 1, lastStage());
        nextReprobe = addDays(now, reprobeDays(reprobeStage));
        clearProbe.add(pKey);
      } else {
        state = 'probing';
        since = prev.since;
        reprobeStage = prev.reprobeStage;
        nextReprobe = prev.nextReprobe;
      }
    } else {
      const v = evaluateScope(s);
      state = v.verdict;
      // A suppression is sticky until its reprobe: probe decisions nudge the counters, and a failed probe
      // must extend the wait (08 §8.2 "else k++") rather than let a borderline UB demote the rule. Only
      // evidence that flips the verdict to active outright (e.g. accepts from another device) releases it.
      if (prev?.state === 'suppressed' && state === 'demoted') state = 'suppressed';
      if (state === 'suppressed') {
        if (prev?.state === 'suppressed') {
          since = prev.since;
          reprobeStage = prev.reprobeStage;
          nextReprobe = prev.nextReprobe ?? addDays(prev.since, reprobeDays(reprobeStage));
          if (!manual && Date.parse(nextReprobe) <= nowMs) {
            state = 'probing';
            since = now;
            nextReprobe = undefined;
            clearProbe.add(pKey);
          }
        } else {
          since = prev?.state === 'demoted' ? prev.since : now;
          reprobeStage = 0;
          nextReprobe = addDays(now, reprobeDays(0));
        }
      } else if (prev !== undefined && prev.state === state) {
        since = prev.since;
      }
    }

    entries[key] = {
      state,
      eligibleForBulk: promoted.has(p.rule),
      scope,
      scopeKey: scope === 'global' ? '' : p.scopeKey,
      since,
      ...(nextReprobe !== undefined ? { nextReprobe } : {}),
      reprobeStage,
    };
  }

  // Suppression cap: per scope group, at most floor(share * |style rules|) style rules suppressed.
  const styleRules = new Set<string>(STYLE_RULE_IDS);
  for (const rule of rules) {
    const cat = ruleCategory(rule, opts.categories);
    if (cat !== undefined && cat !== 'correctness') styleRules.add(rule);
  }
  const cap = Math.floor(C.MAX_SUPPRESSED_SHARE * styleRules.size);
  const groups = new Map<string, string[]>();
  for (const [key, st] of Object.entries(entries)) {
    if (st.state !== 'suppressed') continue;
    const p = parseStatsKey(key);
    if (p === undefined || !styleRules.has(p.rule)) continue;
    const g = `${st.scope}|${st.scopeKey}`;
    const list = groups.get(g) ?? [];
    list.push(key);
    groups.set(g, list);
  }
  for (const list of groups.values()) {
    if (list.length <= cap) continue;
    const ranked = list
      .map((key) => {
        const st = entries[key];
        const prev = previous[key];
        return {
          key,
          keep: prev?.state === 'suppressed' || prev?.state === 'probing' ? 0 : 1,
          sinceMs: st === undefined ? 0 : Date.parse(st.since) || 0,
        };
      })
      .sort((x, y) => x.keep - y.keep || y.sinceMs - x.sinceMs || (x.key < y.key ? -1 : 1));
    for (const { key } of ranked.slice(cap)) {
      const st = entries[key];
      if (st === undefined) continue;
      const prev = previous[key];
      entries[key] = {
        state: 'demoted',
        eligibleForBulk: st.eligibleForBulk,
        scope: st.scope,
        scopeKey: st.scopeKey,
        since: prev?.state === 'demoted' ? prev.since : now,
        reprobeStage: 0,
      };
    }
  }

  // Settle counters: clear finished / restarted probe cycles, halve un-suppressed entries.
  let settled: Record<string, RuleStats> = stats as Record<string, RuleStats>;
  if (halve.size > 0 || clearProbe.size > 0) {
    settled = { ...stats };
    for (const key of clearProbe) delete settled[key];
    for (const key of halve) {
      const s = settled[key];
      if (s === undefined) continue;
      settled[key] = { ...s, accepted: Math.floor(s.accepted / 2), dismissed: Math.floor(s.dismissed / 2) };
    }
  }

  return { ruleStates: entries, stats: settled };
}

/** The states only; use {@link resolveLearning} when the settled counters must be kept too. */
export function resolveRuleStates(
  stats: Readonly<Record<string, RuleStats>>,
  previous: Readonly<Record<string, LearnedRuleState>>,
  now: string,
  manualOff: readonly ManualOff[] = [],
  opts: ResolveOptions = {},
): Record<string, LearnedRuleState> {
  return resolveLearning(stats, previous, now, manualOff, opts).ruleStates;
}

/** The entry that speaks for (rule, host, ctx): host -> ctx -> global. */
export function lookupRuleState(
  ruleStates: Readonly<Record<string, LearnedRuleState>>,
  rule: string,
  host: string,
  ctx: WritingContext | string,
): LearnedRuleState | undefined {
  const h = normalizeHost(host);
  return (
    (h.length > 0 ? ruleStates[statsKey('host', h, rule)] : undefined) ??
    ruleStates[statsKey('ctx', ctx, rule)] ??
    ruleStates[statsKey('global', '', rule)]
  );
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type HiddenReason = 'manual' | 'suppressed' | 'probe_limit';

export interface ApplyLearnedInput {
  ruleStates: Readonly<Record<string, LearnedRuleState>>;
  promoted: ReadonlySet<string>;
  manualOff: readonly ManualOff[];
  host: string;
  ctx: WritingContext;
  /** rules.muted live values ("rule" or "rule@host"), or plain rule ids already resolved for this host. */
  mutedRules: readonly string[];
}

export interface ApplyLearnedResult {
  visible: Suggestion[];
  hidden: { id: string; reason: HiddenReason }[];
}

/**
 * Filter and annotate one field's suggestions with learned state. The correctness floor (correctness,
 * severity error, confidence >= CONFIDENCE_FLOOR) is always visible unless manually muted; suppressed rules
 * are hidden; demoted rules get learnedState 'demoted'; probing rules show at most REPROBE_COUNT
 * exposures as 'probe'; promoted correctness fixes move from Tier B to Tier A at confidence >= 0.70.
 */
export function applyLearnedState(suggestions: readonly Suggestion[], input: ApplyLearnedInput): ApplyLearnedResult {
  const C = LEARNER_CONSTANTS;
  const visible: Suggestion[] = [];
  const hidden: ApplyLearnedResult['hidden'] = [];
  let probes = 0;

  for (const s of suggestions) {
    if (isManuallyOff(s.rule, input.host, input.mutedRules, input.manualOff)) {
      hidden.push({ id: s.id, reason: 'manual' });
      continue;
    }
    const out: Suggestion = { ...s, learnedState: 'active' };
    const floor = s.category === 'correctness' && s.severity === 'error' && s.confidence >= C.CONFIDENCE_FLOOR;
    if (!floor) {
      const st = lookupRuleState(input.ruleStates, s.rule, input.host, input.ctx);
      if (st?.state === 'suppressed') {
        hidden.push({ id: s.id, reason: 'suppressed' });
        continue;
      }
      if (st?.state === 'probing') {
        if (probes >= C.REPROBE_COUNT) {
          hidden.push({ id: s.id, reason: 'probe_limit' });
          continue;
        }
        probes += 1;
        out.learnedState = 'probe';
      } else if (st?.state === 'demoted') {
        out.learnedState = 'demoted';
      }
    }
    if (
      out.tier === 'B' &&
      input.promoted.has(s.rule) &&
      s.category === 'correctness' &&
      SPAN_KINDS.has(s.kind) &&
      s.severity === 'error' &&
      s.autoApplySafe &&
      s.meaningPreserving &&
      s.anchor === 'exact' &&
      s.confidence >= PROMOTED_TIER_A_CONFIDENCE
    ) {
      out.tier = 'A';
    }
    visible.push(out);
  }
  return { visible, hidden };
}

// ---------------------------------------------------------------------------
// Dictionary candidates
// ---------------------------------------------------------------------------

const DICTIONARY_TOKEN_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’-]{1,99}$/u;

export function isDictionaryToken(token: string): boolean {
  return DICTIONARY_TOKEN_RE.test(token) && !token.includes('‹');
}

export function isCapitalized(token: string): boolean {
  return /^\p{Lu}/u.test(token);
}

/**
 * Tokens the user keeps rejecting spelling/capitalization fixes for (08 §8.2 DICTIONARY): dismissed >= 3
 * times, or >= 2 times across >= 2 fields, or a capitalized token dismissed >= 2 times. A `self_corrected`
 * back to the flagged token counts as a dismissal; tokens whose correction the user accepted twice are
 * contested and never proposed. Document identity is the fieldId; `existing` entries are excluded.
 */
export function dictionaryCandidates(events: readonly FeedbackEvent[], existing: readonly string[]): string[] {
  interface Tally {
    casings: Map<string, number>;
    dismissals: number;
    fields: Set<string>;
    acceptedCorrections: number;
  }
  const tallies = new Map<string, Tally>();
  const tally = (token: string): Tally => {
    const k = token.toLowerCase();
    let t = tallies.get(k);
    if (t === undefined) {
      t = { casings: new Map(), dismissals: 0, fields: new Set(), acceptedCorrections: 0 };
      tallies.set(k, t);
    }
    t.casings.set(token, (t.casings.get(token) ?? 0) + 1);
    return t;
  };

  for (const e of events) {
    if (!DICTIONARY_RULES.has(e.rule) || typeof e.original !== 'string') continue;
    const token = e.original.trim();
    if (!isDictionaryToken(token)) continue;
    if (e.kind === 'dismiss' || (e.kind === 'self_corrected' && typeof e.final === 'string' && e.final.trim() === token)) {
      const t = tally(token);
      t.dismissals += 1;
      t.fields.add(e.fieldId);
    } else if (ACCEPT_KINDS.has(e.kind)) {
      tally(token).acceptedCorrections += 1;
    }
  }

  const existingLower = new Set(existing.map((w) => w.toLowerCase()));
  const out: { token: string; score: number }[] = [];
  for (const [lower, t] of tallies) {
    if (existingLower.has(lower) || t.acceptedCorrections >= 2) continue;
    let token = lower;
    let best = -1;
    for (const [casing, count] of t.casings) {
      if (count > best) {
        best = count;
        token = casing;
      }
    }
    const qualifies =
      t.dismissals >= 3 || (t.dismissals >= 2 && t.fields.size >= 2) || (isCapitalized(token) && t.dismissals >= 2);
    if (qualifies) out.push({ token, score: t.dismissals });
  }
  return out.sort((x, y) => y.score - x.score || (x.token < y.token ? -1 : x.token > y.token ? 1 : 0)).map((x) => x.token);
}

// ---------------------------------------------------------------------------
// Dialect inference
// ---------------------------------------------------------------------------

const ALL_BRITISH: readonly Dialect[] = ['en-GB', 'en-CA', 'en-AU', 'en-IN'];
const US_ONLY: readonly Dialect[] = ['en-US'];
const US_CA: readonly Dialect[] = ['en-US', 'en-CA'];
const GB_AU_IN: readonly Dialect[] = ['en-GB', 'en-AU', 'en-IN'];

function buildDialectMarkers(): Map<string, readonly Dialect[]> {
  const m = new Map<string, readonly Dialect[]>();
  const add = (words: readonly string[], dialects: readonly Dialect[]): void => {
    for (const w of words) m.set(w, dialects);
  };
  const ourStems = ['colour', 'flavour', 'honour', 'favour', 'behaviour', 'neighbour', 'labour', 'humour', 'harbour', 'rumour', 'armour', 'odour', 'vigour', 'endeavour', 'savour'];
  for (const w of ourStems) {
    const us = w.replace(/our$/, 'or');
    add([w, `${w}s`, `${w}ed`, `${w}ing`, `${w}ful`, `${w}ite`, `${w}ites`], ALL_BRITISH);
    add([us, `${us}s`, `${us}ed`, `${us}ing`, `${us}ful`, `${us}ite`, `${us}ites`], US_ONLY);
  }
  const iseStems = ['organise', 'realise', 'recognise', 'apologise', 'specialise', 'criticise', 'emphasise', 'minimise', 'maximise', 'optimise', 'prioritise', 'summarise', 'customise', 'utilise', 'finalise'];
  for (const w of iseStems) {
    const us = w.replace(/ise$/, 'ize');
    const stem = w.slice(0, -1);
    const usStem = us.slice(0, -1);
    add([w, `${w}s`, `${w}d`, `${stem}ing`, `${stem}ation`, `${stem}ations`], GB_AU_IN);
    add([us, `${us}s`, `${us}d`, `${usStem}ing`, `${usStem}ation`, `${usStem}ations`], US_CA);
  }
  for (const w of ['analyse', 'paralyse', 'catalyse']) {
    const us = w.replace(/yse$/, 'yze');
    add([w, `${w}s`, `${w}d`, `${w.slice(0, -1)}ing`], GB_AU_IN);
    add([us, `${us}s`, `${us}d`, `${us.slice(0, -1)}ing`], US_CA);
  }
  const rePairs: readonly (readonly [string, string])[] = [['centre', 'center'], ['theatre', 'theater'], ['litre', 'liter'], ['fibre', 'fiber'], ['metre', 'meter'], ['calibre', 'caliber']];
  for (const [gb, us] of rePairs) {
    add([gb, `${gb}s`, `${gb}d`], ALL_BRITISH);
    if (us !== 'meter') add([us, `${us}s`, `${us}ed`], US_ONLY);
  }
  const oguePairs: readonly (readonly [string, string])[] = [['catalogue', 'catalog'], ['dialogue', 'dialog'], ['analogue', 'analog']];
  for (const [gb, us] of oguePairs) {
    add([gb, `${gb}s`], ALL_BRITISH);
    add([us, `${us}s`], US_ONLY);
  }
  add(['travelling', 'traveller', 'travellers', 'travelled', 'cancelled', 'cancelling', 'modelling', 'modelled', 'labelled', 'labelling', 'fuelled', 'jewellery', 'counsellor'], ALL_BRITISH);
  add(['traveling', 'traveler', 'travelers', 'traveled', 'canceled', 'canceling', 'modeling', 'modeled', 'labeled', 'labeling', 'fueled', 'jewelry', 'counselor'], US_ONLY);
  add(['grey', 'greys', 'defence', 'offence', 'licence', 'pretence', 'cheque', 'cheques', 'tyre', 'tyres', 'kerb', 'pyjamas', 'mum', 'whilst', 'learnt', 'spelt', 'dreamt', 'favourite', 'favourites', 'storey', 'plough', 'mould', 'moustache', 'sceptical', 'practise'], ALL_BRITISH);
  add(['gray', 'grays', 'defense', 'offense', 'license', 'pretense', 'pajamas', 'mom', 'story', 'plow', 'mold', 'mustache', 'skeptical'], US_ONLY);
  add(['tire', 'tires', 'curb', 'aluminum', 'program', 'programs'], US_CA);
  add(['aluminium'], GB_AU_IN);
  add(['programme', 'programmes'], ['en-GB', 'en-IN']);
  add(['lakh', 'lakhs', 'crore', 'crores', 'prepone', 'preponed', 'timepass'], ['en-IN']);
  add(['arvo', 'brekkie', 'servo', 'bogan', 'esky', 'ute'], ['en-AU']);
  add(['toque', 'tuque', 'poutine', 'loonie', 'toonie'], ['en-CA']);
  return m;
}

let dialectMarkers: Map<string, readonly Dialect[]> | undefined;

/** Marker word -> dialects it is consistent with (built lazily, pure data). */
export function dialectMarkerTable(): ReadonlyMap<string, readonly Dialect[]> {
  dialectMarkers ??= buildDialectMarkers();
  return dialectMarkers;
}

export const DIALECT_INFER_MIN_TOKENS = 20;
export const DIALECT_INFER_MIN_SHARE = 0.8;
const DIALECT_PRIORITY: readonly Dialect[] = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'];

/**
 * Infer the writer's dialect from typed samples: count marker tokens (colour/color, organise/organize,
 * centre/center, ...); when >= 20 markers were seen and >= 80% of them are consistent with one dialect,
 * return it (ties resolve US > GB > CA > AU > IN). Otherwise undefined.
 */
export function inferDialect(samples: readonly string[]): Dialect | undefined {
  const table = dialectMarkerTable();
  const counts = new Map<Dialect, number>();
  let total = 0;
  for (const sample of samples) {
    if (typeof sample !== 'string') continue;
    for (const word of sample.toLowerCase().match(/[a-z]+/g) ?? []) {
      const dialects = table.get(word);
      if (dialects === undefined) continue;
      total += 1;
      for (const d of dialects) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  if (total < DIALECT_INFER_MIN_TOKENS) return undefined;
  let best: Dialect | undefined;
  let bestCount = -1;
  for (const d of DIALECT_PRIORITY) {
    const c = counts.get(d) ?? 0;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best !== undefined && bestCount / total >= DIALECT_INFER_MIN_SHARE ? best : undefined;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Writing context -> voice context (code has no voice profile). */
export const VOICE_CONTEXT_FOR: Readonly<Record<WritingContext, VoiceContext | undefined>> = {
  email: 'messages',
  chat: 'messages',
  social: 'messages',
  doc: 'documents',
  other: 'documents',
  code: undefined,
};

export interface SummaryOptions {
  now: string;
  days: 7 | 14 | 28;
  storeSnippets: boolean;
  /** Voice samples, for the per-context `samples30d` count. */
  voiceSamples?: readonly VoiceSample[];
}

interface Counts {
  shown: number;
  accepted: number;
  dismissed: number;
  ignored: number;
}

function emptyCounts(): Counts {
  return { shown: 0, accepted: 0, dismissed: 0, ignored: 0 };
}

function countEvent(c: Counts, e: FeedbackEvent): void {
  if (e.kind === 'shown') c.shown += 1;
  else if (ACCEPT_KINDS.has(e.kind)) c.accepted += 1;
  else if (e.kind === 'dismiss' || e.kind === 'report_incorrect') c.dismissed += 1;
  else if (e.kind === 'ignore') c.ignored += 1;
}

/** Rate with Wilson CI and the delta against the previous window. */
export function trendValue(pos: number, n: number, prevPos: number, prevN: number): TrendValue {
  const value = n > 0 ? pos / n : 0;
  const prev = prevN > 0 ? prevPos / prevN : 0;
  const ci = n > 0 ? wilson(pos, n) : { lb: 0, ub: 0 };
  return { value, ciLow: ci.lb, ciHigh: ci.ub, prev, delta: value - prev, n };
}

function rateBlock(cur: Counts, prev: Counts): RateBlock {
  const dec = cur.accepted + cur.dismissed;
  const prevDec = prev.accepted + prev.dismissed;
  return {
    shown: cur.shown,
    accepted: cur.accepted,
    dismissed: cur.dismissed,
    ignored: cur.ignored,
    acceptance: trendValue(cur.accepted, dec, prev.accepted, prevDec),
    dismissRate: trendValue(cur.dismissed, dec, prev.dismissed, prevDec),
    ignoreRate: trendValue(cur.ignored, cur.shown, prev.ignored, prev.shown),
  };
}

function groupCounts<K extends string>(events: readonly FeedbackEvent[], keyOf: (e: FeedbackEvent) => K | undefined): Map<K, Counts> {
  const out = new Map<K, Counts>();
  for (const e of events) {
    const k = keyOf(e);
    if (k === undefined) continue;
    let c = out.get(k);
    if (c === undefined) {
      c = emptyCounts();
      out.set(k, c);
    }
    countEvent(c, e);
  }
  return out;
}

/** Words written in the window: per field, the largest wordCountTyped reported with a `shown` event. */
function wordsTyped(events: readonly FeedbackEvent[]): number {
  const perField = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'shown' || typeof e.wordCountTyped !== 'number' || !(e.wordCountTyped >= 0)) continue;
    perField.set(e.fieldId, Math.max(perField.get(e.fieldId) ?? 0, e.wordCountTyped));
  }
  let total = 0;
  for (const n of perField.values()) total += n;
  return total;
}

const CATEGORIES: readonly SuggestionCategory[] = ['correctness', 'clarity', 'engagement', 'delivery'];

/**
 * The dashboard summary (08 §8.5 restricted to the LearningSummary contract): window rates with Wilson CIs
 * and trends against the previous window, per category / context / host, the rule table from
 * `learning.ruleStates` + `learning.stats`, learned-state counts, voice rows, history and privacy.
 */
export function buildLearningSummary(doc: ProfileDocument, events: readonly FeedbackEvent[], opts: SummaryOptions): LearningSummary {
  const nowMs = Date.parse(opts.now);
  const windowMs = opts.days * DAY_MS;
  const fromMs = nowMs - windowMs;
  const prevFromMs = fromMs - windowMs;

  const valid: { e: FeedbackEvent; t: number }[] = [];
  for (const e of events) {
    if (typeof e !== 'object' || e === null || typeof e.rule !== 'string') continue;
    const t = Date.parse(e.t);
    if (Number.isNaN(t)) continue;
    valid.push({ e, t });
  }
  const current = valid.filter((x) => x.t >= fromMs && x.t <= nowMs).map((x) => x.e);
  const previous = valid.filter((x) => x.t >= prevFromMs && x.t < fromMs).map((x) => x.e);

  const categories: Record<string, SuggestionCategory> = {};
  for (const { e } of valid) {
    if (categories[e.rule] === undefined && (CATEGORIES as readonly string[]).includes(e.category)) categories[e.rule] = e.category;
  }

  const total = emptyCounts();
  for (const e of current) countEvent(total, e);
  const prevTotal = emptyCounts();
  for (const e of previous) countEvent(prevTotal, e);

  const byCat = groupCounts(current, (e) => e.category);
  const prevByCat = groupCounts(previous, (e) => e.category);
  const words = wordsTyped(current);
  const prevWords = wordsTyped(previous);
  const byCategory = {} as LearningSummary['byCategory'];
  for (const cat of CATEGORIES) {
    const cur = byCat.get(cat) ?? emptyCounts();
    const prev = prevByCat.get(cat) ?? emptyCounts();
    const rate = trendValue(Math.min(cur.shown, words), words, Math.min(prev.shown, prevWords), prevWords);
    byCategory[cat] = {
      ...rateBlock(cur, prev),
      per100Words: {
        value: rate.value * 100,
        ciLow: rate.ciLow * 100,
        ciHigh: rate.ciHigh * 100,
        prev: rate.prev * 100,
        delta: rate.delta * 100,
        n: words,
      },
    };
  }

  const byCtx = groupCounts(current, (e) => e.ctx);
  const prevByCtx = groupCounts(previous, (e) => e.ctx);
  const byContext: LearningSummary['byContext'] = {};
  for (const [ctx, cur] of byCtx) byContext[ctx] = rateBlock(cur, prevByCtx.get(ctx) ?? emptyCounts());

  const byHostMap = groupCounts(current, (e) => (typeof e.host === 'string' && e.host.length > 0 ? normalizeHost(e.host) : undefined));
  const prevByHost = groupCounts(previous, (e) => (typeof e.host === 'string' && e.host.length > 0 ? normalizeHost(e.host) : undefined));
  const byHost = [...byHostMap.entries()]
    .sort((x, y) => y[1].shown - x[1].shown || y[1].accepted + y[1].dismissed - (x[1].accepted + x[1].dismissed) || (x[0] < y[0] ? -1 : 1))
    .slice(0, 10)
    .map(([host, cur]) => ({ host, ...rateBlock(cur, prevByHost.get(host) ?? emptyCounts()) }));

  const stats = doc.learning.stats;
  const ruleStates = doc.learning.ruleStates;
  const promoted = promotedRules(stats, categories);
  const mutedLive = orSetLive(doc.rules.muted);
  const rowKeys = new Set<string>(Object.keys(ruleStates));
  for (const key of Object.keys(stats)) {
    const p = parseStatsKey(key);
    if (p !== undefined && p.scope === 'global') rowKeys.add(key);
  }
  const byRule: LearningSummary['byRule'] = [];
  for (const key of rowKeys) {
    const p = parseStatsKey(key);
    if (p === undefined || p.scope === 'probe') continue;
    const s = stats[key] ?? emptyRuleStats();
    const st = ruleStates[key];
    const n = decisionsOf(s);
    const { lb, ub } = wilson(s.accepted, n);
    const scopeKey = p.scope === 'global' ? '' : p.scopeKey;
    const manualOff = mutedLive.some((entry) => {
      const m = decodeMute(entry);
      if (m.rule !== p.rule) return false;
      if (m.host === undefined) return true;
      return p.scope === 'host' && (scopeKey === m.host || scopeKey.endsWith(`.${m.host}`));
    });
    byRule.push({
      rule: p.rule,
      category: ruleCategory(p.rule, categories) ?? 'clarity',
      scope: p.scope,
      scopeKey,
      accepted: s.accepted,
      dismissed: s.dismissed,
      shown: s.shown,
      ignored: s.ignored,
      wilsonLB: lb,
      wilsonUB: ub,
      state: st?.state ?? 'active',
      eligibleForBulk: promoted.has(p.rule),
      manualOff,
      ...(st?.since ? { since: st.since } : {}),
      ...(st?.nextReprobe !== undefined ? { nextReprobe: st.nextReprobe } : {}),
    });
  }
  byRule.sort((x, y) => y.accepted + y.dismissed + y.shown - (x.accepted + x.dismissed + x.shown) || (x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0) || (x.scopeKey < y.scopeKey ? -1 : 1));
  if (byRule.length > 300) byRule.length = 300;

  let suppressed = 0;
  let demoted = 0;
  for (const st of Object.values(ruleStates)) {
    if (st.state === 'suppressed') suppressed += 1;
    else if (st.state === 'demoted') demoted += 1;
  }
  const dictionaryLive = orSetLive(doc.dictionary);
  const candidates = new Set(doc.learning.dictionaryCandidates.map((w) => w.toLowerCase()));
  const dictionaryLearned = dictionaryLive.filter((w) => candidates.has(w.toLowerCase())).length;

  const voice: LearningSummary['voice'] = {};
  const thirtyDaysAgo = nowMs - 30 * DAY_MS;
  for (const ctx of ['messages', 'documents'] as const) {
    const profile = doc.voice.profiles[ctx];
    if (profile === undefined) continue;
    let decisions30d = 0;
    for (const { e, t } of valid) {
      if (t >= thirtyDaysAgo && t <= nowMs && DECISION_KINDS.has(e.kind) && VOICE_CONTEXT_FOR[e.ctx] === ctx) decisions30d += 1;
    }
    let samples30d = 0;
    for (const s of opts.voiceSamples ?? []) {
      const t = Date.parse(s.t);
      if (!Number.isNaN(t) && t >= thirtyDaysAgo && t <= nowMs && s.voiceContext === ctx) samples30d += 1;
    }
    voice[ctx] = {
      version: profile.version,
      generatedAt: profile.generatedAt,
      traits: profile.traits.length,
      confidence: profile.confidence,
      strength: doc.voice.settings.value.strength,
      samples30d,
      decisions30d,
    };
  }

  let oldest: number | undefined;
  for (const { t } of valid) if (oldest === undefined || t < oldest) oldest = t;

  return {
    window: { days: opts.days, from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() },
    overall: rateBlock(total, prevTotal),
    byCategory,
    byContext,
    byHost,
    byRule,
    learnedState: {
      suppressed,
      demoted,
      promoted: promoted.size,
      manualOff: mutedLive.length,
      dictionaryLearned,
      dictionaryManual: dictionaryLive.length - dictionaryLearned,
      ...(doc.learning.dialectInferred !== undefined ? { dialectInferred: doc.learning.dialectInferred } : {}),
    },
    voice,
    history: doc.learning.history.slice(-30),
    privacy: {
      storeSnippets: opts.storeSnippets,
      rawEvents: valid.length,
      ...(oldest !== undefined ? { oldestEvent: new Date(oldest).toISOString() } : {}),
    },
  };
}
