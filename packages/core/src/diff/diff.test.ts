import { describe, expect, it } from 'vitest';
import type { JudgeFinding } from '../judge/judge.js';
import type { ReportJson } from '../report/report-json.js';
import { computeDiff, normalizeTargetUrl } from './diff.js';

const finding = (overrides: Partial<JudgeFinding> & { hash: string }): JudgeFinding => ({
  id: overrides.id ?? 'F-1',
  title: overrides.title ?? 't',
  category: overrides.category ?? 'bug',
  severity: overrides.severity ?? 'minor',
  evidence: overrides.evidence ?? [],
  rationale: overrides.rationale ?? 'r',
  finding_hash: overrides.hash,
});

function mkReport(overrides: Partial<ReportJson> & { findings?: JudgeFinding[] }): ReportJson {
  const findings = overrides.findings ?? [];
  return {
    v: 2,
    _written_at: '2026-05-10T00:00:00Z',
    tool: { name: 'iris', version: '0.0.0' },
    run: {
      id: 'r1',
      target: { kind: 'web', url: 'https://x.com' },
      mode: 'free',
      started_at: '',
      ended_at: '',
      duration_s: 0,
      cost_usd: 0,
      models: { explorer: 'x', judge: 'x' },
      termination: 'done',
      step_count: 0,
    },
    headline: {
      score: 5.0,
      threshold_passed: true,
      blockers: 0,
      majors: 0,
      minors: findings.length,
      nits: 0,
      suggestions: 0,
    },
    scores: { overall: { score: 5.0, weighted_from: [] }, profiles: {} },
    spec_compliance: { applicable: false, goals: [], summary: '' },
    findings,
    coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: '' },
    meta: { confidence_overall: 0, confidence_caveats: [], would_re_explore_with: [] },
    next_actions: { for_builder: [], for_re_evaluation: [] },
    ...overrides,
  };
}

describe('computeDiff', () => {
  it('classifies findings as fixed / new / persistent by finding_hash', () => {
    const prev = mkReport({
      findings: [
        finding({ hash: 'h1', id: 'F-1', title: 'A' }),
        finding({ hash: 'h2', id: 'F-2', title: 'B' }),
      ],
    });
    const curr = mkReport({
      findings: [
        finding({ hash: 'h2', id: 'F-2', title: 'B' }),
        finding({ hash: 'h3', id: 'F-3', title: 'C' }),
      ],
    });
    const d = computeDiff(prev, curr);
    expect(d.findings.fixed.map((f) => f.finding_hash)).toEqual(['h1']);
    expect(d.findings.new.map((f) => f.finding_hash)).toEqual(['h3']);
    expect(d.findings.persistent.map((f) => f.finding_hash)).toEqual(['h2']);
  });

  it('computes score deltas overall and by profile', () => {
    const prev = mkReport({
      headline: {
        score: 5.0,
        threshold_passed: true,
        blockers: 0,
        majors: 0,
        minors: 0,
        nits: 0,
        suggestions: 0,
      },
      scores: {
        overall: { score: 5.0, weighted_from: ['ux', 'a11y'] },
        profiles: {
          ux: { score: 4.0, dimensions: {} },
          a11y: { score: 6.0, dimensions: {} },
        },
      },
    });
    const curr = mkReport({
      headline: {
        score: 7.0,
        threshold_passed: true,
        blockers: 0,
        majors: 0,
        minors: 0,
        nits: 0,
        suggestions: 0,
      },
      scores: {
        overall: { score: 7.0, weighted_from: ['ux', 'a11y'] },
        profiles: {
          ux: { score: 6.0, dimensions: {} },
          a11y: { score: 8.0, dimensions: {} },
        },
      },
    });
    const d = computeDiff(prev, curr);
    expect(d.score_delta.overall).toBe(2.0);
    expect(d.score_delta.by_profile).toEqual({ ux: 2.0, a11y: 2.0 });
  });

  it('reports newly tested + verification changes in coverage_delta', () => {
    const prev = mkReport({
      spec_compliance: {
        applicable: true,
        goals: [
          { id: 'G1', description: 'a', status: 'verified', evidence: [] },
          { id: 'G2', description: 'b', status: 'untested', evidence: [] },
          { id: 'G3', description: 'c', status: 'partial', evidence: [] },
        ],
        summary: '',
      },
    });
    const curr = mkReport({
      spec_compliance: {
        applicable: true,
        goals: [
          { id: 'G1', description: 'a', status: 'verified', evidence: [] },
          { id: 'G2', description: 'b', status: 'verified', evidence: [] },
          { id: 'G3', description: 'c', status: 'verified', evidence: [] },
        ],
        summary: '',
      },
    });
    const d = computeDiff(prev, curr);
    expect(d.coverage_delta.newly_tested_goals).toEqual(['G2']);
    expect(d.coverage_delta.verification_changes).toEqual([
      { id: 'G3', prev: 'partial', curr: 'verified' },
    ]);
  });

  it('reports no_longer_tested when coverage shrinks', () => {
    const prev = mkReport({
      spec_compliance: {
        applicable: true,
        goals: [{ id: 'G1', description: 'a', status: 'verified', evidence: [] }],
        summary: '',
      },
    });
    const curr = mkReport({
      spec_compliance: {
        applicable: true,
        goals: [{ id: 'G1', description: 'a', status: 'untested', evidence: [] }],
        summary: '',
      },
    });
    const d = computeDiff(prev, curr);
    expect(d.coverage_delta.no_longer_tested).toEqual(['G1']);
  });

  it('handles legacy v1 reports without finding_hash by computing on the fly', () => {
    const prev = mkReport({
      findings: [
        // No finding_hash set
        {
          id: 'F-1',
          title: 'Same finding',
          category: 'bug',
          severity: 'minor',
          evidence: ['E1'],
          rationale: '',
        },
      ],
    });
    const curr = mkReport({
      findings: [
        {
          id: 'F-1-new-id',
          title: 'Same finding',
          category: 'bug',
          severity: 'minor',
          evidence: ['E1'],
          rationale: '',
        },
      ],
    });
    const d = computeDiff(prev, curr);
    expect(d.findings.persistent).toHaveLength(1);
    expect(d.findings.new).toHaveLength(0);
    expect(d.findings.fixed).toHaveLength(0);
  });
});

describe('normalizeTargetUrl', () => {
  it('strips trailing slash and query', () => {
    expect(normalizeTargetUrl('https://x.com/foo/')).toBe('x.com/foo');
    expect(normalizeTargetUrl('https://x.com/foo?a=1')).toBe('x.com/foo');
  });
});
