import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportHtml } from './report-html.js';
import { buildReportJson } from './report-json.js';

describe('buildReportHtml', () => {
  it('produces well-formed HTML with the score in the TL;DR', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    const html = buildReportHtml(r);
    expect(html).toMatch(/<!doctype html>/i);
    // Score rendered as "6.5 / 10" in TL;DR
    expect(html).toContain('6.5');
    // No Tailwind CDN reference (we use hand-crafted CSS)
    expect(html).not.toContain('cdn.tailwindcss');
  });

  it('escapes HTML in titles and rationale', () => {
    const j = fakeJudge();
    const first = j.findings[0];
    if (!first) throw new Error('fake judge has no findings');
    first.title = '<script>alert("x")</script>';
    const r = buildReportJson({ judge: j, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders findings with severity prefixes and category tags', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    // Severity tags appear inline (not in emoji form)
    expect(html).toMatch(/sev-tag sev-blocker/);
    expect(html).toMatch(/sev-tag sev-nit/);
    // No category emoji icons (we dropped them)
    expect(html).not.toContain('🐛');
  });

  it('renders rubric breakdown collapsed by default', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('quality');
    expect(html).toContain('usability');
    // Rubric section is a <details> (collapsed by default)
    expect(html).toMatch(/<details class="rubric-section"/);
  });

  it('renders spec compliance as "What got tested" with plain-English status labels', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toMatch(/What got tested/);
    expect(html).toContain('G1');
    expect(html).toContain('G2');
    // Plain-English status labels: "works", "partial", "broken", "untested"
    expect(html).toMatch(/works|partial|broken|untested/);
  });

  it('renders a TL;DR section summarizing the run', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toMatch(/class="tldr/);
    // TL;DR mentions verified count or findings count
    expect(html).toMatch(/Iris verified|Iris partially verified|Iris was unable/);
  });
});
