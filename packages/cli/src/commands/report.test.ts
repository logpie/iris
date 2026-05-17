import { describe, expect, it } from 'vitest';
import { findingsSnapshotFromReport, normalizeRevalidatedRunMetadata } from './report.js';

function fakeRun(termination: string) {
  return {
    id: 'run-1',
    target: { kind: 'web', url: 'https://example.com' },
    mode: 'grounded',
    started_at: '2026-05-16T00:00:00.000Z',
    ended_at: '2026-05-16T00:01:00.000Z',
    duration_s: 60,
    cost_usd: 0,
    models: { discovery: 'gpt-5.4', explorer: 'gpt-5.4', judge: 'gpt-5.4' },
    reasoning_efforts: { discovery: 'medium', explorer: 'medium', judge: 'medium' },
    termination,
    step_count: 12,
  };
}

function runEnd(termination: string) {
  return {
    v: 1,
    id: 'evt-run-end',
    ts: 1,
    target_kind: 'web',
    kind: 'run_end',
    actor: 'system',
    payload: { termination },
  };
}

describe('normalizeRevalidatedRunMetadata', () => {
  it('clears stale judge_failed termination after successful revalidation', () => {
    const run = normalizeRevalidatedRunMetadata(
      fakeRun('judge_failed'),
      [runEnd('done')] as never,
      '/tmp/no-run-config',
      false,
    );

    expect(run.termination).toBe('done');
  });

  it('keeps real blocked judge failures blocked', () => {
    const run = normalizeRevalidatedRunMetadata(
      fakeRun('judge_failed'),
      [runEnd('done')] as never,
      '/tmp/no-run-config',
      true,
    );

    expect(run.termination).toBe('judge_failed');
  });

  it('uses the trace run termination when exploration hit a real budget', () => {
    const run = normalizeRevalidatedRunMetadata(
      fakeRun('judge_failed'),
      [runEnd('budget_steps')] as never,
      '/tmp/no-run-config',
      false,
    );

    expect(run.termination).toBe('budget_steps');
  });

  it('does not fabricate done when a judge_failed report has no trace termination', () => {
    const run = normalizeRevalidatedRunMetadata(
      fakeRun('judge_failed'),
      [] as never,
      '/tmp/no-run-config',
      false,
    );

    expect(run.termination).toBe('judge_failed');
  });
});

describe('findingsSnapshotFromReport', () => {
  it('keeps findings.json consistent with a revalidated report', () => {
    const snapshot = findingsSnapshotFromReport({
      headline: {
        score: 8,
        threshold_passed: true,
        blockers: 0,
        majors: 0,
        minors: 0,
        nits: 0,
        suggestions: 0,
        goals_attempted: 1,
        goals_verified: 1,
        goals_total: 1,
      },
      tool: { name: 'iris', version: '0.0.0' },
      run: fakeRun('done'),
      scores: { overall: { score: 8, weighted_from: [] }, profiles: {} },
      findings: [],
      discarded_findings: [
        { tentative_event_id: 'F-001', reason: 'tool_friction_without_user_visible_impact' },
      ],
      evidence_validation: { verified: 0, downgraded: 0, discarded: 1 },
      spec_compliance: {
        applicable: true,
        goals: [],
        summary: 'No findings after revalidation.',
      },
      coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
      artifacts: {},
      next_actions: { for_builder: [] },
    } as never);

    expect(snapshot.findings).toEqual([]);
    expect(snapshot.discarded_findings).toEqual([
      { tentative_event_id: 'F-001', reason: 'tool_friction_without_user_visible_impact' },
    ]);
    expect(snapshot.evidence_validation).toEqual({ verified: 0, downgraded: 0, discarded: 1 });
    expect(snapshot._written_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
