import type { RubricProfile } from '@iris/rubrics';
import type { JudgeOutput } from './judge.js';

export function ensureRubricScoreCoverage(
  judge: JudgeOutput,
  rubricProfiles: RubricProfile[],
): JudgeOutput {
  if (rubricProfiles.length === 0) return judge;

  const profiles = { ...judge.scores.profiles };
  const missingProfiles: string[] = [];
  const missingDimensions: string[] = [];

  for (const rubric of rubricProfiles) {
    const existingProfile = profiles[rubric.name];
    if (!existingProfile) missingProfiles.push(rubric.name);

    const dimensions = { ...(existingProfile?.dimensions ?? {}) };
    for (const dimension of rubric.dimensions) {
      if (dimensions[dimension.id]) continue;
      missingDimensions.push(`${rubric.name}.${dimension.id}`);
      dimensions[dimension.id] = {
        score: null,
        rationale: 'Judge omitted this requested rubric dimension.',
        evidence: [],
      };
    }

    profiles[rubric.name] = {
      score: existingProfile?.score ?? 0,
      dimensions,
    };
  }

  const requestedProfileNames = rubricProfiles.map((profile) => profile.name);
  const weightedFrom = Array.from(
    new Set([...judge.scores.overall.weighted_from, ...requestedProfileNames]),
  );
  const missingWeighted = requestedProfileNames.filter(
    (name) => !judge.scores.overall.weighted_from.includes(name),
  );

  if (
    missingProfiles.length === 0 &&
    missingDimensions.length === 0 &&
    missingWeighted.length === 0
  ) {
    return judge;
  }

  return {
    ...judge,
    scores: {
      ...judge.scores,
      overall: { ...judge.scores.overall, weighted_from: weightedFrom },
      profiles,
    },
    meta: {
      ...judge.meta,
      confidence_caveats: [
        ...judge.meta.confidence_caveats,
        ...rubricCoverageCaveats({ missingProfiles, missingDimensions, missingWeighted }),
      ],
    },
  };
}

function rubricCoverageCaveats(input: {
  missingProfiles: string[];
  missingDimensions: string[];
  missingWeighted: string[];
}): string[] {
  const caveats: string[] = [];
  if (input.missingProfiles.length > 0) {
    caveats.push(
      `Judge omitted requested rubric profiles: ${input.missingProfiles.join(', ')}.`,
    );
  }
  if (input.missingDimensions.length > 0) {
    caveats.push(
      `Judge omitted requested rubric dimensions: ${summarizeList(input.missingDimensions)}.`,
    );
  }
  const weightedOnly = input.missingWeighted.filter(
    (name) => !input.missingProfiles.includes(name),
  );
  if (weightedOnly.length > 0) {
    caveats.push(`Judge omitted profiles from weighted_from: ${weightedOnly.join(', ')}.`);
  }
  return caveats;
}

function summarizeList(values: string[], max = 8): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} and ${values.length - max} more`;
}
