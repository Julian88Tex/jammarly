/**
 * Learning ingest and fold (ARCHITECTURE §3.7): completes the content script's FeedbackEventInputs into
 * FeedbackEvents, redacts or strips snippets, buffers them for upload and folds them into the device shadow at once
 * so suppressions take effect immediately. Unpaired, the shadow IS profile.learning (written back with a fresh
 * clock); paired, the server is authoritative and the shadow is replaced by profile.learning on every poll.
 *
 * The deterministic learner is `@jammarly/shared/learner`: `foldEvents` turns events into per-(scope, rule)
 * counters, `resolveLearning` turns counters into states keyed by `statsKey(scope, scopeKey, rule)` (read with
 * `lookupRuleState`, host -> ctx -> global) and settles reprobe cycles, `promotedRules` flags the correctness rules
 * whose fixes qualify for Tier A at confidence >= 0.70. Manual overrides live only in `rules.muted` (see
 * `encodeMute`); the port hub writes them, this module only feeds them back to the learner so a muted rule is
 * never reprobed.
 */
import type { FeedbackEvent, FeedbackEventInput, LearningSummary, VoiceSample } from '@jammarly/shared/learning';
import type { LearnedRuleState, ProfileDocument } from '@jammarly/shared/profile';
import type { SuggestionCategory } from '@jammarly/shared/types';
import type { DeviceClock } from '../clock';
import type { ManualOff, RuleCategories } from '../shared-engine';
import { buildLearningSummary, decodeMute, dictionaryCandidates, foldEvents, inferDialect, orSetLive, promotedRules, redactSentence, redactSnippet, resolveLearning } from '../shared-engine';
import type { Store } from '../storage';
import { LIMITS } from '../storage';
import { appendBounded, randomUuid } from '../util';

type Learning = ProfileDocument['learning'];

/** The learner's output as the config and the engine consume it. Manual overrides are read from rules.muted. */
export interface LearnedStateView {
  /** Resolved states keyed by statsKey(scope, scopeKey, rule); read with lookupRuleState (host -> ctx -> global). */
  ruleStates: Readonly<Record<string, LearnedRuleState>>;
  /** Correctness rules whose fixes qualify for Tier A at confidence >= 0.70 (global n >= 10, Wilson LB >= 0.80). */
  promoted: ReadonlySet<string>;
}

export interface IngestContext {
  deviceId: string;
  model?: string;
  promptVersion: string;
  /** EffectiveConfig.storeSnippets for the field's host (false strips every snippet before buffering). */
  storeSnippets: boolean;
}

export interface LearningService {
  /** Completes, redacts, buffers and folds events; returns the completed events (for tests and uploads). */
  ingest(inputs: readonly FeedbackEventInput[], ctx: IngestContext): Promise<FeedbackEvent[]>;
  /** Folds already-complete events (idempotent by eventId). */
  foldInto(events: readonly FeedbackEvent[]): Promise<void>;
  addSamples(samples: readonly VoiceSample[], storeSnippets: boolean): Promise<void>;
  learned(): LearnedStateView;
  /** Paired devices: adopt the server's learning section on every successful poll. */
  replaceShadow(learning: Learning): Promise<void>;
  summary(now?: number): LearningSummary;
}

export interface LearningDeps {
  store: Store;
  clock: DeviceClock;
  isPaired(): boolean;
  now?: () => number;
}

const SNIPPET_FIELDS = ['original', 'replacement', 'final'] as const;

/** Completes one input into a FeedbackEvent and applies the snippet policy. */
export function completeEvent(input: FeedbackEventInput, ctx: IngestContext, profile: ProfileDocument, nowMs: number): FeedbackEvent {
  const goals = { ...profile.settings.goals.value, ...(profile.sites.overrides[input.host]?.value.goals ?? {}) };
  const event: FeedbackEvent = {
    ...input,
    v: 1,
    eventId: randomUuid(),
    t: new Date(nowMs).toISOString(),
    deviceId: ctx.deviceId,
    promptVersion: ctx.promptVersion,
    profileVersion: profile.version,
    profileStrength: profile.voice.settings.value.strength,
    goals,
    dialect: profile.settings.dialect.value,
  };
  if (ctx.model !== undefined) event.model = ctx.model;
  for (const field of SNIPPET_FIELDS) {
    const v = event[field];
    if (v === undefined) continue;
    if (!ctx.storeSnippets) delete event[field];
    else event[field] = redactSnippet(v);
  }
  if (event.sentence !== undefined) {
    if (!ctx.storeSnippets) delete event.sentence;
    else event.sentence = redactSentence(event.sentence);
  }
  return event;
}

/** Live rules.muted entries ("<rule>" or "<rule>@<host>") as the learner's manual overrides. */
export function manualOffFromMuted(entries: readonly string[]): ManualOff[] {
  const out: ManualOff[] = [];
  for (const entry of entries) {
    const m = decodeMute(entry);
    if (m.rule.length === 0) continue;
    out.push(m.host === undefined ? { scope: 'global', rule: m.rule } : { scope: 'host', scopeKey: m.host, rule: m.rule });
  }
  return out;
}

