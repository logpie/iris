import { describe, expect, it } from 'vitest';
import { buildLlmClient } from './llm-factory.js';

describe('buildLlmClient', () => {
  it('throws when no API key in env or opts', () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    // biome-ignore lint/performance/noDelete: must actually remove the key from env, not set to undefined
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => buildLlmClient()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('builds a client when api_key is supplied', () => {
    const client = buildLlmClient({ api_key: 'sk-ant-test' });
    expect(client).toBeDefined();
    expect(client.totals().calls).toBe(0);
  });
});
