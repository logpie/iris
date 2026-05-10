import { describe, expect, it } from 'vitest';
import { buildSummaryLine, type SummaryInput } from './summary.js';

describe('buildSummaryLine', () => {
  it('produces a single-line valid JSON terminated by newline', () => {
    const inp: SummaryInput = {
      score: 7.4,
      threshold_passed: true,
      findings: { blocker: 1, major: 4, minor: 12, nit: 3, suggestion: 15 },
      run_dir: './iris-runs/x',
      duration_s: 412,
      cost_usd: 1.84,
      caveats: 3,
    };
    const line = buildSummaryLine(inp);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n').filter((s) => s.length > 0)).toHaveLength(1);

    const parsed = JSON.parse(line.trim()) as SummaryInput & { v: number };
    expect(parsed.v).toBe(1);
    expect(parsed.score).toBe(7.4);
    expect(parsed.threshold_passed).toBe(true);
    expect(parsed.findings.blocker).toBe(1);
  });

  it('rounds score and cost to 2 decimals', () => {
    const line = buildSummaryLine({
      score: 7.4444,
      threshold_passed: false,
      findings: { blocker: 0, major: 0, minor: 0, nit: 0, suggestion: 0 },
      run_dir: '/x',
      duration_s: 10,
      cost_usd: 1.84321,
      caveats: 0,
    });
    const parsed = JSON.parse(line.trim()) as { score: number; cost_usd: number };
    expect(parsed.score).toBe(7.44);
    expect(parsed.cost_usd).toBe(1.84);
  });
});
