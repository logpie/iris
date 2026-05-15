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

  it('repairs one-character trace id typos in report evidence references', () => {
    const actual = '01KRMREXYEFSDZQY135WB4T0PM';
    const typo = '01KRMRREXYEFSDZQY135WB4T0PM';
    const judge = fakeJudge();
    judge.findings = [
      {
        id: 'F-typo',
        title: 'Minor issue',
        category: 'ux',
        severity: 'minor',
        evidence: [typo],
        rationale: 'A minor issue was observed.',
      },
    ];
    judge.scores.profiles.quality!.dimensions.correctness!.evidence = [typo];
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'Verify thing', status: 'verified', evidence: [typo] },
    ];
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: actual,
          ts: 1,
          step: 1,
          target_kind: 'web',
          kind: 'observation',
          actor: 'adapter',
          payload: { ref: 'OBS-000001', summary: 'Thing is visible' },
        },
      ],
    });
    expect(r.findings[0]?.evidence).toEqual([actual]);
    expect(r.scores.profiles.quality?.dimensions.correctness?.evidence).toEqual([actual]);
    expect(r.spec_compliance.goals[0]?.evidence).toEqual([actual]);
  });

  it('does not score responsive rubric dimensions when no mobile viewport was exercised', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.scores.profiles.frontend_correctness = {
      score: 9,
      dimensions: {
        console_clean: {
          score: 10,
          rationale: 'No console errors.',
          evidence: [],
        },
        responsive_behavior: {
          score: 8,
          rationale: 'No desktop responsive issue was seen.',
          evidence: ['OBS_DESKTOP'],
        },
      },
    };
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'OBS_DESKTOP',
          ts: 1,
          step: 1,
          target_kind: 'web',
          kind: 'observation',
          actor: 'adapter',
          payload: {
            ref: 'OBS-000001',
            summary: 'Desktop page',
            perception_state: { v: 1, viewport: { width: 1280, height: 720 }, elements: [] },
          },
        },
      ],
    });

    expect(
      r.scores.profiles.frontend_correctness?.dimensions.responsive_behavior?.score,
    ).toBeNull();
    expect(
      r.scores.profiles.frontend_correctness?.dimensions.responsive_behavior?.evidence,
    ).toEqual([]);
  });

  it('does not turn Iris probe-injection CSP failures into product console or axe scores', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.meta.confidence_caveats = [];
    judge.scores.profiles.frontend_correctness = {
      score: 9,
      dimensions: {
        console_clean: {
          score: 8,
          rationale: 'One console error was seen.',
          evidence: ['CONSOLE_1'],
        },
      },
    };
    judge.scores.profiles.accessibility = {
      score: 10,
      dimensions: {
        axe_violations: {
          score: 10,
          rationale: 'Axe reported no violations.',
          evidence: ['AXE_1'],
        },
      },
    };
    const cspText =
      "Executing inline script violates the following Content Security Policy directive 'script-src self'. The action has been blocked.";
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'AXE_1',
          ts: 1,
          step: 1,
          target_kind: 'web',
          kind: 'probe_result',
          actor: 'system',
          payload: { probe: 'axe', ok: false, error: cspText },
        },
        {
          v: 1,
          id: 'CONSOLE_1',
          ts: 2,
          step: 1,
          target_kind: 'web',
          kind: 'probe_result',
          actor: 'system',
          payload: {
            probe: 'console_errors_since',
            ok: true,
            summary: { error_count: 1, app_error_count: 1, resource_error_count: 0 },
            data: { app_errors: [{ type: 'error', text: cspText, category: 'app_error' }] },
          },
        },
      ],
    });

    expect(r.scores.profiles.frontend_correctness?.dimensions.console_clean?.score).toBe(10);
    expect(r.scores.profiles.frontend_correctness?.dimensions.console_clean?.rationale).toContain(
      'ignored Iris instrumentation CSP error',
    );
    expect(r.scores.profiles.accessibility?.dimensions.axe_violations?.score).toBeNull();
    expect(r.scores.profiles.accessibility?.dimensions.axe_violations?.rationale).toContain(
      'axe probe did not run',
    );
    expect(r.meta.confidence_caveats).toContain(
      'Not scored: axe probe did not run. Content Security Policy blocked Iris instrumentation.',
    );
  });

  it('keeps responsive rubric scores when a mobile viewport was exercised', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.scores.profiles.frontend_correctness = {
      score: 8,
      dimensions: {
        responsive_behavior: {
          score: 8,
          rationale: 'Mobile viewport worked.',
          evidence: ['OBS_MOBILE'],
        },
      },
    };
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'OBS_MOBILE',
          ts: 1,
          step: 1,
          target_kind: 'web',
          kind: 'observation',
          actor: 'adapter',
          payload: {
            ref: 'OBS-000001',
            summary: 'Mobile page',
            perception_state: { v: 1, viewport: { width: 390, height: 844 }, elements: [] },
          },
        },
      ],
    });

    expect(r.scores.profiles.frontend_correctness?.dimensions.responsive_behavior?.score).toBe(8);
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

  it('preserves optional provider and reasoning metadata in run metadata', () => {
    const r = buildReportJson({
      judge: fakeJudge(),
      run: {
        ...fakeRun(),
        transport: 'codex-appserver',
        models: {
          discovery: 'gpt-5.4-mini',
          explorer: 'gpt-5.4-mini',
          judge: 'gpt-5.4-mini',
        },
        reasoning_efforts: {
          discovery: 'low',
          explorer: 'low',
          judge: 'low',
        },
      },
    });
    expect(r.run.transport).toBe('codex-appserver');
    expect(r.run.models.discovery).toBe('gpt-5.4-mini');
    expect(r.run.reasoning_efforts?.judge).toBe('low');
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
            goals: [
              {
                id: 'G1',
                description: 'Search content',
                priority: 'must',
                journey_id: 'J1',
                surface_ids: ['S1'],
              },
            ],
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
            product_use_contract: {
              product_kinds: ['search_content'],
              primary_value_loop: 'Search, open, and consume content.',
              core_artifacts: ['loaded article or result content'],
              user_jobs: [
                {
                  id: 'PU1',
                  title: 'Find content',
                  journey_id: 'J1',
                  required_actions: ['enter query', 'open result'],
                  expected_artifact: 'article content visible',
                  acceptable_evidence: ['post-search observation with article title'],
                  weak_evidence: ['search box visible'],
                  risk: 'high',
                },
              ],
            },
          },
        },
      ],
    });
    expect(r.discovery?.surfaces?.[0]?.label).toBe('Search');
    expect(r.discovery?.journeys?.[0]?.title).toBe('Search content');
    expect(r.discovery?.coverage_plan?.rationale).toBe('Search is the core journey.');
    expect(r.discovery?.product_use_contract?.product_kinds).toEqual(['search_content']);
    expect(r.discovery?.product_use_contract?.user_jobs[0]?.weak_evidence).toContain(
      'search box visible',
    );
  });

  it('includes trace-derived task runs with replay metadata', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.spec_compliance.goals = [
      {
        id: 'G1',
        description: 'Search content',
        status: 'verified',
        evidence: ['OBS2'],
        notes: 'Observation shows the article.',
      },
    ];
    const r = buildReportJson({
      judge,
      run: fakeRun(),
      trace_events: [
        {
          v: 1,
          id: 'A1',
          ts: 1,
          step: 1,
          target_kind: 'web',
          kind: 'action',
          actor: 'explorer',
          payload: { tool: 'click', args: { selector: '#search' } },
        },
        {
          v: 1,
          id: 'R1',
          ts: 2,
          step: 1,
          target_kind: 'web',
          kind: 'action_result',
          actor: 'adapter',
          payload: { tool: 'click', ok: true },
        },
        {
          v: 1,
          id: 'OBS2',
          ts: 3,
          step: 1,
          target_kind: 'web',
          kind: 'observation',
          actor: 'adapter',
          payload: {
            ref: 'OBS-000002',
            summary: 'Article loaded',
            perception_state: {
              v: 1,
              url: 'https://example.com/article',
              title: 'Article',
              screenshot_ref: 'evidence/screenshots/step-0002.png',
              elements: [{ id: 'E001', stable_hash: 'habc12345', name: 'Article', visible: true }],
            },
          },
        },
        {
          v: 1,
          id: 'GS1',
          ts: 4,
          step: 1,
          target_kind: 'web',
          kind: 'goal_status',
          actor: 'explorer',
          payload: {
            id: 'G1',
            status: 'verified',
            rationale: 'Article loaded',
            evidence_event_ids: ['OBS2'],
          },
        },
      ],
    });
    expect(r.task_runs?.[0]).toMatchObject({
      id: 'TR-G1',
      goal_id: 'G1',
      status: 'verified',
      evidence_event_ids: ['OBS2'],
      replay: { replayable: true, action_count: 1, successful_action_count: 1 },
    });
    expect(r.task_runs?.[0]?.actions[0]).toMatchObject({
      tool: 'click',
      result_event_id: 'R1',
      post_observation_event_id: 'OBS2',
    });
    expect(r.task_runs?.[0]?.observations[0]).toMatchObject({
      event_id: 'OBS2',
      element_hashes: ['habc12345'],
    });
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
