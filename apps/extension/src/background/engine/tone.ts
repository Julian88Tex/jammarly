/**
 * The separate whole-field tone call (ARCHITECTURE §3.3): runs after a deep pass or a full ('all') check when the
 * field holds >= TONE_MIN_CHARS characters, keyed by the hash of the first 2,500 characters (`toneCacheKey`) in a
 * small cache, and emits a `tone` port message. The byte-stable system prompt, the cache key, the masked user turn
 * and the tolerant parser come from `@jammarly/shared/prompts/tone`; with the mock provider the tone comes from
 * the mock engine's document.tone.
 *
 * Request budget: when a suggestion call already covered the whole text, the orchestrator `remember`s its
 * document tone instead of calling. Otherwise a field gets at most one tone call per TONE_MIN_INTERVAL_MS, unless
 * its length changed by TONE_RECHECK_CHANGE or more since the last tone (a small edit rarely changes the tone).
 */
import type { CheckRequest, ToneAnalysis, ToneLabel, TokenUsage } from '@jammarly/shared/types';
import type { SystemBlock } from '../shared-engine';
import { buildToneMessages, parseToneOutput, toneCacheKey, TONE_MIN_CHARS } from '../shared-engine';
import type { Provider, ProviderToneInput } from './provider';

export { TONE_MIN_CHARS, toneCacheKey };

/** Minimum time between two tone calls for one field (unless the text changed a lot). */
export const TONE_MIN_INTERVAL_MS = 60_000;
/** Relative length change since the last tone that justifies a new call inside the interval. */
export const TONE_RECHECK_CHANGE = 0.25;

export interface ToneRunner {
  /** Starts a tone call when the request qualifies; resolves with the tone (or null) once it was emitted. */
  maybeRun(request: CheckRequest, opts: { provider: Provider; model: string; send(tone: ToneAnalysis): void; onUsage?(usage: TokenUsage): void }): Promise<ToneAnalysis | null>;
  /** Records a tone that a suggestion call returned for the whole text, so no tone call is made for it. */
  remember(request: Pick<CheckRequest, 'fieldId' | 'text'>, tone: ToneAnalysis): void;
  cancel(fieldId: string): void;
  readonly cacheSize: number;
}

export function qualifiesForTone(request: CheckRequest): boolean {
  return request.text.length >= TONE_MIN_CHARS && (request.pass === 'deep' || request.dirtyBlockHashes === 'all');
}

/** The shared tone call in the provider's shape: the system prompt as one cached block, the masked `<text>` turn. */
export function toneInputFor(request: Pick<CheckRequest, 'text' | 'context' | 'protectedRanges'>): ProviderToneInput {
  const messages = buildToneMessages(request.text, request.protectedRanges);
  const system: SystemBlock[] = [{ type: 'text', text: messages.system, cache_control: { type: 'ephemeral' } }];
  return { system, user: messages.user, text: request.text, context: request.context };
}

/** A one-sentence summary from labels when the response carried none ("Sounds confident and a little informal."). */
export function toneSummaryFor(labels: readonly ToneLabel[]): string {
  if (labels.length === 0) return '';
  const parts = labels.map((l) => (l.strength === 'slight' ? `a little ${l.label}` : l.strength === 'strong' ? `very ${l.label}` : l.label));
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const sentence = `Sounds ${joined}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function createToneRunner(opts: { cacheMax?: number; now?: () => number; minIntervalMs?: number } = {}): ToneRunner {
  const max = opts.cacheMax ?? 50;
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? TONE_MIN_INTERVAL_MS;
  const cache = new Map<string, ToneAnalysis>();
  const inflight = new Map<string, AbortController>();
  /** Per field: when its tone was last computed (or remembered) and for how long a text. */
  const last = new Map<string, { at: number; length: number }>();
  const note = (fieldId: string, text: string): void => {
    last.delete(fieldId);
    last.set(fieldId, { at: now(), length: text.length });
    while (last.size > max) {
      const oldest = last.keys().next().value;
      if (oldest === undefined) break;
      last.delete(oldest);
    }
  };
  /** True when this field had a tone recently and its text did not change much since. */
  const recent = (request: CheckRequest): boolean => {
    const prev = last.get(request.fieldId);
    if (!prev) return false;
    if (now() - prev.at >= minInterval) return false;
    const change = Math.abs(request.text.length - prev.length) / Math.max(1, prev.length);
    return change < TONE_RECHECK_CHANGE;
  };

  const remember = (key: string, tone: ToneAnalysis): void => {
    cache.delete(key);
    cache.set(key, tone);
    while (cache.size > max) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    get cacheSize() {
      return cache.size;
    },
    cancel(fieldId) {
      inflight.get(fieldId)?.abort();
      inflight.delete(fieldId);
    },
    remember(request, tone) {
      if (tone.labels.length === 0) return;
      remember(toneCacheKey(request.text), tone);
      note(request.fieldId, request.text);
    },
    async maybeRun(request, run) {
      if (!qualifiesForTone(request)) return null;
      const key = toneCacheKey(request.text);
      const cached = cache.get(key);
      if (cached) {
        run.send(cached);
        return cached;
      }
      // A tone call is already running for this field (it reflects nearly the same text), or one landed recently.
      if (inflight.has(request.fieldId) || recent(request)) return null;
      const controller = new AbortController();
      inflight.set(request.fieldId, controller);
      try {
        const result = await run.provider.tone(toneInputFor(request), { model: run.model, signal: controller.signal });
        run.onUsage?.(result.usage);
        const tone = parseToneOutput(result.output);
        if (tone.labels.length === 0) return null;
        if (tone.summary.length === 0) tone.summary = toneSummaryFor(tone.labels);
        remember(key, tone);
        note(request.fieldId, request.text);
        if (!controller.signal.aborted) run.send(tone);
        return tone;
      } catch {
        return null;
      } finally {
        if (inflight.get(request.fieldId) === controller) inflight.delete(request.fieldId);
      }
    },
  };
}
