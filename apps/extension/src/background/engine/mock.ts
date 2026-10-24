/**
 * Mock provider (`provider: 'mock'`): deterministic, zero-cost suggestions from the shared mock engine
 * (`@jammarly/shared/mock-engine`), with a short artificial delay so progress stages are observable in tests and
 * demos. The engine honours `dirtyBlockHashes`, so each provider call marks exactly the blocks the orchestrator
 * asked for as dirty; the tone call reuses the engine's document tone. Never touches the network.
 */
import type { CheckRequest } from '@jammarly/shared/types';
import { blockIdFor, mockCheck, MOCK_MODEL } from '../shared-engine';
import { sleep } from '../util';
import type { KeyTestResult, Provider, ProviderCallOptions, ProviderCheckInput, ProviderResult, ProviderToneInput } from './provider';
import { ProviderError, ZERO_USAGE } from './provider';
import { toneSummaryFor } from './tone';

export { MOCK_MODEL };
export const MOCK_DELAY_MS = 30;

export interface MockProviderOptions {
  delayMs?: number;
}

/** The request one provider call checks: only the blocks whose ids were requested are dirty. */
export function requestForBlocks(request: CheckRequest, blockIds: readonly string[]): CheckRequest {
  const wanted = new Set(blockIds);
  return { ...request, dirtyBlockHashes: request.blocks.filter((p) => wanted.has(blockIdFor(p.index))).map((p) => p.hash) };
}

/** A whole-field request with no dirty blocks: only document.tone (and consistency) is derived from it. */
function toneRequestFor(input: ProviderToneInput): CheckRequest {
  return { fieldId: 'tone', version: 0, text: input.text, blocks: [], dirtyBlockHashes: [], pass: 'fast', host: '', context: input.context ?? 'other', fieldKind: 'scratch', protectedRanges: [] };
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
      const { output, usage, model } = mockCheck(requestForBlocks(input.request, input.blockIds));
      return { output, usage, model, stopReason: 'end_turn' };
    },
    async tone(input: ProviderToneInput, callOpts: { model: string; signal?: AbortSignal }): Promise<ProviderResult> {
      if (callOpts.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', true);
      await sleep(delayMs, callOpts.signal);
      const labels = mockCheck(toneRequestFor(input)).output.document.tone;
      return { output: { tone: labels, rationale: toneSummaryFor(labels) }, usage: { ...ZERO_USAGE }, model: MOCK_MODEL, stopReason: 'end_turn' };
    },
    async testKey(): Promise<KeyTestResult> {
      return { valid: true, model: MOCK_MODEL, message: 'Mock engine: no key needed.' };
    },
  };
}
