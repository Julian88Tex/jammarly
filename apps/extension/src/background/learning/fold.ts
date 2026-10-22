/**
 * Learning ingest and fold (ARCHITECTURE §3.7): completes the content script's FeedbackEventInputs into
 * FeedbackEvents, redacts or strips snippets, buffers them for upload and folds them into the device shadow at once
 * so suppressions take effect immediately. Unpaired, the shadow IS profile.learning (written back with a fresh
 * clock); paired, the server is authoritative and the shadow is replaced by profile.learning on every poll.
 */
import type { FeedbackEvent, FeedbackEventInput, LearningSummary, VoiceSample } from '@jammarly/shared/learning';
import type { ProfileDocument } from '@jammarly/shared/profile';
import type { DeviceClock } from '../clock';
import type { LearnedStateView } from '../shared-engine';
import { buildLearningSummary, categoryForRule, dictionaryCandidates, foldEvents, liveValues, promotedRules, redactSentence, redactSnippet, resolveRuleStates } from '../shared-engine';
import type { Store } from '../storage';
import { LIMITS } from '../storage';
import { appendBounded, randomUuid } from '../util';

type Learning = ProfileDocument['learning'];

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

export function createLearning(deps: LearningDeps): LearningService {
  const { store, clock } = deps;
  const now = deps.now ?? Date.now;

  const shadow = (): Learning => store.local.get('learningShadow');

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
    let next = foldEvents(shadow(), fresh);
    next = { ...next, ruleStates: resolveRuleStates(next, categoryForRule) };
    const buffer = store.local.get('eventBuffer');
    next = { ...next, dictionaryCandidates: dictionaryCandidates(buffer.concat(fresh.filter((e) => !buffer.includes(e))), liveValues(profile.dictionary)) };
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
      await store.local.set('sampleBuffer', appendBounded(store.local.get('sampleBuffer'), clean, LIMITS.SAMPLE_BUFFER_MAX));
    },
    learned() {
      const s = shadow();
      const profile = store.local.get('profile');
      return { ruleStates: s.ruleStates, promoted: promotedRules(s.ruleStates), manualOff: liveValues(profile.rules.muted) };
    },
    async replaceShadow(learning) {
      await store.local.set('learningShadow', learning);
    },
    summary(at) {
      const profile = store.local.get('profile');
      return buildLearningSummary({
        events: store.local.get('eventBuffer'),
        profile,
        learning: shadow(),
        manualOff: liveValues(profile.rules.muted),
        now: at ?? now(),
        days: 28,
        categoryOf: categoryForRule,
      });
    },
  };
}
