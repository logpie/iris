import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportHtml } from './report-html.js';
import { buildReportJson } from './report-json.js';

describe('buildReportHtml', () => {
  it('produces well-formed HTML with the score in the headline', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    const html = buildReportHtml(r);
    expect(html).toMatch(/<!doctype html>/i);
    // Score is rendered as "6.5" in the hero (one decimal)
    expect(html).toContain('6.5');
    // Failure styling: rose color band on hero when threshold not passed
    expect(html).toMatch(/border-rose-200|bg-rose-100/);
    // Iris brand mark
    expect(html).toContain('Iris');
  });

  it('escapes HTML in titles and rationale', () => {
    const j = fakeJudge();
    j.findings[0]!.title = '<script>alert("x")</script>';
    const r = buildReportJson({ judge: j, run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders findings with severity badges (icons and category labels)', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    // Each finding has a severity pill and a category pill
    expect(html).toMatch(/blocker/);
    expect(html).toMatch(/nit/);
    // Category icons render in the cards
    expect(html).toContain('🐛'); // bug
  });

  it('renders profile score bars with dimensions', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toContain('quality');
    expect(html).toContain('usability');
    // Profile name is capitalized + has " dimensions"
    expect(html).toMatch(/dimensions/);
  });

  it('renders spec compliance with per-goal status pills', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toMatch(/Spec compliance/);
    // Goal IDs from fakeJudge
    expect(html).toContain('G1');
    expect(html).toContain('G2');
  });

  it('renders the next_actions for_builder list', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const html = buildReportHtml(r);
    expect(html).toMatch(/Next actions/);
    expect(html).toMatch(/builder/i);
  });
});
