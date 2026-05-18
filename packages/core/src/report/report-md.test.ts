import { describe, expect, it } from 'vitest';
import { fakeJudge, fakeRun } from './_fakes.js';
import { buildReportJson } from './report-json.js';
import { buildReportMd } from './report-md.js';

describe('buildReportMd', () => {
  it('produces a markdown header with score and pass/fail', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun(), threshold: 7.0 });
    const md = buildReportMd(r);
    expect(md).toMatch(/# Iris run — Provisional product score: 6\.5/);
    expect(md).toContain('**Evidence confidence:**');
    expect(md).toMatch(/❌/);
  });

  it('lists scenario checks when applicable', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/Scenario checks/);
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
    expect(md).toMatch(/Scenario checks — 1 \/ 1/);
    expect(md).toMatch(/✅ G1: load article/);
  });

  it('renders goal validation transition counts and reasons', () => {
    const judge = fakeJudge();
    judge.spec_compliance.goal_claim_validation = {
      verified_kept: 1,
      partial_upgraded: 1,
      partial_kept: 1,
      downgraded: 1,
      downgrade_reasons: ['G4: no outcome artifact cited'],
      partial_reasons: ['G2: no outcome-shaped evidence in goal window'],
    };
    const r = buildReportJson({ judge, run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toContain(
      'Evidence audit: 1 verified kept, 1 partial upgraded, 1 partial kept, 1 downgraded',
    );
    expect(md).toContain('G4: no outcome artifact cited');
    expect(md).toContain('G2: no outcome-shaped evidence in goal window');
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

  it('renders model and reasoning-effort metadata', () => {
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
    const md = buildReportMd(r);
    expect(md).toContain('**Transport:** codex-appserver');
    expect(md).toContain('discovery gpt-5.4-mini (effort low)');
    expect(md).toContain('judge gpt-5.4-mini (effort low)');
  });

  it('does not show a clean pass marker for provisional product scores', () => {
    const judge = fakeJudge();
    judge.findings = [];
    judge.scores.overall.score = 7.5;
    judge.meta.confidence_overall = 0.8;
    judge.meta.confidence_caveats = [];
    judge.spec_compliance.goals = [
      { id: 'G1', description: 'create artifact', status: 'verified', evidence: ['T1'] },
      { id: 'G2', description: 'edit artifact', status: 'verified', evidence: ['T2'] },
      { id: 'G3', description: 'style artifact', status: 'partial', evidence: ['T3'] },
      { id: 'G4', description: 'export artifact', status: 'partial', evidence: ['T4'] },
    ];
    const md = buildReportMd(buildReportJson({ judge, run: fakeRun(), threshold: 7 }));
    expect(md.split('\n')[0]).toContain('❌');
    expect(md.split('\n')[0]).not.toContain('✅');
  });

  it('renders scenario-plan metadata from Discovery', () => {
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
            product_use_contract: {
              product_kinds: ['canvas_editor'],
              primary_value_loop: 'Create a durable drawing artifact.',
              core_artifacts: ['visible drawing on canvas'],
              value_loops: [
                {
                  id: 'VL1',
                  title: 'Create and refine drawing',
                  artifact: 'visible drawing on canvas',
                  required_capabilities: ['canvas creation', 'visible editing'],
                  proof_obligations: ['drawing object remains visible after editing'],
                  weak_evidence: ['toolbar selected'],
                },
              ],
              user_jobs: [
                {
                  id: 'PU1',
                  title: 'Draw something',
                  required_actions: ['drag on canvas'],
                  expected_artifact: 'drawing visible',
                  acceptable_evidence: ['post-drag canvas screenshot'],
                  weak_evidence: ['toolbar selected'],
                  risk: 'high',
                },
              ],
            },
          },
        },
      ],
    });
    const md = buildReportMd(r);
    expect(md).toContain('**Overall mission:** Create a durable drawing artifact.');
    expect(md).toContain('**User journeys checked:**');
    expect(md).toContain('VL1: Create and refine drawing');
    expect(md).toContain('**Success criteria:** drawing object remains visible after editing');
    expect(md).toContain('**Tested scenarios:**');
    expect(md).toContain('PU1: Draw something');
    expect(md).not.toContain('Product-use contract');
  });

  it('omits zero-cost metadata from markdown reports', () => {
    const r = buildReportJson({
      judge: fakeJudge(),
      run: { ...fakeRun(), cost_usd: 0 },
    });
    const md = buildReportMd(r);
    expect(md).not.toContain('Cost');
    expect(md).not.toContain('$0.00');
  });

  it('lists top blocker/major findings', () => {
    const r = buildReportJson({ judge: fakeJudge(), run: fakeRun() });
    const md = buildReportMd(r);
    expect(md).toMatch(/Top findings/);
    expect(md).toMatch(/F-001.*Login fails/);
  });

  it('lists non-major findings instead of hiding them', () => {
    const judge = fakeJudge();
    judge.findings = [
      {
        id: 'F-minor',
        title: 'Inline validation copy is unclear',
        category: 'copy',
        severity: 'minor',
        evidence: ['T3'],
        rationale: 'The field error is visible but vague.',
      },
      {
        id: 'F-suggestion',
        title: 'Consider a compact mode',
        category: 'suggestion',
        severity: 'suggestion',
        evidence: [],
        rationale: 'Power users may prefer denser rows.',
      },
    ];
    const md = buildReportMd(buildReportJson({ judge, run: fakeRun() }));

    expect(md).toMatch(/Other findings/);
    expect(md).toContain('F-minor [minor]');
    expect(md).toContain('F-suggestion [suggestion]');
  });

  it('does not silently truncate non-major findings', () => {
    const judge = fakeJudge();
    judge.findings = Array.from({ length: 12 }, (_, index) => ({
      id: `F-minor-${index + 1}`,
      title: `Minor finding ${index + 1}`,
      category: 'ux' as const,
      severity: 'minor' as const,
      evidence: ['T3'],
      rationale: 'A minor issue was observed.',
    }));

    const md = buildReportMd(buildReportJson({ judge, run: fakeRun() }));

    expect(md).toContain('F-minor-1 [minor]');
    expect(md).toContain('F-minor-12 [minor]');
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
