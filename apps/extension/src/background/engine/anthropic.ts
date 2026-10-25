/**
 * Anthropic provider (ARCHITECTURE §3.3): `client.messages.stream()` with structured output, cached system blocks,
 * per-pass effort/thinking, the server-side-fallback beta for Opus (through the beta client, the only place the SDK
 * accepts `betas`/`fallbacks`), explicit `stop_reason` handling and SDK error mapping. The client is injectable so
 * unit tests never touch the network.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '@jammarly/shared/types';
import type { SystemBlock } from '../shared-engine';
import { effortFor, estimateCostUsd, SUGGESTION_OUTPUT_SCHEMA, thinkingFor, TONE_MAX_TOKENS, TONE_OUTPUT_SCHEMA } from '../shared-engine';
import { isAbortError } from '../util';
import type { KeyTestResult, Provider, ProviderCallOptions, ProviderCheckInput, ProviderResult, ProviderToneInput } from './provider';
import { ProviderError } from './provider';

export const KEY_TEST_MODEL = 'claude-haiku-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/**
 * Output budgets. A thorough pass writes about 100 tokens per suggestion, and one call now carries a whole email
 * (up to 1,200 words), so the old 4,096 truncated busy drafts. OTPM rate limits count the tokens actually
 * generated, not max_tokens, so a generous ceiling costs nothing; the deep budget also covers adaptive thinking.
 * Both calls stream, so large values never hit the SDK's non-streaming timeout guard.
 */
export const MAX_TOKENS_FAST = 16000;
export const MAX_TOKENS_DEEP = 32000;
/** The separate tone call's output budget (ARCHITECTURE §3.3), from the shared tone module. */
export const MAX_TOKENS_TONE: number = TONE_MAX_TOKENS;

// --- the slice of the SDK the provider uses (so tests can inject a fake) ---------------------------------------

export interface AnthropicMessageParams {
  model: string;
  max_tokens: number;
  system?: SystemBlock[];
  messages: { role: 'user'; content: string }[];
  output_config?: { format?: { type: 'json_schema'; schema: Record<string, unknown> }; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  thinking?: { type: 'disabled' } | { type: 'adaptive' };
}

export interface AnthropicBetaMessageParams extends AnthropicMessageParams {
  betas: string[];
  fallbacks: 'default';
}

export interface AnthropicMessageLike {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  model: string;
}

export interface AnthropicStreamLike {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  finalMessage(): Promise<AnthropicMessageLike>;
  abort?(): void;
}

export interface AnthropicClientLike {
  messages: {
    stream(params: AnthropicMessageParams, opts?: { signal?: AbortSignal }): AnthropicStreamLike;
    create(params: AnthropicMessageParams, opts?: { signal?: AbortSignal }): Promise<AnthropicMessageLike>;
  };
  beta: { messages: { stream(params: AnthropicBetaMessageParams, opts?: { signal?: AbortSignal }): AnthropicStreamLike } };
}

export type ClientFactory = (apiKey: string) => AnthropicClientLike;

export const defaultClientFactory: ClientFactory = (apiKey) =>
  new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 120_000 }) as unknown as AnthropicClientLike;

// --- error mapping ----------------------------------------------------------------------------------------------

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as { get?: (n: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === 'function') {
    const v = h.get(name);
    return typeof v === 'string' ? v : undefined;
  }
  const v = h[name] ?? h[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

/** Milliseconds from a Retry-After header (seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value: string | undefined, nowMs = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s) * 1000));
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : undefined;
}

/** Maps SDK and fetch failures to ProviderErrors (research 02 reviewer A5/A6/A7, 05 M1). */
export function mapAnthropicError(err: unknown, nowMs = Date.now()): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = (typeof err === 'object' && err !== null ? err : {}) as { name?: unknown; status?: unknown; message?: unknown; error?: unknown; headers?: unknown; cause?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (isAbortError(err) || name === 'APIUserAbortError') return new ProviderError('cancelled', 'Request cancelled', true);
  let body = '';
  try {
    body = JSON.stringify(e.error ?? '');
  } catch {
    body = '';
  }
  if (body.includes('enforced_spend_limit_reached') || message.includes('enforced_spend_limit_reached')) {
    return new ProviderError('spend-cap', 'Your Anthropic spend limit was reached.', false);
  }
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === 401 || name === 'AuthenticationError') return new ProviderError('auth', 'Anthropic rejected the API key.', false);
  if (status === 403 || name === 'PermissionDeniedError') return new ProviderError('auth', 'This API key may not use this model.', false);
  // A key created outside a workspace (or for another org) fails every call with a 400 about its scope.
  if (status === 400 && /not scoped to a workspace|api key|x-api-key|organization/i.test(`${message} ${body}`)) {
    return new ProviderError('auth', 'This API key cannot be used here. Create a new key inside a workspace at console.anthropic.com, then paste it in Settings.', false);
  }
  if (status === 429 || name === 'RateLimitError') {
    return new ProviderError('rate-limit', 'Rate limited by Anthropic.', true, parseRetryAfter(headerValue(e.headers, 'retry-after'), nowMs));
  }
  // The SDK's connection errors do not set `name`; recognise them by class name and by their fixed messages.
  const ctorName = typeof err === 'object' && err !== null ? (err.constructor as { name?: string } | undefined)?.name ?? '' : '';
  if (
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    ctorName === 'APIConnectionError' ||
    ctorName === 'APIConnectionTimeoutError' ||
    err instanceof TypeError ||
    /^Connection error|Request timed out|fetch failed|network|Failed to fetch/i.test(message)
  ) {
    return new ProviderError('network', "Couldn't reach Anthropic.", true);
  }
  if (status !== undefined && status >= 500) return new ProviderError('unknown', `Anthropic returned ${status}.`, true);
  return new ProviderError('unknown', message || 'Unknown error', true);
}

// --- response handling ------------------------------------------------------------------------------------------

function usageOf(msg: AnthropicMessageLike, model: string): TokenUsage {
  const u = msg.usage ?? { input_tokens: 0, output_tokens: 0 };
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: estimateCostUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) };
}

