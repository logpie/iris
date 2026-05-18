import { describe, expect, it } from 'vitest';
import { deriveTestingPlan } from './testing-plan.js';

describe('deriveTestingPlan', () => {
  it('turns artifact-editor discovery into journey groups and executable scenarios', () => {
    const plan = deriveTestingPlan({
      discovery: {
        product_description: 'A whiteboard editor.',
        surfaces: [
          {
            id: 'S1',
            label: 'Canvas',
            kind: 'content',
            url: '',
            source: 'initial',
            value: 'core',
            confidence: 1,
            evidence: [],
            controls: [],
            prerequisites: [],
          },
          {
            id: 'S2',
            label: 'Share',
            kind: 'toolbar',
            url: '',
            source: 'initial',
            value: 'important_secondary',
            confidence: 1,
            evidence: [],
            controls: [],
            prerequisites: [],
          },
          {
            id: 'S3',
            label: 'SDK promo',
            kind: 'banner',
            url: '',
            source: 'initial',
            value: 'peripheral',
            confidence: 1,
            evidence: [],
            controls: [],
            prerequisites: [],
          },
        ],
        journeys: [
          {
            id: 'J1',
            title: 'Create diagram',
            priority: 'must',
            surface_ids: ['S1'],
            user_intent: 'Create visible canvas content.',
            suggested_goal: 'Create a labeled diagram.',
            expected_evidence: ['diagram remains visible'],
            risk: 'high',
            goal_class: 'core',
          },
          {
            id: 'J2',
            title: 'Share board',
            priority: 'should',
            surface_ids: ['S2'],
            user_intent: 'Enter sharing.',
            suggested_goal: 'Open sharing.',
            expected_evidence: ['share boundary appears'],
            risk: 'medium',
            goal_class: 'secondary_workflow',
          },
        ],
        goals: [
          {
            id: 'G1',
            description: 'Create a labeled diagram and verify it remains visible.',
            priority: 'must',
            journey_id: 'J1',
            surface_ids: ['S1'],
            goal_class: 'core',
          },
          {
            id: 'G2',
            description: 'Open Share and verify a share boundary appears.',
            priority: 'should',
            journey_id: 'J2',
            surface_ids: ['S2'],
            goal_class: 'secondary_workflow',
          },
        ],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and share a whiteboard artifact.',
          core_artifacts: ['visible diagram', 'share boundary'],
          value_loops: [
            {
              id: 'VL1',
              title: 'Canvas creation',
              artifact: 'visible diagram',
              required_capabilities: ['place shapes', 'type labels'],
              proof_obligations: ['multiple objects remain visible'],
              weak_evidence: ['toolbar selected'],
            },
            {
              id: 'VL2',
              title: 'Sharing',
              artifact: 'share boundary',
              required_capabilities: ['open share'],
              proof_obligations: ['share dialog or sign-in appears'],
              weak_evidence: ['share button focused'],
            },
          ],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create a labeled diagram',
              value_loop_id: 'VL1',
              journey_id: 'J1',
              scenario_brief:
                'Create a launch diagram titled "Launch plan" with "Draft" and "Review" labels.',
              test_data: ['Launch plan', 'Draft', 'Review'],
              required_actions: ['place shape', 'type label'],
              proof_obligations: ['diagram remains visible'],
              expected_artifact: 'labeled diagram on canvas',
              required_outputs: ['readable "Launch plan"', 'Draft and Review labels'],
              quality_bar: ['the diagram should read as a small plan, not filler marks'],
              acceptable_evidence: ['post-create canvas screenshot'],
              weak_evidence: ['canvas focused'],
              risk: 'high',
            },
            {
              id: 'PU2',
              title: 'Open sharing',
              value_loop_id: 'VL2',
              journey_id: 'J2',
              scenario_brief: 'Open sharing for the current board.',
              test_data: [],
              required_actions: ['click Share'],
              proof_obligations: ['share dialog appears'],
              expected_artifact: 'share dialog',
              required_outputs: ['share dialog or sign-in boundary'],
              quality_bar: ['the share state should be tied to the current board'],
              acceptable_evidence: ['share UI screenshot'],
              weak_evidence: ['button focus'],
              risk: 'medium',
            },
          ],
        },
        coverage_plan: {
          selected_journey_ids: ['J1', 'J2'],
          deferred_surface_ids: ['S3'],
          rationale: 'Core creation and sharing are more important than promo.',
          coverage_risk: 'medium',
        },
      },
    });

    expect(plan?.primary_journey_id).toBe('VL1');
    expect(plan?.main_outcome).toBe('Create and share a whiteboard artifact.');
    expect(plan?.journeys.map((journey) => journey.title)).toEqual(['Canvas creation', 'Sharing']);
    expect(plan?.scenarios).toHaveLength(2);
    expect(plan?.scenarios[0]).toMatchObject({
      id: 'G1',
      journey_id: 'VL1',
      title: 'Create a labeled diagram',
      scenario_brief:
        'Create a launch diagram titled "Launch plan" with "Draft" and "Review" labels.',
      test_data: ['Launch plan', 'Draft', 'Review'],
      expected_result: 'labeled diagram on canvas',
      required_outputs: ['readable "Launch plan"', 'Draft and Review labels'],
      quality_bar: ['the diagram should read as a small plan, not filler marks'],
      actions: ['place shape', 'type label'],
    });
    expect(plan?.deferred[0]).toMatchObject({
      id: 'S3',
      title: 'SDK promo',
      reason: 'Core creation and sharing are more important than promo.',
    });
  });

  it('keeps content-product discovery scenario-native without a product contract', () => {
    const plan = deriveTestingPlan({
      discovery: {
        product_description: 'A reference site.',
        goals: [
          {
            id: 'G1',
            description: 'Search for a topic and open the article.',
            priority: 'must',
            journey_id: 'J1',
            surface_ids: ['S-search'],
          },
        ],
        journeys: [
          {
            id: 'J1',
            title: 'Find and read content',
            priority: 'must',
            surface_ids: ['S-search'],
            user_intent: 'Find a specific topic.',
            suggested_goal: 'Search for a topic and open the article.',
            expected_evidence: ['article page loads'],
            risk: 'high',
          },
        ],
      },
    });

    expect(plan?.primary_journey_id).toBe('J1');
    expect(plan?.journeys[0]).toMatchObject({
      title: 'Find and read content',
      user_goal: 'Find a specific topic.',
      success_state: 'article page loads',
    });
    expect(plan?.scenarios[0]).toMatchObject({
      id: 'G1',
      title: 'Find and read content',
      expected_result: 'article page loads',
    });
  });

  it('falls back to judge goals when Discovery is unavailable', () => {
    const plan = deriveTestingPlan({
      goals: [
        { id: 'G1', description: 'Sign in successfully', status: 'verified', evidence: ['T1'] },
        { id: 'G2', description: 'Create an issue', status: 'partial', evidence: ['T2'] },
      ],
    });

    expect(plan?.primary_journey_id).toBe('J-primary');
    expect(plan?.journeys[0]?.title).toBe('Checked scenarios');
    expect(plan?.scenarios.map((scenario) => scenario.title)).toEqual([
      'Sign in successfully',
      'Create an issue',
    ]);
  });

  it('merges duplicate task checks inside the same product area', () => {
    const plan = deriveTestingPlan({
      discovery: {
        goals: [
          {
            id: 'G1',
            description: 'Open the page menu and trigger an export or download flow.',
            priority: 'should',
            journey_id: 'J1',
            surface_ids: ['S-menu'],
          },
          {
            id: 'G2',
            description: 'Export or download the current artifact.',
            priority: 'should',
            journey_id: 'J2',
            surface_ids: ['S-export'],
          },
          {
            id: 'G3',
            description: 'Open the share dialog.',
            priority: 'should',
            journey_id: 'J3',
            surface_ids: ['S-share'],
          },
        ],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and export a canvas artifact.',
          core_artifacts: ['canvas artifact'],
          value_loops: [
            {
              id: 'VL1',
              title: 'Export',
              artifact: 'exported artifact',
              required_capabilities: ['export'],
              proof_obligations: ['download begins'],
              weak_evidence: ['menu only'],
            },
            {
              id: 'VL2',
              title: 'Sharing',
              artifact: 'share boundary',
              required_capabilities: ['share'],
              proof_obligations: ['share dialog appears'],
              weak_evidence: ['button focus'],
            },
          ],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Export or download the board',
              journey_id: 'J1',
              value_loop_id: 'VL1',
              scenario_brief: 'Export or download the current board after creating content.',
              test_data: [],
              required_actions: ['open menu', 'choose export'],
              proof_obligations: ['download begins'],
              expected_artifact: 'export/download state',
              required_outputs: ['download begins'],
              quality_bar: ['export should be tied to the current board'],
              acceptable_evidence: ['download action'],
              weak_evidence: ['menu only'],
              risk: 'medium',
            },
            {
              id: 'PU2',
              title: 'Export or download the current artifact',
              journey_id: 'J2',
              value_loop_id: 'VL1',
              scenario_brief: 'Export or download the current board after creating content.',
              test_data: [],
              required_actions: ['choose download'],
              proof_obligations: ['download begins'],
              expected_artifact: 'artifact download begins',
              required_outputs: ['download begins'],
              quality_bar: ['export should be tied to the current board'],
              acceptable_evidence: ['download action'],
              weak_evidence: ['download option only'],
              risk: 'medium',
            },
            {
              id: 'PU3',
              title: 'Open sharing',
              journey_id: 'J3',
              value_loop_id: 'VL2',
              scenario_brief: 'Open sharing for the current board.',
              test_data: [],
              required_actions: ['click Share'],
              proof_obligations: ['share dialog appears'],
              expected_artifact: 'share dialog',
              required_outputs: ['share dialog appears'],
              quality_bar: ['share should be tied to the current board'],
              acceptable_evidence: ['share UI'],
              weak_evidence: ['button focus'],
              risk: 'medium',
            },
          ],
        },
      },
    });

    expect(plan?.scenarios.map((scenario) => scenario.title)).toEqual([
      'Export or download the board',
      'Open sharing',
    ]);
    expect(plan?.scenarios[0]?.source_goal_ids).toEqual(['G1', 'G2']);
    expect(plan?.journeys.find((journey) => journey.id === 'VL1')?.scenario_ids).toEqual(['G1']);
  });

  it('keeps distinct product-use jobs that share one discovery journey', () => {
    const plan = deriveTestingPlan({
      discovery: {
        product_description: 'A live employee data grid.',
        goals: [
          {
            id: 'G1',
            description: 'Filter the employee table for London rows.',
            priority: 'must',
            journey_id: 'J1',
            surface_ids: ['S1'],
          },
          {
            id: 'G2',
            description: 'Sort the employee table by Age and verify ascending ages.',
            priority: 'must',
            journey_id: 'J1',
            surface_ids: ['S1'],
          },
          {
            id: 'G3',
            description: 'Set 25 entries per page and verify Showing 26 to 50 of 57 entries.',
            priority: 'must',
            journey_id: 'J1',
            surface_ids: ['S1'],
          },
        ],
        journeys: [
          {
            id: 'J1',
            title: 'Use employee grid controls',
            priority: 'must',
            surface_ids: ['S1'],
            user_intent: 'Change table state.',
            suggested_goal: 'Use employee table controls and verify changed rows.',
            expected_evidence: ['changed grid state'],
            risk: 'high',
          },
        ],
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed employee table state'],
          value_loops: [
            {
              id: 'VL1',
              title: 'Data grid controls',
              artifact: 'changed employee table',
              required_capabilities: ['filter rows', 'sort columns', 'paginate rows'],
              proof_obligations: ['changed rows and status text'],
              weak_evidence: ['focused control only'],
            },
          ],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter the employee table to London rows',
              journey_id: 'J1',
              value_loop_id: 'VL1',
              scenario_brief: 'Use table Search to filter London rows.',
              test_data: ['London'],
              required_actions: ['type London'],
              proof_obligations: ['filtered count visible'],
              expected_artifact: 'Filtered rows',
              required_outputs: ['London', 'filtered from 57 total entries'],
              quality_bar: ['row filtering is visible'],
              acceptable_evidence: ['filtered row screenshot'],
              weak_evidence: ['input focus only'],
              risk: 'high',
            },
            {
              id: 'PU2',
              title: 'Sort employees by age',
              journey_id: 'J1',
              value_loop_id: 'VL1',
              scenario_brief: 'Sort the employee table by Age.',
              test_data: ['Age column'],
              required_actions: ['click Age'],
              proof_obligations: ['ascending ages visible'],
              expected_artifact: 'Age sorted rows',
              required_outputs: ['Age', '19', '20', '21'],
              quality_bar: ['numeric order is proven'],
              acceptable_evidence: ['sorted row screenshot'],
              weak_evidence: ['header focus only'],
              risk: 'high',
            },
            {
              id: 'PU3',
              title: 'Change page length and move to the next page',
              journey_id: 'J1',
              value_loop_id: 'VL1',
              scenario_brief: 'Set page length to 25 and navigate to page 2.',
              test_data: ['25 entries per page', 'Page 2'],
              required_actions: ['select 25', 'click page 2'],
              proof_obligations: ['second page range visible'],
              expected_artifact: 'Second page rows',
              required_outputs: ['25 entries per page', 'Showing 26 to 50 of 57 entries'],
              quality_bar: ['page size and pagination both changed'],
              acceptable_evidence: ['second page screenshot'],
              weak_evidence: ['dropdown open only'],
              risk: 'medium',
            },
          ],
        },
      },
    });

    expect(plan?.scenarios).toHaveLength(3);
    expect(plan?.scenarios.map((scenario) => scenario.title)).toEqual([
      'Filter the employee table to London rows',
      'Sort employees by age',
      'Change page length and move to the next page',
    ]);
    expect(plan?.scenarios[1]?.required_outputs).toEqual(['Age', '19', '20', '21']);
    expect(plan?.scenarios[2]?.required_outputs).toEqual([
      '25 entries per page',
      'Showing 26 to 50 of 57 entries',
    ]);
  });
});
