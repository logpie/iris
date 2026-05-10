import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportHtml } from './report-html.js';
import { buildReportJson } from './report-json.js';

describe('buildReportHtml', () => {
  it('produces well-formed HTML with the score in the headline', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    const html = buildReportHtml(r);
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain('6.5');
    expect(html).toContain('headline fail');
  });

  it('escapes HTML in titles and rationale', () => {
    const j = fakeJudge();
    j.findings[0]!.title = '<script>alert("x")</script>';
    const r = buildReportJson({ judge: j, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders findings with severity-specific classes', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toMatch(/sev-blocker/);
    expect(html).toMatch(/sev-nit/);
  });

  it('renders profile scores', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('quality');
    expect(html).toContain('usability');
  });
});
