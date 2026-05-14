import { describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: '<dynamic-boundary>',
  createSdkMcpServer: vi.fn(),
  query: queryMock,
  tool: vi.fn(),
}));

import { runAgentSdkSingleShot } from './agent-sdk-runner.js';

function sdkQueryResult(): AsyncGenerator<unknown> {
  return (async function* () {
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '{"ok":true}' }] },
    };
    yield {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      usage: { input_tokens: 12, output_tokens: 4 },
    };
  })();
}

describe('runAgentSdkSingleShot', () => {
  it('does not forward maxTokens as taskBudget', async () => {
    queryMock.mockReturnValueOnce(sdkQueryResult());

    const result = await runAgentSdkSingleShot({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'claude-opus-4-6',
      maxTokens: 8000,
      timeoutS: 1,
    });

    expect(result.text).toBe('{"ok":true}');
    const queryArg = queryMock.mock.calls[0]?.[0] as
      | { options?: Record<string, unknown> }
      | undefined;
    expect(queryArg?.options).not.toHaveProperty('taskBudget');
  });
});
