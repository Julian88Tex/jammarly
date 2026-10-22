/**
 * The separate whole-field tone call (ARCHITECTURE §3.3): runs after a deep pass or a full ('all') check when the
 * field holds >= 150 characters, keyed by the hash of the first 2,500 characters in a small cache, and emits a
 * `tone` port message. With the mock provider the tone comes from the mock engine's document.tone.
 */
import type { CheckRequest, ToneAnalysis, TokenUsage } from '@jammarly/shared/types';
import { buildToneMessages, hashText, parseToneOutput, toneSummaryFor } from '../shared-engine';
import type { Provider } from './provider';

export const TONE_MIN_CHARS = 150;
export const TONE_KEY_CHARS = 2500;

export interface ToneRunner {
  /** Starts a tone call when the request qualifies; resolves with the tone (or null) once it was emitted. */
  maybeRun(request: CheckRequest, opts: { provider: Provider; model: string; send(tone: ToneAnalysis): void; onUsage?(usage: TokenUsage): void }): Promise<ToneAnalysis | null>;
  cancel(fieldId: string): void;
  readonly cacheSize: number;
}

export function qualifiesForTone(request: CheckRequest): boolean {
  return request.text.length >= TONE_MIN_CHARS && (request.pass === 'deep' || request.dirtyBlockHashes === 'all');
}

export function toneKey(text: string): string {
  return hashText(text.slice(0, TONE_KEY_CHARS));
}

export function createToneRunner(opts: { cacheMax?: number } = {}): ToneRunner {
  const max = opts.cacheMax ?? 50;
  const cache = new Map<string, ToneAnalysis>();
  const inflight = new Map<string, AbortController>();

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
    async maybeRun(request, run) {
      if (!qualifiesForTone(request)) return null;
      const key = toneKey(request.text);
      const cached = cache.get(key);
      if (cached) {
        run.send(cached);
        return cached;
      }
      inflight.get(request.fieldId)?.abort();
      const controller = new AbortController();
      inflight.set(request.fieldId, controller);
      try {
        const messages = buildToneMessages(request.text);
        const result = await run.provider.tone({ ...messages, text: request.text }, { model: run.model, signal: controller.signal });
        run.onUsage?.(result.usage);
        const tone = parseToneOutput(result.output);
        if (tone.labels.length === 0) return null;
        if (tone.summary.length === 0) tone.summary = toneSummaryFor(tone.labels);
        remember(key, tone);
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
