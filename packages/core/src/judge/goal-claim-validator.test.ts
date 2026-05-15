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

    expect(result.summary).toEqual({ verified_kept: 2, downgraded: 0, downgrade_reasons: [] });
    expect(result.goals.map((goal) => goal.status)).toEqual(['verified', 'verified']);
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

    expect(result.summary).toEqual({ verified_kept: 2, downgraded: 0, downgrade_reasons: [] });
    expect(result.goals.map((g) => g.status)).toEqual(['verified', 'verified']);
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
    const applied = applyGoalClaimValidationToJudgeOutput(judge, {
      goals: [
        { ...judge.spec_compliance.goals[0]!, status: 'partial' },
        judge.spec_compliance.goals[1]!,
      ],
      summary: {
        verified_kept: 1,
        downgraded: 1,
        downgrade_reasons: ['G1: outcome artifacts exist but none cited in evidence'],
      },
    });

    expect(applied.spec_compliance.summary).toBe(
      'Goal evidence validation downgraded 1 verified claim. Final goal status: 1 verified, 1 partial.',
    );
    expect(applied.meta.confidence_caveats).toContain(
      '1 verified goal claim(s) were downgraded by deterministic evidence validation.',
    );
  });
});
