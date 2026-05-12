import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportJson } from './report-json.js';

describe('buildReportJson', () => {
  it('produces a v:2 report with headline counts', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    expect(r.v).toBe(2);
    expect(r.headline.blockers).toBe(1);
    expect(r.headline.nits).toBe(1);
    expect(r.headline.score).toBe(6.5);
    expect(r.headline.threshold_passed).toBe(false);
  });

  it('threshold_passed remains false when score >= threshold but blocker present (Phase 12)', () => {
    // The fake has 1 blocker — even with score ≥ threshold, threshold_passed
    // is now false because the new gate requires zero blockers.
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 6.0 });
    expect(r.headline.threshold_passed).toBe(false);
  });

  it('threshold omitted means threshold_passed=true when no blocker (Phase 12)', () => {
    const clean = fakeJudge();
    clean.findings = clean.findings.filter((f) => f.severity !== 'blocker');
    const r = buildReportJson({ judge: clean, run: fakeRun() });
    expect(r.headline.threshold_passed).toBe(true);
  });

  it('threshold_passed false when coverage < 50% (Phase 12)', () => {
    const judge = fakeJudge();
    judge.findings = []; // remove blocker so only coverage matters
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'a', status: 'verified', evidence: ['T2'] },
      { id: 'G2', description: 'b', status: 'untested', evidence: [] },
      { id: 'G3', description: 'c', status: 'untested', evidence: [] },
      { id: 'G4', description: 'd', status: 'untested', evidence: [] },
    ];
    // 1/4 = 25% attempted — below the 50% floor.
    const r = buildReportJson({ judge, run: fakeRun(), threshold: 5.0 });
    expect(r.headline.threshold_passed).toBe(false);
  });

  it('threshold_passed true when coverage ≥ 50% and no blockers (Phase 12)', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'a', status: 'verified', evidence: ['T2'] },
      { id: 'G2', description: 'b', status: 'partial', evidence: ['T3'] },
      { id: 'G3', description: 'c', status: 'untested', evidence: [] },
      { id: 'G4', description: 'd', status: 'untested', evidence: [] },
    ];
    // 2/4 = 50% — exactly at the floor.
    const r = buildReportJson({ judge, run: fakeRun(), threshold: 5.0 });
    expect(r.headline.threshold_passed).toBe(true);
  });

  it('next_actions.for_builder is sorted by severity', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    expect(r.next_actions.for_builder[0]?.finding_id).toBe('F-001');
    expect(r.next_actions.for_builder[0]?.fix_priority).toBe(1);
  });

  it('forwards re_evaluation suggestions from meta', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    expect(r.next_actions.for_re_evaluation).toContain('--persona keyboard_only');
  });
});
