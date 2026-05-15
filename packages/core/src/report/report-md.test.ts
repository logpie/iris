import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportJson } from './report-json.js';
import { buildReportMd } from './report-md.js';

describe('buildReportMd', () => {
  it('produces a markdown header with score and pass/fail', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    const md = buildReportMd(r);
    expect(md).toMatch(/# Iris run — 6\.5/);
    expect(md).toMatch(/❌/);
  });

  it('lists spec compliance goals when applicable', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/Spec compliance/);
    expect(md).toMatch(/G1: sign in/);
    expect(md).toMatch(/G2: export/);
  });

  it('counts verified goals as passing', () => {
    const judge = fakeJudge();
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'load article', status: 'verified', evidence: ['T2'] },
    ];
    const r = buildReportJson({ judge, run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/Spec compliance — 1 \/ 1/);
    expect(md).toMatch(/✅ G1: load article/);
  });

  it('renders optional provider token usage', () => {
    const r = buildReportJson({
      judge: fakeJudge(),
      run: {
        ...fakeRun(),
        usage: {
          total: {
            input_tokens: 402084,
            cached_input_tokens: 361216,
            non_cached_input_tokens: 40868,
            output_tokens: 909,
          },
        },
      },
    });
    const md = buildReportMd(r);
    expect(md).toMatch(/Tokens:.*402,084/);
    expect(md).toMatch(/non-cached 40,868/);
  });

  it('lists top blocker/major findings', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/Top findings/);
    expect(md).toMatch(/F-001.*Login fails/);
  });

  it('renders scores as a markdown table', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/\| Profile \| Score \|/);
    expect(md).toMatch(/\| quality \| 7/);
  });

  it('renders rubric dimensions as a score matrix', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/\| Profile \| Dimension \| Score \| Rationale \|/);
    expect(md).toContain('| quality | correctness | 7 | r |');
    expect(md).toContain('| usability | clarity | 6 | r |');
  });

  it('surfaces weighted profiles omitted from profile scores', () => {
    const judge = fakeJudge();
    judge.scores.overall.weighted_from.push('frontend_correctness');
    const r = buildReportJson({ judge, run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toContain('| frontend_correctness | missing |');
    expect(md).toContain(
      '| frontend_correctness | (profile) | missing | Listed in weighted_from but absent from scores.profiles. |',
    );
  });
});
