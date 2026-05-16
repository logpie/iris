import type {
  DiscoveryCoveragePlan,
  DiscoveryGoal,
  DiscoveryJourney,
  DiscoverySurface,
  ProductUseContract,
  ProductUseJob,
  ProductUseValueLoop,
} from '../discovery/discovery.js';
import type { JudgeOutput } from '../judge/judge.js';

type JudgeGoal = JudgeOutput['spec_compliance']['goals'][number];

interface ScenarioSourceGoal {
  id: string;
  description: string;
  priority: 'must' | 'should';
  journey_id?: string | undefined;
  surface_ids: string[];
}

export interface TestingPlan {
  v: 1;
  product_summary: string;
  overall_mission?: string | undefined;
  /** @deprecated Use overall_mission for reader-facing copy. Kept for JSON compatibility. */
  main_outcome?: string | undefined;
  primary_journey_id: string;
  journeys: UserJourney[];
  scenarios: UserScenario[];
  deferred: DeferredArea[];
  internal_map?: {
    surface_ids?: string[];
    raw_discovery_refs?: string[];
  };
}

export interface UserJourney {
  id: string;
  title: string;
  user_goal: string;
  success_state: string;
  priority: 'primary' | 'supporting' | 'sample';
  scenario_ids: string[];
}

export interface UserScenario {
  id: string;
  source_goal_ids?: string[] | undefined;
  journey_id: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  scenario_brief: string;
  intent: string;
  test_data: string[];
  actions: string[];
  expected_result: string;
  required_outputs: string[];
  quality_bar: string[];
  strong_evidence: string[];
  weak_evidence: string[];
  source_surface_ids: string[];
}

export interface DeferredArea {
  id: string;
  title: string;
  reason: string;
  source_surface_ids: string[];
}

export interface DiscoveryReportLike {
  product_description?: string;
  goals?: DiscoveryGoal[];
  surfaces?: DiscoverySurface[];
  journeys?: DiscoveryJourney[];
  coverage_plan?: DiscoveryCoveragePlan;
  product_use_contract?: ProductUseContract;
}

export function deriveTestingPlan(input: {
  discovery?: DiscoveryReportLike | undefined;
  goals?: JudgeGoal[] | undefined;
}): TestingPlan | undefined {
  const discovery = input.discovery;
  const discoveryGoals = discovery?.goals ?? [];
  const judgeGoals = input.goals ?? [];
  if (!discovery && judgeGoals.length === 0) return undefined;

  const journeyById = new Map((discovery?.journeys ?? []).map((journey) => [journey.id, journey]));
  const surfaceById = new Map((discovery?.surfaces ?? []).map((surface) => [surface.id, surface]));
  const contract = discovery?.product_use_contract;
  const jobsByJourney = indexJobsByJourney(contract?.user_jobs ?? []);
  const jobsByGoalText = indexJobsByText(contract?.user_jobs ?? []);
  const loops = contract?.value_loops ?? [];
  const scenarioSourceGoals: ScenarioSourceGoal[] =
    discoveryGoals.length > 0
      ? discoveryGoals
      : (contract?.user_jobs ?? []).length > 0
        ? (contract?.user_jobs ?? []).map((job) => ({
            id: job.id,
            description: job.title,
            priority: job.risk === 'high' ? ('must' as const) : ('should' as const),
            ...(job.journey_id ? { journey_id: job.journey_id } : {}),
            surface_ids: [],
          }))
        : judgeGoals.map((goal) => ({
            id: goal.id,
            description: goal.description,
            priority: 'should' as const,
            surface_ids: [],
          }));

  const rawScenarios = scenarioSourceGoals.map((goal) => {
    const rawJourney = goal.journey_id ? journeyById.get(goal.journey_id) : undefined;
    const job = findJobForGoal(goal, rawJourney, jobsByJourney, jobsByGoalText);
    const loopId =
      job?.value_loop_id ??
      inferLoopId(`${goal.description} ${rawJourney?.title ?? ''} ${job?.title ?? ''}`, loops) ??
      (loops.length === 1 ? loops[0]?.id : undefined);
    const journeyId = loopId ?? rawJourney?.id ?? 'J-primary';
    const actions = compactStrings(job?.required_actions ?? []);
    const strongEvidence = compactStrings(
      job?.acceptable_evidence ?? rawJourney?.expected_evidence ?? [],
    );
    const expectedResult =
      firstString(job?.expected_artifact, rawJourney?.expected_evidence?.[0], goal.description) ??
      goal.description;
    const weakEvidence = compactStrings(job?.weak_evidence ?? []);
    const surfaceIds = uniqueStrings([
      ...(goal.surface_ids ?? []),
      ...(rawJourney?.surface_ids ?? []),
    ]);
    return {
      id: goal.id,
      source_goal_ids: [goal.id],
      journey_id: journeyId,
      title: job?.title || rawJourney?.title || goal.description,
      priority: goal.priority === 'must' ? 'must' : 'should',
      scenario_brief: job?.scenario_brief || goal.description,
      intent: rawJourney?.user_intent || goal.description,
      test_data: compactStrings(job?.test_data ?? []),
      actions,
      expected_result: expectedResult,
      required_outputs: compactStrings(job?.required_outputs ?? []),
      quality_bar: compactStrings(job?.quality_bar ?? []),
      strong_evidence: strongEvidence.length > 0 ? strongEvidence : [expectedResult],
      weak_evidence: weakEvidence,
      source_surface_ids: surfaceIds,
    } satisfies UserScenario;
  });
  const scenarios = mergeDuplicateScenarios(rawScenarios);

  const journeys = buildUserJourneys({
    contract,
    rawJourneys: discovery?.journeys ?? [],
    scenarios,
  });
  const primaryJourneyId =
    journeys.find((journey) => journey.priority === 'primary')?.id ??
    journeys[0]?.id ??
    'J-primary';
  const deferred = buildDeferredAreas(discovery?.coverage_plan, surfaceById);
  const surfaceIds = uniqueStrings([
    ...(discovery?.surfaces ?? []).map((surface) => surface.id),
    ...scenarios.flatMap((scenario) => scenario.source_surface_ids),
  ]);

  return {
    v: 1,
    product_summary: discovery?.product_description || '',
    ...(contract?.primary_value_loop
      ? {
          overall_mission: contract.primary_value_loop,
          main_outcome: contract.primary_value_loop,
        }
      : {}),
    primary_journey_id: primaryJourneyId,
    journeys,
    scenarios,
    deferred,
    ...(surfaceIds.length > 0
      ? {
          internal_map: {
            surface_ids: surfaceIds,
          },
        }
      : {}),
  };
}

