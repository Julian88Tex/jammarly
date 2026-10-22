/**
 * Mock provider (`provider: 'mock'`): deterministic, zero-cost suggestions from the shared mock engine, honouring
 * only the requested block ids, with a short artificial delay so progress stages are observable in tests and
 * demos. Never touches the network.
 */
import { mockCheck, mockTone, toneSummaryFor } from '../shared-engine';
import { sleep } from '../util';
import type { KeyTestResult, Provider, ProviderCallOptions, ProviderCheckInput, ProviderResult, ProviderToneInput } from './provider';
import { ProviderError, ZERO_USAGE } from './provider';

export const MOCK_MODEL = 'mock';
export const MOCK_DELAY_MS = 30;

export interface MockProviderOptions {
  delayMs?: number;
}

export function createMockProvider(opts: MockProviderOptions = {}): Provider {
  const delayMs = opts.delayMs ?? MOCK_DELAY_MS;
  return {
    kind: 'mock',
    async check(input: ProviderCheckInput, callOpts: ProviderCallOptions): Promise<ProviderResult> {
      if (callOpts.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', true);
      await sleep(Math.floor(delayMs / 2), callOpts.signal);
      callOpts.onFirstToken?.();
      await sleep(Math.ceil(delayMs / 2), callOpts.signal);
      const output = mockCheck(input.request, input.blockIds);
      return { output, usage: { ...ZERO_USAGE }, model: MOCK_MODEL, stopReason: 'end_turn' };
    },
    async tone(input: ProviderToneInput, callOpts: { model: string; signal?: AbortSignal }): Promise<ProviderResult> {
      if (callOpts.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', true);
      await sleep(delayMs, callOpts.signal);
      const labels = mockTone(input.text);
      return { output: { tone: labels, rationale: toneSummaryFor(labels) }, usage: { ...ZERO_USAGE }, model: MOCK_MODEL, stopReason: 'end_turn' };
    },
    async testKey(): Promise<KeyTestResult> {
      return { valid: true, model: MOCK_MODEL, message: 'Mock engine: no key needed.' };
    },
  };
}