/** Category per rule id as observed in events, so rules outside the engine vocabulary count as what they are. */
export function categoriesFrom(events: readonly FeedbackEvent[]): RuleCategories {
  const out: Record<string, SuggestionCategory> = {};
  for (const e of events) {
    if (typeof e.rule === 'string' && e.rule.length > 0 && out[e.rule] === undefined) out[e.rule] = e.category;
  }
  return out;
}

export function createLearning(deps: LearningDeps): LearningService {
  const { store, clock } = deps;
  const now = deps.now ?? Date.now;

  const shadow = (): Learning => store.local.get('learningShadow');

  // promotedRules runs Wilson over every global counter; the shadow is replaced wholesale on every write, so the
  // stats object's identity is a sound memo key.
  let promotedMemo: { stats: Learning['stats']; promoted: ReadonlySet<string> } | null = null;
  const promotedFor = (learning: Learning): ReadonlySet<string> => {
    if (promotedMemo === null || promotedMemo.stats !== learning.stats) promotedMemo = { stats: learning.stats, promoted: promotedRules(learning.stats) };
    return promotedMemo.promoted;
  };

  const write = async (next: Learning): Promise<void> => {
    await store.local.set('learningShadow', next);
    if (!deps.isPaired()) {
      const profile = store.local.get('profile');
      await store.local.set('profile', { ...profile, learning: { ...next, updatedHlc: clock.next() } });
    }
  };

  const fold = async (events: readonly FeedbackEvent[]): Promise<void> => {
    const seenList = store.local.get('seenEventIds');
    const seen = new Set(seenList);
    const fresh = events.filter((e) => !seen.has(e.eventId));
    if (fresh.length === 0) return;
    const profile = store.local.get('profile');
    const current = shadow();
    const nowIso = new Date(now()).toISOString();
    const folded = foldEvents(current.stats, fresh, { now: nowIso, seen });
    const buffer = store.local.get('eventBuffer');
    const buffered = new Set(buffer.map((e) => e.eventId));
    const all = buffer.concat(fresh.filter((e) => !buffered.has(e.eventId)));
    // Persisted manual mutes plus the overrides this batch asked for keep a muted rule out of reprobing.
    const manualOff = [...manualOffFromMuted(orSetLive(profile.rules.muted)), ...folded.manualOff];
    const resolved = resolveLearning(folded.stats, current.ruleStates, nowIso, manualOff, { categories: categoriesFrom(all) });
    let cursor = current.lastEventCursor;
    for (const e of fresh) if (e.t > cursor) cursor = e.t;
    const next: Learning = {
      ...current,
      stats: resolved.stats,
      ruleStates: resolved.ruleStates,
      dictionaryCandidates: dictionaryCandidates(all, orSetLive(profile.dictionary)),
      lastEventCursor: cursor,
    };
    await store.local.set('seenEventIds', appendBounded(seenList, fresh.map((e) => e.eventId), LIMITS.SEEN_EVENT_IDS_MAX));
    await write(next);
  };

  return {
    async ingest(inputs, ctx) {
      if (inputs.length === 0) return [];
      const profile = store.local.get('profile');
      const t = now();
      const events = inputs.map((input) => completeEvent(input, ctx, profile, t));
      await store.local.set('eventBuffer', appendBounded(store.local.get('eventBuffer'), events, LIMITS.EVENT_BUFFER_MAX));
      await fold(events);
      return events;
    },
    foldInto: fold,
    async addSamples(samples, storeSnippets) {
      if (!storeSnippets || samples.length === 0) return;
      const clean = samples.map((s) => ({ ...s, sentence: redactSentence(s.sentence) })).filter((s) => s.sentence.length > 0);
      if (clean.length === 0) return;
      const all = appendBounded(store.local.get('sampleBuffer'), clean, LIMITS.SAMPLE_BUFFER_MAX);
      await store.local.set('sampleBuffer', all);
      // The writer's dialect, once >= 20 marker words agree at >= 80% (undefined until then: nothing is recorded).
      const inferred = inferDialect(all.map((s) => s.sentence));
      if (inferred !== undefined && inferred !== shadow().dialectInferred) await write({ ...shadow(), dialectInferred: inferred });
    },
    learned() {
      const s = shadow();
      return { ruleStates: s.ruleStates, promoted: promotedFor(s) };
    },
    async replaceShadow(learning) {
      await store.local.set('learningShadow', learning);
    },
    summary(at) {
      const profile = store.local.get('profile');
      const privacy = profile.settings.privacy.value;
      return buildLearningSummary({ ...profile, learning: shadow() }, store.local.get('eventBuffer'), {
        now: new Date(at ?? now()).toISOString(),
        days: 28,
        storeSnippets: privacy.storeSnippets && privacy.learningEnabled,
        voiceSamples: store.local.get('sampleBuffer'),
      });
    },
  };
}
