import { describe, expect, it } from 'vitest';
import {
  ScenarioCompletionGateVerifier,
  buildScenarioCompletionGates,
  formatScenarioGatePrompt,
} from './scenario-completion-gate.js';

describe('scenario completion gate', () => {
  it('tells Explorer to trust cited observation text over missing screenshot text', () => {
    const prompt = formatScenarioGatePrompt([
      {
        goalId: 'G1',
        requiredOutputs: ['Showing 26 to 50 of 57 entries'],
        requiredVisibleText: ['Showing 26 to 50 of 57 entries'],
      },
    ]);

    expect(prompt).toContain('trust that text and mark verified');
  });

  it('builds gate checklists from required outputs instead of test-data metadata', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'whiteboard',
      goals: [
        {
          id: 'G1',
          description: 'Create roadmap',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['canvas_editor'],
        primary_value_loop: 'Create a board.',
        core_artifacts: ['board'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Create roadmap',
            journey_id: 'J1',
            scenario_brief: 'Create a roadmap.',
            test_data: [
              'Milestones: Research, Prototype, Beta, Launch',
              'Media filename if upload is available: launch-chart.png',
            ],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'roadmap',
            required_outputs: ['Q3 Launch Roadmap', 'Research', 'Prototype'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'medium',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates).toEqual([
      {
        goalId: 'G1',
        requiredOutputs: ['Q3 Launch Roadmap', 'Research', 'Prototype'],
        requiredVisibleText: ['Q3 Launch Roadmap', 'Research', 'Prototype'],
      },
    ]);
  });

  it('matches gates to the product-use job, not just the shared journey id', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'employee data grid',
      goals: [
        {
          id: 'G1',
          description: 'Filter the employee table for London rows.',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
        {
          id: 'G2',
          description: 'Sort the employee table by Age and verify ascending ages.',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
        {
          id: 'G3',
          description: 'Set 25 entries per page and verify Showing 26 to 50 of 57 entries.',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['data_grid'],
        primary_value_loop: 'Use employee table controls.',
        core_artifacts: ['changed grid state'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Filter the employee table to London rows',
            journey_id: 'J1',
            scenario_brief: 'Use table Search to filter London rows.',
            test_data: ['London'],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Filtered rows',
            required_outputs: ['London', 'filtered from 57 total entries'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
          {
            id: 'PU2',
            title: 'Sort employees by age',
            journey_id: 'J1',
            scenario_brief: 'Sort the employee table by Age.',
            test_data: ['youngest visible employees such as 19, 20, 21'],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Age sorted rows',
            required_outputs: ['Age', 'Employee rows with ages ordered consistently'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
          {
            id: 'PU3',
            title: 'Change page length and move to the next page',
            journey_id: 'J1',
            scenario_brief: 'Set page length to 25 and navigate to page 2.',
            test_data: ['25 entries per page', 'Page 2'],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Second page rows',
            required_outputs: ['25 entries per page', 'Showing 26 to 50 of 57 entries'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'medium',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates).toMatchObject([
      { goalId: 'G1', requiredVisibleText: ['London', 'filtered from 57 total entries'] },
      { goalId: 'G2', requiredVisibleText: ['Age', '19', '20', '21'] },
      {
        goalId: 'G3',
        requiredVisibleText: ['Showing 26 to 50 of 57 entries'],
      },
    ]);
  });

  it('builds a conservative union gate when same-journey product-use jobs are ambiguous', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'employee data grid',
      goals: [
        {
          id: 'G1',
          description: 'Use employee grid controls and verify the table changes.',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['data_grid'],
        primary_value_loop: 'Use employee table controls.',
        core_artifacts: ['changed grid state'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Filter London rows',
            journey_id: 'J1',
            scenario_brief: 'Filter London rows.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Filtered rows',
            required_outputs: ['London'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
          {
            id: 'PU2',
            title: 'Sort age rows',
            journey_id: 'J1',
            scenario_brief: 'Sort by Age.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Sorted rows',
            required_outputs: ['Age'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates).toEqual([
      {
        goalId: 'G1',
        requiredOutputs: ['London', 'Age'],
        requiredVisibleText: ['London', 'Age'],
      },
    ]);
  });

  it('builds a conservative union gate when a generic goal has no journey id', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'employee data grid',
      goals: [
        {
          id: 'G1',
          description: 'Use the employee grid.',
          priority: 'must',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['data_grid'],
        primary_value_loop: 'Use employee table controls.',
        core_artifacts: ['changed grid state'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Filter London rows',
            scenario_brief: 'Filter London rows.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Filtered rows',
            required_outputs: ['London'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
          {
            id: 'PU2',
            title: 'Sort age rows',
            scenario_brief: 'Sort by Age.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'Sorted rows',
            required_outputs: ['Age'],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates).toEqual([
      {
        goalId: 'G1',
        requiredOutputs: ['London', 'Age'],
        requiredVisibleText: ['London', 'Age'],
      },
    ]);
  });

  it('rejects verified completion when cited evidence misses a required output', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G2',
        requiredOutputs: ['Support Triage Flow', 'Customer blocked?', 'Reproduce'],
        requiredVisibleText: ['Support Triage Flow', 'Customer blocked?', 'Reproduce'],
      },
    ]);
    verifier.recordTraceEvent('ACTION1', 'action', { tool: 'click', args: { selector: '#save' } });
    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: 'Canvas shows Customer blocked? and Reproduce connected by arrows.',
    });

    expect(verifier.check('G2', ['OBS1'])).toEqual({
      ok: false,
      missing: ['Support Triage Flow'],
      required: ['Support Triage Flow', 'Customer blocked?', 'Reproduce'],
    });
  });

  it('passes verified completion when cited evidence shows all required outputs', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Activation trend', 'Check onboarding drop-off'],
        requiredVisibleText: ['Activation trend', 'Check onboarding drop-off'],
      },
    ]);
    verifier.recordTraceEvent('ACTION1', 'action', { tool: 'click', args: { selector: '#save' } });
    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: 'Canvas shows Activation trend and Check onboarding drop-off annotation.',
    });

    expect(verifier.check('G1', ['OBS1']).ok).toBe(true);
  });

  it('rejects evidence already claimed by a different goal', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Alpha result'],
        requiredVisibleText: ['Alpha result'],
      },
      {
        goalId: 'G2',
        requiredOutputs: ['Alpha result'],
        requiredVisibleText: ['Alpha result'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', { summary: 'Alpha result' });
    verifier.recordTraceEvent('STATUS1', 'goal_status', {
      id: 'G1',
      status: 'verified',
      evidence_event_ids: ['OBS1'],
    });

    expect(verifier.check('G2', ['OBS1'])).toEqual({
      ok: false,
      missing: ['Alpha result'],
      required: ['Alpha result'],
      unacceptableEvidenceEventIds: ['OBS1'],
    });
  });

  it('does not synthesize a required phrase across separate evidence events', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Checkout complete'],
        requiredVisibleText: ['Checkout complete'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', { summary: 'Checkout page' });
    verifier.recordTraceEvent('OBS2', 'observation', { summary: 'Task complete' });

    expect(verifier.check('G1', ['OBS1', 'OBS2'])).toEqual({
      ok: false,
      missing: ['Checkout complete'],
      required: ['Checkout complete'],
    });
  });

  it('does not satisfy separate required outputs from separate evidence events', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['London', 'filtered from 57 total entries'],
        requiredVisibleText: ['London', 'filtered from 57 total entries'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: 'London office rows are visible.',
    });
    verifier.recordTraceEvent('OBS2', 'observation', {
      summary: 'Showing 1 to 10 of 57 entries filtered from 57 total entries.',
    });

    expect(verifier.check('G1', ['OBS1', 'OBS2'])).toEqual({
      ok: false,
      missing: ['London', 'filtered from 57 total entries'],
      required: ['London', 'filtered from 57 total entries'],
    });
  });

  it('rejects unowned stale evidence from before the current goal attempt', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Alpha'],
        requiredVisibleText: ['Alpha'],
      },
      {
        goalId: 'G2',
        requiredOutputs: ['Alpha'],
        requiredVisibleText: ['Alpha'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', { summary: 'Alpha' });
    verifier.recordTraceEvent('STATUS1', 'goal_status', {
      id: 'G1',
      status: 'partial',
      evidence_event_ids: [],
    });

    expect(verifier.check('G2', ['OBS1'])).toEqual({
      ok: false,
      missing: [],
      required: ['Alpha'],
      unacceptableEvidenceEventIds: ['OBS1'],
    });
  });

  it('does not gate visual-only required outputs as text substrings', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'whiteboard',
      goals: [
        {
          id: 'G1',
          description: 'Create kickoff board',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['canvas_editor'],
        primary_value_loop: 'Create a board.',
        core_artifacts: ['board'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Create kickoff board',
            journey_id: 'J1',
            scenario_brief: 'Create a kickoff board.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'kickoff board',
            required_outputs: [
              'Project Phoenix kickoff',
              'visible arrow between milestone objects',
              'one artifact element visibly styled or emphasized',
            ],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'medium',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates[0]?.requiredVisibleText).toEqual(['Project Phoenix kickoff']);
  });

  it('does not require abstract auth-state prose as literal visible text', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'login demo app',
      goals: [
        {
          id: 'G1',
          description: 'Sign in as standard_user',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['auth_account'],
        primary_value_loop: 'Sign in with provided credentials.',
        core_artifacts: ['authenticated app state'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Sign in as the standard demo user',
            journey_id: 'J1',
            scenario_brief: 'Use standard_user and prove post-login state.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'authenticated app state',
            required_outputs: [
              'standard_user credentials submitted',
              'Login page no longer blocks access',
              'Authenticated destination or app content visible',
            ],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates).toEqual([]);
  });

  it('requires post-login product inventory text for commerce auth gates', () => {
    const gates = buildScenarioCompletionGates({
      v: 1,
      target_kind_hint: 'web',
      product_description: 'login demo shop',
      goals: [
        {
          id: 'G1',
          description: 'Sign in as standard_user',
          priority: 'must',
          journey_id: 'J1',
          surface_ids: [],
        },
      ],
      product_use_contract: {
        product_kinds: ['commerce_checkout'],
        primary_value_loop: 'Sign in and reach inventory.',
        core_artifacts: ['authenticated product inventory'],
        value_loops: [],
        user_jobs: [
          {
            id: 'PU1',
            title: 'Sign in as the standard demo user',
            journey_id: 'J1',
            scenario_brief: 'Use standard_user and prove post-login product inventory state.',
            test_data: [],
            required_actions: [],
            proof_obligations: [],
            expected_artifact: 'authenticated inventory state',
            required_outputs: [
              'standard_user credentials submitted',
              'Authenticated product or inventory content visible',
              'Login error absent',
            ],
            quality_bar: [],
            acceptable_evidence: [],
            weak_evidence: [],
            risk: 'high',
          },
        ],
      },
      surfaces: [],
      journeys: [],
      capabilities: [],
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    });

    expect(gates[0]?.requiredVisibleText).toEqual(['Products']);
    const verifier = new ScenarioCompletionGateVerifier(gates);
    verifier.recordTraceEvent('ACTION1', 'action', { tool: 'click', args: { selector: '#login' } });
    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: '## RICH CONTENT\n[input input[type=text]#user-name]\nstandard_user',
    });
    expect(verifier.check('G1', ['OBS1'])).toEqual({
      ok: false,
      missing: ['Products'],
      required: ['Products'],
    });

    verifier.recordTraceEvent('OBS2', 'observation', {
      summary: 'Products\nSauce Labs Backpack\nShopping cart',
    });
    expect(verifier.check('G1', ['OBS2']).ok).toBe(true);
  });

  it('checks structured commerce labels and probe_result ui text', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G2',
        requiredOutputs: ['Product: Sauce Labs Backpack'],
        requiredVisibleText: ['Sauce Labs Backpack'],
      },
    ]);

    verifier.recordTraceEvent('PROBE1', 'probe_result', {
      probe: 'ui_state',
      ok: true,
      phase: 'post-explorer',
      data: {
        text_sample: 'Your Cart',
        selectors: [
          { selector: '.cart_item', text: 'Sauce Labs Backpack' },
          { selector: '#dt-search-0', value: 'London' },
        ],
      },
    });

    expect(verifier.check('G2', ['PROBE1']).ok).toBe(true);
  });

  it('does not let selectors, urls, roles, or field values satisfy visible proof', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Checkout complete', 'London'],
        requiredVisibleText: ['Checkout complete', 'London'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: 'Cart page',
      perception_state: {
        url: 'https://shop.example/checkout-complete',
        elements: [
          { selector: '#checkout-complete', role: 'status' },
          { selector: '#search', value: 'London' },
        ],
      },
    });

    expect(verifier.check('G1', ['OBS1'])).toMatchObject({
      ok: false,
      missing: ['Checkout complete', 'London'],
    });
  });

  it('rejects stale pre-action evidence even when it contains the required text', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Dashboard saved'],
        requiredVisibleText: ['Dashboard saved'],
      },
    ]);

    verifier.recordTraceEvent('OBS_PRE', 'observation', {
      summary: 'Dashboard saved',
    });
    verifier.recordTraceEvent('ACTION1', 'action', { tool: 'click', args: { selector: '#save' } });

    expect(verifier.check('G1', ['OBS_PRE'])).toEqual({
      ok: false,
      missing: ['Dashboard saved'],
      required: ['Dashboard saved'],
      unacceptableEvidenceEventIds: ['OBS_PRE'],
    });
  });

  it('rejects pre-action screenshots or vision descriptions as completion proof', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Dashboard saved'],
        requiredVisibleText: ['Dashboard saved'],
      },
    ]);

    verifier.recordTraceEvent('SS1', 'action_result', {
      tool: 'screenshot',
      ok: true,
      description: 'Dashboard saved',
    });
    verifier.recordTraceEvent('VISION1', 'action_result', {
      tool: 'vision_describe',
      ok: true,
      description: 'Dashboard saved',
    });

    expect(verifier.checkEvidenceEventIds(['SS1', 'VISION1'], { goalId: 'G1' })).toEqual({
      ok: false,
      unknown: [],
      unacceptable: ['SS1', 'VISION1'],
    });
    expect(verifier.check('G1', ['SS1', 'VISION1'])).toEqual({
      ok: false,
      missing: ['Dashboard saved'],
      required: ['Dashboard saved'],
      unacceptableEvidenceEventIds: ['SS1', 'VISION1'],
    });

    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('SS2', 'action_result', {
      tool: 'screenshot',
      ok: true,
      description: 'Dashboard saved',
    });
    expect(verifier.check('G1', ['SS2']).ok).toBe(true);
  });

  it('uses token boundaries so short labels do not pass on unrelated substrings', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Age'],
        requiredVisibleText: ['Age'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action', {
      tool: 'click',
      args: { selector: '#profile' },
    });
    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: 'homepage profile settings',
    });
    expect(verifier.check('G1', ['OBS1'])).toEqual({
      ok: false,
      missing: ['Age'],
      required: ['Age'],
    });

    verifier.recordTraceEvent('OBS2', 'observation', {
      summary: 'Age: 42',
    });
    expect(verifier.check('G1', ['OBS2']).ok).toBe(true);
  });

  it('accepts approximate BMI result text and selected unit mode evidence', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Metric Units tab active', 'BMI near 29.4 kg/m2', 'Overweight category'],
        requiredVisibleText: [
          'Metric Units tab active',
          'BMI near 29.4 kg/m2',
          'Overweight category',
        ],
      },
      {
        goalId: 'G2',
        requiredOutputs: ['Other Units tab active', 'BMI near 28.1 kg/m2'],
        requiredVisibleText: ['Other Units tab active', 'BMI near 28.1 kg/m2'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action', {
      tool: 'click',
      args: { selector: '#calculate' },
    });
    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary:
        'BMI Calculator US Units Metric Units Other Units Result BMI = 29.4 kg/m2 (Overweight) Healthy BMI range: 18.5 kg/m2 - 25 kg/m2',
      perception_state: {
        url: 'https://www.calculator.net/bmi-calculator.html?ctype=metric&x=Calculate',
        elements: [{ selector: 'li#menuon a', text: 'Metric Units' }, { text: 'Other Units' }],
      },
    });

    expect(verifier.check('G1', ['OBS1']).ok).toBe(true);
    expect(verifier.check('G2', ['OBS1'])).toMatchObject({
      ok: false,
      missing: ['Other Units tab active', 'BMI near 28.1 kg/m2'],
    });
  });

  it('reports unknown and unacceptable evidence ids', () => {
    const verifier = new ScenarioCompletionGateVerifier([]);
    verifier.recordTraceEvent('OBS_PRE', 'observation', { summary: 'pre-action' });
    verifier.recordTraceEvent('ACTION1', 'action', { tool: 'click', args: {} });
    verifier.recordTraceEvent('RESULT1', 'action_result', { tool: 'click', ok: true });
    verifier.recordTraceEvent('OBS_POST', 'observation', { summary: 'post-action' });

    expect(verifier.checkEvidenceEventIds(['OBS_PRE', 'MISSING', 'OBS_POST'])).toEqual({
      ok: false,
      unknown: ['MISSING'],
      unacceptable: ['OBS_PRE'],
    });
  });

  it('does not accept failed actions or failed probes as verified evidence', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G1',
        requiredOutputs: ['Dashboard saved'],
        requiredVisibleText: ['Dashboard saved'],
      },
    ]);

    verifier.recordTraceEvent('ACTION1', 'action', { tool: 'click', args: { selector: '#save' } });
    verifier.recordTraceEvent('RESULT1', 'action_result', {
      tool: 'click',
      ok: false,
      error: 'missing selector',
    });
    verifier.recordTraceEvent('OBS1', 'observation', { summary: 'Dashboard saved' });
    verifier.recordTraceEvent('PROBE1', 'probe_result', {
      ok: false,
      probe: 'ui_state',
      phase: 'post-explorer',
      data: { text_sample: 'Dashboard saved' },
    });

    expect(verifier.checkEvidenceEventIds(['OBS1', 'PROBE1'])).toEqual({
      ok: false,
      unknown: [],
      unacceptable: ['OBS1', 'PROBE1'],
    });
    expect(verifier.check('G1', ['OBS1', 'PROBE1']).ok).toBe(false);
  });

  it('renders a concise prompt checklist', () => {
    expect(
      formatScenarioGatePrompt([
        {
          goalId: 'G1',
          requiredOutputs: ['Q3 Launch Roadmap'],
          requiredVisibleText: ['Q3 Launch Roadmap'],
        },
      ]),
    ).toContain('G1: Q3 Launch Roadmap');
  });
});
