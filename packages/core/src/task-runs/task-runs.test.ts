import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../trace/schema.js';
import { buildTaskRuns } from './task-runs.js';

describe('buildTaskRuns', () => {
  it('builds replay-oriented task runs from trace windows and evidence events', () => {
    const trace = [
      ev('OBS1', 1, 'observation', {
        ref: 'OBS-000001',
        perception_state: {
          v: 1,
          url: 'https://example.test/login',
          title: 'Login',
          screenshot_ref: 'evidence/screenshots/step-0001.png',
          elements: [
            {
              id: 'E001',
              stable_hash: 'h11111111',
              tag: 'input',
              name: 'Email',
              visible: true,
            },
          ],
        },
      }),
      ev('A1', 2, 'action', { tool: 'type', args: { selector: '#email', text: 'a@b.co' } }),
      ev('R1', 2, 'action_result', { tool: 'type', ok: true, evidence_refs: [] }),
      ev('OBS2', 2, 'observation', {
        ref: 'OBS-000002',
        perception_state: {
          v: 1,
          url: 'https://example.test/login',
          title: 'Login',
          screenshot_ref: 'evidence/screenshots/step-0002.png',
          elements: [
            {
              id: 'E001',
              stable_hash: 'h22222222',
              tag: 'button',
              name: 'Sign in',
              visible: true,
            },
          ],
        },
      }),
      ev('A2', 3, 'action', { tool: 'click', args: { selector: 'button:has-text("Sign in")' } }),
      ev('R2', 3, 'action_result', { tool: 'click', ok: true, evidence_refs: ['/tmp/click.png'] }),
      ev('OBS3', 3, 'observation', {
        ref: 'OBS-000003',
        perception_state: {
          v: 1,
          url: 'https://example.test/home',
          title: 'Home',
          screenshot_ref: 'evidence/screenshots/step-0003.png',
          elements: [
            {
              id: 'E001',
              stable_hash: 'h33333333',
              tag: 'h1',
              text: 'Welcome',
              visible: true,
            },
          ],
        },
      }),
      ev('GS1', 3, 'goal_status', {
        id: 'G1',
        status: 'verified',
        rationale: 'Home page loaded.',
        evidence_event_ids: ['OBS3'],
      }),
    ];

    const runs = buildTaskRuns({
      goals: [
        {
          id: 'G1',
          description: 'Sign in',
          status: 'verified',
          evidence: ['OBS3'],
          notes: 'Observation shows home page.',
        },
      ],
      trace,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'TR-G1',
      goal_id: 'G1',
      status: 'verified',
      goal_status_event_id: 'GS1',
      evidence_event_ids: ['OBS3'],
      replay: {
        source: 'trace',
        replayable: true,
        action_count: 2,
        successful_action_count: 2,
      },
    });
    expect(runs[0]?.actions).toEqual([
      expect.objectContaining({
        event_id: 'A1',
        result_event_id: 'R1',
        tool: 'type',
        ok: true,
        post_observation_event_id: 'OBS2',
      }),
      expect.objectContaining({
        event_id: 'A2',
        result_event_id: 'R2',
        tool: 'click',
        ok: true,
        evidence_refs: ['/tmp/click.png'],
        post_observation_event_id: 'OBS3',
      }),
    ]);
    expect(runs[0]?.observations.map((obs) => obs.event_id)).toEqual(['OBS1', 'OBS2', 'OBS3']);
    expect(runs[0]?.observations.at(-1)).toMatchObject({
      event_id: 'OBS3',
      observation_ref: 'OBS-000003',
      screenshot_ref: 'evidence/screenshots/step-0003.png',
      url: 'https://example.test/home',
      title: 'Home',
      element_hashes: ['h33333333'],
    });
  });

  it('marks unsupported or failed traces as not replayable', () => {
    const trace = [
      ev('A1', 1, 'action', { tool: 'screenshot', args: {} }),
      ev('R1', 1, 'action_result', { tool: 'screenshot', ok: true }),
      ev('GS1', 1, 'goal_status', {
        id: 'G1',
        status: 'verified',
        evidence_event_ids: ['R1'],
      }),
    ];
    const runs = buildTaskRuns({
      goals: [{ id: 'G1', description: 'Capture screenshot', status: 'verified', evidence: ['R1'] }],
      trace,
    });
    expect(runs[0]?.replay).toMatchObject({
      replayable: false,
      reason: 'unsupported tool for deterministic replay: screenshot',
    });
  });
});

function ev(
  id: string,
  step: number,
  kind: TraceEvent['kind'],
  payload: Record<string, unknown>,
): TraceEvent {
  return {
    v: 1,
    id,
    ts: step,
    step,
    target_kind: 'web',
    kind,
    actor: kind === 'action' ? 'explorer' : kind === 'action_result' ? 'adapter' : 'system',
    payload,
  };
}
