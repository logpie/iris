import { describe, expect, it } from 'vitest';
import {
  ScenarioCompletionGateVerifier,
  buildScenarioCompletionGates,
  formatScenarioGatePrompt,
} from './scenario-completion-gate.js';

describe('scenario completion gate', () => {
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

  it('rejects verified completion when cited evidence misses a required output', () => {
    const verifier = new ScenarioCompletionGateVerifier([
      {
        goalId: 'G2',
        requiredOutputs: ['Support Triage Flow', 'Customer blocked?', 'Reproduce'],
        requiredVisibleText: ['Support Triage Flow', 'Customer blocked?', 'Reproduce'],
      },
    ]);
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
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary: 'Canvas shows Activation trend and Check onboarding drop-off annotation.',
    });

    expect(verifier.check('G1', ['OBS1']).ok).toBe(true);
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
    verifier.recordTraceEvent('OBS1', 'observation', {
      summary:
        '## RICH CONTENT\n[input input[type=text]#user-name]\nstandard_user',
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
        requiredOutputs: ['Product: Sauce Labs Backpack', 'Search: London'],
        requiredVisibleText: ['Sauce Labs Backpack', 'London'],
      },
    ]);

    verifier.recordTraceEvent('PROBE1', 'probe_result', {
      probe: 'ui_state',
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