/** Turns a final message into a ProviderResult; refusal and max_tokens become typed errors, partial JSON is never shown. */
export function resultFromMessage(msg: AnthropicMessageLike, requestedModel: string): ProviderResult {
  const model = typeof msg.model === 'string' && msg.model.length > 0 ? msg.model : requestedModel;
  const usage = usageOf(msg, model);
  if (msg.stop_reason === 'refusal') throw new ProviderError('refusal', "The model declined to check this text.", false);
  if (msg.stop_reason === 'max_tokens') throw new ProviderError('truncated', 'The response was cut off.', false);
  const text = (msg.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('');
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new ProviderError('invalid-response', 'The model returned an unreadable answer.', true);
  }
  return { output, usage, model, stopReason: msg.stop_reason };
}

async function runStream(stream: AnthropicStreamLike, model: string, onFirstToken?: () => void): Promise<ProviderResult> {
  if (onFirstToken) {
    let fired = false;
    const once = (): void => {
      if (fired) return;
      fired = true;
      onFirstToken();
    };
    try {
      stream.on('streamEvent', once);
      stream.on('text', once);
    } catch {
      // a fake stream without events
    }
  }
  let msg: AnthropicMessageLike;
  try {
    msg = await stream.finalMessage();
  } catch (err) {
    throw mapAnthropicError(err);
  }
  return resultFromMessage(msg, model);
}

/** Request body for a suggestion call (exported for tests of the request shape). */
export function checkParams(input: Pick<ProviderCheckInput, 'system' | 'user'>, model: string, pass: 'fast' | 'deep'): AnthropicMessageParams {
  return {
    model,
    max_tokens: pass === 'fast' ? MAX_TOKENS_FAST : MAX_TOKENS_DEEP,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
    output_config: { format: { type: 'json_schema', schema: SUGGESTION_OUTPUT_SCHEMA as unknown as Record<string, unknown> }, effort: effortFor(pass) },
    thinking: thinkingFor(model, pass),
  };
}

export function toneParams(input: Pick<ProviderToneInput, 'system' | 'user'>, model: string): AnthropicMessageParams {
  return {
    model,
    max_tokens: MAX_TOKENS_TONE,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
    output_config: { format: { type: 'json_schema', schema: TONE_OUTPUT_SCHEMA as unknown as Record<string, unknown> }, effort: 'low' },
    thinking: thinkingFor(model, 'fast'),
  };
}

export function usesFallbackBeta(model: string): boolean {
  return model.includes('opus');
}

export interface AnthropicProviderOptions {
  clientFactory?: ClientFactory;
}

export function createAnthropicProvider(apiKey: string, opts: AnthropicProviderOptions = {}): Provider {
  const factory = opts.clientFactory ?? defaultClientFactory;
  let client: AnthropicClientLike | null = null;
  const getClient = (): AnthropicClientLike => {
    if (client === null) client = factory(apiKey);
    return client;
  };
  const open = (params: AnthropicMessageParams, signal: AbortSignal | undefined): AnthropicStreamLike => {
    const c = getClient();
    const options = signal ? { signal } : undefined;
    if (usesFallbackBeta(params.model)) {
      return c.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, options);
    }
    return c.messages.stream(params, options);
  };

  return {
    kind: 'anthropic',
    async check(input: ProviderCheckInput, callOpts: ProviderCallOptions): Promise<ProviderResult> {
      if (callOpts.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', true);
      let stream: AnthropicStreamLike;
      try {
        stream = open(checkParams(input, callOpts.model, callOpts.pass), callOpts.signal);
      } catch (err) {
        throw mapAnthropicError(err);
      }
      return runStream(stream, callOpts.model, callOpts.onFirstToken);
    },
    async tone(input: ProviderToneInput, callOpts: { model: string; signal?: AbortSignal }): Promise<ProviderResult> {
      if (callOpts.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled', true);
      let stream: AnthropicStreamLike;
      try {
        stream = getClient().messages.stream(toneParams(input, callOpts.model), callOpts.signal ? { signal: callOpts.signal } : undefined);
      } catch (err) {
        throw mapAnthropicError(err);
      }
      return runStream(stream, callOpts.model);
    },
    async testKey(key: string): Promise<KeyTestResult> {
      const trimmed = key.trim();
      if (trimmed.length === 0) return { valid: false, message: 'Enter an API key first.', code: 'no-api-key' };
      try {
        const msg = await factory(trimmed).messages.create({ model: KEY_TEST_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
        return { valid: true, model: typeof msg.model === 'string' ? msg.model : KEY_TEST_MODEL };
      } catch (err) {
        const mapped = mapAnthropicError(err);
        return { valid: false, message: mapped.message, code: mapped.code };
      }
    },
  };
}
