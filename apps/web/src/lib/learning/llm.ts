/**
 * A thin, test-friendly adapter over the Anthropic SDK: one `create()` call with the structured-output
 * options the learning job needs. Tests pass a fake implementing {@link LlmClient}.
 */
import type { JsonSchema } from '@jammarly/shared/prompts';

export interface LlmRequest {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  outputSchema?: JsonSchema;
  effort?: 'low' | 'medium' | 'high';
  /** Haiku classifier calls run without thinking. */
  thinkingDisabled?: boolean;
}

export interface LlmResult {
  stopReason: string | null;
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  create(req: LlmRequest): Promise<LlmResult>;
}

export const MIN_LLM_TIMEOUT_MS = 5_000;

/** SDK-backed client: `maxRetries: 0` and a timeout derived from the function deadline (research 07 §7.1). */
export function createAnthropicLlm(apiKey: string, timeoutMs: number): LlmClient {
  const timeout = Math.max(MIN_LLM_TIMEOUT_MS, Math.floor(timeoutMs));
  let clientPromise: Promise<import('@anthropic-ai/sdk').default> | null = null;
  const client = (): Promise<import('@anthropic-ai/sdk').default> => {
    if (clientPromise === null) {
      clientPromise = import('@anthropic-ai/sdk').then((m) => new m.default({ apiKey, maxRetries: 0, timeout }));
    }
    return clientPromise;
  };
  return {
    async create(req: LlmRequest): Promise<LlmResult> {
      const anthropic = await client();
      const message = await anthropic.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        ...(req.thinkingDisabled === true ? { thinking: { type: 'disabled' as const } } : {}),
        output_config: {
          ...(req.outputSchema !== undefined ? { format: { type: 'json_schema' as const, schema: req.outputSchema as Record<string, unknown> } } : {}),
          ...(req.effort !== undefined ? { effort: req.effort } : {}),
        },
      });
      const text = message.content
        .filter((b): b is { type: 'text'; text: string } & typeof b => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        stopReason: message.stop_reason,
        text,
        model: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    },
  };
}