function indexJobsByJourney(jobs: ProductUseJob[]): Map<string, ProductUseJob[]> {
  const out = new Map<string, ProductUseJob[]>();
  for (const job of jobs) {
    if (!job.journey_id) continue;
    const existing = out.get(job.journey_id) ?? [];
    existing.push(job);
    out.set(job.journey_id, existing);
  }
  return out;
}

function indexJobsByText(jobs: ProductUseJob[]): ProductUseJob[] {
  return jobs.filter((job) => job.title || job.expected_artifact);
}

function findJobForGoal(
  goal: DiscoveryGoal,
  journey: DiscoveryJourney | undefined,
  jobsByJourney: Map<string, ProductUseJob[]>,
  jobsByGoalText: ProductUseJob[],
): ProductUseJob | undefined {
  const journeyJobs = goal.journey_id ? (jobsByJourney.get(goal.journey_id) ?? []) : [];
  if (journeyJobs.length === 1) return journeyJobs[0];
  const text = normalizeText(`${goal.description} ${journey?.title ?? ''}`);
  return (
    journeyJobs.find((job) => textOverlaps(text, normalizeText(job.title))) ??
    jobsByGoalText.find((job) =>
      textOverlaps(text, normalizeText(`${job.title} ${job.expected_artifact}`)),
    )
  );
}

function buildUserJourneys(input: {
  contract?: ProductUseContract | undefined;
  rawJourneys: DiscoveryJourney[];
  scenarios: UserScenario[];
}): UserJourney[] {
  const out: UserJourney[] = [];
  const usedScenarioIds = new Set<string>();
  const loops = input.contract?.value_loops ?? [];
  for (const loop of loops) {
    const scenarioIds = input.scenarios
      .filter((scenario) => scenario.journey_id === loop.id)
      .map((scenario) => scenario.id);
    if (scenarioIds.length === 0) continue;
    for (const id of scenarioIds) usedScenarioIds.add(id);
    out.push({
      id: loop.id,
      title: loop.title,
      user_goal: loop.artifact || loop.title,
      success_state:
        loop.proof_obligations.length > 0
          ? loop.proof_obligations.join('; ')
          : loop.artifact || 'visible product result',
      priority: out.length === 0 ? 'primary' : 'supporting',
      scenario_ids: scenarioIds,
    });
  }

  for (const rawJourney of input.rawJourneys) {
    const scenarioIds = input.scenarios
      .filter(
        (scenario) => scenario.journey_id === rawJourney.id && !usedScenarioIds.has(scenario.id),
      )
      .map((scenario) => scenario.id);
    if (scenarioIds.length === 0) continue;
    for (const id of scenarioIds) usedScenarioIds.add(id);
    out.push({
      id: rawJourney.id,
      title: rawJourney.title,
      user_goal: rawJourney.user_intent || rawJourney.suggested_goal,
      success_state:
        rawJourney.expected_evidence.length > 0
          ? rawJourney.expected_evidence.join('; ')
          : rawJourney.suggested_goal,
      priority: rawJourney.priority === 'must' && out.length === 0 ? 'primary' : 'supporting',
      scenario_ids: scenarioIds,
    });
  }

  const remaining = input.scenarios.filter((scenario) => !usedScenarioIds.has(scenario.id));
  if (remaining.length > 0) {
    out.push({
      id: 'J-primary',
      title: input.contract?.primary_value_loop ? 'Primary workflow' : 'Checked scenarios',
      user_goal: input.contract?.primary_value_loop || 'Use the product successfully',
      success_state: input.contract?.core_artifacts.length
        ? input.contract.core_artifacts.join('; ')
        : 'visible result',
      priority: out.length === 0 ? 'primary' : 'supporting',
      scenario_ids: remaining.map((scenario) => scenario.id),
    });
  }

  return out;
}

