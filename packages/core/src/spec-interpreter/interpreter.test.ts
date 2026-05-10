import { describe, expect, it, vi } from 'vitest';
import { type LlmCallInput, LlmClient, type LlmRawResponse } from '../llm/client.js';
import { InterpretedSpecSchema, interpretSpec } from './interpreter.js';

function fakeResponse(text: string): LlmRawResponse {
  return {
    id: 'msg_x',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

describe('interpretSpec', () => {
  it('parses a well-formed JSON response from the model', async () => {
    const transport = vi.fn(
      async (_input: LlmCallInput): Promise<LlmRawResponse> =>
        fakeResponse(
          JSON.stringify({
            v: 1,
            target_kind_hint: 'web',
            goals: [
              { id: 'G1', description: 'User can sign in with email', priority: 'must' },
              { id: 'G2', description: 'User can recover password', priority: 'should' },
            ],
            focus_areas: ['authentication'],
            hints: ['app uses email-based login'],
            out_of_scope: ['admin dashboard'],
          }),
        ),
    );
    const client = new LlmClient({ transport });
    const r = await interpretSpec('Users should be able to sign in.', client);
    expect(r.target_kind_hint).toBe('web');
    expect(r.goals).toHaveLength(2);
    expect(r.goals[0]?.id).toBe('G1');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('extracts JSON from a response wrapped in code fences', async () => {
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeResponse(
          `\`\`\`json\n${JSON.stringify({
            v: 1,
            target_kind_hint: 'web',
            goals: [{ id: 'G1', description: 'works', priority: 'must' }],
            focus_areas: [],
            hints: [],
            out_of_scope: [],
          })}\n\`\`\``,
        ),
    );
    const client = new LlmClient({ transport });
    const r = await interpretSpec('test', client);
    expect(r.goals[0]?.description).toBe('works');
  });

  it('throws on unparseable response', async () => {
    const transport = vi.fn(async (): Promise<LlmRawResponse> => fakeResponse('no json here'));
    const client = new LlmClient({ transport });
    await expect(interpretSpec('test', client)).rejects.toThrow(/no JSON/i);
  });

  it('rejects schema-invalid response', async () => {
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeResponse(JSON.stringify({ v: 99, target_kind_hint: 'mars', goals: [] })),
    );
    const client = new LlmClient({ transport });
    await expect(interpretSpec('test', client)).rejects.toThrow();
  });

  it('InterpretedSpecSchema is exported', () => {
    expect(InterpretedSpecSchema).toBeDefined();
  });
});
