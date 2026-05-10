import { describe, expect, it, vi } from 'vitest';
import { type LlmCallInput, LlmClient, type LlmRawResponse } from './client.js';

describe('LlmClient', () => {
  it('delegates to the injected transport and accumulates usage', async () => {
    const fakeTransport = vi.fn(
      async (input: LlmCallInput): Promise<LlmRawResponse> => ({
        id: `msg_${input.model}`,
        model: input.model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const client = new LlmClient({ transport: fakeTransport });

    const r = await client.call({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(r.text).toBe('hello');
    expect(r.usage.input_tokens).toBe(100);
    expect(r.usage.output_tokens).toBe(50);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(client.totals().calls).toBe(1);
    expect(client.totals().cost_usd).toBeGreaterThan(0);
    expect(fakeTransport).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff on rate-limit errors', async () => {
    let calls = 0;
    const flaky = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => {
      calls++;
      if (calls < 3) {
        const e = new Error('rate limited') as Error & { status?: number };
        e.status = 429;
        throw e;
      }
      return {
        id: 'ok',
        model: input.model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'finally' }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
    });
    const client = new LlmClient({ transport: flaky, retry_initial_ms: 1, max_retries: 5 });
    const r = await client.call({
      model: 'claude-sonnet-4-6',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(r.text).toBe('finally');
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 400 errors', async () => {
    const bad = vi.fn(async (): Promise<LlmRawResponse> => {
      const e = new Error('bad request') as Error & { status?: number };
      e.status = 400;
      throw e;
    });
    const client = new LlmClient({ transport: bad, max_retries: 5 });
    await expect(
      client.call({
        model: 'claude-sonnet-4-6',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
