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
});
