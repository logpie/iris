import { describe, expect, it } from 'vitest';
import { runDiscovery } from './discovery.js';

describe('runDiscovery', () => {
  it('parses a well-formed discoverer response', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: 'Example Domain',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({
          v: 1,
          target_kind_hint: 'web',
          product_description: 'Placeholder example page.',
          goals: [
            { id: 'G1', description: 'Read the description', priority: 'must' },
            { id: 'G2', description: 'Click the More info link', priority: 'should' },
          ],
          focus_areas: [],
          hints: [],
          out_of_scope: [],
        }),
        cost_usd: 0.05,
      }),
    });
    expect(result).not.toBeNull();
    expect(result?.output.goals).toHaveLength(2);
    expect(result?.cost_usd).toBeCloseTo(0.05);
  });

  it('returns null on unparseable response (caller falls back to free mode)', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: '...',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({ text: 'sorry, I cannot help with that', cost_usd: 0 }),
    });
    expect(result).toBeNull();
  });

  it('returns null on schema mismatch (missing required goal fields)', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: '...',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: JSON.stringify({ v: 1, goals: [{ id: 'G1' }] }),
        cost_usd: 0,
      }),
    });
    expect(result).toBeNull();
  });

  it('strips a leading prose preamble before the JSON object', async () => {
    const result = await runDiscovery({
      url: 'https://example.com',
      observation_summary: '...',
      screenshot_path: '/tmp/x.png',
      discoverer: async () => ({
        text: `Here is my analysis. {\n  "v": 1,\n  "target_kind_hint": "web",\n  "product_description": "x",\n  "goals": [{"id":"G1","description":"y","priority":"must"}],\n  "focus_areas": [],\n  "hints": [],\n  "out_of_scope": []\n}`,
        cost_usd: 0,
      }),
    });
    expect(result).not.toBeNull();
    expect(result?.output.goals[0]?.id).toBe('G1');
  });
});
