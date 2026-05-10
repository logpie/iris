import { describe, expect, it } from 'vitest';
import { type Mode, ModeSchema, type RunConfig, RunConfigSchema } from './types.js';

describe('core types', () => {
  it('ModeSchema accepts the three valid modes', () => {
    const modes: Mode[] = ['free', 'grounded', 'targeted'];
    for (const m of modes) {
      expect(ModeSchema.parse(m)).toBe(m);
    }
  });

  it('ModeSchema rejects unknown modes', () => {
    expect(() => ModeSchema.parse('explore')).toThrow();
  });

  it('RunConfigSchema validates a complete eval config', () => {
    const cfg: RunConfig = {
      verb: 'eval',
      target: { kind: 'web', value: 'https://example.com' },
      mode: 'free',
      out_dir: './iris-runs/test',
      max_steps: 60,
      max_cost_usd: 5,
      timeout_s: 600,
      explorer_model: 'claude-sonnet-4-6',
      judge_model: 'claude-opus-4-7',
      engine: 'hybrid',
      no_html: false,
      no_clips: false,
      print_summary: false,
      verbose: false,
      json_logs: false,
    };
    expect(RunConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it('RunConfigSchema rejects negative budgets', () => {
    expect(() =>
      RunConfigSchema.parse({
        verb: 'eval',
        target: { kind: 'web', value: 'https://example.com' },
        mode: 'free',
        out_dir: '/tmp/x',
        max_steps: -1,
        max_cost_usd: 5,
        timeout_s: 600,
        explorer_model: 'claude-sonnet-4-6',
        judge_model: 'claude-opus-4-7',
        engine: 'hybrid',
        no_html: false,
        no_clips: false,
        print_summary: false,
        verbose: false,
        json_logs: false,
      }),
    ).toThrow();
  });
});
