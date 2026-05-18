import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../trace/schema.js';
import { reconcileJudgeGoalStatusesWithTrace } from './goal-status-reconciler.js';
import type { JudgeOutput } from './judge.js';

describe('reconcileJudgeGoalStatusesWithTrace', () => {
  it('uses latest structured goal_status when Judge contradicts verified proof', () => {
    const judge = fakeJudge({
      goals: [
        {
          id: 'G4',
          description: 'Inspect the Javascript implementation section.',
          status: 'partial',
          evidence: ['OBS-old'],
          notes: "OBS-000015 does not visibly show new DataTable('#example').",
        },
      ],
      summary: 'Implementation proof remained partial.',
    });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      trace: [
        ev('OBS15', 'observation', { ref: 'OBS-000015' }),
        ev('GS4', 'goal_status', {
          id: 'G4',
          status: 'verified',
          rationale: "Observation OBS-000015 shows new DataTable('#example') and dependency URLs.",
          evidence_event_ids: ['OBS15'],
        }),
      ],
    });

    expect(result.summary.corrected).toBe(1);
    expect(result.judge.spec_compliance.goals[0]).toMatchObject({
      status: 'verified',
      evidence: ['OBS15'],
      notes: "Observation OBS-000015 shows new DataTable('#example') and dependency URLs.",
    });
    expect(result.judge.spec_compliance.goal_status_reconciliation?.reasons[0]).toContain(
      'status partial -> verified',
    );
  });

  it('also corrects overconfident Judge verified rows from latest partial status', () => {
    const judge = fakeJudge({
      goals: [
        {
          id: 'G2',
          description: 'Sort the grid.',
          status: 'verified',
          evidence: ['OBS21'],
          notes: 'All required sort proof is complete.',
        },
      ],
      summary: 'All goals verified.',
    });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      trace: [
        ev('OBS22', 'observation', { ref: 'OBS-000022' }),
        ev('GS2', 'goal_status', {
          id: 'G2',
          status: 'partial',
          rationale: 'The visible rows changed, but the required order proof is incomplete.',
          evidence_event_ids: ['OBS22'],
        }),
      ],
    });

    expect(result.judge.spec_compliance.goals[0]).toMatchObject({
      status: 'partial',
      evidence: ['OBS22'],
      notes: 'The visible rows changed, but the required order proof is incomplete.',
    });
  });

  it('does not overwrite a deterministic goal-claim validator veto', () => {
    const judge = fakeJudge({
      goals: [
        {
          id: 'G2',
          description: 'Sort the grid.',
          status: 'partial',
          evidence: ['OBS21'],
          notes:
            'Sort proof was incomplete. [goal-claim validator: product-use contract missing required actions: click salary header]',
        },
      ],
      summary: 'One goal partial.',
    });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      trace: [
        ev('OBS22', 'observation', { ref: 'OBS-000022' }),
        ev('GS2', 'goal_status', {
          id: 'G2',
          status: 'verified',
          rationale: 'Explorer claimed sort proof was complete.',
          evidence_event_ids: ['OBS22'],
        }),
      ],
    });

    expect(result.summary.corrected).toBe(0);
    expect(result.judge.spec_compliance.goals[0]).toMatchObject({
      status: 'partial',
      evidence: ['OBS21'],
    });
  });

  it('reconstructs discovery goals omitted by Judge from latest trace status', () => {
    const judge = fakeJudge({
      goals: [
        {
          id: 'G1',
          description: 'Search content',
          status: 'verified',
          evidence: ['OBS1'],
          notes: 'Observation OBS1 shows the result.',
        },
      ],
      summary: 'One goal verified.',
    });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      trace: [
        ev('DISC', 'discovery', {
          goals: [
            { id: 'G1', description: 'Search content' },
            { id: 'G2', description: 'Open history' },
          ],
        }),
        ev('OBS2', 'observation', { ref: 'OBS-000002' }),
        ev('GS2', 'goal_status', {
          id: 'G2',
          status: 'partial',
          rationale: 'History was not fully proven.',
          evidence_event_ids: ['OBS2'],
        }),
      ],
    });

    expect(result.summary.reasons).toContain('G2: added missing goal from trace');
    expect(result.judge.spec_compliance.goals).toHaveLength(2);
    expect(result.judge.spec_compliance.goals[1]).toMatchObject({
      id: 'G2',
      description: 'Open history',
      status: 'partial',
      evidence: ['OBS2'],
      notes: 'History was not fully proven.',
    });
  });

  it('does not reconstruct unknown goal_status ids as report goals', () => {
    const judge = fakeJudge({
      goals: [
        {
          id: 'G1',
          description: 'Search content',
          status: 'untested',
          evidence: [],
          notes: 'Judge omitted proof.',
        },
      ],
      summary: 'One goal untested.',
    });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      trace: [
        ev('DISC', 'discovery', {
          goals: [{ id: 'G1', description: 'Search content' }],
        }),
        ev('OBS99', 'observation', { ref: 'OBS-000099' }),
        ev('GS99', 'goal_status', {
          id: 'G99',
          status: 'verified',
          rationale: 'Hallucinated goal id.',
          evidence_event_ids: ['OBS99'],
        }),
      ],
    });

    expect(result.summary.corrected).toBe(0);
    expect(result.judge.spec_compliance.goals.map((goal) => goal.id)).toEqual(['G1']);
    expect(result.judge.spec_compliance.goals[0]?.status).toBe('untested');
  });

  it('uses explicit spec goals as the expected contract when trace has no discovery event', () => {
    const judge = fakeJudge({
      goals: [
        {
          id: 'G99',
          description: 'Invented task',
          status: 'verified',
          evidence: ['OBS99'],
          notes: 'Judge invented a verified goal.',
        },
      ],
      summary: 'Invented goal verified.',
    });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      expected_goals: [
        { id: 'G1', description: 'Create a project' },
        { id: 'G2', description: 'Invite a teammate' },
      ],
      trace: [
        ev('OBS99', 'observation', { ref: 'OBS-000099' }),
        ev('GS99', 'goal_status', {
          id: 'G99',
          status: 'verified',
          rationale: 'Hallucinated goal id.',
          evidence_event_ids: ['OBS99'],
        }),
        ev('OBS2', 'observation', { ref: 'OBS-000002' }),
        ev('GS2', 'goal_status', {
          id: 'G2',
          status: 'partial',
          rationale: 'Invite flow was incomplete.',
          evidence_event_ids: ['OBS2'],
        }),
      ],
    });

    expect(result.judge.spec_compliance.goals.map((goal) => goal.id)).toEqual(['G1', 'G2']);
    expect(result.judge.spec_compliance.goals[0]).toMatchObject({
      description: 'Create a project',
      status: 'untested',
    });
    expect(result.judge.spec_compliance.goals[1]).toMatchObject({
      description: 'Invite a teammate',
      status: 'partial',
      evidence: ['OBS2'],
    });
    expect(result.summary.reasons).toContain(
      'G99: removed unexpected Judge goal not present in discovery/proposed goals',
    );
  });

  it('allows reconstruction for explicit goal_proposed ids', () => {
    const judge = fakeJudge({ goals: [], summary: 'Judge omitted proposed goal.' });
    const result = reconcileJudgeGoalStatusesWithTrace({
      judge,
      trace: [
        ev('DISC', 'discovery', {
          goals: [{ id: 'G1', description: 'Search content' }],
        }),
        ev('GP2', 'goal_proposed', {
          id: 'G2',
          description: 'Check the account menu',
        }),
        ev('OBS2', 'observation', { ref: 'OBS-000002' }),
        ev('GS2', 'goal_status', {
          id: 'G2',
          status: 'verified',
          rationale: 'Account menu was verified.',
          evidence_event_ids: ['OBS2'],
        }),
      ],
    });

    expect(result.judge.spec_compliance.goals.map((goal) => goal.id)).toEqual(['G1', 'G2']);
    expect(result.judge.spec_compliance.goals[1]).toMatchObject({
      description: 'Check the account menu',
      status: 'verified',
      evidence: ['OBS2'],
    });
  });
});

function fakeJudge(input: {
  goals: JudgeOutput['spec_compliance']['goals'];
  summary: string;
}): JudgeOutput {
  return {
    v: 1,
    findings: [],
    discarded_findings: [],
    scores: {
      overall: { score: 8, weighted_from: ['quality'] },
      profiles: {
        quality: {
          score: 8,
          dimensions: {
            correctness: { score: 8, rationale: 'ok', evidence: [] },
          },
        },
      },
    },
    spec_compliance: {
      applicable: true,
      goals: input.goals,
      summary: input.summary,
    },
    coverage_review: {
      surfaces_explored: 1,
      surfaces_unexplored: 0,
      judgement: 'ok',
    },
    meta: {
      confidence_overall: 0.8,
      confidence_caveats: [],
      would_re_explore_with: [],
    },
  };
}

function ev(id: string, kind: TraceEvent['kind'], payload: Record<string, unknown>): TraceEvent {
  return {
    v: 1,
    id,
    ts: 1,
    step: 1,
    target_kind: 'web',
    kind,
    actor: 'system',
    payload,
  };
}
