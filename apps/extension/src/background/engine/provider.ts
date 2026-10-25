/**
 * The engine's provider contract: what the orchestrator needs from a model backend (Anthropic or the mock).
 * Providers return the raw model output; parsing and anchoring happen in the orchestrator so both providers
 * run through exactly the same validation.
 */
import type { CheckError, CheckErrorCode, CheckRequest, EngineProvider, TokenUsage, WritingContext } from '@jammarly/shared/types';
import type { SystemBlock } from '../shared-engine';
import { EngineOutputError } from '../shared-engine';
import { isAbortError } from '../util';

export interface ProviderCheckInput {
  system: SystemBlock[];
  user: string;
  /** The request and the block ids this call covers (the mock derives its output from these). */
  request: CheckRequest;
  blockIds: string[];
}

export interface ProviderToneInput {
  system: SystemBlock[];
  user: string;
  text: string;
  /** Writing context of the field; the mock derives its tone from it, the model is told nothing. */
  context?: WritingContext;
}

export interface ProviderCallOptions {
  model: string;
  pass: 'fast' | 'deep';
  signal?: AbortSignal;
  /** Called once when the first streamed bytes arrive (progress stage 'streaming'). */
  onFirstToken?: () => void;
}

export interface ProviderResult {
  /** Parsed JSON object the model returned (unknown until the engine schema parser validates it). */
  output: unknown;
  usage: TokenUsage;
  /** The model that answered (a fallback model may differ from the one requested). */
  model: string;
  stopReason: string | null;
}

export interface KeyTestResult {
  valid: boolean;
  model?: string;
  message?: string;
  code?: CheckErrorCode;
}

export interface Provider {
  readonly kind: EngineProvider;
  check(input: ProviderCheckInput, opts: ProviderCallOptions): Promise<ProviderResult>;
  tone(input: ProviderToneInput, opts: { model: string; signal?: AbortSignal }): Promise<ProviderResult>;
  testKey?(apiKey: string): Promise<KeyTestResult>;
}

/** A failure the UI can act on; `code` is the CheckErrorCode the content script maps to a button state. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly code: CheckErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ProviderError');
}

export const ERROR_MESSAGES: Record<CheckErrorCode, string> = {
  'no-api-key': 'Add your Anthropic API key in Jammarly settings.',
  'consent-required': 'Finish setting up Jammarly to start checking.',
  budget: 'Daily budget reached. Checks resume at midnight.',
  auth: 'Anthropic rejected the API key. Check it in Jammarly settings.',
  'rate-limit': 'Anthropic is rate-limiting requests. Jammarly will retry.',
  'spend-cap': 'Your Anthropic spend limit was reached.',
  network: "Couldn't reach Anthropic. Check your connection.",
  refusal: "Couldn't check one paragraph",
  truncated: "Couldn't check one paragraph",
  'invalid-response': 'The model returned an unreadable answer.',
  cancelled: 'Check cancelled.',
  disabled: 'Jammarly is turned off here.',
  unknown: 'Something went wrong while checking.',
};

export function checkError(code: CheckErrorCode, retryable: boolean, message?: string, retryAfterMs?: number): CheckError {
  const out: CheckError = { code, message: message ?? ERROR_MESSAGES[code], retryable };
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
  return out;
}

/** Maps anything thrown by a provider or the parser to a CheckError. */
export function toCheckError(e: unknown): CheckError {
  if (isProviderError(e)) return checkError(e.code, e.retryable, e.message, e.retryAfterMs);
  if (e instanceof EngineOutputError) return checkError('invalid-response', true);
  if (isAbortError(e)) return checkError('cancelled', true);
  return checkError('unknown', true);
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e9) / 1e9,
  };
}
