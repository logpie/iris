import type { OutcomeContract } from '@iris/adapter-types';
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../trace/schema.js';
import {
  applyGoalClaimValidationToJudgeOutput,
  sliceGoalWindows,
  validateGoalClaims,
} from './goal-claim-validator.js';
import type { JudgeOutput } from './judge.js';

function ev(
  id: string,
  kind: TraceEvent['kind'],
  payload: Record<string, unknown> = {},
): TraceEvent {
  return {
    v: 1,
    id,
    ts: 0,
    step: 0,
    target_kind: 'web',
    kind,
    actor: 'system',
    payload,
  };
}

function judgeWithGoals(goals: JudgeOutput['spec_compliance']['goals']): JudgeOutput {
  return {
    v: 1,
    findings: [],
    discarded_findings: [],
    scores: {
      overall: { score: 7, weighted_from: [] },
      profiles: {},
    },
    spec_compliance: {
      applicable: true,
      goals,
      summary: 'x',
    },
    coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: 'x' },
    meta: { confidence_overall: 0.5, confidence_caveats: [], would_re_explore_with: [] },
  };
}

// Stub contract: returns the listed refs as outcome artifacts.
function stubContract(refsByGoal: Record<string, string[]>): OutcomeContract {
  return {
    kind: 'test',
    collectOutcomeEvidence: ({ goal }) =>
      (refsByGoal[goal.id] ?? []).map((ref) => ({ kind: 'screenshot' as const, ref })),
  };
}