function mergeDuplicateScenarios(scenarios: UserScenario[]): UserScenario[] {
  const out: UserScenario[] = [];
  for (const scenario of scenarios) {
    const existing = out.find((candidate) => areDuplicateScenarios(candidate, scenario));
    if (!existing) {
      out.push(scenario);
      continue;
    }
    existing.source_goal_ids = uniqueStrings([
      ...(existing.source_goal_ids ?? [existing.id]),
      ...(scenario.source_goal_ids ?? [scenario.id]),
    ]);
    existing.priority =
      existing.priority === 'must' || scenario.priority === 'must' ? 'must' : existing.priority;
    existing.scenario_brief = chooseMoreSpecificText(
      existing.scenario_brief,
      scenario.scenario_brief,
    );
    existing.test_data = uniqueStrings([...existing.test_data, ...scenario.test_data]);
    existing.actions = uniqueStrings([...existing.actions, ...scenario.actions]);
    existing.required_outputs = uniqueStrings([
      ...existing.required_outputs,
      ...scenario.required_outputs,
    ]);
    existing.quality_bar = uniqueStrings([...existing.quality_bar, ...scenario.quality_bar]);
    existing.strong_evidence = uniqueStrings([
      ...existing.strong_evidence,
      ...scenario.strong_evidence,
    ]);
    existing.weak_evidence = uniqueStrings([...existing.weak_evidence, ...scenario.weak_evidence]);
    existing.source_surface_ids = uniqueStrings([
      ...existing.source_surface_ids,
      ...scenario.source_surface_ids,
    ]);
    existing.expected_result = chooseMoreSpecificText(
      existing.expected_result,
      scenario.expected_result,
    );
  }
  return out;
}

function areDuplicateScenarios(a: UserScenario, b: UserScenario): boolean {
  if (a.journey_id !== b.journey_id) return false;
  const aTitle = words(a.title);
  const bTitle = words(b.title);
  if (aTitle.length >= 2 && bTitle.length >= 2) {
    return aTitle[0] === bTitle[0] && aTitle[1] === bTitle[1];
  }
  const aText = normalizeText(a.title);
  const bText = normalizeText(b.title);
  return Boolean(aText && bText && (aText.includes(bText) || bText.includes(aText)));
}

function chooseMoreSpecificText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const aWords = words(a).length;
  const bWords = words(b).length;
  if (aWords === bWords) return a.length >= b.length ? a : b;
  return aWords > bWords ? a : b;
}

function buildDeferredAreas(
  coveragePlan: DiscoveryCoveragePlan | undefined,
  surfaceById: Map<string, DiscoverySurface>,
): DeferredArea[] {
  return (coveragePlan?.deferred_surface_ids ?? []).map((id) => {
    const surface = surfaceById.get(id);
    return {
      id,
      title: surface?.label || id,
      reason: coveragePlan?.rationale || 'Not selected for this run',
      source_surface_ids: [id],
    };
  });
}

function inferLoopId(text: string, loops: ProductUseValueLoop[]): string | undefined {
  const normalized = normalizeText(text);
  let best: { id: string; score: number } | undefined;
  for (const loop of loops) {
    const score = overlapScore(
      normalized,
      normalizeText(
        [
          loop.title,
          loop.artifact,
          ...loop.required_capabilities,
          ...loop.proof_obligations,
          ...loop.weak_evidence,
        ].join(' '),
      ),
    );
    if (score > (best?.score ?? 0)) best = { id: loop.id, score };
  }
  return best && best.score >= 2 ? best.id : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function compactStrings(values: string[]): string[] {
  return uniqueStrings(values.map((value) => value.trim()).filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function textOverlaps(a: string, b: string): boolean {
  return overlapScore(a, b) >= 2 || a.includes(b) || b.includes(a);
}

function overlapScore(a: string, b: string): number {
  const aWords = new Set(words(a));
  let score = 0;
  for (const word of words(b)) {
    if (aWords.has(word)) score += 1;
  }
  return score;
}

function normalizeText(value: string): string {
  return words(value).join(' ');
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  'and',
  'the',
  'for',
  'from',
  'with',
  'that',
  'this',
  'into',
  'onto',
  'verify',
  'visible',
  'current',
  'product',
  'user',
]);
