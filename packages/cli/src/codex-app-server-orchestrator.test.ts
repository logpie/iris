import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_JUDGE_SYSTEM,
  buildJudgeFailureOutput,
  parseJudgeOutput,
} from './codex-app-server-orchestrator.js';

describe('parseJudgeOutput', () => {
  it('repairs a premature top-level close before spec_compliance', () => {
    const text =
      '{"v":1,"findings":[],"discarded_findings":[],"scores":{"overall":{"score":6,"weighted_from":["quality"]},"profiles":{"quality":{"score":6,"dimensions":{"correctness":{"score":6,"rationale":"ok","evidence":[]}}}}}},"spec_compliance":{"applicable":true,"goals":[{"id":"G1","description":"do it","status":"verified","evidence":["OBS-1"],"notes":"done"}],"summary":"done"},"coverage_review":{"surfaces_explored":1,"surfaces_unexplored":0,"judgement":"ok"},"meta":{"confidence_overall":0.8,"confidence_caveats":[],"would_re_explore_with":[]},"access_blocks":[]}';

    const out = parseJudgeOutput(text);
    expect(out.spec_compliance.goals[0]?.status).toBe('verified');
    expect(out.coverage_review.surfaces_explored).toBe(1);
  });

  it('repairs unbalanced score profile braces before top-level Judge sections', () => {
    const text =
      '{"v":1,"findings":[],"discarded_findings":[],"scores":{"overall":{"score":8,"weighted_from":["quality","usability","accessibility"]},"profiles":{"quality":{"score":8,"dimensions":{"correctness":{"score":8,"rationale":"ok","evidence":[]}}},"usability":{"score":8,"dimensions":{"clarity":{"score":8,"rationale":"ok","evidence":[]}},"accessibility":{"score":7,"dimensions":{"keyboard_nav":{"score":7,"rationale":"ok","evidence":[]}}}}},"spec_compliance":{"applicable":true,"goals":[{"id":"G1","description":"do it","status":"verified","evidence":["OBS-1"],"notes":"done"}],"summary":"done"},"coverage_review":{"surfaces_explored":1,"surfaces_unexplored":0,"judgement":"ok"},"meta":{"confidence_overall":0.8,"confidence_caveats":[],"would_re_explore_with":[]},"access_blocks":[]}';

    const out = parseJudgeOutput(text);
    expect(out.scores.profiles.accessibility?.dimensions.keyboard_nav?.score).toBe(7);
    expect(out.spec_compliance.goals[0]?.status).toBe('verified');
  });
});

describe('CODEX_APP_SERVER_JUDGE_SYSTEM', () => {
  it('inherits the core Judge evidence and product-use rules', () => {
    expect(CODEX_APP_SERVER_JUDGE_SYSTEM).toContain(
      'Preserve the exact claim boundary in goal notes',
    );
    expect(CODEX_APP_SERVER_JUDGE_SYSTEM).toContain(
      'Findings like "X gives no visible confirmation"',
    );
    expect(CODEX_APP_SERVER_JUDGE_SYSTEM).toContain(
      'If the discovery event includes product_use_contract',
    );
    expect(CODEX_APP_SERVER_JUDGE_SYSTEM).toContain('Codex App Server Output Constraints');
  });
});

describe('buildJudgeFailureOutput', () => {
  it('keeps Explorer goal rows diagnostic and never turns Judge failure into a positive score', () => {
    const out = buildJudgeFailureOutput({
      reason: 'malformed Judge JSON',
      goals: [{ description: 'Create a launch plan' }],
      rubricProfiles: [
        {
          name: 'quality',
          applies_to_targets: ['web'],
          applies_to_modes: ['free', 'grounded', 'targeted'],
          weight_in_overall: 1,
          dimensions: [
            {
              id: 'correctness',
              weight: 1,
              description: 'Score correctness',
            },
          ],
        },
      ],
      events: [
        {
          v: 1,
          id: 'GS1',
          ts: 1,
          step: 1,
          target_kind: 'web',
          kind: 'goal_status',
          actor: 'explorer',
          payload: {
            id: 'G1',
            status: 'verified',
            rationale: 'Visible launch plan appeared',
            evidence_event_ids: ['OBS1'],
          },
        },
      ],
    });

    expect(out.scores.overall.score).toBe(0);
    expect(out.scores.overall.weighted_from).toEqual([]);
    expect(out.scores.profiles.quality?.score).toBe(0);
    expect(out.scores.profiles.quality?.dimensions.correctness?.score).toBeNull();
    expect(out.spec_compliance.goals[0]?.status).toBe('partial');
    expect(out.spec_compliance.summary).toContain('diagnostic only');
    expect(out.meta.confidence_overall).toBe(0);
  });
});
