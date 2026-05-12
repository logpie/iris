import { type RubricProfile, loadBundledRubric } from '@iris/rubrics';

const ALL_WEB_RUBRICS = [
  'quality',
  'usability',
  'accessibility',
  'frontend-correctness',
  'coverage',
  // Phase 10: universal UX rubric that produces signal regardless of whether
  // spec goals are provided. Default-on for web runs.
  'ux-baseline',
] as const;

export async function loadRubricsByNames(names?: string[]): Promise<RubricProfile[]> {
  const list = names && names.length > 0 ? names : [...ALL_WEB_RUBRICS];
  const out: RubricProfile[] = [];
  for (const name of list) {
    out.push(await loadBundledRubric('web', name));
  }
  return out;
}
