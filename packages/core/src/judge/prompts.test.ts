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
    expect(digest).not.toContain('PU1/J1');
  });

  it('limits core artifacts in discovery digest to selected journey artifacts when available', () => {
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
          product_description: 'Data grid with docs.',
          goals: [{ id: 'G1', description: 'Filter the employee table', journey_id: 'J1' }],
          coverage_plan: {
            selected_journey_ids: ['J1'],
            deferred_surface_ids: ['S2'],
            rationale: 'Primary table workflow selected.',
            coverage_risk: 'medium',
          },
          product_use_contract: {
            product_kinds: ['data_grid', 'developer_documentation'],
            primary_value_loop: 'Use the table and docs.',
            core_artifacts: ['filtered table state', 'visible implementation snippet'],
            value_loops: [
              {
                id: 'VL1',
                title: 'Use the employee table',
                artifact: 'filtered table state',
              },
              {
                id: 'VL2',
                title: 'Read implementation documentation',
                artifact: 'visible implementation snippet',
                proof_obligations: ['inspect Javascript source code'],
                weak_evidence: ['table rows changed without docs content'],
              },
            ],
            user_jobs: [
              {
                id: 'PU1',
                journey_id: 'J1',
                value_loop_id: 'VL1',
                title: 'Filter rows',
                expected_artifact: 'Filtered DataTable state',
                required_outputs: ['London rows visible'],
              },
              {
                id: 'PU2',
                journey_id: 'J2',
                value_loop_id: 'VL2',
                title: 'Read docs',
                expected_artifact: 'visible implementation snippet',
                required_outputs: ["new DataTable('#example');"],
              },
            ],
          },
        },
      },
    ]);

    expect(digest).toContain('Filtered DataTable state');
    expect(digest).toContain('London rows visible');
    expect(digest).toContain('Use the employee table');
    expect(digest).not.toContain('visible implementation snippet');
    expect(digest).not.toContain("new DataTable('#example');");
    expect(digest).not.toContain('Read implementation documentation');
    expect(digest).not.toContain('inspect Javascript source code');
  });

  it('preserves outcome text that appears after form boilerplate in observations', () => {
    const boilerplate =
      'US Units Metric Units Other Units Age ages: 2 - 120 Gender Male Female Height feet inches Weight pounds '.repeat(
        3,
      );
    const summary = [
      'BMI Calculator',
      '## VISIBLE TEXT',
      boilerplate,
      'Result',
      'BMI = 30.9 kg/m2   (Obese Class I)',
      '16',
      '17',
      '18.5',
      '25',
      '30',
      '35',
      '40',
      'Underweight',
      'Normal',
      'Overweight',
      'Obesity',
      'BMI = 30.9',
      'Healthy BMI range: 18.5 kg/m2 - 25 kg/m2',
      'Healthy weight for the height: 107.8 lbs - 145.6 lbs',
    ].join('\n');
    expect(summary.indexOf('BMI = 30.9')).toBeGreaterThan(200);

    const digest = buildTraceDigest([
      {
        v: 1,
        id: 'OBS-BMI',
        ts: 0,
        step: 4,
        target_kind: 'web',
        kind: 'observation',
        actor: 'system',
        payload: {
          ref: 'OBS-000011',
          summary,
        },
      },
    ]);

    expect(digest).toContain('BMI = 30.9 kg/m2');
    expect(digest).toContain('Obese Class I');
    expect(digest).toContain('Healthy BMI range: 18.5 kg/m2 - 25 kg/m2');
  });

  it('preserves data-grid rows before table summary text', () => {
    const summary = [
      'DataTables example - Zero configuration',
      '## VISIBLE TEXT',
      'Name Position Office Age Start date Salary',
      'Airi Satou Accountant Tokyo 33 2008-11-28 $162,700',
      'Garrett Winters Accountant Tokyo 63 2011-07-25 $170,750',
      'Showing 1 to 5 of 5 entries (filtered from 57 total entries)',
    ].join('\n');

    const digest = buildTraceDigest([
      {
        v: 1,
        id: 'OBS-DT',
        ts: 0,
        step: 4,
        target_kind: 'web',
        kind: 'observation',
        actor: 'system',
        payload: {
          ref: 'OBS-000003',
          summary,
        },
      },
    ]);

    expect(digest).toContain('Airi Satou Accountant Tokyo');
    expect(digest).toContain('filtered from 57 total entries');
  });

  it('preserves implementation-code evidence that appears after long page text', () => {
    const summary = [
      'DataTables example - Zero configuration',
      '## VISIBLE TEXT',
      'Navigation and table boilerplate '.repeat(25),
      'Javascript',
      'HTML',
      'CSS',
      'The Javascript shown below is used to initialise the table shown in this example:',
      'Javascript',
      '1',
      "new DataTable('#example');",
      'In addition to the above code, the following Javascript library files are loaded for use in this example:',
      'https://cdn.datatables.net/2.3.8/js/dataTables.js',
      'The HTML shown below is the raw HTML table element, before it has been enhanced by DataTables:',
      ...Array.from({ length: 12 }, (_, index) => String(index + 1)),
      '<table id="example" class="display">',
      '<thead>',
      '<tr>',
      '<th>Name</th>',
    ].join('\n');
    expect(summary.indexOf("new DataTable('#example');")).toBeGreaterThan(320);

    const digest = buildTraceDigest([
      {
        v: 1,
        id: 'OBS-CODE',
        ts: 0,
        step: 23,
        target_kind: 'web',
        kind: 'observation',
        actor: 'system',
        payload: {
          ref: 'OBS-000024',
          summary,
        },
      },
    ]);

    expect(digest).toContain("new DataTable('#example');");
    expect(digest).toContain('<table id="example" class="display">');
    expect(digest).toContain('https://cdn.datatables.net/2.3.8/js/dataTables.js');
  });

  it('does not clip goal_status rationale before concrete proof details', () => {
    const rationale = `${'prefix '.repeat(18)}US Units calculation was submitted with the scenario values and the visible result panel updated to BMI 30.9 kg/m2, Obese Class I, with Healthy BMI range, Healthy weight for the height, BMI Prime, and Ponderal Index visible.`;
    expect(rationale.indexOf('BMI 30.9')).toBeGreaterThan(100);

    const digest = buildTraceDigest([
      {
        v: 1,
        id: 'GS-BMI',
        ts: 0,
        step: 5,
        target_kind: 'web',
        kind: 'goal_status',
        actor: 'explorer',
        payload: {
          id: 'G1',
          status: 'verified',
          evidence_event_ids: ['OBS-BMI'],
          rationale,
        },
      },
    ]);

    expect(digest).toContain('BMI 30.9 kg/m2');
    expect(digest).toContain('Ponderal Index visible');
  });
});
