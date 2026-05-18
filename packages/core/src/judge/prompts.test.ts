import { describe, expect, it } from 'vitest';
import { JUDGE_SYSTEM, buildTraceDigest } from './prompts.js';

describe('JUDGE_SYSTEM', () => {
  it('instructs the Judge to preserve goal scope boundaries', () => {
    expect(JUDGE_SYSTEM).toContain('Preserve the exact claim boundary in goal notes');
    expect(JUDGE_SYSTEM).toContain('it must NOT say or imply "user logged in"');
    expect(JUDGE_SYSTEM).toContain('verified means the stated scope was verified');
  });

  it('instructs the Judge not to score failed Iris probes as product results', () => {
    expect(JUDGE_SYSTEM).toContain(
      'Do not penalize the product for Iris/tooling instrumentation errors',
    );
    expect(JUDGE_SYSTEM).toContain('If the axe probe itself failed or was blocked by CSP/tooling');
    expect(JUDGE_SYSTEM).toContain('do not claim axe passed');
  });

  it('instructs the Judge to score real-use depth from scenario acceptance criteria', () => {
    expect(JUDGE_SYSTEM).toContain('product_use_contract');
    expect(JUDGE_SYSTEM).toContain('primary journey');
    expect(JUDGE_SYSTEM).toContain('weak_evidence');
    expect(JUDGE_SYSTEM).toContain('Separate surface coverage from real-use depth');
    expect(JUDGE_SYSTEM).toContain('Separate product quality from evaluator uncertainty');
    expect(JUDGE_SYSTEM).toContain('not automatically a product defect');
  });

  it('instructs the Judge not to treat disabled destructive controls as product defects', () => {
    expect(JUDGE_SYSTEM).toContain('First verify the trace established the action precondition');
    expect(JUDGE_SYSTEM).toContain('the relevant control was enabled');
    expect(JUDGE_SYSTEM).toContain('treat it as an Iris execution/proof gap');
  });

  it('carries product-use contract acceptance criteria into discovery trace digest', () => {
    const digest = buildTraceDigest([
      {
        v: 1,
        id: 'DISCOVERY',
        ts: 0,
        step: 0,
        target_kind: 'web',
        kind: 'discovery',
        actor: 'system',
        payload: {
          product_description: 'Canvas editor',
          goals: [{ id: 'G1', description: 'Create a project board' }],
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create and export a project board.',
            core_artifacts: ['visible project board'],
            user_jobs: [
              {
                id: 'PU1',
                journey_id: 'J1',
                title: 'Create project board',
                scenario_brief: 'Plan Launch Alpha',
                test_data: ['Launch Alpha', 'Risk: dependency'],
                required_actions: ['create shapes', 'label risk'],
                required_outputs: ['Launch Alpha board visible'],
                quality_bar: ['labels readable'],
                weak_evidence: ['toolbar opened'],
              },
            ],
          },
        },
      },
    ]);

    expect(digest).toContain('product_use_contract');
    expect(digest).toContain('canvas_editor');
    expect(digest).toContain('Create and export a project board');
    expect(digest).toContain('PU1/J1');
    expect(digest).toContain('Plan Launch Alpha');
    expect(digest).toContain('Launch Alpha board visible');
    expect(digest).toContain('toolbar opened');
  });

  it('prioritizes selected product-use jobs before clipping the discovery trace digest', () => {
    const digest = buildTraceDigest([
      {
        v: 1,
        id: 'DISCOVERY',
        ts: 0,
        step: 0,
        target_kind: 'web',
        kind: 'discovery',
        actor: 'system',
        payload: {
          product_description: 'Planning board',
          goals: [{ id: 'G9', description: 'Verify selected scenario', journey_id: 'J9' }],
          coverage_plan: {
            selected_journey_ids: ['J9'],
            deferred_surface_ids: [],
            rationale: 'J9 is the selected scenario.',
            coverage_risk: 'medium',
          },
          product_use_contract: {
            product_kinds: ['canvas_editor'],
            primary_value_loop: 'Create a realistic board.',
            core_artifacts: ['board'],
            user_jobs: Array.from({ length: 9 }, (_, index) => ({
              id: `PU${index + 1}`,
              journey_id: `J${index + 1}`,
              title: `Job ${index + 1}`,
              scenario_brief: `Scenario ${index + 1}`,
              test_data:
                index === 8
                  ? ['Column labels: Backlog, In Review, Released']
                  : [`Data ${index + 1}`],
              required_actions: [],
              required_outputs:
                index === 8 ? ['Backlog', 'In Review', 'Released'] : [`Output ${index + 1}`],
              quality_bar:
                index === 8 ? ['Represents a realistic workflow'] : [`Quality ${index + 1}`],
              weak_evidence: index === 8 ? ['toolbar selected only'] : [`Weak ${index + 1}`],
            })),
          },
        },
      },
    ]);

    expect(digest).toContain('PU9/J9');
    expect(digest).toContain('Backlog');
    expect(digest).toContain('toolbar selected only');
  });
});
