import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportJson } from './report-json.js';

describe('buildReportJson', () => {
  it('produces a v:1 report with headline counts', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    expect(r.v).toBe(1);
    expect(r.headline.blockers).toBe(1);
    expect(r.headline.nits).toBe(1);
    expect(r.headline.score).toBe(6.5);
    expect(r.headline.threshold_passed).toBe(false);
  });

  it('threshold_passed true when score >= threshold', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 6.0 });
    expect(r.headline.threshold_passed).toBe(true);
  });

  it('threshold omitted means threshold_passed=true', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
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
