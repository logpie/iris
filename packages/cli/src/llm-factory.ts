import Anthropic from '@anthropic-ai/sdk';
import { llm } from '@iris/core';

export interface BuildClientOptions {
  api_key?: string;
}

export function buildLlmClient(opts: BuildClientOptions = {}): llm.LlmClient {
  const apiKey = opts.api_key ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No ANTHROPIC_API_KEY in env. Set it to a valid key, or use cassettes for testing.',
    );
  }
  const sdk = new Anthropic({ apiKey });
  const transport: llm.LlmTransport = async (input) => {
    const systemStr = typeof input.system === 'string' ? input.system : undefined;
    const r = await sdk.messages.create({
      model: input.model,
      ...(systemStr !== undefined ? { system: systemStr } : {}),
      messages: input.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : (m.content as unknown as Array<{ type: string; [k: string]: unknown }>),
        // biome-ignore lint/suspicious/noExplicitAny: cast required for SDK overload compatibility
      })) as any,
      ...(input.tools
        ? {
            tools: input.tools as Array<{
              name: string;
              description?: string;
              input_schema: object;
            }>,
          }
        : {}),
      max_tokens: input.max_tokens ?? 4096,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: SDK overload resolution needs full-object cast
    } as any);
    return {
      id: r.id,
      model: r.model,
      stop_reason: r.stop_reason ?? 'end_turn',
      content: r.content as unknown as Array<Record<string, unknown>>,
      usage: {
        input_tokens: r.usage.input_tokens,
        output_tokens: r.usage.output_tokens,
        cache_creation_input_tokens:
          (r.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens:
          (r.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
      },
    };
  };
  return new llm.LlmClient({ transport });
}
