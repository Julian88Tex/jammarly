import { describe, expect, it } from 'vitest';
import { splitParagraphs } from '@jammarly/shared/text';
import type { CheckRequest } from '@jammarly/shared/types';
import {
  checkParams,
  createAnthropicProvider,
  mapAnthropicError,
  MAX_TOKENS_DEEP,
  MAX_TOKENS_FAST,
  parseRetryAfter,
  resultFromMessage,
  toneParams,
  usesFallbackBeta,
  type AnthropicClientLike,
  type AnthropicMessageLike,
  type AnthropicMessageParams,
  type AnthropicStreamLike,
} from '../../src/background/engine/anthropic';
import { ProviderError } from '../../src/background/engine/provider';
import { buildCheckMessages, SUGGESTION_SYSTEM_PROMPT } from '../../src/background/shared-engine';

function message(over: Partial<AnthropicMessageLike> = {}): AnthropicMessageLike {
  return {
    content: [{ type: 'text', text: JSON.stringify({ blocks: [], document: { tone: [], consistency: [], notes: '' } }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    model: 'claude-haiku-5-5',
    ...over,
  };
}

interface FakeClient extends AnthropicClientLike {
  streams: { params: AnthropicMessageParams; beta: boolean; signal?: AbortSignal }[];
  creates: AnthropicMessageParams[];
}

function fakeClient(respond: (params: AnthropicMessageParams) => AnthropicMessageLike | Error, createRespond?: () => AnthropicMessageLike | Error): FakeClient {
  const streams: FakeClient['streams'] = [];
  const creates: AnthropicMessageParams[] = [];
  const makeStream = (params: AnthropicMessageParams): AnthropicStreamLike => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    return {
      on(event, fn) {
        (handlers[event] ??= []).push(fn);
        return this;
      },
      async finalMessage() {
        for (const fn of handlers.streamEvent ?? []) fn({ type: 'message_start' });
        const r = respond(params);
        if (r instanceof Error) throw r;
        return r;
      },
    };
  };
  return {
    streams,
    creates,
    messages: {
      stream(params, opts) {
        streams.push({ params, beta: false, ...(opts?.signal ? { signal: opts.signal } : {}) });
        return makeStream(params);
      },
      async create(params) {
        creates.push(params);
        const r = (createRespond ?? (() => message({ model: 'claude-haiku-5-5' })))();
        if (r instanceof Error) throw r;
        return r;
      },
    },
    beta: {
      messages: {
        stream(params, opts) {
          streams.push({ params, beta: true, ...(opts?.signal ? { signal: opts.signal } : {}) });
          return makeStream(params);
        },
      },
    },
  };
}

function sdkError(name: string, status?: number, extra: Record<string, unknown> = {}): Error {
  const e = new Error(`${name} ${status ?? ''}`.trim());
  e.name = name;
  Object.assign(e, { status, ...extra });
  return e;
}

const TEXT = 'He said that the the report were finished yesterday.';
const req: CheckRequest = { fieldId: 'f', version: 1, text: TEXT, blocks: splitParagraphs(TEXT), dirtyBlockHashes: 'all', pass: 'deep', host: 'x.com', context: 'email', fieldKind: 'textarea', protectedRanges: [] };

describe('anthropic provider: error mapping', () => {
  it('maps 401 to auth (not retryable)', () => {
    const e = mapAnthropicError(sdkError('AuthenticationError', 401));
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
  });

  it('maps a 400 about the key not being scoped to a workspace to auth with a fix-it message', () => {
    const e = mapAnthropicError(sdkError('BadRequestError', 400, { message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace."}}' }));
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/workspace/);
  });

  it('keeps other 400s as unknown', () => {
    expect(mapAnthropicError(sdkError('BadRequestError', 400, { message: 'max_tokens: too large' })).code).toBe('unknown');
  });

  it('maps 429 to rate-limit with retryAfterMs from the header (seconds and HTTP date)', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const e = mapAnthropicError(sdkError('RateLimitError', 429, { headers: new Headers({ 'retry-after': '7' }) }), now);
    expect(e.code).toBe('rate-limit');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(7000);
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    const plain = mapAnthropicError({ name: 'RateLimitError', status: 429, headers: { 'retry-after': '2' } }, now);
    expect(plain.retryAfterMs).toBe(2000);
  });

  it('maps an enforced spend limit body to spend-cap even on a 429', () => {
    const e = mapAnthropicError(sdkError('RateLimitError', 429, { error: { type: 'error', error: { type: 'rate_limit_error', error_code: 'enforced_spend_limit_reached' } } }));
    expect(e.code).toBe('spend-cap');
    expect(e.retryable).toBe(false);
  });

  it('maps aborts to cancelled and connection failures to network', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(mapAnthropicError(abort).code).toBe('cancelled');
    expect(mapAnthropicError(sdkError('APIUserAbortError')).code).toBe('cancelled');
    expect(mapAnthropicError(sdkError('APIConnectionError')).code).toBe('network');
    expect(mapAnthropicError(new TypeError('fetch failed')).code).toBe('network');
    expect(mapAnthropicError(sdkError('APIConnectionError')).retryable).toBe(true);
  });

  it('maps everything else to unknown and passes ProviderErrors through', () => {
    expect(mapAnthropicError(sdkError('InternalServerError', 500)).code).toBe('unknown');
    expect(mapAnthropicError(new Error('weird')).code).toBe('unknown');
    const pe = new ProviderError('refusal', 'x', false);
    expect(mapAnthropicError(pe)).toBe(pe);
  });
});

describe('anthropic provider: response handling', () => {
  it('turns refusal and max_tokens stop reasons into typed errors and never parses partial output', () => {
    expect(() => resultFromMessage(message({ stop_reason: 'refusal', content: [] }), 'm')).toThrow(/declined/);
    try {
      resultFromMessage(message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"blocks": [' }] }), 'm');
      expect.unreachable();
    } catch (e) {
      expect((e as ProviderError).code).toBe('truncated');
    }
    try {
      resultFromMessage(message({ content: [{ type: 'text', text: 'not json' }] }), 'm');
      expect.unreachable();
    } catch (e) {
      expect((e as ProviderError).code).toBe('invalid-response');
    }
  });

  it('maps usage including cache tokens and the cost of the answering model', () => {
    const r = resultFromMessage(message(), 'claude-opus-5-5');
    expect(r.model).toBe('claude-haiku-5-5'); // the response model wins (fallback-aware)
    expect(r.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 2000, cacheWriteTokens: 0 });
    // Haiku: 1000 * 0.1 + 200 * 0.5 + 2000 * 0.01 per million = 0.00022
    expect(r.usage.costUsd).toBeCloseTo(0.00022, 8);
  });
});

describe('anthropic provider: request shape', () => {
  it('sends cached system blocks, structured output, effort and thinking per model and pass', () => {
    const messages = buildCheckMessages(req, ['b0'], { voiceBlock: '<user_voice_profile>x</user_voice_profile>' });
    const fast = checkParams(messages, 'claude-haiku-5-5', 'fast');
    expect(fast.system).toHaveLength(2);
    expect(fast.system?.[0]).toMatchObject({ type: 'text', text: SUGGESTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } });
    expect(fast.system?.[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(fast.max_tokens).toBe(MAX_TOKENS_FAST);
    // A whole email in one call with a thorough suggestion list needs far more than the old 4,096.
    expect(MAX_TOKENS_FAST).toBeGreaterThanOrEqual(16000);
    expect(fast.output_config?.format?.type).toBe('json_schema');
    expect(fast.output_config?.effort).toBe('medium');
    expect(fast.thinking).toEqual({ type: 'disabled' });
    expect(fast.messages).toEqual([{ role: 'user', content: messages.user }]);

    const deep = checkParams(messages, 'claude-opus-5-5', 'deep');
    expect(deep.max_tokens).toBe(MAX_TOKENS_DEEP);
    expect(MAX_TOKENS_DEEP).toBeGreaterThanOrEqual(32000);
    expect(deep.output_config?.effort).toBe('medium');
    expect(deep.thinking).toEqual({ type: 'adaptive' });
    // Haiku on a deep pass still thinks adaptively (effort medium).
    expect(checkParams(messages, 'claude-haiku-5-5', 'deep').thinking).toEqual({ type: 'adaptive' });
    const tone = toneParams({ system: [], user: '<text>x</text>' }, 'claude-haiku-5-5');
    expect(tone.max_tokens).toBe(300);
    expect(tone.thinking).toEqual({ type: 'disabled' });
  });

  it('uses the beta client with the fallback beta only for opus', async () => {
    const client = fakeClient(() => message());
    const provider = createAnthropicProvider('sk-test', { clientFactory: () => client });
    const messages = buildCheckMessages(req, ['b0']);
    const input = { system: messages.system, user: messages.user, request: req, blockIds: ['b0'] };
    const controller = new AbortController();
    let streaming = 0;
    await provider.check(input, { model: 'claude-opus-5-5', pass: 'deep', signal: controller.signal, onFirstToken: () => streaming++ });
    await provider.check(input, { model: 'claude-haiku-5-5', pass: 'fast' });
    expect(client.streams).toHaveLength(2);
    expect(client.streams[0]!.beta).toBe(true);
    expect(client.streams[0]!.params).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(client.streams[0]!.signal).toBe(controller.signal);
    expect(client.streams[1]!.beta).toBe(false);
    expect('betas' in client.streams[1]!.params).toBe(false);
    expect(streaming).toBe(1);
    expect(usesFallbackBeta('claude-sonnet-5-5')).toBe(false);
  });

  it('propagates mapped errors from the stream', async () => {
    const client = fakeClient(() => sdkError('AuthenticationError', 401));
    const provider = createAnthropicProvider('sk-bad', { clientFactory: () => client });
    const messages = buildCheckMessages(req, ['b0']);
    await expect(provider.check({ system: messages.system, user: messages.user, request: req, blockIds: ['b0'] }, { model: 'claude-haiku-5-5', pass: 'fast' })).rejects.toMatchObject({ code: 'auth' });
  });

  it('testKey sends a 1-token haiku request and maps failures', async () => {
    const good = fakeClient(() => message());
    const provider = createAnthropicProvider('', { clientFactory: () => good });
    const ok = await provider.testKey!('sk-good');
    expect(ok).toMatchObject({ valid: true, model: 'claude-haiku-5-5' });
    expect(good.creates[0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1 });

    const bad = fakeClient(() => message(), () => sdkError('AuthenticationError', 401));
    const provider2 = createAnthropicProvider('', { clientFactory: () => bad });
    const r = await provider2.testKey!('sk-bad');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('auth');
    expect(await provider2.testKey!('   ')).toMatchObject({ valid: false, code: 'no-api-key' });
  });
});
