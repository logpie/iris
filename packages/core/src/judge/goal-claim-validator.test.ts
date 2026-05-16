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

    expect(result.summary).toEqual({ verified_kept: 2, downgraded: 0, downgrade_reasons: [] });
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
              required_actions: ['choose a text, note, label, or annotation tool', 'enter readable text'],
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

    expect(result.summary).toEqual({ verified_kept: 1, downgraded: 0, downgrade_reasons: [] });
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

    expect(result.summary).toEqual({ verified_kept: 1, downgraded: 0, downgrade_reasons: [] });
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
    const firstGoal = judge.spec_compliance.goals[0];
    const secondGoal = judge.spec_compliance.goals[1];
    if (!firstGoal || !secondGoal) throw new Error('expected two goals');
    const applied = applyGoalClaimValidationToJudgeOutput(judge, {
      goals: [{ ...firstGoal, status: 'partial' }, secondGoal],
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
        downgraded: 1,
        downgrade_reasons: ['G1: missing artifact proof'],
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
