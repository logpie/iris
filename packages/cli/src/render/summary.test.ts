import { describe, expect, it } from 'vitest';
import { type SummaryInput, buildSummaryLine } from './summary.js';

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
    expect(parsed.v).toBe(3);
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

  it('separates scenario evidence from finding-draft evidence', () => {
    const line = buildSummaryLine({
      score: 8.7,
      threshold_passed: true,
      findings: { blocker: 0, major: 0, minor: 0, nit: 0, suggestion: 0 },
      run_dir: '/x',
      duration_s: 10,
      cost_usd: 0,
      caveats: 0,
      goals_attempted: 7,
      goals_verified: 7,
      goals_total: 7,
      scenario_evidence_verified: 7,
      finding_evidence_verified: 0,
      unsupported_finding_drafts_discarded: 1,
    });
    const parsed = JSON.parse(line.trim()) as {
      scenario_evidence: { verified: number; downgraded: number };
      finding_evidence: {
        verified: number;
        downgraded: number;
        unsupported_drafts_discarded: number;
      };
      evidence?: unknown;
    };
    expect(parsed.scenario_evidence).toEqual({ verified: 7, downgraded: 0 });
    expect(parsed.finding_evidence).toEqual({
      verified: 0,
      downgraded: 0,
      unsupported_drafts_discarded: 1,
    });
    expect(parsed.evidence).toBeUndefined();
  });
});
