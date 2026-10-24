/**
 * EffectiveConfig for one host (ARCHITECTURE §3.6/§3.7): device settings + profile document + learned state folded
 * into what a content script needs. Pure functions; the worker computes a config on hello and re-broadcasts it
 * whenever settings, profile or learned state change.
 */
import type { DeviceSettings, EffectiveConfig, SuggestionCategory, WritingContext, WritingGoals } from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import type { LearnedRuleState, ProfileDocument, ProfileOp } from '@jammarly/shared/profile';
import { hostContext } from '../content/sites/base';
import type { LearnedStateView } from './learning/fold';
import { categoryForRule, isSensitiveHost, lookupRuleState, mutedRulesForHost, orSetLive, parseStatsKey } from './shared-engine';
import type { UsageLedger } from './storage';
import { budgetState } from './usage';
import { normalizeHostName, randomHex } from './util';

export interface ConfigInput {
  host: string;
  settings: DeviceSettings;
  profile: ProfileDocument;
  learned: LearnedStateView;
  /** Hosts and fields turned off until the next visit (storage.session). */
  sessionOff: { hosts: string[]; fields: string[] };
  usage?: UsageLedger;
  /** chrome.runtime.id; '' outside the extension. */
  runtimeId: string;
  now?: number;
}

/** Writing context for a host: site override first, then the site map, else 'other'. */
export function contextFor(host: string, profile: ProfileDocument): WritingContext {
  const override = profile.sites.overrides[host]?.value.context ?? profile.sites.overrides[normalizeHostName(host)]?.value.context;
  if (override) return override;
  if (host === '' || host === 'sidepanel') return 'other';
  return hostContext(host);
}

/** Rule ids the learner holds a state for in any scope (probe counters are not states). */
export function learnedRuleIds(ruleStates: Readonly<Record<string, LearnedRuleState>>): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(ruleStates)) {
    const p = parseStatsKey(key);
    if (p !== undefined && p.scope !== 'probe') out.add(p.rule);
  }
  return [...out];
}

/**
 * Muted rules for a host: live rules.muted entries that apply here (plain ids, "<rule>@<host>" for this host or a
 * parent domain) plus learner suppressions in scope (host -> ctx -> global). The learner never adds correctness
 * rules: ARCHITECTURE §3.7 keeps core correctness errors visible, so local rules keep running for them and the
 * engine hides only their sub-floor suggestions.
 */
export function mutedRulesFor(host: string, ctx: WritingContext, profile: ProfileDocument, learned: LearnedStateView): string[] {
  const out = new Set<string>(mutedRulesForHost(orSetLive(profile.rules.muted), host));
  for (const rule of learnedRuleIds(learned.ruleStates)) {
    if (categoryForRule(rule) === 'correctness') continue;
    if (lookupRuleState(learned.ruleStates, rule, host, ctx)?.state === 'suppressed') out.add(rule);
  }
  return [...out].sort();
}

export function demotedRulesFor(host: string, ctx: WritingContext, learned: LearnedStateView): string[] {
  const out: string[] = [];
  for (const rule of learnedRuleIds(learned.ruleStates)) {
    if (lookupRuleState(learned.ruleStates, rule, host, ctx)?.state === 'demoted') out.push(rule);
  }
  return out.sort();
}

export function goalsFor(host: string, profile: ProfileDocument): WritingGoals {
  const base = profile.settings.goals.value;
  const override = profile.sites.overrides[host]?.value.goals;
  return override ? { ...base, ...override } : { ...base };
}

export function categoriesFor(host: string, profile: ProfileDocument): Record<SuggestionCategory, boolean> {
  const base = profile.settings.categories.value;
  const override = profile.sites.overrides[host]?.value.categories;
  const out = {} as Record<SuggestionCategory, boolean>;
  for (const c of CATEGORIES) out[c] = (base[c] ?? true) && (override?.[c] ?? true);
  return out;
}

