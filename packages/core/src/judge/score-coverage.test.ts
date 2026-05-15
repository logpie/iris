import type { RubricProfile } from '@iris/rubrics';
import { describe, expect, it } from 'vitest';
import type { JudgeOutput } from './judge.js';
import { ensureRubricScoreCoverage } from './score-coverage.js';

const rubrics: RubricProfile[] = [
  {
    name: 'quality',
    applies_to_targets: ['web'],
    applies_to_modes: ['free', 'grounded', 'targeted'],
    weight_in_overall: 1,
    dimensions: [
      {
        id: 'correctness',
        description: 'Works correctly.',
        weight: 1,
        scoring_anchors: {},
      },
      {
        id: 'polish',
        description: 'Feels polished.',
        weight: 1,
        scoring_anchors: {},
      },
    ],
  },
  {
    name: 'frontend_correctness',
    applies_to_targets: ['web'],
    applies_to_modes: ['free', 'grounded', 'targeted'],
    weight_in_overall: 1,
    dimensions: [
      {
        id: 'interaction_outcomes',
        description: 'Interactions lead to visible outcomes.',
        weight: 1,
        scoring_anchors: {},
      },
    ],
  },
];

describe('ensureRubricScoreCoverage', () => {
  it('fills omitted requested profiles and dimensions without overwriting returned scores', () => {
    const judge = fakeJudgeOutput();
    const out = ensureRubricScoreCoverage(judge, rubrics);

    expect(out.scores.overall.weighted_from).toEqual(['quality', 'frontend_correctness']);
    expect(out.scores.profiles.quality?.score).toBe(8);
    expect(out.scores.profiles.quality?.dimensions.correctness?.score).toBe(8);
    expect(out.scores.profiles.quality?.dimensions.polish?.score).toBeNull();
    expect(out.scores.profiles.frontend_correctness?.score).toBe(0);
    expect(
      out.scores.profiles.frontend_correctness?.dimensions.interaction_outcomes?.score,
    ).toBeNull();
    expect(out.meta.confidence_caveats.join('\n')).toContain(
      'Judge omitted requested rubric profiles: frontend_correctness.',
    );
    expect(out.meta.confidence_caveats.join('\n')).toContain('quality.polish');
  });

  it('is idempotent once requested rubric coverage is complete', () => {
    const once = ensureRubricScoreCoverage(fakeJudgeOutput(), rubrics);
    const twice = ensureRubricScoreCoverage(once, rubrics);
    expect(twice).toEqual(once);
  });
});

function fakeJudgeOutput(): JudgeOutput {
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
            correctness: { score: 8, rationale: 'Core flow worked.', evidence: ['E1'] },
          },
        },
      },
    },
    spec_compliance: { applicable: false, goals: [], summary: '' },
    coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: 'ok' },
    meta: { confidence_overall: 0.8, confidence_caveats: [], would_re_explore_with: [] },
  };
}
