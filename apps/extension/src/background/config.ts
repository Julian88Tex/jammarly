/**
 * EffectiveConfig for one host (ARCHITECTURE §3.6/§3.7): device settings + profile document + learned state folded
 * into what a content script needs. Pure functions; the worker computes a config on hello and re-broadcasts it
 * whenever settings, profile or learned state change.
 */
import type { DeviceSettings, EffectiveConfig, SuggestionCategory, WritingContext, WritingGoals } from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import type { ProfileDocument, ProfileOp } from '@jammarly/shared/profile';
import { hostContext } from '../content/sites/base';
import type { LearnedStateView } from './shared-engine';
import { isSensitiveHost, learnedStateApplies, liveValues } from './shared-engine';
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

/** Muted rules for a host: live global ids, live "<rule>@<host>" ids, plus learner suppressions in scope. */
export function mutedRulesFor(host: string, ctx: WritingContext, profile: ProfileDocument, learned: LearnedStateView): string[] {
  const out = new Set<string>();
  const normalized = normalizeHostName(host);
  for (const value of liveValues(profile.rules.muted)) {
    const at = value.indexOf('@');
    if (at === -1) out.add(value);
    else {
      const scope = value.slice(at + 1);
      if (scope === host || normalizeHostName(scope) === normalized) out.add(value.slice(0, at));
    }
  }
  for (const [rule, state] of Object.entries(learned.ruleStates)) {
    if (state.state === 'suppressed' && learnedStateApplies(state, host, ctx)) out.add(rule);
  }
  return [...out].sort();
}

export function demotedRulesFor(host: string, ctx: WritingContext, learned: LearnedStateView): string[] {
  const out: string[] = [];
  for (const [rule, state] of Object.entries(learned.ruleStates)) {
    if (state.state === 'demoted' && learnedStateApplies(state, host, ctx)) out.push(rule);
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
  return liveValues(profile.sites.disabled).some((h) => h === host || normalizeHostName(h) === normalized);
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
    deepPassIdleMs: Math.max(2500, Math.round(debounceMs * 3.5)),
    showFloatingButton: settings.showFloatingButton,
    showUnderlines: settings.showUnderlines,
    colorblindMode: settings.colorblindMode,
    shortcutSafeMode: false,
    ignoreSiteOptOut: profile.settings.ignoreOptOutHosts.value.some((h) => h === host || normalizeHostName(h) === normalizeHostName(host)),
    checkOptedOutFields: profile.settings.checkOptedOutFields.value,
    mutedRules: mutedRulesFor(host, context, profile, learned),
    demotedRules: demotedRulesFor(host, context, learned),
    dictionary: liveValues(profile.dictionary).sort(),
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
