import { describe, expect, it } from 'vitest';
import { parseJudgeOutput } from './codex-app-server-orchestrator.js';

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