export function hostDisabled(host: string, profile: ProfileDocument): boolean {
  const normalized = normalizeHostName(host);
  return orSetLive(profile.sites.disabled).some((h) => h === host || normalizeHostName(h) === normalized);
}

export function computeEffectiveConfig(input: ConfigInput): EffectiveConfig {
  const { host, settings, profile, learned, sessionOff } = input;
  const now = input.now ?? Date.now();
  const context = contextFor(host, profile);
  const privacy = profile.settings.privacy.value;
  const sessionOffHost = sessionOff.hosts.includes(host) || sessionOff.hosts.includes(normalizeHostName(host));
  const enabledOnHost = settings.enabled && !hostDisabled(host, profile) && !sessionOffHost;
  const debounceMs = Math.max(100, Math.round(settings.debounceMs));
  const budget = input.usage ? budgetState(settings, input.usage, now) : { exhausted: false, spentToday: 0, limit: settings.dailyBudgetUsd };
  const sensitive = isSensitiveHost(host, profile.settings.privateSites.value);
  return {
    enabled: settings.enabled,
    enabledOnHost,
    host,
    context,
    mode: settings.pairing ? profile.settings.mode.value : settings.mode,
    goals: goalsFor(host, profile),
    dialect: profile.settings.dialect.value,
    categories: categoriesFor(host, profile),
    debounceMs,
    fastPassIdleMs: debounceMs,
    deepPassIdleMs: Math.max(1200, Math.round(debounceMs * 1.75)),
    showFloatingButton: settings.showFloatingButton,
    showUnderlines: settings.showUnderlines,
    colorblindMode: settings.colorblindMode,
    shortcutSafeMode: false,
    ignoreSiteOptOut: profile.settings.ignoreOptOutHosts.value.some((h) => h === host || normalizeHostName(h) === normalizeHostName(host)),
    checkOptedOutFields: profile.settings.checkOptedOutFields.value,
    mutedRules: mutedRulesFor(host, context, profile, learned),
    demotedRules: demotedRulesFor(host, context, learned),
    // orSetLive returns live values in canonical (sorted) order.
    dictionary: orSetLive(profile.dictionary),
    styleDecisions: { ...profile.settings.styleDecisions.value },
    storeSnippets: privacy.storeSnippets && privacy.learningEnabled && !sensitive,
    engineReady: settings.provider === 'mock' || settings.apiKey.length > 0,
    consented: privacy.consentAt !== null || settings.provider === 'mock',
    budgetExhausted: budget.exhausted,
    gdocsAnnounceId: input.runtimeId,
    gdocsInline: settings.gdocsInline,
    userSalt: profile.settings.userSalt.value,
  };
}

/** The op that gives an account its random 32-byte salt, or null when the profile already has one. */
export function ensureUserSaltOp(profile: ProfileDocument): ProfileOp | null {
  if (profile.settings.userSalt.value.length > 0) return null;
  return { op: 'set', path: 'settings.userSalt', value: randomHex(32), hlc: '' };
}

/** The models used for each pass under the engine mode and budget (ARCHITECTURE §3.3). */
export function modelsFor(settings: DeviceSettings, profile: ProfileDocument, budgetExhausted: boolean): { fast: string; deep: string; mode: DeviceSettings['mode'] } {
  const paired = settings.pairing !== null;
  const mode = paired ? profile.settings.mode.value : settings.mode;
  const model = paired ? profile.settings.model.value : settings.model;
  const fastModel = paired ? profile.settings.fastModel.value : settings.fastModel;
  let fast: string;
  let deep: string;
  switch (mode) {
    case 'quality':
      fast = model;
      deep = model;
      break;
    case 'economy':
      fast = fastModel;
      deep = fastModel;
      break;
    default:
      fast = fastModel;
      deep = model;
  }
  if (budgetExhausted) deep = fastModel;
  return { fast, deep, mode };
}