describe('sliceGoalWindows', () => {
  it('windows trace into per-goal slices using goal_status events', () => {
    const trace: TraceEvent[] = [
      ev('A', 'observation'),
      ev('B', 'action_result', { tool: 'click', ok: true }),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
      ev('D', 'observation'),
      ev('E', 'goal_status', { id: 'G2', status: 'partial' }),
    ];
    const goals = [
      { id: 'G1', description: '', status: 'verified' as const, evidence: [] },
      { id: 'G2', description: '', status: 'partial' as const, evidence: [] },
    ];
    const windows = sliceGoalWindows(trace, goals);
    expect(windows.get('G1')?.map((e) => e.id)).toEqual(['A', 'B', 'C']);
    expect(windows.get('G2')?.map((e) => e.id)).toEqual(['D', 'E']);
  });

  it('windows interleaved parallel traces by session_id', () => {
    const trace: TraceEvent[] = [
      ev('A1', 'action_result', { tool: 'press', ok: true, session_id: 'session-0' }),
      ev('A2', 'observation', { session_id: 'session-0' }),
      ev('B1', 'action_result', { tool: 'click', ok: true, session_id: 'session-1' }),
      ev('B2', 'observation', { session_id: 'session-1' }),
      ev('B3', 'goal_status', { id: 'G2', status: 'verified', session_id: 'session-1' }),
      ev('A3', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['A2'],
        session_id: 'session-0',
      }),
    ];
    const goals = [
      { id: 'G1', description: '', status: 'verified' as const, evidence: ['A2'] },
      { id: 'G2', description: '', status: 'verified' as const, evidence: ['B2'] },
    ];
    const windows = sliceGoalWindows(trace, goals);
    expect(windows.get('G1')?.map((e) => e.id)).toEqual(['A1', 'A2', 'A3']);
    expect(windows.get('G2')?.map((e) => e.id)).toEqual(['B1', 'B2', 'B3']);
  });

  it('preserves earlier action evidence when a goal is later re-marked verified', () => {
    const trace: TraceEvent[] = [
      ev('A1', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('A2', 'observation'),
      ev('A3', 'goal_status', { id: 'G1', status: 'partial' }),
      ev('B1', 'action_result', { tool: 'paste', ok: true }),
      ev('B2', 'goal_status', { id: 'G2', status: 'partial' }),
      ev('A4', 'observation'),
      ev('A5', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['A4'] }),
      ev('B3', 'goal_status', { id: 'G2', status: 'verified' }),
    ];
    const goals = [
      { id: 'G1', description: '', status: 'verified' as const, evidence: ['A4'] },
      { id: 'G2', description: '', status: 'verified' as const, evidence: ['B2'] },
    ];
    const windows = sliceGoalWindows(trace, goals);
    expect(windows.get('G1')?.map((e) => e.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(windows.get('G2')?.map((e) => e.id)).toEqual(['B1', 'B2', 'B3']);
  });

  it('gives empty window to goals with no goal_status event', () => {
    const trace: TraceEvent[] = [ev('A', 'observation')];
    const goals = [{ id: 'G1', description: '', status: 'untested' as const, evidence: [] }];
    expect(sliceGoalWindows(trace, goals).get('G1')).toEqual([]);
  });
});

describe('validateGoalClaims', () => {
  it('returns no-op summary when no contract', () => {
    const judge = judgeWithGoals([
      { id: 'G1', description: 'x', status: 'verified', evidence: ['screenshot-X.png'] },
    ]);
    const result = validateGoalClaims({ judge, trace: [] });
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps verified when the Judge cites an outcome artifact', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'draw a rectangle',
        status: 'verified',
        evidence: ['screenshot-X.png'],
        notes: 'rectangle visible on canvas after drag',
      },
    ]);
    const contract = stubContract({ G1: ['screenshot-X.png'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('preserves partial when cited evidence satisfies the product-use contract', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'complete checkout', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['commerce_checkout'],
          primary_value_loop: 'Complete a purchase.',
          core_artifacts: ['checkout confirmation'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Complete checkout',
              journey_id: 'J1',
              required_outputs: ['Checkout complete'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', { summary: 'Checkout complete confirmation is visible.' }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'partial',
        evidence_event_ids: ['B'],
        rationale: 'Checkout complete confirmation is visible, but status was conservative.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'complete checkout',
        status: 'partial',
        evidence: ['B'],
        notes: 'Observation B shows Checkout complete confirmation after submit.',
      },
    ]);
    const contract = stubContract({ G1: ['B'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.verified_kept).toBe(0);
    expect(result.summary.partial_upgraded).toBe(0);
    expect(result.summary.partial_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('partial');
    expect(result.goals[0]?.notes).toContain('validator does not upgrade partial claims');
  });

  it('keeps partial when the claim explicitly says proof is incomplete', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'inspect reference tables', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['calculator_tool'],
          primary_value_loop: 'Use calculator reference content.',
          core_artifacts: ['reference table'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Inspect reference tables',
              journey_id: 'J1',
              required_outputs: ['BMI table for adults', 'Chart for boys'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'screenshot', ok: true }),
      ev('B', 'observation', {
        summary: 'BMI table for adults and Chart for boys are visible in the reference area.',
      }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'partial',
        evidence_event_ids: ['B'],
        rationale:
          'Screenshots were captured, but full adult and child table proof remained partial.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'inspect reference tables',
        status: 'partial',
        evidence: ['B'],
        notes: 'The cited evidence does not fully prove all required reference table details.',
      },
    ]);
    const contract = stubContract({ G1: ['B'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.partial_upgraded).toBe(0);
    expect(result.summary.partial_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('partial');
    expect(result.goals[0]?.notes).toContain('partial explicitly reported incomplete proof');
  });

  it('rewrites stale Judge summary when validation preserves a partial goal', () => {
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'complete checkout',
        status: 'partial',
        evidence: ['B'],
        notes: 'Observation B shows Checkout complete confirmation after submit.',
      },
    ]);
    judge.spec_compliance.summary = 'Checkout remained partial.';
    const goal = judge.spec_compliance.goals[0];
    if (!goal) throw new Error('expected goal');

    const applied = applyGoalClaimValidationToJudgeOutput(judge, {
      goals: [
        {
          ...goal,
          notes: `${goal.notes} [goal-claim validator: partial claim preserved; validator does not upgrade partial claims]`,
        },
      ],
      summary: {
        verified_kept: 0,
        partial_upgraded: 0,
        partial_kept: 1,
        downgraded: 0,
        downgrade_reasons: [],
        partial_reasons: ['G1: partial claim preserved; validator does not upgrade partial claims'],
      },
    });

    expect(applied.spec_compliance.summary).toBe(
      'Goal evidence validation kept 1 partial claim as partial. Final goal status: 1 partial.',
    );
    expect(applied.spec_compliance.goal_claim_validation?.partial_upgraded).toBe(0);
    expect(applied.spec_compliance.goal_claim_validation?.partial_kept).toBe(1);
    expect(applied.meta.confidence_caveats).toContain(
      '1 partial goal claim(s) stayed partial after deterministic evidence validation.',
    );
  });

  it('records why a partial goal stays partial', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'goal_status', {
        id: 'G1',
        status: 'partial',
        evidence_event_ids: ['A'],
        rationale: 'Only the panel opened; no final artifact was visible.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'draw a rectangle',
        status: 'partial',
        evidence: ['A'],
        notes: 'Only the panel opened; no final artifact was visible.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: [] }),
    });

    expect(result.summary.partial_kept).toBe(1);
    expect(result.summary.partial_reasons?.[0]).toContain('no outcome-shaped evidence');
    expect(result.goals[0]?.status).toBe('partial');
    expect(result.goals[0]?.notes).toContain('outcome not confirmed');
  });

  it('does not accept typed credentials alone as post-login proof', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'sign in as standard_user', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['auth_account'],
          primary_value_loop: 'Sign in and reach authenticated inventory.',
          core_artifacts: ['authenticated inventory page'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Log in as standard_user',
              journey_id: 'J1',
              required_outputs: [
                'standard_user credentials submitted',
                'Authenticated product or inventory content visible',
                'Login error absent',
              ],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'type', ok: true }),
      ev('B', 'observation', { summary: 'Login\nUsername\nstandard_user\nPassword\nsecret_sauce' }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'standard_user credentials were entered.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'sign in as standard_user',
        status: 'verified',
        evidence: ['B'],
        notes: 'standard_user credentials were entered into the login form.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });
    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('Products');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('accepts post-login inventory text and probe_result selector values as scenario proof', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'sign in as standard_user', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['auth_account'],
          primary_value_loop: 'Sign in and reach authenticated inventory.',
          core_artifacts: ['authenticated inventory page'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Log in as standard_user',
              journey_id: 'J1',
              required_outputs: [
                'standard_user credentials submitted',
                'Authenticated product or inventory content visible',
                'Login error absent',
              ],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'type', ok: true }),
      ev('B', 'probe_result', {
        probe: 'ui_state',
        data: {
          selectors: [{ selector: '.title', text: 'Products' }],
        },
      }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'Products inventory is visible after login.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'sign in as standard_user',
        status: 'verified',
        evidence: ['B'],
        notes: 'Products inventory is visible after login.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('downgrades verified → partial when no outcome artifact exists', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'vision_click', ok: true }),
      ev('B', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'draw a rectangle',
        status: 'verified',
        evidence: ['some-ref'],
        notes: 'properties panel appeared when tool was selected',
      },
    ]);
    const contract = stubContract({}); // no outcome
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.status).toBe('partial');
    expect(result.goals[0]?.notes).toMatch(/goal-claim validator/);
  });

  it('downgrades when outcome artifacts exist but Judge cites none of them', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'vision_click', ok: true }),
      ev('B', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'draw a rectangle',
        status: 'verified',
        evidence: ['unrelated-ref'],
        notes: 'I think it worked',
      },
    ]);
    const contract = stubContract({ G1: ['actual-screenshot.png'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('downgrades verified → partial when notes field is empty (Phase 14 mandatory notes)', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'add a todo',
        status: 'verified',
        evidence: ['B'],
        // notes omitted — should be auto-downgraded.
      },
    ]);
    const contract = stubContract({ G1: ['B'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.status).toBe('partial');
    expect(result.goals[0]?.notes).toMatch(/missing audit notes/);
  });

  it('keeps verified when notes contain substantive explanation (≥20 chars)', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'draw a rectangle',
        status: 'verified',
        evidence: ['B'],
        notes: 'Post-drag observation OBS-000003 contains rectangle in canvas outline.',
      },
    ]);
    const contract = stubContract({ G1: ['B'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('downgrades verified goals that miss product-use required actions', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a board object', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create visible canvas content.',
          core_artifacts: ['visible shape on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create visible shape',
              journey_id: 'J1',
              required_actions: [
                'select a drawing or shape tool',
                'drag on canvas',
                'change one or more style controls such as color, fill, dash, or size',
              ],
              expected_artifact: 'visible created shape',
              acceptable_evidence: ['post-action screenshot showing shape'],
              weak_evidence: ['toolbar selected'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a board object',
        status: 'verified',
        evidence: ['B'],
        notes: 'Post-action observation shows a created shape on the canvas.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });
    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('missing required actions');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('does not require optional product-use actions', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Add a second content type', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create visible canvas content.',
          core_artifacts: ['visible board content'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Add a second content type',
              journey_id: 'J1',
              required_actions: [
                'create or place visible content on the canvas',
                'add readable text or a note',
                'optionally insert media or an embed',
              ],
              expected_artifact: 'visible second content type',
              acceptable_evidence: ['post-action screenshot showing content'],
              weak_evidence: ['toolbar selected'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'action_result', { tool: 'type', ok: true }),
      ev('C', 'observation'),
      ev('D', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Add a second content type',
        status: 'verified',
        evidence: ['C'],
        notes: 'A text note was added alongside the existing canvas object.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['C'] }),
    });
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('downgrades verified goals whose notes match product-use weak evidence', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a board object', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create visible canvas content.',
          core_artifacts: ['visible shape on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create visible shape',
              journey_id: 'J1',
              required_actions: ['drag on canvas'],
              expected_artifact: 'visible created shape',
              acceptable_evidence: ['post-action screenshot showing shape'],
              weak_evidence: ['toolbar selected'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a board object',
        status: 'verified',
        evidence: ['B'],
        notes: 'The toolbar selected state changed after choosing the shape tool.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });
    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('rejected weak evidence');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('downgrades artifact-editor goals when evidence is a shallow single-object proof', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a meaningful board artifact', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and edit visible canvas content.',
          core_artifacts: ['composed visible canvas artifact'],
          value_loops: [
            {
              id: 'VL1',
              title: 'Create and edit a canvas artifact',
              artifact: 'composed visible canvas artifact',
              required_capabilities: [
                'create or place visible content on the canvas',
                'add readable text, a label, a connector, media, or a second object',
                'modify an existing object with style, size, position, or structure change',
              ],
              proof_obligations: [
                'The canvas contains a composed artifact, not just an activated tool or empty board.',
                'At least one existing canvas object is visibly edited, styled, moved, resized, or connected.',
              ],
              weak_evidence: ['single trivial mark with no edit or composition'],
            },
          ],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create meaningful board content',
              value_loop_id: 'VL1',
              journey_id: 'J1',
              required_actions: [
                'create or place visible content on the canvas',
                'add readable text, a label, a connector, media, or a second object',
                'modify an existing object with style, size, position, or structure change',
              ],
              proof_obligations: [
                'The canvas contains a composed artifact, not just an activated tool or empty board.',
                'At least one existing canvas object is visibly edited, styled, moved, resized, or connected.',
              ],
              expected_artifact: 'composed visible canvas artifact with edited object state',
              acceptable_evidence: [
                'post-action screenshot showing multiple/edited canvas elements',
              ],
              weak_evidence: ['single trivial mark with no edit or composition'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a meaningful board artifact',
        status: 'verified',
        evidence: ['B'],
        notes: 'A rectangle is visible on the canvas after dragging.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toMatch(
      /missing required actions|materiality floor/,
    );
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('downgrades named scenarios when cited evidence omits the required content', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a launch planning board', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create a named planning board.',
          core_artifacts: ['launch planning board'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create a launch planning board',
              journey_id: 'J1',
              scenario_brief:
                'Create a small launch planning board titled "Launch plan" with two labeled steps, "Draft" and "Review", a connector or arrow between them, and one visible style change.',
              test_data: ['Launch plan', 'Draft', 'Review'],
              required_actions: [
                'create or place visible content on the canvas',
                'type readable labels',
                'change one style control such as color or fill',
              ],
              expected_artifact: 'composed launch planning board',
              required_outputs: [
                'readable title or note "Launch plan"',
                'two labeled canvas elements: "Draft" and "Review"',
              ],
              acceptable_evidence: ['post-action screenshot showing named board content'],
              weak_evidence: ['generic rectangle and note only'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'action_result', { tool: 'type', ok: true }),
      ev('C', 'action_result', { tool: 'click', ok: true }),
      ev('D', 'observation', { summary: 'Canvas shows a rectangle, a note, and a styled arrow.' }),
      ev('E', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['D'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a launch planning board',
        status: 'verified',
        evidence: ['D'],
        notes: 'The evidence shows a rectangle, a note, and a styled arrow on the board.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['D'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain(
      'scenario-specific proof missing required content',
    );
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('keeps named scenarios verified when evidence shows the required content', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a launch planning board', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create a named planning board.',
          core_artifacts: ['launch planning board'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create a launch planning board',
              journey_id: 'J1',
              scenario_brief:
                'Create a small launch planning board titled "Launch plan" with two labeled steps, "Draft" and "Review", a connector or arrow between them, and one visible style change.',
              test_data: ['Launch plan', 'Draft', 'Review'],
              required_actions: [
                'create or place visible content on the canvas',
                'type readable labels',
                'change one style control such as color or fill',
              ],
              expected_artifact: 'composed launch planning board',
              required_outputs: [
                'readable title or note "Launch plan"',
                'two labeled canvas elements: "Draft" and "Review"',
              ],
              acceptable_evidence: ['post-action screenshot showing named board content'],
              weak_evidence: ['generic rectangle and note only'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'action_result', { tool: 'type', ok: true }),
      ev('C', 'action_result', { tool: 'click', ok: true }),
      ev('D', 'observation', {
        summary:
          'Canvas shows Launch plan with Draft and Review labels connected by an arrow; the Review box has a blue fill.',
      }),
      ev('E', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['D'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a launch planning board',
        status: 'verified',
        evidence: ['D'],
        notes:
          'The post-action evidence shows Launch plan, Draft, and Review labels connected by an arrow with styling.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['D'] }),
    });

    expect(result.summary.downgraded).toBe(0);
    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('uses required outputs rather than metadata-heavy test data for scenario proof', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a Q3 Launch Roadmap', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and refine visible canvas content.',
          core_artifacts: ['roadmap board'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create a styled launch roadmap board',
              journey_id: 'J1',
              scenario_brief:
                'Create a Q3 launch roadmap whiteboard with a title, four labeled milestone boxes, arrows between milestones, and a risk note.',
              test_data: [
                'Title: Q3 Launch Roadmap',
                'Milestones: Research, Prototype, Beta, Launch',
                'Risk note: API quota risk',
                'Owners: Ana and Bo',
                'Use at least one blue or green style and one solid or semi fill',
              ],
              required_actions: [
                'click or focus the canvas',
                'select Rectangle and place four milestone boxes',
                'select Text and type the title and milestone labels',
                'select Arrow and connect the milestone boxes',
                'select Note and add the risk note',
                'choose a non-default color or fill from the style toolbar',
              ],
              expected_artifact: 'A readable launch roadmap diagram on the canvas.',
              required_outputs: [
                'Q3 Launch Roadmap',
                'Research',
                'Prototype',
                'Beta',
                'Launch',
                'API quota risk',
              ],
              acceptable_evidence: ['post-action screenshot showing named roadmap content'],
              weak_evidence: ['toolbar selection without visible roadmap content'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'action_result', { tool: 'type', ok: true }),
      ev('C', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('D', 'action_result', { tool: 'click', ok: true }),
      ev('E', 'observation', {
        summary:
          'Canvas shows Q3 Launch Roadmap with Research, Prototype, Beta, Launch, API quota risk, and Owners: Ana and Bo.',
      }),
      ev('F', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['E'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a Q3 Launch Roadmap',
        status: 'verified',
        evidence: ['E'],
        notes: 'Visible roadmap shows Research, Prototype, Beta, Launch, risk, and owners.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['E'] }),
    });

    expect(result.summary.downgraded).toBe(0);
    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('does not require procedural scenario instructions as visible text', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Export the current board', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and export a board.',
          core_artifacts: ['board export'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Export or download the board',
              journey_id: 'J1',
              scenario_brief:
                'Use the page menu to export or download the board created in-session.',
              test_data: [
                'Use the current board created in J1 or J2',
                'Prefer Download or an export format surfaced by the menu',
              ],
              required_actions: ['open export or download', 'complete the output action'],
              expected_artifact: 'board-linked download',
              required_outputs: ['visible export/download option or file event'],
              acceptable_evidence: ['post-action evidence showing export/download state'],
              weak_evidence: ['menu label only'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', {
        summary: 'The page menu shows Export and Download for the current board.',
      }),
      ev('C', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['B'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Export the current board',
        status: 'verified',
        evidence: ['B'],
        notes: 'The post-action evidence shows export and download choices for the current board.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps artifact-editor revision goals when proof shows a visible state delta', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          {
            id: 'G1',
            description: 'Duplicate an object and verify state changes',
            journey_id: 'J1',
          },
        ],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and revise visible canvas content.',
          core_artifacts: ['visible shape on canvas'],
          value_loops: [
            {
              id: 'VL1',
              title: 'Revise board state and history',
              artifact:
                'A board whose object count, arrangement, or history state changes through duplicate/delete/undo/redo',
              required_capabilities: [
                'duplicate an object',
                'delete an object',
                'undo and redo board changes',
                'create or place visible content on the canvas',
                'add readable text, a label, a connector, media, or a second object',
                'modify an existing object with style, size, position, or structure change',
              ],
              proof_obligations: [
                'the board visibly reflects the edit action',
                'object count or placement changes on the canvas',
                'The canvas contains a composed artifact, not just an activated tool or empty board.',
              ],
              weak_evidence: ['the history button was clicked', 'nothing on the board changes'],
            },
          ],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Duplicate, delete, or undo a board object',
              value_loop_id: 'VL1',
              journey_id: 'J1',
              required_actions: [
                'select an existing object',
                'use Duplicate, Delete, Undo, or Redo',
                'inspect the board after the action',
                'create or place visible content on the canvas',
                'add readable text, a label, a connector, media, or a second object',
                'modify an existing object with style, size, position, or structure change',
              ],
              proof_obligations: [
                'the object count or arrangement changes on the canvas',
                'the board state reflects the action clearly',
                'The canvas contains a composed artifact, not just an activated tool or empty board.',
              ],
              expected_artifact:
                'A modified board state with duplication, removal, or history reversal visible',
              acceptable_evidence: ['a copied object appears'],
              weak_evidence: ['the undo/redo button is pressed without board change'],
              risk: 'low',
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'action_result', { tool: 'click', ok: true }),
      ev('C', 'observation'),
      ev('D', 'goal_status', {
        id: 'G1',
        status: 'verified',
        rationale:
          'Duplicated a board object and the visible object count changed from 2 of 2 to 3 of 3.',
        evidence_event_ids: ['C'],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Duplicate an object and verify state changes',
        status: 'verified',
        evidence: ['C'],
        notes: 'Duplicate changed the visible board object count from 2 of 2 to 3 of 3.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['C'] }),
    });

    expect(result.summary.downgraded).toBe(0);
    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('does not apply edit/history materiality floor to media insertion jobs', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Insert media on the board', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and import visible canvas content.',
          core_artifacts: ['visible image on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Insert media or embed content',
              journey_id: 'J1',
              required_actions: [
                'upload media',
                'start from an existing artifact or object',
                'perform a visible edit, history, duplicate, delete, undo, redo, or arrangement action',
              ],
              proof_obligations: [
                'the inserted asset is visible as a board object',
                'The artifact visibly reflects the edit or history action.',
              ],
              expected_artifact: 'visible uploaded image on the canvas',
              acceptable_evidence: ['post-action screenshot showing uploaded image'],
              weak_evidence: ['file picker opened'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click_upload', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Insert media on the board',
        status: 'verified',
        evidence: ['B'],
        notes: 'Uploaded media and the inserted image appeared on the whiteboard.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('downgrades non-default shape goals when proof only shows a default rectangle', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Place a non-default shape', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create visible canvas content.',
          core_artifacts: ['visible shape on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Use a non-default shape from the shape library',
              journey_id: 'J1',
              required_actions: ['open the shape library', 'place a non-default shape'],
              proof_obligations: ['a diamond, cloud, ellipse, or similar shape is visible'],
              expected_artifact: 'non-default shape visible on canvas',
              acceptable_evidence: ['post-action screenshot showing non-default shape'],
              weak_evidence: ['rectangle placed instead'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Place a non-default shape',
        status: 'verified',
        evidence: ['B'],
        notes: 'A rectangle was created and labeled on the canvas.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });
    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('non-default shape evidence');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('keeps verified when product-use required actions and artifact evidence are present', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Create a board object', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create visible canvas content.',
          core_artifacts: ['visible shape on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create visible shape',
              journey_id: 'J1',
              required_actions: [
                'select a drawing or shape tool',
                'drag on canvas',
                'change one or more style controls such as color, fill, dash, or size',
              ],
              expected_artifact: 'visible created shape',
              acceptable_evidence: ['post-action screenshot showing shape'],
              weak_evidence: ['toolbar selected'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'press', ok: true }),
      ev('B', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('C', 'action_result', { tool: 'click', ok: true }),
      ev('D', 'observation'),
      ev('E', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a board object',
        status: 'verified',
        evidence: ['D'],
        notes:
          'Selected the shape tool, then the post-drag observation shows a created object on the canvas with a style change.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['D'] }),
    });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps batched goal_status calls when cited evidence has the required action history', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          { id: 'G1', description: 'Create a board object', journey_id: 'J1' },
          { id: 'G2', description: 'Style the board object', journey_id: 'J2' },
        ],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create and style visible canvas content.',
          core_artifacts: ['visible styled shape on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Create visible shape',
              journey_id: 'J1',
              required_actions: ['select a drawing or shape tool', 'drag on canvas'],
              expected_artifact: 'visible created shape',
              acceptable_evidence: ['post-action screenshot showing shape'],
              weak_evidence: ['toolbar selected'],
            },
            {
              id: 'PU2',
              title: 'Style visible shape',
              journey_id: 'J2',
              required_actions: ['create or select an object', 'change color or fill controls'],
              expected_artifact: 'visible styled shape',
              acceptable_evidence: ['post-action screenshot showing style change'],
              weak_evidence: ['style toolbar visible'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'press', ok: true }),
      ev('B', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('C', 'observation'),
      ev('D', 'action_result', { tool: 'click', ok: true }),
      ev('E', 'observation'),
      ev('S1', 'goal_status', {
        id: 'G1',
        status: 'verified',
        rationale: 'Selected a shape tool and dragged a visible shape onto the canvas.',
        evidence_event_ids: ['C'],
      }),
      ev('S2', 'goal_status', {
        id: 'G2',
        status: 'verified',
        rationale: 'Changed fill controls and observed the visible styled shape.',
        evidence_event_ids: ['E'],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Create a board object',
        status: 'verified',
        evidence: ['C'],
        notes: 'Selected a shape tool and dragged a visible object onto the canvas.',
      },
      {
        id: 'G2',
        description: 'Style the board object',
        status: 'verified',
        evidence: ['E'],
        notes: 'Changed color/fill controls and observed the visible styled object.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['C'], G2: ['E'] }),
    });

    expect(result.summary).toEqual({
      verified_kept: 2,
      partial_upgraded: 0,
      partial_kept: 0,
      downgraded: 0,
      downgrade_reasons: [],
      partial_reasons: [],
    });
    expect(result.goals.map((goal) => goal.status)).toEqual(['verified', 'verified']);
  });

  it('uses OBS refs to recover cited action history for batched goal statuses', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Add a readable note', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          primary_value_loop: 'Create meaningful board content.',
          core_artifacts: ['visible note on canvas'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Add a readable project note',
              journey_id: 'J1',
              required_actions: [
                'choose a text, note, label, or annotation tool',
                'enter readable text',
              ],
              expected_artifact: 'readable note visible on the board',
              test_data: ['Risk: dependency'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'action_result', { tool: 'type', ok: true }),
      ev('C', 'observation', {
        ref: 'OBS-000028',
        summary: 'A note labeled Risk: dependency is visible on the canvas.',
      }),
      ev('S1', 'goal_status', {
        id: 'G1',
        status: 'verified',
        rationale: 'Added a readable note labeled Risk: dependency and kept it visible.',
        evidence_event_ids: ['C'],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Add a readable note',
        status: 'verified',
        evidence: ['OBS-000028'],
        notes: 'The note text Risk: dependency was added and stayed visible on the board.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['C'] }),
    });

    expect(result.summary).toEqual({
      verified_kept: 1,
      partial_upgraded: 0,
      partial_kept: 0,
      downgraded: 0,
      downgrade_reasons: [],
      partial_reasons: [],
    });
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('does not force every scenario to satisfy broad value-loop capabilities', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Add a readable note', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['canvas_editor'],
          value_loops: [
            {
              id: 'VL1',
              title: 'Create and refine a board',
              required_capabilities: [
                'create or place visible content on the canvas',
                'add readable text, a label, a connector, media, or a second object',
                'modify an existing object with style, size, position, or structure change',
              ],
            },
          ],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Add a readable project note',
              journey_id: 'J1',
              value_loop_id: 'VL1',
              required_actions: ['enter readable text'],
              expected_artifact: 'readable note visible on the board',
              test_data: ['Risk: dependency'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'type', ok: true }),
      ev('B', 'observation', {
        summary: 'A note labeled Risk: dependency is visible on the canvas.',
      }),
      ev('S1', 'goal_status', {
        id: 'G1',
        status: 'verified',
        rationale: 'Added a readable note labeled Risk: dependency and kept it visible.',
        evidence_event_ids: ['B'],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Add a readable note',
        status: 'verified',
        evidence: ['B'],
        notes: 'The note text Risk: dependency was added and stayed visible on the board.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary).toEqual({
      verified_kept: 1,
      partial_upgraded: 0,
      partial_kept: 0,
      downgraded: 0,
      downgrade_reasons: [],
      partial_reasons: [],
    });
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps verified when terse Judge notes have a substantive Explorer rationale', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        rationale: 'The Terms of Use page loaded from the Wikimedia legal destination.',
        evidence_event_ids: ['B'],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'open terms',
        status: 'verified',
        evidence: ['B'],
        notes: 'Terms page loaded.',
      },
    ]);
    const contract = stubContract({ G1: ['B'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
    expect(result.goals[0]?.notes).toContain('Explorer rationale');
  });

  it('keeps verified when Judge cites goal_status that points to outcome evidence', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation'),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'open a page',
        status: 'verified',
        evidence: ['C'],
        notes: 'Goal status cites observation B showing the destination page.',
      },
    ]);
    const contract = stubContract({ G1: ['B'] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps verified when Judge evidence has a unique stable-prefix trace id typo', () => {
    const actual = '01KRM5RG87DRXMHMXGXVVKAVGF';
    const typo = '01KRM5RG87DRXMHMXGVVWXKAVGF';
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev(actual, 'observation'),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: [actual],
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'open Japanese Wikipedia',
        status: 'verified',
        evidence: [typo],
        notes: 'Japanese Wikipedia homepage loaded after choosing the language link.',
      },
    ]);
    const contract = stubContract({ G1: [actual] });
    const result = validateGoalClaims({ judge, trace, outcome_contract: contract });
    expect(result.summary.verified_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps out-of-order verified goals when their cited observation is outcome-shaped', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation'),
      ev('C', 'action_result', { tool: 'click', ok: true }),
      ev('D', 'observation'),
      ev('E', 'goal_status', { id: 'G2', status: 'verified' }),
      ev('F', 'goal_status', { id: 'G1', status: 'verified' }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'open the main menu',
        status: 'verified',
        evidence: ['B'],
        notes: 'Observation B shows the opened menu after the click.',
      },
      {
        id: 'G2',
        description: 'open another page',
        status: 'verified',
        evidence: ['D'],
        notes: 'Observation D shows another destination after clicking a link.',
      },
    ]);
    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: {
        kind: 'test',
        collectOutcomeEvidence: ({ goal_events }) => {
          const hasInteraction = goal_events.some(
            (e) =>
              e.kind === 'action_result' && e.payload.tool === 'click' && e.payload.ok === true,
          );
          if (!hasInteraction) return [];
          return goal_events
            .filter((e) => e.kind === 'observation')
            .map((e) => ({ kind: 'screenshot' as const, ref: e.id }));
        },
      },
    });

    expect(result.summary).toEqual({
      verified_kept: 2,
      partial_upgraded: 0,
      partial_kept: 0,
      downgraded: 0,
      downgrade_reasons: [],
      partial_reasons: [],
    });
    expect(result.goals.map((g) => g.status)).toEqual(['verified', 'verified']);
  });

  it('keeps calculator goals verified when cited proof uses near-number and active-unit semantics', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          {
            id: 'G1',
            description: 'Switch to Metric Units and calculate BMI near 29.4',
            journey_id: 'J1',
          },
        ],
        product_use_contract: {
          product_kinds: ['calculator_tool'],
          primary_value_loop: 'Calculate BMI and read the result.',
          core_artifacts: ['BMI result panel'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Metric BMI calculation',
              journey_id: 'J1',
              required_actions: ['Click Calculate.', 'submit or calculate the result'],
              required_outputs: [
                'Metric Units tab active',
                'BMI near 29.4 kg/m2',
                'Overweight category',
              ],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', {
        summary:
          'BMI Calculator US Units Metric Units Other Units Result BMI = 29.4 kg/m2 (Overweight) Healthy BMI range: 18.5 kg/m2 - 25 kg/m2',
        perception_state: {
          url: 'https://www.calculator.net/bmi-calculator.html?ctype=metric&x=Calculate',
          elements: [{ selector: 'li#menuon a', text: 'Metric Units' }],
        },
      }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'Metric calculation result shows BMI 29.4 Overweight.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Switch to Metric Units and calculate BMI near 29.4',
        status: 'verified',
        evidence: ['B'],
        notes: 'Observation B shows BMI 29.4 Overweight after a metric calculation.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('downgrades verified claims when notes or Explorer rationale explicitly say proof is incomplete', () => {
    const trace: TraceEvent[] = [
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', { summary: 'Result panel opened.' }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'The result panel opened, but could not verify the final calculated result.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'calculate result',
        status: 'verified',
        evidence: ['B'],
        notes: 'Result panel was observed, but final result proof is incomplete.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('incomplete-proof');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('does not let non-visible metadata satisfy required scenario outputs', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Complete checkout', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['commerce_checkout'],
          primary_value_loop: 'Reach checkout confirmation.',
          core_artifacts: ['confirmation state'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Checkout',
              journey_id: 'J1',
              required_outputs: ['Checkout complete'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', {
        summary: 'Cart page is still visible.',
        perception_state: {
          url: 'https://shop.example/checkout-complete',
          elements: [
            { selector: '#checkout-complete', role: 'status', value: 'Checkout complete' },
          ],
        },
      }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'Checkout complete is implied by the URL.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Complete checkout',
        status: 'verified',
        evidence: ['B'],
        notes: 'The URL changed to checkout-complete after clicking.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('Checkout complete');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('does not borrow previous goal evidence for scenario-specific proof', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          { id: 'G1', description: 'Show Alpha', journey_id: 'J1' },
          { id: 'G2', description: 'Show Alpha again', journey_id: 'J2' },
        ],
        product_use_contract: {
          product_kinds: ['calculator_tool'],
          primary_value_loop: 'Produce scenario-specific results.',
          core_artifacts: ['result panel'],
          user_jobs: [
            { id: 'PU1', title: 'First', journey_id: 'J1', required_outputs: ['Alpha result'] },
            { id: 'PU2', title: 'Second', journey_id: 'J2', required_outputs: ['Alpha result'] },
          ],
        },
      }),
      ev('A1', 'action_result', { tool: 'click', ok: true }),
      ev('B1', 'observation', { summary: 'Alpha result' }),
      ev('C1', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['B1'] }),
      ev('A2', 'action_result', { tool: 'click', ok: true }),
      ev('B2', 'observation', { summary: 'Beta result' }),
      ev('C2', 'goal_status', { id: 'G2', status: 'verified', evidence_event_ids: ['B2'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Show Alpha',
        status: 'verified',
        evidence: ['B1'],
        notes: 'Alpha result was visible after the first action.',
      },
      {
        id: 'G2',
        description: 'Show Alpha again',
        status: 'verified',
        evidence: ['B2'],
        notes: 'Second goal cited its own observation after the second action.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B1'], G2: ['B2'] }),
    });

    expect(result.goals[0]?.status).toBe('verified');
    expect(result.goals[1]?.status).toBe('partial');
    expect(result.summary.downgrade_reasons[0]).toContain('Alpha result');
  });

  it('rejects evidence already cited by a previous different goal', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          { id: 'G1', description: 'Show Alpha', journey_id: 'J1' },
          { id: 'G2', description: 'Show Alpha again', journey_id: 'J2' },
        ],
        product_use_contract: {
          product_kinds: ['calculator_tool'],
          primary_value_loop: 'Produce scenario-specific results.',
          core_artifacts: ['result panel'],
          user_jobs: [
            { id: 'PU1', title: 'First', journey_id: 'J1', required_outputs: ['Alpha result'] },
            { id: 'PU2', title: 'Second', journey_id: 'J2', required_outputs: ['Alpha result'] },
          ],
        },
      }),
      ev('A1', 'action_result', { tool: 'click', ok: true }),
      ev('B1', 'observation', { summary: 'Alpha result' }),
      ev('C1', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['B1'] }),
      ev('A2', 'action_result', { tool: 'click', ok: true }),
      ev('B2', 'observation', { summary: 'Beta result' }),
      ev('C2', 'goal_status', { id: 'G2', status: 'verified', evidence_event_ids: ['B1'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Show Alpha',
        status: 'verified',
        evidence: ['B1'],
        notes: 'Alpha result was visible after the first action.',
      },
      {
        id: 'G2',
        description: 'Show Alpha again',
        status: 'verified',
        evidence: ['B1'],
        notes: 'The second goal reused the prior Alpha observation.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B1'], G2: ['B1'] }),
    });

    expect(result.goals[0]?.status).toBe('verified');
    expect(result.goals[1]?.status).toBe('partial');
    expect(result.summary.downgrade_reasons[0]).toMatch(/Alpha result|outcome artifact/);
  });

  it('does not synthesize scenario proof phrases across separate evidence events', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Complete checkout', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['commerce_checkout'],
          primary_value_loop: 'Complete checkout.',
          core_artifacts: ['checkout confirmation'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Complete checkout',
              journey_id: 'J1',
              required_outputs: ['Checkout complete'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', { summary: 'Checkout page' }),
      ev('C', 'observation', { summary: 'Task complete' }),
      ev('D', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['B', 'C'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Complete checkout',
        status: 'verified',
        evidence: ['B', 'C'],
        notes: 'Cited evidence contains checkout and complete words.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B', 'C'] }),
    });

    expect(result.goals[0]?.status).toBe('partial');
    expect(result.summary.downgrade_reasons[0]).toContain('Checkout complete');
  });

  it('does not let one action satisfy multiple required actions', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Export report', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['dashboard_filtering'],
          primary_value_loop: 'Export a report.',
          core_artifacts: ['downloaded report'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Export report',
              journey_id: 'J1',
              required_actions: ['Open the export menu', 'Click the CSV export button'],
              required_outputs: ['Export complete'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', { summary: 'Export complete' }),
      ev('C', 'goal_status', { id: 'G1', status: 'verified', evidence_event_ids: ['B'] }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Export report',
        status: 'verified',
        evidence: ['B'],
        notes: 'Export complete is visible after one click.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.goals[0]?.status).toBe('partial');
    expect(result.summary.downgrade_reasons[0]).toContain('click the csv export button');
  });

  it('keeps data-grid proof verified when actions and visible row output are present', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G1', description: 'Filter table for Tokyo', journey_id: 'J1' }],
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use table controls.',
          core_artifacts: ['filtered table state'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter table',
              journey_id: 'J1',
              required_actions: [
                'Click the table Search input next to the employee table.',
                'Type Tokyo.',
                'Observe the table body and summary text.',
                'apply a table search, sort, page-length, pagination, grouping, or row-detail control',
                'inspect the resulting table rows, count, order, or detail state',
              ],
              required_outputs: ['Airi Satou', 'filtered from 57 total entries'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'action_result', { tool: 'type', ok: true }),
      ev('C', 'observation', {
        summary:
          'Airi Satou Accountant Tokyo 33 2008-11-28 $162,700\nShowing 1 to 5 of 5 entries (filtered from 57 total entries)',
      }),
      ev('D', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['C'],
        rationale: 'Tokyo filter shows Airi Satou and a filtered-from-57 summary.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Filter table for Tokyo',
        status: 'verified',
        evidence: ['C'],
        notes: 'Airi Satou is visible in the filtered Tokyo results with a filtered count.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['C'] }),
    });

    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('matches same-journey product-use jobs before enforcing required outputs', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          {
            id: 'G3',
            description: 'Set 25 entries per page and verify Showing 26 to 50 of 57 entries.',
            journey_id: 'J1',
          },
        ],
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed grid state'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter the employee table to London rows',
              journey_id: 'J1',
              required_outputs: ['London', 'filtered from 57 total entries'],
            },
            {
              id: 'PU2',
              title: 'Sort employees by age',
              journey_id: 'J1',
              required_outputs: ['Age', '19', '20', '21'],
            },
            {
              id: 'PU3',
              title: 'Change page length and move to the next page',
              journey_id: 'J1',
              required_actions: [
                'Open the entries per page select',
                'Choose 25',
                'Click the next pagination control',
                'apply a table search, sort, page-length, pagination, grouping, or row-detail control',
                'inspect the resulting table rows, count, order, or detail state',
              ],
              required_outputs: ['25 entries per page', 'Showing 26 to 50 of 57 entries'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'select', ok: true }),
      ev('B', 'action_result', { tool: 'click', ok: true }),
      ev('C', 'observation', {
        summary:
          '25 entries per page\nShowing 26 to 50 of 57 entries\nQuinn Flynn Support Lead Edinburgh',
      }),
      ev('D', 'goal_status', {
        id: 'G3',
        status: 'verified',
        evidence_event_ids: ['C'],
        rationale: 'Page length is 25 and the second-page status is visible.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G3',
        description: 'Set 25 entries per page and verify Showing 26 to 50 of 57 entries.',
        status: 'verified',
        evidence: ['C'],
        notes: 'The page-size and second-page status text are visible.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G3: ['C'] }),
    });

    expect(result.summary.verified_kept).toBe(1);
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('uses concrete numeric test data for data-grid sort proof instead of semantic prose', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [{ id: 'G2', description: 'Sort the employee table by Age.', journey_id: 'J2' }],
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed grid state'],
          user_jobs: [
            {
              id: 'PU2',
              title: 'Sort employees by age',
              journey_id: 'J2',
              required_actions: ['Click the Age column header', 'Observe the first visible rows'],
              test_data: ['youngest visible employees such as 19, 20, 21'],
              required_outputs: ['Age', 'Employee rows with ages ordered consistently'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', {
        summary: 'Age\nTatyana Fitzpatrick 19\nShou Itou 20\nCaesar Vance 21',
      }),
      ev('C', 'goal_status', {
        id: 'G2',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'Age-sorted rows show ages 19, 20, and 21.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G2',
        description: 'Sort the employee table by Age.',
        status: 'verified',
        evidence: ['B'],
        notes: 'Age-sorted rows show ages 19, 20, and 21.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G2: ['B'] }),
    });

    expect(result.summary.verified_kept).toBe(1);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps a calculator goal partial when the required unit mode is not actually active', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          {
            id: 'G1',
            description: 'Open Other Units and calculate BMI near 28.1',
            journey_id: 'J1',
          },
        ],
        product_use_contract: {
          product_kinds: ['calculator_tool'],
          primary_value_loop: 'Calculate BMI and read the result.',
          core_artifacts: ['BMI result panel'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Other-units BMI calculation',
              journey_id: 'J1',
              required_outputs: ['Other Units tab active', 'BMI near 28.1 kg/m2'],
            },
          ],
        },
      }),
      ev('A', 'action_result', { tool: 'click', ok: true }),
      ev('B', 'observation', {
        summary:
          'BMI Calculator US Units Metric Units Other Units Result BMI = 28.1 kg/m2 (Overweight)',
        perception_state: {
          url: 'https://www.calculator.net/bmi-calculator.html?ctype=metric&x=Calculate',
          elements: [{ selector: 'li#menuon a', text: 'Metric Units' }],
        },
      }),
      ev('C', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['B'],
        rationale: 'BMI 28.1 appears but Other Units did not stay active.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Open Other Units and calculate BMI near 28.1',
        status: 'verified',
        evidence: ['B'],
        notes: 'Observation B shows BMI 28.1.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['B'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.summary.downgrade_reasons[0]).toContain('Other Units tab active');
    expect(result.goals[0]?.status).toBe('partial');
  });

  it('leaves non-verified goals untouched', () => {
    const judge = judgeWithGoals([
      { id: 'G1', description: 'x', status: 'partial', evidence: [] },
      { id: 'G2', description: 'x', status: 'blocked', evidence: [] },
      { id: 'G3', description: 'x', status: 'untested', evidence: [] },
    ]);
    const contract = stubContract({});
    const result = validateGoalClaims({ judge, trace: [], outcome_contract: contract });
    expect(result.summary.downgraded).toBe(0);
    expect(result.goals.map((g) => g.status)).toEqual(['partial', 'blocked', 'untested']);
  });

  it('uses the canonical Discovery goal text when Judge paraphrases a same-journey goal', () => {
    const trace: TraceEvent[] = [
      ev('DISC', 'discovery', {
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed table state'],
          value_loops: [],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter London rows',
              journey_id: 'J1',
              scenario_brief: 'Filter London rows.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Filtered rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['London'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
            {
              id: 'PU2',
              title: 'Sort employees by age',
              journey_id: 'J1',
              scenario_brief: 'Sort the employee table by Age ascending.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Age-sorted rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['Age', '19', '20', '21'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
          ],
        },
        goals: [
          {
            id: 'G2',
            description: 'Sort the employee table by Age and verify ascending ages.',
            journey_id: 'J1',
          },
        ],
      }),
      ev('ACT', 'action_result', { tool: 'click', ok: true }),
      ev('OBS', 'observation', { summary: 'Age column sorted: 19, 20, 21.' }),
      ev('STATUS', 'goal_status', {
        id: 'G2',
        status: 'verified',
        evidence_event_ids: ['OBS'],
        rationale: 'Observation OBS shows Age values 19, 20, 21 in sorted order.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G2',
        description: 'Use employee grid controls and verify the table changes.',
        status: 'verified',
        evidence: ['OBS'],
        notes: 'Observation OBS shows Age values 19, 20, 21 in sorted order.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G2: ['OBS'] }),
    });

    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[0]?.status).toBe('verified');
  });

  it('keeps selector-based data-grid sort proof when goal statuses are emitted late', () => {
    const trace: TraceEvent[] = [
      ev('DISCOVERY', 'discovery', {
        goals: [
          { id: 'G1', description: 'Filter the employee table for Tokyo.', journey_id: 'J1' },
          { id: 'G2', description: 'Sort the table by Salary descending.', journey_id: 'J2' },
        ],
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed grid state'],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter employees by office',
              journey_id: 'J1',
              required_actions: ['Type Tokyo into the table search.'],
              required_outputs: ['Tokyo', 'filtered from 57 total entries'],
            },
            {
              id: 'PU2',
              title: 'Sort the table by salary',
              journey_id: 'J2',
              required_actions: [
                'Clear the table search field if it contains text.',
                'Click the Salary column header.',
                'If needed, click again to reach descending order.',
                'Observe the reordered rows and Salary header sort state.',
              ],
              test_data: ['Column: Salary', 'High-salary row example: Angelica Ramos, $1,200,000'],
              required_outputs: ['Salary', '$1,200,000', 'Angelica Ramos'],
            },
          ],
        },
      }),
      ev('G1-A', 'action_result', { tool: 'type', ok: true }),
      ev('G1-E', 'observation', {
        summary: 'Tokyo rows are visible and the footer says filtered from 57 total entries.',
      }),
      ev('G2-A1', 'action', {
        tool: 'click',
        args: { selector: '#example thead th:last-child' },
      }),
      ev('G2-R1', 'action_result', { tool: 'click', ok: true }),
      {
        ...ev('G1-AUTO', 'goal_status', {
          id: 'G1',
          status: 'partial',
          evidence_event_ids: [],
          auto_cutover: true,
          rationale: 'auto-cutover after 15 turns without explicit goal_status',
        }),
        step: 6,
      },
      {
        ...ev('G1-S', 'goal_status', {
          id: 'G1',
          status: 'verified',
          evidence_event_ids: ['G1-E'],
          rationale: 'Tokyo filtered rows are visible.',
        }),
        step: 7,
      },
      {
        ...ev('G2-E', 'observation', {
          summary: 'Salary sorted descending. Angelica Ramos appears first with $1,200,000.',
        }),
        step: 7,
      },
      {
        ...ev('G2-S', 'goal_status', {
          id: 'G2',
          status: 'verified',
          evidence_event_ids: ['G2-E'],
          rationale: 'Salary descending sort is visible with Angelica Ramos and $1,200,000.',
        }),
        step: 7,
      },
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Filter the employee table for Tokyo.',
        status: 'verified',
        evidence: ['G1-E'],
        notes: 'Tokyo filtered rows are visible.',
      },
      {
        id: 'G2',
        description: 'Sort the table by Salary descending.',
        status: 'verified',
        evidence: ['G2-E'],
        notes: 'Angelica Ramos appears first with $1,200,000 after Salary sorting.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['G1-E'], G2: ['G2-E'] }),
    });

    expect(result.summary.downgraded).toBe(0);
    expect(result.goals[1]?.status).toBe('verified');
  });

  it('downgrades ambiguous same-journey product-use matches instead of skipping the contract', () => {
    const trace: TraceEvent[] = [
      ev('DISC', 'discovery', {
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed table state'],
          value_loops: [],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter London rows',
              journey_id: 'J1',
              scenario_brief: 'Filter London rows.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Filtered rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['London'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
            {
              id: 'PU2',
              title: 'Sort by age',
              journey_id: 'J1',
              scenario_brief: 'Sort by Age.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Sorted rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['Age'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
          ],
        },
        goals: [{ id: 'G1', description: 'Use table controls.', journey_id: 'J1' }],
      }),
      ev('ACT', 'action_result', { tool: 'click', ok: true }),
      ev('OBS', 'observation', { summary: 'The table changed.' }),
      ev('STATUS', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['OBS'],
        rationale: 'Observation OBS shows the table changed.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Use table controls.',
        status: 'verified',
        evidence: ['OBS'],
        notes: 'Observation OBS shows the table changed.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['OBS'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.notes).toContain('product-use contract ambiguous');
  });

  it('downgrades ambiguous no-journey product-use matches instead of skipping the contract', () => {
    const trace: TraceEvent[] = [
      ev('DISC', 'discovery', {
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use employee table controls.',
          core_artifacts: ['changed table state'],
          value_loops: [],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter London rows',
              scenario_brief: 'Filter London rows.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Filtered rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['London'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
            {
              id: 'PU2',
              title: 'Sort by age',
              scenario_brief: 'Sort by Age.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Sorted rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['Age'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
          ],
        },
        goals: [{ id: 'G1', description: 'Use table controls.' }],
      }),
      ev('ACT', 'action_result', { tool: 'click', ok: true }),
      ev('OBS', 'observation', { summary: 'The table changed.' }),
      ev('STATUS', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['OBS'],
        rationale: 'Observation OBS shows the table changed.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Use table controls.',
        status: 'verified',
        evidence: ['OBS'],
        notes: 'Observation OBS shows the table changed.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['OBS'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.notes).toContain('product-use contract ambiguous');
  });

  it('does not satisfy multiple scenario outputs from separate cited evidence events', () => {
    const trace: TraceEvent[] = [
      ev('DISC', 'discovery', {
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use table controls.',
          core_artifacts: ['changed table state'],
          value_loops: [],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter London rows',
              journey_id: 'J1',
              scenario_brief: 'Filter London rows.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Filtered rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['London', 'filtered from 57 total entries'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
          ],
        },
        goals: [{ id: 'G1', description: 'Filter London rows.', journey_id: 'J1' }],
      }),
      ev('ACT', 'action_result', { tool: 'click', ok: true }),
      ev('OBS1', 'observation', { summary: 'London rows are visible.' }),
      ev('OBS2', 'observation', { summary: 'filtered from 57 total entries.' }),
      ev('STATUS', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['OBS1', 'OBS2'],
        rationale: 'OBS1 shows London and OBS2 shows filtered from 57 total entries.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Filter London rows.',
        status: 'verified',
        evidence: ['OBS1', 'OBS2'],
        notes: 'OBS1 shows London and OBS2 shows filtered from 57 total entries.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['OBS1', 'OBS2'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.notes).toContain('scenario-specific proof missing required content');
  });

  it('does not treat mutating action_result narration as visible scenario proof', () => {
    const trace: TraceEvent[] = [
      ev('DISC', 'discovery', {
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use table controls.',
          core_artifacts: ['changed table state'],
          value_loops: [],
          user_jobs: [
            {
              id: 'PU1',
              title: 'Filter London rows',
              journey_id: 'J1',
              scenario_brief: 'Filter London rows.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Filtered rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['London'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
          ],
        },
        goals: [{ id: 'G1', description: 'Filter London rows.', journey_id: 'J1' }],
      }),
      ev('ACT', 'action_result', {
        tool: 'type',
        ok: true,
        description: 'Typed London into the search box.',
      }),
      ev('OBS', 'observation', { summary: 'No matching records found.' }),
      ev('STATUS', 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['ACT', 'OBS'],
        rationale: 'Typed London and observed the table.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'Filter London rows.',
        status: 'verified',
        evidence: ['ACT', 'OBS'],
        notes: 'Typed London and observed the table.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G1: ['OBS'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[0]?.notes).toContain('scenario-specific proof missing required content');
  });

  it('rejects stale unowned evidence from before an earlier goal status', () => {
    const trace: TraceEvent[] = [
      ev('DISC', 'discovery', {
        product_use_contract: {
          product_kinds: ['data_grid'],
          primary_value_loop: 'Use table controls.',
          core_artifacts: ['changed table state'],
          value_loops: [],
          user_jobs: [
            {
              id: 'PU2',
              title: 'Show Alpha rows',
              journey_id: 'J2',
              scenario_brief: 'Show Alpha rows.',
              required_actions: [],
              proof_obligations: [],
              expected_artifact: 'Alpha rows',
              acceptable_evidence: [],
              test_data: [],
              required_outputs: ['Alpha'],
              quality_bar: [],
              weak_evidence: [],
              risk: 'high',
            },
          ],
        },
        goals: [
          { id: 'G1', description: 'First goal.', journey_id: 'J1' },
          { id: 'G2', description: 'Show Alpha rows.', journey_id: 'J2' },
        ],
      }),
      ev('OBS1', 'observation', { summary: 'Alpha' }),
      ev('STATUS1', 'goal_status', {
        id: 'G1',
        status: 'partial',
        evidence_event_ids: [],
        rationale: 'First goal was partial.',
      }),
      ev('STATUS2', 'goal_status', {
        id: 'G2',
        status: 'verified',
        evidence_event_ids: ['OBS1'],
        rationale: 'Alpha was visible in a stale observation.',
      }),
    ];
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'First goal.',
        status: 'partial',
        evidence: [],
        notes: 'First goal was partial.',
      },
      {
        id: 'G2',
        description: 'Show Alpha rows.',
        status: 'verified',
        evidence: ['OBS1'],
        notes: 'Alpha was visible in a stale observation.',
      },
    ]);

    const result = validateGoalClaims({
      judge,
      trace,
      outcome_contract: stubContract({ G2: ['OBS1'] }),
    });

    expect(result.summary.downgraded).toBe(1);
    expect(result.goals[1]?.notes).toContain('scenario-specific proof missing');
  });

  it('rewrites stale Judge summary when validation downgrades a goal', () => {
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'search',
        status: 'verified',
        evidence: ['OBS1'],
        notes: 'Search result loaded.',
      },
      {
        id: 'G2',
        description: 'donate',
        status: 'verified',
        evidence: ['OBS2'],
        notes: 'Donate page loaded.',
      },
    ]);
    judge.spec_compliance.summary = 'All goals verified.';
    const firstGoal = judge.spec_compliance.goals[0];
    const secondGoal = judge.spec_compliance.goals[1];
    if (!firstGoal || !secondGoal) throw new Error('expected two goals');
    const applied = applyGoalClaimValidationToJudgeOutput(judge, {
      goals: [{ ...firstGoal, status: 'partial' }, secondGoal],
      summary: {
        verified_kept: 1,
        partial_upgraded: 0,
        partial_kept: 0,
        downgraded: 1,
        downgrade_reasons: ['G1: outcome artifacts exist but none cited in evidence'],
        partial_reasons: [],
      },
    });

    expect(applied.spec_compliance.summary).toBe(
      'Goal evidence validation downgraded 1 verified claim. Final goal status: 1 verified, 1 partial.',
    );
    expect(applied.meta.confidence_caveats).toContain(
      '1 verified goal claim(s) were downgraded by deterministic evidence validation.',
    );
  });

  it('removes stale goal-validation caveats before applying the current validation summary', () => {
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'inspect source code',
        status: 'verified',
        evidence: ['OBS1'],
        notes: 'Source code was visible.',
      },
    ]);
    judge.meta.confidence_caveats = [
      'G1 was downgraded by goal validation in an earlier pass.',
      'Checkout validation scenario was not tested on mobile.',
      'Network requests were not exhaustively inspected.',
    ];
    const firstGoal = judge.spec_compliance.goals[0];
    if (!firstGoal) throw new Error('expected goal');

    const applied = applyGoalClaimValidationToJudgeOutput(judge, {
      goals: [firstGoal],
      summary: {
        verified_kept: 1,
        partial_upgraded: 0,
        partial_kept: 0,
        downgraded: 0,
        downgrade_reasons: [],
        partial_reasons: [],
      },
    });

    expect(applied.meta.confidence_caveats).toEqual([
      'Checkout validation scenario was not tested on mobile.',
      'Network requests were not exhaustively inspected.',
    ]);
  });

  it('caps goal-dependent rubric scores after validated goal downgrades', () => {
    const judge = judgeWithGoals([
      {
        id: 'G1',
        description: 'create',
        status: 'verified',
        evidence: ['OBS1'],
        notes: 'Created.',
      },
      {
        id: 'G2',
        description: 'share',
        status: 'verified',
        evidence: ['OBS2'],
        notes: 'Shared.',
      },
    ]);
    judge.scores = {
      overall: { score: 9.5, weighted_from: ['quality', 'coverage'] },
      profiles: {
        quality: {
          score: 9.5,
          dimensions: {
            correctness: {
              score: 10,
              rationale: 'All goals completed.',
              evidence: ['OBS1', 'OBS2'],
            },
            polish: { score: 9, rationale: 'Looks stable.', evidence: [] },
          },
        },
        coverage: {
          score: 9.5,
          dimensions: {
            depth: { score: 10, rationale: 'Deep.', evidence: ['OBS1', 'OBS2'] },
          },
        },
      },
    };
    const firstGoal = judge.spec_compliance.goals[0];
    const secondGoal = judge.spec_compliance.goals[1];
    if (!firstGoal || !secondGoal) throw new Error('expected two goals');

    const applied = applyGoalClaimValidationToJudgeOutput(judge, {
      goals: [{ ...firstGoal, status: 'partial' }, secondGoal],
      summary: {
        verified_kept: 1,
        partial_upgraded: 0,
        partial_kept: 0,
        downgraded: 1,
        downgrade_reasons: ['G1: missing artifact proof'],
        partial_reasons: [],
      },
    });

    expect(applied.scores.overall.score).toBe(7.5);
    expect(applied.scores.profiles.quality?.score).toBe(7.5);
    expect(applied.scores.profiles.quality?.dimensions.correctness?.score).toBe(7.5);
    expect(applied.scores.profiles.quality?.dimensions.correctness?.rationale).toContain(
      '1/2 verified, 1 partial',
    );
    expect(applied.scores.profiles.quality?.dimensions.polish?.score).toBe(9);
    expect(applied.scores.profiles.coverage?.dimensions.depth?.score).toBe(7.5);
  });
});
