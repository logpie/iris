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

  it('threshold omitted means threshold_passed=true when no blocker or major findings (Phase 12)', () => {
    const clean = fakeJudge();
    clean.findings = clean.findings.filter(
      (f) => f.severity !== 'blocker' && f.severity !== 'major',
    );
    const r = buildReportJson({ judge: clean, run: fakeRun() });
    expect(r.headline.threshold_passed).toBe(true);
  });

  it('threshold_passed false when major findings are present', () => {
    const judge = fakeJudge();
    judge.findings = [
      {
        id: 'F-major',
        title: 'Major product issue',
        category: 'bug',
        severity: 'major',
        evidence: ['T2'],
        rationale: 'A major issue should block the pass verdict.',
      },
    ];
    const r = buildReportJson({ judge, run: fakeRun(), threshold: 1.0 });
    expect(r.headline.threshold_passed).toBe(false);
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

  it('threshold_passed false when report is blocked', () => {
    const judge = fakeJudge();
    judge.findings = [];
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      blocked: { reasons: ['judge failed'] },
    });
    expect(r.headline.blocked).toBe(true);
    expect(r.headline.threshold_passed).toBe(false);
  });

  it('normalizes accidental 0-100 Judge scores to the 0-10 report scale', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.scores.overall.score = 91;
    const profile = judge.scores.profiles.quality!;
    profile.score = 88;
    profile.dimensions.correctness!.score = 100;
    const r = buildReportJson({ judge, run: fakeRun(), threshold: 9 });
    expect(r.headline.score).toBe(9.1);
    expect(r.scores.overall.score).toBe(9.1);
    expect(r.scores.profiles.quality!.score).toBe(8.8);
    expect(r.scores.profiles.quality!.dimensions.correctness!.score).toBe(10);
    expect(r.headline.threshold_passed).toBe(true);
  });

  it('preserves optional provider token usage in run metadata', () => {
    const run = {
      ...fakeRun(),
      usage: {
        total: {
          input_tokens: 100,
          cached_input_tokens: 60,
          non_cached_input_tokens: 40,
          output_tokens: 5,
        },
        last: {
          input_tokens: 30,
          cached_input_tokens: 20,
          non_cached_input_tokens: 10,
          output_tokens: 2,
        },
      },
    };
    const r = buildReportJson({ judge: fakeJudge(), run });
    expect(r.run.usage?.total?.input_tokens).toBe(100);
    expect(r.run.usage?.total?.non_cached_input_tokens).toBe(40);
    expect(r.run.usage?.last?.cached_input_tokens).toBe(20);
  });

  it('extracts Discovery surface graph metadata from trace events', () => {
    const r = buildReportJson({
      judge: fakeJudge(),
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'DISCOVERY_1',
          ts: 1,
          step: 0,
          target_kind: 'web',
          kind: 'discovery',
          actor: 'system',
          payload: {
            product_description: 'A searchable content product.',
            goals: [{ id: 'G1', description: 'Search content', priority: 'must', journey_id: 'J1', surface_ids: ['S1'] }],
            surfaces: [
              {
                id: 'S1',
                label: 'Search',
                kind: 'search',
                url: 'https://example.com',
                source: 'initial',
                value: 'core',
                confidence: 0.9,
                evidence: [],
              },
            ],
            journeys: [
              {
                id: 'J1',
                title: 'Search content',
                priority: 'must',
                surface_ids: ['S1'],
                user_intent: 'Find content',
                suggested_goal: 'Search content',
                expected_evidence: [],
                risk: 'high',
              },
            ],
            coverage_plan: {
              selected_journey_ids: ['J1'],
              deferred_surface_ids: [],
              rationale: 'Search is the core journey.',
              coverage_risk: 'low',
            },
          },
        },
      ],
    });
    expect(r.discovery?.surfaces?.[0]?.label).toBe('Search');
    expect(r.discovery?.journeys?.[0]?.title).toBe('Search content');
    expect(r.discovery?.coverage_plan?.rationale).toBe('Search is the core journey.');
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
