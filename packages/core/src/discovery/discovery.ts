// Phase 10: discovery pass. Runs after preflight, before Explorer. Takes the
// landed page (URL + observation + screenshot) and asks an LLM to play the
// role of a new user proposing what to try. Returns a spec-shaped object
// that downstream code already knows how to consume.

import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import {
  scenarioInstructionHints,
  scenarioVisibleDataTokens,
  selectProductUseJobForGoal,
} from '../scenario/scenario-data.js';
import { DISCOVERY_SYSTEM, DISCOVERY_USER_TEMPLATE } from './prompts.js';

export const DiscoveryGoalClassSchema = z.enum([
  'core',
  'secondary_workflow',
  'setup',
  'sample',
  'peripheral',
  'diagnostic',
]);
export type DiscoveryGoalClass = z.infer<typeof DiscoveryGoalClassSchema>;

export const DiscoveryGoalSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['must', 'should']),
  journey_id: z.string().min(1).optional(),
  surface_ids: z.array(z.string()).default([]),
  goal_class: DiscoveryGoalClassSchema.optional(),
});
export type DiscoveryGoal = z.infer<typeof DiscoveryGoalSchema>;

export const DiscoverySurfaceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum([
    'page',
    'nav',
    'form',
    'search',
    'menu',
    'modal',
    'banner',
    'content',
    'table',
    'media',
    'toolbar',
    'account',
    'settings',
    'footer',
    'external',
    'unknown',
  ]),
  url: z.string().default(''),
  source: z
    .enum(['initial', 'scroll', 'menu_peek', 'banner_dismiss', 'primary_journey', 'sample_nav'])
    .default('initial'),
  value: z.enum(['core', 'important_secondary', 'peripheral']).default('important_secondary'),
  confidence: z.number().min(0).max(1).default(0.7),
  evidence: z.array(z.object({ ref: z.string(), note: z.string() })).default([]),
  controls: z
    .array(
      z.object({
        role: z.string().optional(),
        tag: z.string().optional(),
        name: z.string().optional(),
        href: z.string().optional(),
        type: z.string().optional(),
        ariaExpanded: z.string().optional(),
      }),
    )
    .default([]),
  prerequisites: z.array(z.string()).default([]),
});
export type DiscoverySurface = z.infer<typeof DiscoverySurfaceSchema>;

export const DiscoveryJourneySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  priority: z.enum(['must', 'should', 'could']),
  surface_ids: z.array(z.string()).default([]),
  user_intent: z.string().default(''),
  suggested_goal: z.string().min(1),
  sample_input: z.string().optional(),
  expected_evidence: z.array(z.string()).default([]),
  risk: z.enum(['high', 'medium', 'low']).default('medium'),
  goal_class: DiscoveryGoalClassSchema.optional(),
});
export type DiscoveryJourney = z.infer<typeof DiscoveryJourneySchema>;

export const DiscoveryCoveragePlanSchema = z.object({
  selected_journey_ids: z.array(z.string()).default([]),
  deferred_surface_ids: z.array(z.string()).default([]),
  rationale: z.string().default(''),
  recommended_steps_per_goal: z.number().int().positive().optional(),
  coverage_risk: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type DiscoveryCoveragePlan = z.infer<typeof DiscoveryCoveragePlanSchema>;

export const ProductKindSchema = z.enum([
  'canvas_editor',
  'document_editor',
  'search_content',
  'crud_workflow',
  'dashboard_filtering',
  'data_grid',
  'commerce_checkout',
  'auth_account',
  'media_tool',
  'settings_tool',
  'content_site',
  'communication_tool',
  'developer_tool',
  'developer_documentation',
  'calculator_tool',
  'unknown',
]);
export type ProductKind = z.infer<typeof ProductKindSchema>;

export const DiscoveryCapabilityImportanceSchema = z.enum([
  'core',
  'important',
  'secondary',
  'diagnostic',
]);
export type DiscoveryCapabilityImportance = z.infer<typeof DiscoveryCapabilityImportanceSchema>;

export const DiscoveryCapabilityStatusSchema = z.enum([
  'selected',
  'deferred',
  'discovered',
  'not_applicable',
]);
export type DiscoveryCapabilityStatus = z.infer<typeof DiscoveryCapabilityStatusSchema>;

export const DiscoveryCapabilitySelectionExpectationSchema = z.enum([
  'must_test',
  'should_test_or_explain',
  'not_normally_tested',
]);
export type DiscoveryCapabilitySelectionExpectation = z.infer<
  typeof DiscoveryCapabilitySelectionExpectationSchema
>;

export const DiscoveryCapabilitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  product_kind: ProductKindSchema.default('unknown'),
  importance: DiscoveryCapabilityImportanceSchema.default('important'),
  status: DiscoveryCapabilityStatusSchema.default('discovered'),
  selection_expectation: DiscoveryCapabilitySelectionExpectationSchema.optional(),
  skip_reason: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  source: z
    .enum([
      'product_kind_prior',
      'model',
      'surface',
      'primary_journey',
      'journey',
      'user_job',
      'heuristic',
    ])
    .default('model'),
  evidence: z.array(z.string().min(1)).default([]),
  scenario_ids: z.array(z.string().min(1)).default([]),
  journey_ids: z.array(z.string().min(1)).default([]),
  surface_ids: z.array(z.string().min(1)).default([]),
  denominator_reason: z.string().default(''),
  coverage_gap: z.string().default(''),
});
export type DiscoveryCapability = z.infer<typeof DiscoveryCapabilitySchema>;

export const ProductUseJobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  value_loop_id: z.string().min(1).optional(),
  journey_id: z.string().min(1).optional(),
  scenario_brief: z.string().default(''),
  required_actions: z.array(z.string().min(1)).default([]),
  proof_obligations: z.array(z.string().min(1)).default([]),
  expected_artifact: z.string().default(''),
  acceptable_evidence: z.array(z.string().min(1)).default([]),
  test_data: z.array(z.string().min(1)).default([]),
  required_outputs: z.array(z.string().min(1)).default([]),
  quality_bar: z.array(z.string().min(1)).default([]),
  weak_evidence: z.array(z.string().min(1)).default([]),
  risk: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type ProductUseJob = z.infer<typeof ProductUseJobSchema>;

export const ProductUseValueLoopSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artifact: z.string().default(''),
  required_capabilities: z.array(z.string().min(1)).default([]),
  proof_obligations: z.array(z.string().min(1)).default([]),
  weak_evidence: z.array(z.string().min(1)).default([]),
});
export type ProductUseValueLoop = z.infer<typeof ProductUseValueLoopSchema>;

export const ProductUseContractSchema = z.object({
  product_kinds: z.array(ProductKindSchema).default(['unknown']),
  primary_value_loop: z.string().default(''),
  core_artifacts: z.array(z.string().min(1)).default([]),
  value_loops: z.array(ProductUseValueLoopSchema).default([]),
  user_jobs: z.array(ProductUseJobSchema).default([]),
});
export type ProductUseContract = z.infer<typeof ProductUseContractSchema>;

export const DiscoveryOutputSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]).default(1),
  target_kind_hint: z.enum(['web', 'cli', 'api', 'desktop']).default('web'),
  product_description: z.string().default(''),
  product_use_contract: ProductUseContractSchema.optional(),
  goals: z.array(DiscoveryGoalSchema),
  surfaces: z.array(DiscoverySurfaceSchema).default([]),
  journeys: z.array(DiscoveryJourneySchema).default([]),
  capabilities: z.array(DiscoveryCapabilitySchema).default([]),
  coverage_plan: DiscoveryCoveragePlanSchema.optional(),
  focus_areas: z.array(z.string()).default([]),
  hints: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
});
export type DiscoveryOutput = z.infer<typeof DiscoveryOutputSchema>;

// Discoverer callback — transport-agnostic, mirrors VisionDescriber from
// adapter-web. Allows SDK transport (subscription, no API key) to plug a
// vision-capable callback instead of constructing an LlmClient.
export type Discoverer = (input: {
  systemPrompt: string;
  userPrompt: string;
  imagePath: string;
  model?: string;
}) => Promise<{ text: string; cost_usd: number }>;

export interface DiscoveryRunInputs {
  url: string;
  observation_summary: string;
  survey_summary?: string;
  survey_payload?: unknown;
  screenshot_path: string;
  // One of these must be provided. `discoverer` is used when set; falls back
  // to `client` otherwise (the api/cli transport path).
  discoverer?: Discoverer;
  client?: LlmClient;
  model?: string;
}

export interface DiscoveryRunResult {
  output: DiscoveryOutput;
  cost_usd: number;
}

function normalizeDiscoveryOutput(
  out: DiscoveryOutput,
  sourceText: string,
  surveySurfaces: DiscoverySurface[] = [],
): DiscoveryOutput {
  const surfaceNormalization = normalizeDiscoverySurfaces(
    mergeModelAndSurveySurfaces(out.surfaces, surveySurfaces),
  );
  const surfaces = surfaceNormalization.items;
  const journeySource =
    out.journeys.length > 0
      ? remapJourneySurfaceRefs(out.journeys, surfaceNormalization.idMap)
      : synthesizeJourneysFromGoals(
          remapGoalRefs(out.goals, surfaceNormalization.idMap, new Map()),
          surfaces,
        );
  const journeyNormalization = normalizeDiscoveryJourneys(journeySource, surfaces);
  const remappedOut = remapDiscoveryOutputRefs(
    out,
    surfaceNormalization.idMap,
    journeyNormalization.idMap,
  );
  const rawJourneys = attachPageContextSurfaces(journeyNormalization.items, surfaces);
  let productUseContract = normalizeProductUseContract(
    remappedOut.product_use_contract,
    rawJourneys,
    surfaces,
  );
  let journeys = normalizeJourneyMateriality(rawJourneys, surfaces, productUseContract);
  journeys = ensureArtifactEditorCapabilityJourneys(journeys, surfaces, productUseContract);
  journeys = ensureJourneysForUnlinkedProductUseJobs(journeys, surfaces, productUseContract);
  productUseContract = normalizeProductUseContract(
    remappedOut.product_use_contract,
    journeys,
    surfaces,
  );
  journeys = normalizeJourneyMateriality(journeys, surfaces, productUseContract);
  let coveragePlan = normalizeDiscoveryCoveragePlan(
    remappedOut.coverage_plan,
    journeys,
    surfaces,
    productUseContract,
  );
  const initialCapabilities = normalizeDiscoveryCapabilities(
    remappedOut.capabilities,
    productUseContract,
    journeys,
    surfaces,
    coveragePlan,
    [],
  );
  const capabilityRepair = closeDiscoveryCapabilityGaps({
    journeys,
    surfaces,
    productUseContract,
    coveragePlan,
    capabilities: initialCapabilities,
  });
  if (capabilityRepair.added_journey_ids.length > 0) {
    journeys = capabilityRepair.journeys;
    productUseContract = normalizeProductUseContract(
      remappedOut.product_use_contract,
      journeys,
      surfaces,
    );
    journeys = normalizeJourneyMateriality(journeys, surfaces, productUseContract);
    coveragePlan = normalizeDiscoveryCoveragePlan(
      {
        ...(coveragePlan ?? {
          selected_journey_ids: [],
          deferred_surface_ids: [],
          rationale: '',
          coverage_risk: 'medium' as const,
        }),
        selected_journey_ids: [
          ...new Set([
            ...(coveragePlan?.selected_journey_ids ?? []),
            ...capabilityRepair.added_journey_ids,
          ]),
        ],
        rationale: coveragePlan?.rationale ?? '',
      },
      journeys,
      surfaces,
      productUseContract,
    );
    const selectedAfterRepair = new Set(coveragePlan?.selected_journey_ids ?? []);
    const keptRepairLabels = capabilityRepair.added_journey_ids.some((id) =>
      selectedAfterRepair.has(id),
    )
      ? capabilityRepair.added_capability_labels
      : [];
    if (coveragePlan && keptRepairLabels.length > 0) {
      coveragePlan = {
        ...coveragePlan,
        rationale: appendCoverageRationale(coveragePlan.rationale, keptRepairLabels),
      };
    }
  }
  const goals: DiscoveryGoal[] = [];
  const seenDescriptions = new Set<string>();
  const selectedJourneyIds = new Set(coveragePlan?.selected_journey_ids ?? []);
  const structured = journeys.length > 0;

  for (const goal of remappedOut.goals) {
    const key = discoveryGoalKey(goal);
    if (seenDescriptions.has(key)) continue;
    seenDescriptions.add(key);
    const attached = attachDiscoveryGoalRefs(goal, journeys, coveragePlan);
    const journey = attached.journey_id
      ? journeys.find((candidate) => candidate.id === attached.journey_id)
      : undefined;
    const aligned = applyScenarioBriefToGoal(
      alignGoalDescriptionWithJourney(attached, journey, productUseContract),
      productUseContract,
    );
    if (hasAmbiguousMultiJobJourney(productUseContract, aligned)) continue;
    const goalClass =
      aligned.goal_class ?? journey?.goal_class ?? classifyStandaloneGoal(aligned, surfaces);
    if (structured) {
      if (aligned.journey_id && !selectedJourneyIds.has(aligned.journey_id)) continue;
      if (!isSeedGoalClass(goalClass)) continue;
    }
    goals.push({ ...aligned, goal_class: goalClass });
  }

  if (structured) {
    for (const journey of journeys) {
      if (!selectedJourneyIds.has(journey.id)) continue;
      if (!isSeedGoalClass(journey.goal_class ?? 'peripheral')) continue;
      const journeyJobs = productUseJobsForJourney(productUseContract, journey.id);
      if (journeyJobs.length > 1) {
        for (const [index, job] of journeyJobs.entries()) {
          const alreadyCovered = goals.some((goal) => {
            if (goal.journey_id !== journey.id) return false;
            return selectProductUseJobForGoal(productUseContract?.user_jobs, goal)?.id === job.id;
          });
          if (alreadyCovered) continue;
          const baseGoal: DiscoveryGoal = {
            id: `synth-${job.id || `${journey.id}-${index + 1}`}`,
            description: goalDescriptionForProductUseJob(job),
            priority: job.risk === 'high' || journey.priority === 'must' ? 'must' : 'should',
            journey_id: journey.id,
            surface_ids: journey.surface_ids,
            goal_class: journey.goal_class,
          };
          goals.push(baseGoal);
        }
        continue;
      }
      if (goals.some((goal) => goal.journey_id === journey.id)) continue;
      const job = journeyJobs[0];
      const baseGoal: DiscoveryGoal = {
        id: `synth-${journey.id}`,
        description: goalDescriptionForJourney(journey, job),
        priority: journey.priority === 'must' ? 'must' : 'should',
        journey_id: journey.id,
        surface_ids: journey.surface_ids,
        goal_class: journey.goal_class,
      };
      goals.push(baseGoal);
    }
  }

  // Legacy v1 Discovery only had prose, so these supplements protected against
  // severe under-compression on rich content pages. With v2 surface/journey
  // output, appending heuristic goals breaks the graph contract by creating
  // goals with no originating journey. Let the structured planner own v2.
  if (surfaces.length === 0 && journeys.length === 0) {
    for (const goal of supplementalDiscoveryGoals(sourceText, goals)) {
      const key = discoveryGoalKey(goal);
      if (seenDescriptions.has(key)) continue;
      seenDescriptions.add(key);
      goals.push(goal);
    }
  }

  const dedupedGoals = dedupeDiscoveryGoalsByScenarioFamily(goals, productUseContract);
  const finalGoals = dedupedGoals.map((goal, index) => ({ ...goal, id: `G${index + 1}` }));
  const capabilities = normalizeDiscoveryCapabilities(
    remappedOut.capabilities,
    productUseContract,
    journeys,
    surfaces,
    coveragePlan,
    finalGoals,
  );

  return {
    ...out,
    v: out.v === 2 || surfaces.length > 0 || journeys.length > 0 ? 2 : 1,
    surfaces,
    journeys,
    capabilities,
    ...(coveragePlan ? { coverage_plan: coveragePlan } : {}),
    ...(productUseContract ? { product_use_contract: productUseContract } : {}),
    goals: finalGoals,
  };
}

function closeDiscoveryCapabilityGaps(input: {
  journeys: DiscoveryJourney[];
  surfaces: DiscoverySurface[];
  productUseContract: ProductUseContract | undefined;
  coveragePlan: DiscoveryCoveragePlan | undefined;
  capabilities: DiscoveryCapability[];
}): {
  journeys: DiscoveryJourney[];
  added_journey_ids: string[];
  added_capability_labels: string[];
} {
  const productKinds = normalizedProductKinds(input.productUseContract);
  if (input.capabilities.length === 0 || productKinds.length === 0) {
    return { journeys: input.journeys, added_journey_ids: [], added_capability_labels: [] };
  }
  const selectedJourneyIds = new Set(input.coveragePlan?.selected_journey_ids ?? []);
  const out = [...input.journeys];
  const addedJourneyIds: string[] = [];
  const addedCapabilityLabels: string[] = [];
  for (const capability of capabilityGapsWorthPlanning(input.capabilities, productKinds)) {
    if (capabilityAlreadySelected(capability, out, selectedJourneyIds, input.productUseContract)) {
      continue;
    }
    const existingGapJourneyIds = capability.journey_ids.filter((journeyId) => {
      const journey = out.find((candidate) => candidate.id === journeyId);
      return journey && !selectedJourneyIds.has(journeyId)
        ? isSeedGoalClass(journey.goal_class ?? 'core')
        : false;
    });
    if (existingGapJourneyIds.length > 0) {
      for (const journeyId of existingGapJourneyIds) {
        selectedJourneyIds.add(journeyId);
        addedJourneyIds.push(journeyId);
      }
      if (existingGapJourneyIds.length > 0) addedCapabilityLabels.push(capability.label);
      continue;
    }
    const surfaceIds = selectSurfacesForCapabilityGap(capability, input.surfaces);
    if (surfaceIds.length === 0) continue;
    const gapJourney = journeyForCapabilityGap({
      capability,
      surfaces: input.surfaces,
      surfaceIds,
      productUseContract: input.productUseContract,
      journeyId: nextJourneyId(
        out,
        input.productUseContract?.user_jobs
          .map((job) => job.journey_id)
          .filter((id): id is string => Boolean(id)) ?? [],
      ),
      hasSelectedCoreJourney: out.some(
        (journey) =>
          selectedJourneyIds.has(journey.id) &&
          (journey.goal_class === 'core' || journey.priority === 'must'),
      ),
    });
    if (!gapJourney) continue;
    out.push(gapJourney);
    selectedJourneyIds.add(gapJourney.id);
    addedJourneyIds.push(gapJourney.id);
    addedCapabilityLabels.push(capability.label);
  }
  return {
    journeys: out,
    added_journey_ids: addedJourneyIds,
    added_capability_labels: addedCapabilityLabels,
  };
}

function capabilityGapsWorthPlanning(
  capabilities: DiscoveryCapability[],
  productKinds: ProductKind[],
): DiscoveryCapability[] {
  return capabilities
    .filter((capability) => capability.status !== 'selected')
    .filter((capability) => capability.status !== 'not_applicable')
    .filter((capability) => {
      const prior = capabilityPriorForCapability(capability);
      const capabilityText = [
        capability.label,
        capability.denominator_reason,
        capability.coverage_gap,
      ].join(' ');
      if (isSupportWorkflowForConcreteProduct(capabilityText, productKinds)) return false;
      if (
        capability.product_kind === 'developer_documentation' &&
        hasConcreteWorkflowProductKind(productKinds) &&
        !isImplementationCodeWorkflowForDeveloperExample(capabilityText, productKinds)
      ) {
        return false;
      }
      if (
        prior?.requiresSurfaceMatch &&
        capability.surface_ids.length === 0 &&
        capability.journey_ids.length === 0
      ) {
        return false;
      }
      if (capability.importance === 'core') return true;
      if (capability.selection_expectation === 'not_normally_tested') return false;
      if (capability.selection_expectation === 'must_test') return true;
      if (capability.importance !== 'important') return false;
      if (!productKinds.includes(capability.product_kind)) return false;
      return capability.surface_ids.length > 0 || capability.status === 'deferred';
    })
    .sort((a, b) => capabilityGapRank(a) - capabilityGapRank(b));
}

function capabilityGapRank(capability: DiscoveryCapability): number {
  const importance = capability.importance === 'core' ? 0 : 10;
  const concrete = capability.surface_ids.length > 0 || capability.journey_ids.length > 0 ? 0 : 1;
  return importance + concrete;
}

function capabilityAlreadySelected(
  capability: DiscoveryCapability,
  journeys: DiscoveryJourney[],
  selectedJourneyIds: Set<string>,
  productUseContract: ProductUseContract | undefined,
): boolean {
  if (
    isCalculatorResultCapability(capability) ||
    isCalculatorInputsUnitsCapability(capability) ||
    isCalculatorInterpretationCapability(capability)
  ) {
    const selectedText = journeys
      .filter((journey) => selectedJourneyIds.has(journey.id))
      .map(journeyScenarioText)
      .join(' ');
    if (
      (isCalculatorResultCapability(capability) && calculatorResultCoveredByText(selectedText)) ||
      (isCalculatorInputsUnitsCapability(capability) &&
        calculatorInputsUnitsCoveredByText(selectedText)) ||
      (isCalculatorInterpretationCapability(capability) &&
        calculatorInterpretationCoveredByText(selectedText))
    ) {
      return true;
    }
  }
  if (isDataGridFilterCapability(capability) || isDataGridSortPageCapability(capability)) {
    const selectedText = selectedJourneyAndJobText(
      journeys,
      selectedJourneyIds,
      productUseContract,
    );
    if (isDataGridFilterCapability(capability)) return dataGridFilterCoveredByText(selectedText);
    return dataGridSortPageCoveredByText(selectedText);
  }
  if (isContentToolsCapability(capability)) {
    const selectedText = journeys
      .filter((journey) => selectedJourneyIds.has(journey.id))
      .map(journeyScenarioText)
      .join(' ');
    return /\b(language|translate|edit|history|talk)\b/.test(
      normalizeTextForMatching(selectedText),
    );
  }
  if (coverageGapIndicatesUncovered(capability.coverage_gap)) return false;
  if (capability.journey_ids.some((journeyId) => selectedJourneyIds.has(journeyId))) return true;
  return journeys.some((journey) => {
    if (!selectedJourneyIds.has(journey.id)) return false;
    return capabilityMatchesText(capabilityToSeed(capability), journeyScenarioText(journey));
  });
}

function selectedJourneyAndJobText(
  journeys: DiscoveryJourney[],
  selectedJourneyIds: Set<string>,
  productUseContract: ProductUseContract | undefined,
): string {
  const journeyText = journeys
    .filter((journey) => selectedJourneyIds.has(journey.id))
    .map(journeyScenarioText);
  const jobText = (productUseContract?.user_jobs ?? [])
    .filter((job) => job.journey_id && selectedJourneyIds.has(job.journey_id))
    .map((job) =>
      [
        job.title,
        job.scenario_brief,
        job.expected_artifact,
        ...job.required_actions,
        ...job.proof_obligations,
        ...job.test_data,
        ...job.required_outputs,
        ...job.quality_bar,
      ].join(' '),
    );
  return [...journeyText, ...jobText].join(' ');
}

function isCalculatorResultCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'calculator_tool') return false;
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap].join(' '),
  );
  return /\b(calculate|computed?|submitted?|result|value|output|estimate|classification)\b/.test(
    text,
  );
}

function isCalculatorInputsUnitsCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'calculator_tool') return false;
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap].join(' '),
  );
  return /\b(input|field|unit|option|variant|metric|imperial|height|weight|age|loan|interest|term|selector)\b/.test(
    text,
  );
}

function isCalculatorInterpretationCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'calculator_tool') return false;
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap].join(' '),
  );
  return /\b(interpret|category|classification|healthy range|healthy weight|bmi prime|ponderal|gauge)\b/.test(
    text,
  );
}

function calculatorResultCoveredByText(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  return (
    /\b(calculate|computed?|estimate|convert|submit)\b/.test(normalized) &&
    /\b(result|value|output|category|classification|payment|bmi|mortgage|loan|total|answer)\b/.test(
      normalized,
    )
  );
}

function calculatorInputsUnitsCoveredByText(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  if (!/\b(calculate|computed?|estimate|convert|submit|enter)\b/.test(normalized)) return false;
  const inputTerms = [
    /\b(input|field|non default|option|unit|metric|imperial)\b/,
    /\b(height|weight|age|feet|foot|inch|inches|pounds?|lbs?|kg|kilograms?|cm|centimeters?)\b/,
    /\b(home|purchase|down|interest|rate|term|loan|principal|amount)\b/,
  ].filter((pattern) => pattern.test(normalized)).length;
  return inputTerms >= 1;
}

function calculatorInterpretationCoveredByText(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  if (!/\b(calculate|computed?|result|bmi)\b/.test(normalized)) return false;
  return /\b(category|classification|healthy range|healthy weight|bmi prime|ponderal|overweight|normal|obese)\b/.test(
    normalized,
  );
}

function isDataGridFilterCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'data_grid') return false;
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap].join(' '),
  );
  return /\b(search|filter|query)\b/.test(text);
}

function isDataGridSortPageCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'data_grid') return false;
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap].join(' '),
  );
  return /\b(sort|order|column|page length|entries per page|pagination|next|previous|row range)\b/.test(
    text,
  );
}

function isContentToolsCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'search_content') return false;
  return normalizeTextForMatching(capability.label) === 'use visible content tools';
}

function dataGridFilterCoveredByText(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  return (
    /\b(search|filter|query)\b/.test(normalized) &&
    /\b(table|grid|datatable|rows?|count|entries)\b/.test(normalized)
  );
}

function dataGridSortPageCoveredByText(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  return (
    /\b(sort|sorted|order|column|page length|entries per page|pagination|next|previous|page \d+|row range|displayed range)\b/.test(
      normalized,
    ) && /\b(table|grid|datatable|rows?|entries|column|range)\b/.test(normalized)
  );
}

function capabilityToSeed(capability: DiscoveryCapability): DiscoveryCapabilitySeed {
  const prior = capabilityPriorForCapability(capability);
  return {
    key: capabilityKey(capability.label),
    label: capability.label,
    product_kind: capability.product_kind,
    importance: capability.importance,
    status: capability.status,
    selection_expectation: capability.selection_expectation,
    skip_reason: capability.skip_reason,
    confidence: capability.confidence,
    source: capability.source,
    evidence: capability.evidence,
    scenario_ids: capability.scenario_ids,
    journey_ids: capability.journey_ids,
    surface_ids: capability.surface_ids,
    denominator_reason: capability.denominator_reason,
    coverage_gap: capability.coverage_gap,
    ...(prior?.surfacePattern ? { surfacePattern: prior.surfacePattern } : {}),
    ...(prior?.textPattern ? { textPattern: prior.textPattern } : {}),
  };
}

function selectSurfacesForCapabilityGap(
  capability: DiscoveryCapability,
  surfaces: DiscoverySurface[],
): string[] {
  const surfaceIds = capability.surface_ids.filter((id) =>
    surfaces.some((surface) => surface.id === id),
  );
  if (surfaceIds.length > 0) return surfaceIds;
  const prior = capabilityPriorForCapability(capability);
  if (prior) {
    const matching = surfaces
      .filter((surface) => prior.surfacePattern.test(surfaceSearchText(surface)))
      .map((surface) => surface.id);
    if (matching.length > 0) return matching;
  }
  const tokens = capabilityTokens(capability.label);
  const matching = surfaces
    .filter((surface) => {
      const text = surfaceSearchText(surface);
      return tokens.some((token) => text.includes(token));
    })
    .map((surface) => surface.id);
  if (matching.length > 0) return matching;
  return surfaces
    .filter((surface) => surface.value === 'core')
    .slice(0, 3)
    .map((surface) => surface.id);
}

function journeyForCapabilityGap(input: {
  capability: DiscoveryCapability;
  surfaces: DiscoverySurface[];
  surfaceIds: string[];
  productUseContract: ProductUseContract | undefined;
  journeyId: string;
  hasSelectedCoreJourney: boolean;
}): DiscoveryJourney | undefined {
  const productKinds = normalizedProductKinds(input.productUseContract);
  const capabilityKind =
    input.capability.product_kind !== 'unknown' ? input.capability.product_kind : undefined;
  const scaffoldKinds =
    productKinds.length > 0 ? productKinds : capabilityKind ? [capabilityKind] : [];
  const surfaceText = input.surfaces
    .filter((surface) => input.surfaceIds.includes(surface.id))
    .map(surfaceSearchText)
    .join(' ');
  const scaffold = materialityScaffold(
    [
      input.capability.label,
      input.capability.denominator_reason,
      input.capability.coverage_gap,
      surfaceText,
    ].join(' '),
    scaffoldKinds,
  );
  const scaffoldText = [
    scaffold.scenarioTitle,
    scaffold.scenarioBrief,
    scaffold.expectedArtifact,
    ...scaffold.requiredOutputs,
    ...scaffold.proofObligations,
  ].join(' ');
  const useScaffold = scaffoldCoversCapability(input.capability, scaffoldText);
  const title =
    useScaffold && scaffold.scenarioTitle
      ? scaffold.scenarioTitle
      : capabilityJourneyTitle(input.capability);
  const suggestedGoal =
    useScaffold && scaffold.scenarioBrief
      ? scaffold.scenarioBrief
      : capabilitySpecificSuggestedGoal(input.capability, surfaceText);
  if (!useScaffold && isGenericCapabilityExerciseGoal(suggestedGoal, input.capability)) {
    return undefined;
  }
  const evidence = uniqueNonEmptyStrings([
    ...(useScaffold ? scaffold.requiredOutputs : []),
    ...(useScaffold ? scaffold.proofObligations : []),
    ...(useScaffold ? [scaffold.expectedArtifact] : []),
    ...capabilitySpecificEvidence(input.capability, surfaceText),
  ]).slice(0, 6);
  const goalClass: DiscoveryGoalClass =
    input.capability.importance === 'core' ? 'core' : 'secondary_workflow';
  return {
    id: input.journeyId,
    title,
    priority:
      input.capability.importance === 'core' && !input.hasSelectedCoreJourney ? 'must' : 'should',
    goal_class: goalClass,
    surface_ids: input.surfaceIds,
    user_intent:
      input.capability.denominator_reason ||
      `Cover the product ability: ${input.capability.label}.`,
    suggested_goal: suggestedGoal,
    ...(scaffold.testData.length > 0 ? { sample_input: scaffold.testData.join('; ') } : {}),
    expected_evidence:
      evidence.length > 0 ? evidence : ['post-action evidence showing the product outcome'],
    risk: input.capability.importance === 'core' ? 'high' : 'medium',
  };
}

function isGenericCapabilityExerciseGoal(goal: string, capability: DiscoveryCapability): boolean {
  if (!/^Exercise\b/i.test(goal.trim())) return false;
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap].join(' '),
  );
  return (
    /\b(authenticated shopping surface|shopping surface after login|reach and use)\b/.test(text) ||
    /\b(browse products|product inventory|inspect details)\b/.test(text)
  );
}

function capabilityJourneyTitle(capability: DiscoveryCapability): string {
  const label = capability.label.trim();
  if (!label) return 'Use an uncovered product ability';
  return label.replace(/^Use\b/i, 'Use').replace(/\.$/, '');
}

function scaffoldCoversCapability(capability: DiscoveryCapability, scaffoldText: string): boolean {
  return scaffoldCoversAnchor(capability.label, scaffoldText);
}

function scaffoldCoversAnchor(anchorText: string, scaffoldText: string): boolean {
  const tokens = capabilityTokens(anchorText);
  if (tokens.length === 0) return true;
  const normalized = normalizeTextForMatching(scaffoldText);
  if (!normalized) return false;
  const shared = tokens.filter((token) => normalized.includes(token));
  return shared.length >= Math.min(2, tokens.length);
}

function capabilitySpecificSuggestedGoal(
  capability: DiscoveryCapability,
  surfaceText: string,
): string {
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap, surfaceText].join(
      ' ',
    ),
  );
  if (capability.product_kind === 'data_grid') {
    if (/\b(search|filter)\b/.test(text)) {
      return 'Use the table search or filter control with a concrete query and verify the visible rows, count, or empty state changes.';
    }
    if (/\b(sort|order|column)\b/.test(text)) {
      return 'Sort an interactive table column and verify the visible row order changes consistently with that column.';
    }
    if (/\b(page length|entries per page|pagination|next|previous|page)\b/.test(text)) {
      return 'Change the table page length or pagination state and verify the displayed row range or visible rows update.';
    }
    return 'Use a data-grid control and verify the table rows, count, order, range, or detail state changes.';
  }
  if (capability.product_kind === 'commerce_checkout') {
    if (/\b(locked|blocked|denial|error|login|log in|sign in|auth)\b/.test(text)) {
      return 'Attempt the named login or account state and verify the visible authenticated destination or blocked-account error.';
    }
    if (/\b(product|catalog|inventory|item|cart|checkout|order)\b/.test(surfaceText)) {
      return 'Reach the product inventory, item detail, cart, or checkout surface and verify product or order content is visible.';
    }
  }
  if (/\b(section|contents|toc|anchor|reference|citation|related|pagination)\b/.test(text)) {
    return 'Use the visible content navigation such as contents, section anchors, citations, related links, or pagination and verify the destination content or heading changes.';
  }
  if (/\b(history|revision|provenance|edit)\b/.test(text)) {
    return 'Open the visible history, provenance, edit, or revision surface and verify the destination is tied to the current content item.';
  }
  if (/\b(language|translate|localized|non english)\b/.test(text)) {
    return 'Use the visible language or localization control and verify a localized content page or interface loads.';
  }
  return `Exercise ${capability.label.toLowerCase()} and verify a concrete user-visible outcome, not just a menu, focus, or toolbar state.`;
}

function capabilitySpecificEvidence(
  capability: DiscoveryCapability,
  surfaceText: string,
): string[] {
  const text = normalizeTextForMatching(
    [capability.label, capability.denominator_reason, capability.coverage_gap, surfaceText].join(
      ' ',
    ),
  );
  if (capability.product_kind === 'data_grid') {
    return [
      'table rows, count, order, page range, or detail state visibly changes',
      'the evidence shows changed grid data, not only an opened menu or focused control',
    ];
  }
  if (/\b(section|contents|toc|anchor|reference|citation|related|pagination)\b/.test(text)) {
    return [
      'destination section heading, citation, related item, or paginated content is visible',
      'the evidence shows navigation changed the readable content, not only that a menu opened',
    ];
  }
  if (/\b(history|revision|provenance|edit)\b/.test(text)) {
    return [
      'history, provenance, edit, or revision destination is visible',
      'the destination remains tied to the same content item',
    ];
  }
  if (/\b(language|translate|localized|non english)\b/.test(text)) {
    return [
      'localized domain, language marker, or translated interface/content is visible',
      'a real localized content page is loaded, not just the language menu',
    ];
  }
  return ['post-action evidence shows the product outcome required by this capability'];
}

function capabilityPriorForCapability(
  capability: DiscoveryCapability,
): DiscoveryCapabilityPrior | undefined {
  return DISCOVERY_CAPABILITY_PRIORS.find(
    (prior) =>
      prior.label === capability.label ||
      (prior.productKind === capability.product_kind &&
        capabilityKey(prior.label) === capabilityKey(capability.label)),
  );
}

function appendCoverageRationale(existing: string, addedCapabilityLabels: string[]): string {
  if (addedCapabilityLabels.length === 0) return existing;
  const addition = `Closed Discovery capability gaps before Explorer: ${addedCapabilityLabels.join('; ')}.`;
  return existing.trim() ? `${existing.trim()} ${addition}` : addition;
}

function normalizeProductUseContract(
  contract: ProductUseContract | undefined,
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
): ProductUseContract | undefined {
  if (!contract) return undefined;
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  const productKinds: ProductKind[] = normalizeContractProductKinds(contract, journeys, surfaces);
  let userJobs = contract.user_jobs
    .filter((job) => job.title.trim() || job.expected_artifact.trim() || job.scenario_brief.trim())
    .map((job, index) => {
      const { journey_id, value_loop_id, ...rest } = job;
      const declaredJourneyId = journey_id?.trim();
      const linkedJourneyId =
        declaredJourneyId && journeyIds.has(declaredJourneyId)
          ? declaredJourneyId
          : matchingProductUseJobJourneyId(job, journeys);
      const normalizedJob: ProductUseJob = {
        ...rest,
        id: job.id || `PU${index + 1}`,
        scenario_brief: job.scenario_brief.trim(),
        required_actions: uniqueNonEmptyStrings(job.required_actions),
        proof_obligations: uniqueNonEmptyStrings(job.proof_obligations),
        acceptable_evidence: uniqueNonEmptyStrings(job.acceptable_evidence),
        test_data: uniqueNonEmptyStrings(job.test_data),
        required_outputs: uniqueNonEmptyStrings(job.required_outputs),
        quality_bar: uniqueNonEmptyStrings(job.quality_bar),
        weak_evidence: uniqueNonEmptyStrings(job.weak_evidence),
      };
      if (value_loop_id) normalizedJob.value_loop_id = value_loop_id;
      if (linkedJourneyId) normalizedJob.journey_id = linkedJourneyId;
      return normalizedJob;
    });
  userJobs = ensureProductUseJobsForMaterialJourneys(userJobs, journeys, surfaces, productKinds);
  userJobs = userJobs.map((job) => enrichProductUseJob(job, productKinds));
  const valueLoops = normalizeProductUseValueLoops(contract, userJobs, productKinds);
  const normalized: ProductUseContract = {
    product_kinds: productKinds,
    primary_value_loop: contract.primary_value_loop,
    core_artifacts: uniqueNonEmptyStrings(contract.core_artifacts),
    value_loops: valueLoops,
    user_jobs: userJobs,
  };
  const hasContent =
    normalized.primary_value_loop.trim().length > 0 ||
    normalized.core_artifacts.length > 0 ||
    normalized.value_loops.length > 0 ||
    normalized.user_jobs.length > 0 ||
    normalized.product_kinds.some((kind) => kind !== 'unknown');
  return hasContent ? normalized : undefined;
}

function matchingProductUseJobJourneyId(
  job: ProductUseJob,
  journeys: DiscoveryJourney[],
): string | undefined {
  const jobText = normalizeTextForMatching(productUseJobSearchText(job));
  if (!jobText) return undefined;
  const jobTitle = normalizeTextForMatching(job.title);
  for (const journey of journeys) {
    const journeyText = journeySearchText(journey);
    const journeyTitle = normalizeTextForMatching(journey.title);
    if (
      jobTitle.length >= 12 &&
      (journeyText.includes(jobTitle) || jobText.includes(journeyTitle))
    ) {
      return journey.id;
    }
    const tokens = importantGoalTokens(jobText).filter((token) => token !== 'canvas');
    if (tokens.length === 0) continue;
    const shared = tokens.filter((token) => journeyText.includes(token));
    const requiredShared = Math.max(3, Math.min(4, Math.ceil(tokens.length * 0.6)));
    if (shared.length >= requiredShared) return journey.id;
  }
  return undefined;
}

function productUseJobSearchText(job: ProductUseJob): string {
  return [
    job.title,
    job.scenario_brief,
    job.expected_artifact,
    ...job.required_actions,
    ...job.proof_obligations,
    ...job.acceptable_evidence,
    ...job.required_outputs,
    ...job.quality_bar,
    ...job.weak_evidence,
  ].join(' ');
}

function normalizeProductUseValueLoops(
  contract: ProductUseContract,
  userJobs: ProductUseJob[],
  productKinds: ProductKind[],
): ProductUseValueLoop[] {
  const loops = contract.value_loops
    .filter((loop) => loop.title.trim() || loop.artifact.trim())
    .map((loop, index) => ({
      id: loop.id || `VL${index + 1}`,
      title: loop.title || contract.primary_value_loop || `Value loop ${index + 1}`,
      artifact: loop.artifact,
      required_capabilities: uniqueNonEmptyStrings(loop.required_capabilities),
      proof_obligations: uniqueNonEmptyStrings(loop.proof_obligations),
      weak_evidence: uniqueNonEmptyStrings(loop.weak_evidence),
    }));
  if (loops.length > 0) return loops.map((loop) => enrichProductUseValueLoop(loop, productKinds));
  const artifact =
    contract.core_artifacts.length > 0
      ? uniqueNonEmptyStrings(contract.core_artifacts).join('; ')
      : firstNonEmpty(userJobs.map((job) => job.expected_artifact)) ||
        'visible value-producing artifact or state change';
  return [
    enrichProductUseValueLoop(
      {
        id: 'VL1',
        title: contract.primary_value_loop || 'Use the product to produce its primary value',
        artifact,
        required_capabilities: uniqueNonEmptyStrings(
          userJobs.flatMap((job) => job.required_actions).slice(0, 8),
        ),
        proof_obligations: uniqueNonEmptyStrings(
          userJobs.flatMap((job) => job.proof_obligations).slice(0, 8),
        ),
        weak_evidence: uniqueNonEmptyStrings(userJobs.flatMap((job) => job.weak_evidence)),
      },
      productKinds,
    ),
  ];
}

function ensureProductUseJobsForMaterialJourneys(
  jobs: ProductUseJob[],
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
  productKinds: ProductKind[],
): ProductUseJob[] {
  const jobsByJourney = new Set(
    jobs.map((job) => job.journey_id).filter((id): id is string => Boolean(id)),
  );
  const surfaceById = new Map(surfaces.map((surface) => [surface.id, surface]));
  const out = [...jobs];
  for (const journey of journeys) {
    if (jobsByJourney.has(journey.id)) continue;
    const selectedSurfaces = journey.surface_ids
      .map((id) => surfaceById.get(id))
      .filter((surface): surface is DiscoverySurface => Boolean(surface));
    const computedClass = classifyMateriality({
      priority: journey.priority,
      risk: journey.risk,
      title: journey.title,
      text: [
        journey.title,
        journey.user_intent,
        journey.suggested_goal,
        ...journey.expected_evidence,
      ].join(' '),
      surfaces: selectedSurfaces,
      productKinds,
    });
    const goalClass = journey.goal_class ?? computedClass;
    if (!isSeedGoalClass(goalClass)) continue;
    const job = deriveProductUseJobFromJourney(journey, productKinds, out.length + 1);
    out.push(job);
    jobsByJourney.add(journey.id);
  }
  return out;
}

function deriveProductUseJobFromJourney(
  journey: DiscoveryJourney,
  productKinds: ProductKind[],
  index: number,
): ProductUseJob {
  const scaffold = materialityScaffold(
    [journey.title, journey.user_intent, journey.suggested_goal].join(' '),
    productKinds,
  );
  const scaffoldText = [
    scaffold.scenarioTitle,
    scaffold.scenarioBrief,
    scaffold.expectedArtifact,
    ...scaffold.requiredOutputs,
    ...scaffold.proofObligations,
  ].join(' ');
  const useScaffold =
    (isArtifactEditorProduct(productKinds) || !hasSpecificJourneyScenario(journey, productKinds)) &&
    scaffoldCoversAnchor(
      [journey.title, journey.user_intent, journey.suggested_goal].join(' '),
      scaffoldText,
    );
  return {
    id: `PU${index}`,
    title:
      useScaffold && scaffold.scenarioTitle
        ? scaffold.scenarioTitle
        : journey.title || titleFromGoal(journey.suggested_goal),
    journey_id: journey.id,
    scenario_brief:
      useScaffold && scaffold.scenarioBrief ? scaffold.scenarioBrief : journey.suggested_goal,
    required_actions: useScaffold ? scaffold.requiredActions : [],
    proof_obligations: useScaffold ? scaffold.proofObligations : journey.expected_evidence,
    expected_artifact:
      firstNonEmpty([
        useScaffold && scaffold.scenarioBrief ? scaffold.expectedArtifact : undefined,
        journey.expected_evidence.join('; '),
        scaffold.expectedArtifact,
      ]) ?? 'visible user-facing outcome',
    acceptable_evidence:
      journey.expected_evidence.length > 0
        ? journey.expected_evidence
        : ['post-action evidence showing the expected artifact or state change'],
    test_data: useScaffold ? scaffold.testData : [],
    required_outputs: useScaffold ? scaffold.requiredOutputs : journey.expected_evidence,
    quality_bar: useScaffold ? scaffold.qualityBar : [],
    weak_evidence: useScaffold ? scaffold.weakEvidence : [],
    risk: journey.risk,
  };
}

function hasSpecificJourneyScenario(
  journey: DiscoveryJourney,
  productKinds: ProductKind[],
): boolean {
  const text = normalizeTextForMatching(
    [
      journey.title,
      journey.suggested_goal,
      journey.sample_input ?? '',
      ...journey.expected_evidence,
    ].join(' '),
  );
  if (!text) return false;
  if (
    (productKinds.includes('search_content') || productKinds.includes('content_site')) &&
    /\b(history|revision|provenance|edit|talk|language|translate|localized)\b/.test(text) &&
    /\b(article|content|page|destination|entries|current)\b/.test(text)
  ) {
    return true;
  }
  const generic = new Set([
    'create',
    'created',
    'update',
    'updated',
    'edit',
    'edited',
    'delete',
    'deleted',
    'clear',
    'cleared',
    'visible',
    'verify',
    'verified',
    'state',
    'item',
    'items',
    'record',
    'records',
    'product',
    'workflow',
    'surface',
    'scenario',
  ]);
  const concreteTokens = importantGoalTokens(text).filter((token) => !generic.has(token));
  const carriesConcreteData =
    /\b(named|called|titled|labeled|labelled|exact)\b/.test(text) ||
    Boolean(journey.sample_input?.trim());
  return (
    concreteTokens.length >= 4 && (carriesConcreteData || journey.expected_evidence.length >= 2)
  );
}

function enrichProductUseJob(job: ProductUseJob, productKinds: ProductKind[]): ProductUseJob {
  const scaffold = materialityScaffold(
    [
      job.title,
      job.scenario_brief,
      job.expected_artifact,
      ...job.test_data,
      ...job.required_outputs,
      ...job.quality_bar,
      ...job.required_actions,
      ...job.proof_obligations,
    ].join(' '),
    productKinds,
  );
  const mergeScaffold = shouldMergeScenarioScaffold(job, scaffold);
  const enriched: ProductUseJob = {
    ...job,
    title:
      scaffold.scenarioTitle && isGenericProductUseTitle(job.title) && mergeScaffold
        ? scaffold.scenarioTitle
        : job.title,
    scenario_brief: job.scenario_brief || scaffold.scenarioBrief,
    required_actions: mergeScaffoldStrings(
      job.required_actions,
      scaffold.requiredActions,
      mergeScaffold,
    ),
    proof_obligations: mergeScaffoldStrings(
      job.proof_obligations,
      scaffold.proofObligations,
      mergeScaffold,
    ),
    expected_artifact:
      mergeScaffold &&
      scaffold.expectedArtifact &&
      isGenericProductUseExpected(job.expected_artifact)
        ? scaffold.expectedArtifact
        : job.expected_artifact || scaffold.expectedArtifact,
    acceptable_evidence: mergeScaffoldStrings(
      job.acceptable_evidence,
      scaffold.acceptableEvidence,
      mergeScaffold,
    ),
    test_data: mergeScaffoldStrings(job.test_data, scaffold.testData, mergeScaffold),
    required_outputs: mergeScaffoldStrings(
      job.required_outputs,
      scaffold.requiredOutputs,
      mergeScaffold,
    ),
    quality_bar: mergeScaffoldStrings(job.quality_bar, scaffold.qualityBar, mergeScaffold),
    weak_evidence: mergeScaffoldStrings(job.weak_evidence, scaffold.weakEvidence, mergeScaffold),
  };
  return relaxCalculatorUnitModeProof(enriched, productKinds);
}

function relaxCalculatorUnitModeProof(
  job: ProductUseJob,
  productKinds: ProductKind[],
): ProductUseJob {
  if (!productKinds.includes('calculator_tool')) return job;
  return {
    ...job,
    required_outputs: job.required_outputs.filter((output) => !isCalculatorTabActiveProof(output)),
    proof_obligations: uniqueNonEmptyStrings(
      job.proof_obligations.map((proof) => relaxCalculatorProofText(proof, productKinds)),
    ),
    acceptable_evidence: uniqueNonEmptyStrings(
      job.acceptable_evidence.map((proof) => relaxCalculatorProofText(proof, productKinds)),
    ),
    quality_bar: uniqueNonEmptyStrings(
      job.quality_bar.map((proof) => relaxCalculatorProofText(proof, productKinds)),
    ),
  };
}

function isCalculatorTabActiveProof(text: string): boolean {
  return /\b(?:us|metric|other)\s+units?\s+tab\s+active\b/i.test(text);
}

function relaxCalculatorProofText(text: string, productKinds: ProductKind[]): string {
  if (!productKinds.includes('calculator_tool')) return text;
  return text.replace(/\b(?:us|metric|other)\s+units?\s+tab\s+active;?\s*/gi, '').trim();
}

function shouldMergeScenarioScaffold(job: ProductUseJob, scaffold: MaterialityScaffold): boolean {
  if (!job.scenario_brief) return true;
  if (!scaffold.scenarioBrief) {
    const scaffoldText = [
      scaffold.scenarioTitle,
      scaffold.expectedArtifact,
      ...scaffold.requiredActions,
      ...scaffold.proofObligations,
      ...scaffold.requiredOutputs,
    ].join(' ');
    return scaffoldCoversAnchor(job.scenario_brief, scaffoldText);
  }
  const existing = normalizeTextForMatching(job.scenario_brief);
  const candidate = normalizeTextForMatching(scaffold.scenarioBrief);
  if (!existing || !candidate) return true;
  if (existing === candidate || existing.includes(candidate) || candidate.includes(existing)) {
    return true;
  }
  const scaffoldText = [
    scaffold.scenarioTitle,
    scaffold.expectedArtifact,
    ...scaffold.requiredActions,
    ...scaffold.proofObligations,
    ...scaffold.requiredOutputs,
  ].join(' ');
  return scaffoldCoversAnchor(job.scenario_brief, `${candidate} ${scaffoldText}`);
}

function mergeScaffoldStrings(
  existing: string[],
  scaffold: string[],
  mergeScaffold: boolean,
): string[] {
  if (existing.length === 0) return mergeScaffold ? uniqueNonEmptyStrings(scaffold) : [];
  return mergeScaffold
    ? uniqueNonEmptyStrings([...existing, ...scaffold])
    : uniqueNonEmptyStrings(existing);
}

function enrichProductUseValueLoop(
  loop: ProductUseValueLoop,
  productKinds: ProductKind[],
): ProductUseValueLoop {
  const scaffold = materialityScaffold(
    [loop.title, loop.artifact, ...loop.required_capabilities, ...loop.proof_obligations].join(' '),
    productKinds,
  );
  return {
    ...loop,
    required_capabilities: uniqueNonEmptyStrings([
      ...loop.required_capabilities,
      ...scaffold.requiredActions,
    ]),
    proof_obligations: uniqueNonEmptyStrings([
      ...loop.proof_obligations,
      ...scaffold.proofObligations,
    ]),
    weak_evidence: uniqueNonEmptyStrings([...loop.weak_evidence, ...scaffold.weakEvidence]),
  };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value?.trim()));
}

function isMediaImportScaffoldText(text: string): boolean {
  const specificText = normalizeTextForMatching(text).replace(
    /\badd readable text a label a connector media or a second object\b/g,
    '',
  );
  return (
    /\b(insert|upload|import|embed|choose|provide|add|open)\b.{0,48}\b(media|image|video|file|asset|embed)\b/.test(
      specificText,
    ) ||
    /\b(media|image|video|file|asset|embed)\b.{0,48}\b(insert|upload|import|embed|picker|dialog|frame|tile|iframe)\b/.test(
      specificText,
    ) ||
    /\b(uploaded|imported|embedded|iframe|file picker|media tile|image object|embed object)\b/.test(
      specificText,
    )
  );
}

interface MaterialityScaffold {
  scenarioTitle: string;
  scenarioBrief: string;
  testData: string[];
  requiredOutputs: string[];
  qualityBar: string[];
  requiredActions: string[];
  proofObligations: string[];
  expectedArtifact: string;
  acceptableEvidence: string[];
  weakEvidence: string[];
}

type ScenarioFields = Pick<
  MaterialityScaffold,
  'scenarioTitle' | 'scenarioBrief' | 'testData' | 'requiredOutputs' | 'qualityBar'
>;

function withScenario(
  base: Omit<MaterialityScaffold, keyof ScenarioFields>,
  scenario: Partial<ScenarioFields> = {},
): MaterialityScaffold {
  return {
    scenarioTitle: scenario.scenarioTitle ?? '',
    scenarioBrief: scenario.scenarioBrief ?? '',
    testData: scenario.testData ?? [],
    requiredOutputs: scenario.requiredOutputs ?? [],
    qualityBar: scenario.qualityBar ?? [],
    ...base,
  };
}

function materialityScaffold(sourceText: string, productKinds: ProductKind[]): MaterialityScaffold {
  const text = sourceText.toLowerCase();
  const artifactEditor =
    productKinds.includes('canvas_editor') ||
    productKinds.includes('document_editor') ||
    productKinds.includes('media_tool');
  const exportLike = /\b(export|download|save as|print)\b/.test(text);
  const shareLike =
    /\b(share|shared|sharing|collaborat|invite|permission|sign[- ]?in|sign[- ]?up|login|auth)\b/.test(
      text,
    );
  const mediaImportLike = isMediaImportScaffoldText(text);
  const artifactRevisionLike =
    /\b(duplicate|delete|remove|undo|redo|history|revision|revise|object count|arrange|arrangement|board state|document state|state change|state changes|copy|paste)\b/.test(
      text,
    );
  const nonDefaultShapeLike =
    /\b(non[- ]default shape|shape library|shape picker|diamond|cloud|ellipse|triangle|star|heart|hexagon|oval|rhombus|x box|check box)\b/.test(
      text,
    );
  const connectorLike = /\b(arrow|connector|line|freehand|draw stroke|relationship)\b/.test(text);
  const textAnnotationLike =
    /\b(text|note|label|caption|annotation)\b/.test(text) &&
    !/\b(create.*artifact|create.*board|meaningful|composed)\b/.test(text);
  const artifactCreationLike =
    /\b(create|make|draw|place|add|build)\b/.test(text) &&
    /\b(shape|canvas|whiteboard|board|diagram|artifact|object|content|document)\b/.test(text);
  const styleLike =
    /\b(restyle|style an|style a|change.*color|change.*fill|color or fill|dash|stroke|opacity|format)\b/.test(
      text,
    ) &&
    !/\b(create.*artifact|create.*board|meaningful|composed)\b/.test(text) &&
    (!artifactCreationLike ||
      /\b(existing|select|selected|restyle|emphasize|priority)\b/.test(text));
  const implementationConfigurationLike =
    /\b(zero configuration|configuration example|implementation|code|snippet|source|docs?|documentation|manual|guide)\b/.test(
      text,
    ) && !/\bsettings?\b/.test(text);
  const styleToolSettingsLike =
    /\b(tool\/settings|tool settings|chosen tool settings|chosen tool\/settings|object styling reflects the chosen tool)\b/.test(
      text,
    );
  const settingsTermLike =
    !implementationConfigurationLike &&
    !styleToolSettingsLike &&
    (/\b(preferences?|settings?|configure (?:settings?|preferences?|options?)|language|shortcuts?|page menu|minimap|theme)\b/.test(
      text,
    ) ||
      /\b(adjust|open|configure|visit|reach|inspect|set)\b.{0,60}\bsettings?\b/.test(text) ||
      /\bsettings?\s+(surface|panel|destination|state|change|option|menu|utility|utilities)\b/.test(
        text,
      ));
  const settingsLike =
    !exportLike &&
    !shareLike &&
    !mediaImportLike &&
    (settingsTermLike || (productKinds.includes('settings_tool') && !artifactEditor));
  const developerDocsLike =
    (productKinds.includes('developer_tool') || productKinds.includes('developer_documentation')) &&
    /\b(api|code|snippet|javascript|html|css|docs?|documentation|example|dependency|cdn|source|manual|guide)\b/.test(
      text,
    ) &&
    !/\b(run|execute|build|deploy|console|logs?|debug)\b/.test(text);
  const calculatorLike = productKinds.includes('calculator_tool') || isCalculatorProductText(text);
  const contentLike =
    productKinds.includes('search_content') || productKinds.includes('content_site');
  const crudLike = productKinds.includes('crud_workflow');
  const dataGridLike = productKinds.includes('data_grid') || isDataGridProductText(text);
  const dashboardLike = productKinds.includes('dashboard_filtering');
  const dashboardViewControlLike = isDashboardViewControlText(text);
  const dataGridViewControlLike = isDataGridViewControlText(text);
  const commerceLike = productKinds.includes('commerce_checkout');

  if (artifactEditor && exportLike) {
    return withScenario(
      {
        requiredActions: [
          'open an export, save, or download control',
          'complete the output action',
        ],
        proofObligations: ['A product artifact output is initiated from the current work state.'],
        expectedArtifact: 'artifact-linked export, save, or download output',
        acceptableEvidence: ['post-action evidence showing export/download/save state'],
        weakEvidence: ['export menu opened with no output', 'download option visible only'],
      },
      {
        scenarioTitle: 'Export or save the completed work artifact',
        scenarioBrief:
          'Export, download, or save the current artifact after it contains user-created content.',
        requiredOutputs: [
          'an export, download, save, or generated-file result tied to the current artifact',
        ],
        qualityBar: [
          'the output action must follow real artifact creation, not an empty workspace',
        ],
      },
    );
  }
  if (artifactEditor && shareLike) {
    return withScenario(
      {
        requiredActions: ['open the share or collaboration entry point'],
        proofObligations: [
          'The share, collaboration, or auth state is tied to the current artifact.',
        ],
        expectedArtifact: 'artifact-linked share, collaboration, or auth state',
        acceptableEvidence: ['post-action evidence showing board/document-linked share or auth UI'],
        weakEvidence: [
          'share button focused only',
          'generic sign-in page with no artifact context',
        ],
      },
      {
        scenarioTitle: 'Prepare the completed artifact for collaboration',
        scenarioBrief:
          'Open the sharing or collaboration entry point for the current artifact and verify the share/auth state is artifact-scoped.',
        requiredOutputs: [
          'share, invite, collaboration, or auth state tied to the current artifact',
        ],
        qualityBar: ['the proof must show artifact context, not a generic marketing or login page'],
      },
    );
  }
  if (developerDocsLike) {
    return withScenario(
      {
        requiredActions: [
          'open or confirm the relevant documentation, example, or source-code section',
          'inspect the visible code, API, dependency, or implementation text',
        ],
        proofObligations: [
          'The proof shows concrete developer-facing instructions, code, or dependency content.',
          'A generic help/settings page or tab label alone is not enough.',
        ],
        expectedArtifact: 'visible developer documentation, example code, or dependency details',
        acceptableEvidence: ['post-action evidence showing the selected docs/code content'],
        weakEvidence: ['tab label visible only', 'generic help link visible only'],
      },
      {
        scenarioTitle: 'Inspect implementation documentation',
        scenarioBrief:
          'Open or confirm the relevant docs/example/source section and verify concrete code, API, or dependency text is visible.',
        requiredOutputs: ['visible code, API, dependency, or implementation text'],
        qualityBar: ['the evidence must include the actual developer content, not just navigation'],
      },
    );
  }
  if (calculatorLike) {
    return withScenario(
      {
        requiredActions: [
          'fill the calculator form with non-default values',
          'submit or calculate the result',
          'inspect the computed result and interpretation',
        ],
        proofObligations: [
          'The result is computed from the entered inputs.',
          'The proof shows a visible numeric result or category, not only the initial form.',
        ],
        expectedArtifact: 'computed calculator result with visible interpretation',
        acceptableEvidence: ['post-action evidence showing updated calculator result text'],
        weakEvidence: ['calculator form loaded', 'input focused with no computed result'],
      },
      {
        scenarioTitle: 'Calculate a concrete result',
        scenarioBrief:
          'Enter realistic non-default values, calculate, and verify the computed result or classification is visible.',
        requiredOutputs: ['computed result value, category, or interpretation'],
        qualityBar: ['the proof must show a result derived from submitted inputs'],
      },
    );
  }
  if (settingsLike) {
    return withScenario({
      requiredActions: ['open the relevant settings, preferences, help, or configuration surface'],
      proofObligations: [
        'The selected settings/help/configuration destination is visibly reached.',
        'If a setting is changed, the changed UI state is observable.',
      ],
      expectedArtifact: 'visible settings, help, or configuration state',
      acceptableEvidence: ['post-action evidence showing the selected settings/help surface'],
      weakEvidence: ['menu merely opened', 'hover state only', 'generic help link visible only'],
    });
  }
  if (artifactEditor && mediaImportLike) {
    return withScenario(
      {
        requiredActions: [
          'open the media, upload, import, or embed entry point',
          'choose or provide media/embed content',
          'confirm the inserted asset appears in the artifact',
        ],
        proofObligations: [
          'The inserted asset is visible as part of the artifact.',
          'The result is more than a file picker, menu, or transient dialog.',
        ],
        expectedArtifact: 'artifact with visible inserted media, file, image, or embed content',
        acceptableEvidence: ['post-action evidence showing inserted media/embed content'],
        weakEvidence: ['upload dialog opened', 'picker opened but no content inserted'],
      },
      {
        scenarioTitle: 'Add supporting media to the work artifact',
        scenarioBrief:
          'Insert or upload a supporting media item into the current artifact and verify it becomes part of the artifact.',
        requiredOutputs: ['visible inserted media or embed object inside the artifact'],
        qualityBar: ['the media must be artifact content, not just an open picker or dialog'],
      },
    );
  }
  if (artifactEditor && artifactRevisionLike) {
    return withScenario(
      {
        requiredActions: [
          'start from an existing artifact or object',
          'perform a visible edit, history, duplicate, delete, undo, redo, or arrangement action',
          'inspect the artifact state after the action',
        ],
        proofObligations: [
          'The artifact visibly reflects the edit or history action.',
          'Object count, position, arrangement, content, or selection state changes on the artifact.',
        ],
        expectedArtifact: 'revised artifact state with a visible object/content/state delta',
        acceptableEvidence: [
          'post-action evidence showing changed object count, arrangement, content, or history state',
        ],
        weakEvidence: [
          'history button clicked with no artifact change',
          'delete or duplicate control focused only',
          'menu opened without a visible artifact state change',
        ],
      },
      {
        scenarioTitle: 'Revise the work artifact after creating it',
        scenarioBrief:
          'Start from a created artifact, then duplicate, delete, undo, redo, move, or resize content and verify the artifact state visibly changes.',
        requiredOutputs: ['visible before/after state change in artifact content or arrangement'],
        qualityBar: ['the edit must affect artifact content, not only a toolbar or history button'],
      },
    );
  }
  if (artifactEditor && nonDefaultShapeLike) {
    return withScenario(
      {
        requiredActions: [
          'open the shape library or shape picker',
          'choose a non-default shape',
          'place the chosen shape into the artifact',
        ],
        proofObligations: [
          'A non-default shape is visible as artifact content.',
          'The proof is the placed shape, not only the open shape menu.',
        ],
        expectedArtifact: 'artifact containing a non-default shape',
        acceptableEvidence: ['post-action evidence showing a placed non-default shape'],
        weakEvidence: ['shape menu opened', 'default rectangle only', 'shape button highlighted'],
      },
      {
        scenarioTitle: 'Add a decision node with a non-default shape',
        scenarioBrief:
          'Add a diamond decision node labeled "Approve?" to the work artifact and verify the non-default shape remains visible.',
        testData: ['Approve?'],
        requiredOutputs: [
          'non-default diamond or similar decision shape',
          'readable label "Approve?"',
        ],
        qualityBar: ['the scenario proves a real shape-library object, not the default rectangle'],
      },
    );
  }
  if (artifactEditor && connectorLike) {
    return withScenario(
      {
        requiredActions: [
          'create or select at least two artifact elements',
          'draw or place an arrow, connector, line, or freehand stroke',
          'verify the relationship or mark is visible',
        ],
        proofObligations: [
          'A connector, arrow, line, or freehand stroke is visible in the artifact.',
          'The mark is part of the artifact, not merely a selected tool.',
        ],
        expectedArtifact: 'artifact with a visible connector, arrow, line, or freehand stroke',
        acceptableEvidence: ['post-action evidence showing connector or drawn stroke'],
        weakEvidence: ['arrow tool selected', 'draw tool highlighted with no mark'],
      },
      {
        scenarioTitle: 'Connect two steps in the artifact',
        scenarioBrief:
          'Connect the "Draft" and "Review" steps with an arrow, connector, or line and verify the relationship is visible.',
        testData: ['Draft', 'Review'],
        requiredOutputs: ['visible connector, arrow, or line between two labeled steps'],
        qualityBar: ['the connector should communicate a relationship, not be an unrelated mark'],
      },
    );
  }
  if (artifactEditor && textAnnotationLike) {
    return withScenario(
      {
        requiredActions: ['choose a text, note, label, or annotation tool', 'enter readable text'],
        proofObligations: [
          'Readable authored text remains visible as artifact content.',
          'The text is not only in a transient input or formatting field.',
        ],
        expectedArtifact: 'artifact with readable authored text or note',
        acceptableEvidence: ['post-action evidence showing readable text/note in the artifact'],
        weakEvidence: ['text tool selected only', 'empty text box', 'format toolbar only'],
      },
      {
        scenarioTitle: 'Add a readable project note',
        scenarioBrief:
          'Add a readable note labeled "Risk: dependency" to the artifact and verify it remains visible.',
        testData: ['Risk: dependency'],
        requiredOutputs: ['readable note or text label "Risk: dependency"'],
        qualityBar: ['the text must be meaningful content in the artifact, not filler text'],
      },
    );
  }
  if (artifactEditor && styleLike) {
    return withScenario(
      {
        requiredActions: [
          'start from an existing artifact element',
          'change a visible style such as color, fill, dash, stroke, size, or font',
          'inspect the artifact after the change',
        ],
        proofObligations: [
          'The selected artifact element visibly changes appearance.',
          'The proof is on the artifact, not only a selected toolbar control.',
        ],
        expectedArtifact: 'artifact element with visible style change',
        acceptableEvidence: ['post-action evidence showing changed style on artifact content'],
        weakEvidence: ['style palette open', 'toolbar color selected with no object change'],
      },
      {
        scenarioTitle: 'Emphasize a priority item with styling',
        scenarioBrief:
          'Style one item in the work artifact so it is visibly emphasized as the priority item.',
        requiredOutputs: ['one artifact element visibly styled or emphasized'],
        qualityBar: ['the style change must apply to artifact content, not only the toolbar state'],
      },
    );
  }
  if (productKinds.includes('canvas_editor')) {
    return withScenario(
      {
        requiredActions: [
          'create or place visible content on the canvas',
          'add readable text, a label, a connector, media, or a second object',
          'modify an existing object with style, size, position, or structure change',
        ],
        proofObligations: [
          'The canvas contains a composed artifact, not just an activated tool or empty board.',
          'At least one existing canvas object is visibly edited, styled, moved, resized, or connected.',
        ],
        expectedArtifact: 'composed visible canvas artifact with edited object state',
        acceptableEvidence: ['post-action evidence showing multiple/edited canvas elements'],
        weakEvidence: [
          'toolbar selected',
          'shape tool active',
          'palette opened',
          'canvas focused',
          'single trivial mark with no edit or composition',
        ],
      },
      {
        scenarioTitle: 'Create a launch planning board',
        scenarioBrief:
          'Create a small launch planning board titled "Launch plan" with two labeled steps, "Draft" and "Review", a connector or arrow between them, and one visible style change.',
        testData: ['Launch plan', 'Draft', 'Review'],
        requiredOutputs: [
          'readable title or note "Launch plan"',
          'two labeled canvas elements: "Draft" and "Review"',
          'a connector, arrow, or clear relationship between the steps',
          'a visible style, position, size, fill, or color change on at least one element',
        ],
        qualityBar: [
          'the result reads as a simple planning diagram, not isolated marks',
          'labels must be readable in the final evidence',
        ],
      },
    );
  }
  if (productKinds.includes('document_editor')) {
    return withScenario(
      {
        requiredActions: ['enter substantive document content', 'edit or format existing content'],
        proofObligations: [
          'The document contains meaningful authored content.',
          'Existing content is visibly edited, formatted, saved, or exported when available.',
        ],
        expectedArtifact: 'meaningful document content with visible edit or formatting state',
        acceptableEvidence: ['post-action evidence showing authored and edited document content'],
        weakEvidence: ['blank document opened', 'format toolbar selected with no changed content'],
      },
      {
        scenarioTitle: 'Draft and format a project update',
        scenarioBrief:
          'Write a short project update with a title "Weekly update", a paragraph, and at least one visible formatting change.',
        testData: ['Weekly update', 'Launch work is on track'],
        requiredOutputs: [
          'title "Weekly update"',
          'substantive paragraph text',
          'visible formatting or edit state applied to authored content',
        ],
        qualityBar: ['the document must contain real prose, not a placeholder word'],
      },
    );
  }
  if (productKinds.includes('media_tool')) {
    return withScenario(
      {
        requiredActions: [
          'load or create media content',
          'apply a visible transform or output action',
        ],
        proofObligations: ['The media artifact visibly changes or produces an output.'],
        expectedArtifact: 'processed or transformed media artifact',
        acceptableEvidence: ['post-action evidence showing media content after a transform/output'],
        weakEvidence: ['upload dialog opened', 'tool panel visible with no media state change'],
      },
      {
        scenarioTitle: 'Transform a sample media artifact',
        scenarioBrief:
          'Load or create a sample media artifact, apply a visible transform, and verify the transformed media or output is visible.',
        requiredOutputs: ['visible loaded media', 'visible transformation or output state'],
        qualityBar: ['the media state must change, not merely show an empty tool panel'],
      },
    );
  }
  if (contentLike) {
    return withScenario(
      {
        requiredActions: [
          'search, navigate, or choose content',
          'open and consume a content result',
        ],
        proofObligations: ['Specific content is loaded and inspected beyond the landing page.'],
        expectedArtifact: 'loaded content result or article state',
        acceptableEvidence: ['post-action evidence showing the selected content/result'],
        weakEvidence: ['homepage loaded', 'search box visible', 'result link focused only'],
      },
      {
        scenarioTitle: 'Research a specific topic',
        scenarioBrief:
          'Search for "OpenAI", open a relevant content result, and inspect readable article or result content beyond the landing page.',
        testData: ['OpenAI'],
        requiredOutputs: ['specific loaded result or article content for "OpenAI"'],
        qualityBar: ['the proof must show consumed content, not only a search box or homepage'],
      },
    );
  }
  if (crudLike) {
    return withScenario(
      {
        requiredActions: [
          'create or update a product entity',
          'verify the entity appears in state',
        ],
        proofObligations: ['A record, item, row, or workflow state is created or changed.'],
        expectedArtifact: 'created or updated entity visible in product state',
        acceptableEvidence: ['post-action evidence showing the new or changed entity'],
        weakEvidence: ['form opened', 'submit button visible with no saved entity'],
      },
      {
        scenarioTitle: 'Create or update a realistic work item',
        scenarioBrief:
          'Create or update a realistic item named "Follow up with Maya" and verify it appears in the product state.',
        testData: ['Follow up with Maya'],
        requiredOutputs: ['saved item or row named "Follow up with Maya"'],
        qualityBar: ['opening a form is not enough; the item must appear after save/submit'],
      },
    );
  }
  if (dataGridLike && dataGridViewControlLike) {
    const scenario = dataGridConcreteScenario(text);
    return withScenario(
      {
        requiredActions: [
          'apply a table search, sort, page-length, pagination, grouping, or row-detail control',
          'inspect the resulting table rows, count, order, or detail state',
        ],
        proofObligations: [
          'The table state changes in response to the control.',
          'The proof includes row/count/order/detail evidence, not only an opened menu or focused input.',
        ],
        expectedArtifact: 'changed data-grid rows, count, order, page range, or detail state',
        acceptableEvidence: ['post-action evidence showing changed data-grid state'],
        weakEvidence: [
          'filter menu opened',
          'search input focused',
          'column header clicked without rows',
        ],
      },
      {
        scenarioTitle: scenario.scenarioTitle,
        scenarioBrief: scenario.scenarioBrief,
        testData: scenario.testData,
        requiredOutputs: scenario.requiredOutputs,
        qualityBar: [
          'the grid data must change; a focused input or open dropdown alone is weak evidence',
        ],
      },
    );
  }
  if (dashboardLike && dashboardViewControlLike) {
    return withScenario(
      {
        requiredActions: ['apply a filter, sort, drilldown, or data-view control'],
        proofObligations: ['The data view changes in response to the control.'],
        expectedArtifact: 'changed chart, table, metric, or filtered data view',
        acceptableEvidence: ['post-action evidence showing changed dashboard data'],
        weakEvidence: ['filter menu opened', 'control focused with unchanged data'],
      },
      {
        scenarioTitle: 'Change the dashboard view with a real filter',
        scenarioBrief:
          'Apply a visible filter, sort, or drilldown and verify the chart, table, metric, or result set changes.',
        requiredOutputs: ['changed chart, table, metric, or filtered data view'],
        qualityBar: ['the data view must change; an open filter menu alone is weak evidence'],
      },
    );
  }
  if (commerceLike) {
    return withScenario(
      {
        requiredActions: [
          'select a product or option',
          'reach cart, checkout, or purchase boundary',
        ],
        proofObligations: ['A product-specific cart/checkout state exists.'],
        expectedArtifact: 'selected item in cart or checkout state',
        acceptableEvidence: ['post-action evidence showing item-specific cart/checkout state'],
        weakEvidence: ['category menu opened', 'product card visible with no selection'],
      },
      {
        scenarioTitle: 'Select an item and reach the purchase boundary',
        scenarioBrief:
          'Choose a concrete product or option and verify that item-specific cart or checkout state appears.',
        requiredOutputs: ['selected item visible in cart, checkout, or purchase-boundary state'],
        qualityBar: ['the proof must show an item selected, not only category browsing'],
      },
    );
  }
  return withScenario({
    requiredActions: [],
    proofObligations: [
      'A visible user-facing artifact, content result, or state change proves the job.',
    ],
    expectedArtifact: 'visible product outcome',
    acceptableEvidence: ['post-action evidence showing the product outcome'],
    weakEvidence: ['button focused only', 'menu opened with no resulting state change'],
  });
}

function dataGridConcreteScenario(text: string): ScenarioFields {
  if (/\bage\b/.test(text) && /\b(sort|sortable|order|column)\b/.test(text)) {
    return {
      scenarioTitle: 'Sort the table by age',
      scenarioBrief:
        'Sort the Age column and verify the visible row order changes according to age values.',
      testData: ['Sort column: Age'],
      requiredOutputs: ['Age column sorted', 'changed row order visible'],
      qualityBar: [],
    };
  }
  if (
    /\b(salary|currency|numeric|number)\b/.test(text) &&
    /\b(sort|sortable|order|column)\b/.test(text)
  ) {
    return {
      scenarioTitle: 'Sort the table by a numeric column',
      scenarioBrief:
        'Sort a numeric or currency column and verify the visible row order changes according to those values.',
      testData: [],
      requiredOutputs: ['changed row order visible'],
      qualityBar: [],
    };
  }
  if (/\b(page length|entries per page|entries[- ]per[- ]page)\b/.test(text)) {
    const pageLength = pageLengthOptionFromText(text);
    return {
      scenarioTitle: 'Change the table page length',
      scenarioBrief:
        'Change the entries-per-page control and verify the displayed row range or number of visible rows updates.',
      testData: pageLength ? [`Page length option: ${pageLength}`] : [],
      requiredOutputs: ['changed page length or row range visible'],
      qualityBar: [],
    };
  }
  if (/\blondon\b/.test(text)) {
    return {
      scenarioTitle: 'Filter the table by a visible value',
      scenarioBrief:
        'Search the table for "London" and verify London rows plus the filtered entry count or range are visible.',
      testData: ['Search query: London'],
      requiredOutputs: ['London', 'filtered entry count or range visible'],
      qualityBar: [],
    };
  }
  return {
    scenarioTitle: 'Change the data grid with a real control',
    scenarioBrief:
      'Apply a table search, sort, page length, pagination, grouping, or row-detail control and verify row, count, order, or detail output changes.',
    testData: [],
    requiredOutputs: ['changed table rows, count, order, range, or detail state'],
    qualityBar: [],
  };
}

function pageLengthOptionFromText(text: string): string | undefined {
  const nearLabel = text.match(
    /\b(?:page length|entries per page|entries[- ]per[- ]page)\D{0,30}(\d{1,3})\b/,
  );
  if (nearLabel?.[1]) return nearLabel[1];
  const entryCount = text.match(/\b(10|25|50|100)\s+(?:entries|rows)\b/);
  return entryCount?.[1];
}

function isGenericProductUseTitle(title: string): boolean {
  const text = normalizeTextForMatching(title);
  if (!text) return true;
  return (
    /\b(simple|visible|first|current|content|artifact|object|state|board content|canvas content)\b/.test(
      text,
    ) || /\b(create|add|use|open|reach|inspect|verify)\b/.test(text)
  );
}

function isGenericProductUseExpected(value: string): boolean {
  const text = normalizeTextForMatching(value);
  if (!text) return true;
  return /\b(visible|created|updated|edited|changed|current)\b.*\b(content|object|artifact|state|shape|canvas|board|document)\b/.test(
    text,
  );
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isDashboardViewControlText(text: string): boolean {
  return /\b(filter|search|sort|page length|entries per page|pagination|drill|drilldown|data view|dashboard view|date range|segment|facet|pivot|grouping|column control|view control)\b/i.test(
    text,
  );
}

function isDataGridViewControlText(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  if (!isDashboardViewControlText(normalized)) return false;
  const dataGridSpecific =
    /\b(table|grid|datatable|data table|rows?|entries|columns?|page length|pagination|row range|employee table)\b/.test(
      normalized,
    );
  if (!dataGridSpecific) return false;
  const documentationLike =
    /\b(header search|site search|docs?|documentation|manual|reference|implementation|code|snippet|source|example)\b/.test(
      normalized,
    );
  const liveGridLike =
    /\b(live|interactive|in[- ]table|visible)\b.{0,50}\b(table|grid|datatable|data table|rows?|entries|columns?)\b/.test(
      normalized,
    ) ||
    /\b(table|grid|datatable|data table|rows?|entries|columns?)\b.{0,50}\b(live|interactive|in[- ]table|visible)\b/.test(
      normalized,
    ) ||
    /\b(employee table|table search input|entries[- ]per[- ]page selector|sortable .{0,24} column|age column)\b/.test(
      normalized,
    );
  const docsOnly = documentationLike && !liveGridLike;
  return !docsOnly;
}

function isCalculatorProductText(text: string): boolean {
  return (
    /\b(calculator|calculate|computed?|estimate|converter|convert|bmi|mortgage|loan|calorie|bmr|result panel)\b/i.test(
      text,
    ) &&
    /\b(input|field|form|submit|calculate|result|value|classification|category|unit|height|weight|age)\b/i.test(
      text,
    )
  );
}

function isDataGridProductText(text: string): boolean {
  return /\b(data\s*grid|datatable|data table|employee table|row grouping|column headers?|page length|entries per page)\b/i.test(
    text,
  );
}

function normalizeContractProductKinds(
  contract: ProductUseContract,
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
): ProductKind[] {
  const rawKinds = uniqueNonEmptyStrings(contract.product_kinds).filter(
    (kind): kind is ProductKind => ProductKindSchema.safeParse(kind).success,
  );
  let nonUnknownKinds: ProductKind[] = rawKinds.filter((kind) => kind !== 'unknown');

  const contractText = normalizeTextForMatching(
    [
      contract.primary_value_loop,
      ...contract.core_artifacts,
      ...contract.value_loops.flatMap((loop) => [
        loop.title,
        loop.artifact,
        ...loop.required_capabilities,
        ...loop.proof_obligations,
      ]),
      ...contract.user_jobs.flatMap((job) => [
        job.title,
        job.scenario_brief,
        job.expected_artifact,
        ...job.required_actions,
        ...job.required_outputs,
        ...job.quality_bar,
      ]),
    ].join(' '),
  );
  const materialSurfaceText = normalizeTextForMatching(
    surfaces.filter(isProductKindEvidenceSurface).map(surfaceSearchText).join(' '),
  );
  const journeyText = normalizeTextForMatching(
    journeys
      .filter((journey) => journey.priority !== 'could')
      .map(journeySearchText)
      .join(' '),
  );
  const supportText = `${contractText} ${materialSurfaceText} ${journeyText}`;
  const inferredKinds: ProductKind[] = [];
  if (isCalculatorProductText(supportText)) inferredKinds.push('calculator_tool');
  if (isDataGridProductText(supportText)) inferredKinds.push('data_grid');
  if (
    /\b(api|code|snippet|javascript|html|css|docs?|documentation|example|dependency|cdn|source)\b/.test(
      supportText,
    ) &&
    !/\b(run|execute|build|deploy|console|logs?|debug)\b/.test(contractText)
  ) {
    inferredKinds.push('developer_documentation');
  }
  nonUnknownKinds = uniqueNonEmptyStrings([...nonUnknownKinds, ...inferredKinds]) as ProductKind[];
  const concreteCalculatorEvidence = hasConcreteCalculatorEvidence(
    [contract.primary_value_loop, ...contract.core_artifacts, materialSurfaceText].join(' '),
  );
  if (
    nonUnknownKinds.includes('calculator_tool') &&
    !concreteCalculatorEvidence &&
    nonUnknownKinds.some((kind) =>
      ['data_grid', 'developer_documentation', 'dashboard_filtering', 'search_content'].includes(
        kind,
      ),
    )
  ) {
    nonUnknownKinds = nonUnknownKinds.filter((kind) => kind !== 'calculator_tool');
  }
  if (nonUnknownKinds.includes('calculator_tool')) {
    nonUnknownKinds = nonUnknownKinds.filter(
      (kind) =>
        kind === 'calculator_tool' ||
        !['content_site', 'search_content', 'dashboard_filtering', 'data_grid'].includes(kind),
    );
  }
  if (nonUnknownKinds.length === 0) return ['unknown'];
  const primaryKinds = nonUnknownKinds.filter(isPrimaryProductKind);
  const hasOtherPrimary = (kind: ProductKind) =>
    primaryKinds.some((candidate) => candidate !== kind && !areContentPeerKinds(candidate, kind));

  const kept = nonUnknownKinds.filter((kind) => {
    if (kind === 'content_site' || kind === 'search_content') {
      return shouldKeepContentKind({
        kind,
        primaryText: normalizeTextForMatching(
          [contract.primary_value_loop, ...contract.core_artifacts].join(' '),
        ),
        supportText,
        hasOtherPrimary: hasOtherPrimary(kind),
      });
    }
    if (kind === 'document_editor') {
      return shouldKeepDocumentEditorKind({
        contractText,
        supportText,
        hasOtherPrimary: hasOtherPrimary(kind),
      });
    }
    if (kind === 'media_tool') {
      return shouldKeepMediaToolKind({
        contractText,
        supportText,
        hasOtherPrimary: hasOtherPrimary(kind),
      });
    }
    if (kind === 'developer_tool') {
      return shouldKeepDeveloperToolKind({
        contractText,
        materialSurfaceText,
        hasOtherPrimary: hasOtherPrimary(kind),
      });
    }
    if (kind === 'developer_documentation') {
      return shouldKeepDeveloperDocumentationKind({
        contractText,
        supportText,
        hasOtherPrimary: hasOtherPrimary(kind),
      });
    }
    if (kind === 'data_grid') {
      return shouldKeepDataGridKind({
        supportText,
        hasOtherPrimary: hasOtherPrimary(kind),
      });
    }
    if (isSupportingProductKind(kind) && primaryKinds.length > 0) {
      return false;
    }
    return productKindTextPattern(kind).test(supportText);
  });

  if (kept.length > 0) return kept;
  const fallback =
    nonUnknownKinds.find((kind) => !isSupportingProductKind(kind)) ?? nonUnknownKinds[0];
  return fallback ? [fallback] : ['unknown'];
}

function hasConcreteCalculatorEvidence(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  return /\b(calculator|bmi|mortgage|loan|payment|amortization|calorie|bmr|converter|conversion|height|weight|body mass|interest rate)\b/.test(
    normalized,
  );
}

function shouldKeepDataGridKind(input: {
  supportText: string;
  hasOtherPrimary: boolean;
}): boolean {
  const concrete = hasConcreteDataGridEvidence(input.supportText);
  if (input.hasOtherPrimary) return concrete;
  return concrete || productKindTextPattern('data_grid').test(input.supportText);
}

function hasConcreteDataGridEvidence(text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  const explicitGrid =
    /\b(data grid|datatable|data table|employee table|entries per page|page length|row range)\b/.test(
      normalized,
    );
  const tableLike = /\b(table|grid|rows?|entries|columns?)\b/.test(normalized);
  const controlLike =
    /\b(search field|table search|filter input|column sort|sortable|sortable column|sort column|pagination|next page|previous page|entries per page|page length|showing \d+)\b/.test(
      normalized,
    );
  return explicitGrid || (tableLike && controlLike);
}

function isProductKindEvidenceSurface(surface: DiscoverySurface): boolean {
  if (surface.value === 'peripheral') return false;
  if (surface.kind === 'banner' || surface.kind === 'modal') return false;
  if (surface.kind === 'external' || surface.kind === 'footer') return false;
  return true;
}

function isPrimaryProductKind(kind: ProductKind): boolean {
  return !isSupportingProductKind(kind) && kind !== 'unknown';
}

function isSupportingProductKind(kind: ProductKind): boolean {
  return kind === 'auth_account' || kind === 'settings_tool';
}

function areContentPeerKinds(a: ProductKind, b: ProductKind): boolean {
  return (
    (a === 'search_content' && b === 'content_site') ||
    (a === 'content_site' && b === 'search_content')
  );
}

function shouldKeepContentKind(input: {
  kind: 'content_site' | 'search_content';
  primaryText: string;
  supportText: string;
  hasOtherPrimary: boolean;
}): boolean {
  const contentCentricPrimary =
    /\b(search|query|lookup|find|read|article|content result|content page|documentation|docs|wiki|encyclopedia|knowledge base)\b/.test(
      input.primaryText,
    );
  const appWorkflowPrimary =
    /\b(calculate|calculator|computed result|checkout|cart|purchase|product catalog|grid|data grid|datatable|dashboard|filter|sort|table|todo|task|record|canvas|whiteboard|diagram|editor|media|image|video|workflow)\b/.test(
      input.primaryText,
    );
  if (input.hasOtherPrimary) return contentCentricPrimary && !appWorkflowPrimary;
  return contentCentricPrimary || productKindTextPattern(input.kind).test(input.supportText);
}

function productKindTextPattern(kind: ProductKind): RegExp {
  switch (kind) {
    case 'canvas_editor':
      return /\b(canvas|whiteboard|board|diagram|draw|drawing|shape|connector|arrow|toolbar)\b/;
    case 'document_editor':
      return /\b(document|editor|write|compose|paragraph|heading|format|publish)\b/;
    case 'search_content':
      return /\b(search|query|result|article|lookup|find)\b/;
    case 'content_site':
      return /\b(content|article|read|post|documentation|docs|page)\b/;
    case 'crud_workflow':
      return /\b(create|record|item|task|ticket|issue|row|status|workflow|save)\b/;
    case 'dashboard_filtering':
      return /\b(dashboard|metric|chart|table|filter|sort|drill|data)\b/;
    case 'data_grid':
      return /\b(data grid|datatable|data table|table|rows?|columns?|filter|search|sort|pagination|entries per page|page length|grouping)\b/;
    case 'commerce_checkout':
      return /\b(product|catalog|cart|checkout|buy|purchase|order|price)\b/;
    case 'communication_tool':
      return /\b(message|chat|conversation|channel|thread|comment|team|invite|collaborat)\b/;
    case 'developer_tool':
      return /\b(api|sdk|developer|code|console|deploy|build|run|logs?|debug|integration)\b/;
    case 'developer_documentation':
      return /\b(api|sdk|developer|code|snippet|javascript|html|css|docs?|documentation|examples?|dependency|cdn|source|guide)\b/;
    case 'calculator_tool':
      return /\b(calculator|calculate|computed?|estimate|convert|converter|bmi|mortgage|loan|payment|result|category|unit)\b/;
    case 'media_tool':
      return /\b(media|image|video|audio|crop|trim|filter|transform|upload|export)\b/;
    case 'auth_account':
      return /\b(auth|account|sign in|sign up|login|profile|session)\b/;
    case 'settings_tool':
      return /\b(settings|preferences|configuration|configure|theme|language|shortcuts?)\b/;
    default:
      return /\b\B/;
  }
}

function shouldKeepDeveloperToolKind(input: {
  contractText: string;
  materialSurfaceText: string;
  hasOtherPrimary: boolean;
}): boolean {
  const developerIdentity =
    /\b(api|sdk|developer|code|console|integration|deploy|logs?|debug)\b/.test(
      input.contractText,
    ) || /\b(project|workspace)\b.{0,40}\b(run|execute|build|deploy)\b/.test(input.contractText);
  const contractDeveloperWorkflow =
    developerIdentity &&
    /\b(configure|run|execute|build|deploy|inspect|debug|generate|integrate)\b/.test(
      input.contractText,
    );
  const productDeveloperSurface =
    /\b(api|sdk|developer|console|code|deploy|build|run|logs?|debug)\b/.test(
      input.materialSurfaceText,
    );
  if (!input.hasOtherPrimary) return contractDeveloperWorkflow || productDeveloperSurface;
  return contractDeveloperWorkflow;
}

function shouldKeepDeveloperDocumentationKind(input: {
  contractText: string;
  supportText: string;
  hasOtherPrimary: boolean;
}): boolean {
  const docsCentricWorkflow =
    /\b(developer|implement|implementation|integrat|code|snippet|api|docs?|documentation|guide|dependency|cdn|source)\b/.test(
      input.contractText,
    ) &&
    /\b(read|learn|inspect|find|search|verify|use|follow|copy|implement|integrat)\b/.test(
      input.contractText,
    );
  const consumerToolWorkflow =
    /\b(calculate|calculator|computed result|health|bmi|mortgage|loan|checkout|cart|purchase|todo|task|canvas|whiteboard|diagram|media|image|video)\b/.test(
      input.contractText,
    );
  if (!input.hasOtherPrimary) {
    return (
      docsCentricWorkflow ||
      productKindTextPattern('developer_documentation').test(input.supportText)
    );
  }
  return docsCentricWorkflow && !consumerToolWorkflow;
}

function shouldKeepDocumentEditorKind(input: {
  contractText: string;
  supportText: string;
  hasOtherPrimary: boolean;
}): boolean {
  const documentSurface = productKindTextPattern('document_editor').test(input.supportText);
  const documentAuthoringWorkflow =
    /\b(document|doc|page|post|article|paragraph|editor)\b/.test(input.contractText) &&
    /\b(write|compose|draft|author|format|publish|save)\b/.test(input.contractText);
  if (!input.hasOtherPrimary) return documentAuthoringWorkflow || documentSurface;
  return (
    /\b(document editor|word processor|write a document|compose a document|draft a document|author a document)\b/.test(
      input.contractText,
    ) ||
    /\b(document|doc)\b.{0,40}\b(write|compose|draft|author|format|publish|save)\b/.test(
      input.contractText,
    )
  );
}

function shouldKeepMediaToolKind(input: {
  contractText: string;
  supportText: string;
  hasOtherPrimary: boolean;
}): boolean {
  const standaloneMediaWorkflow =
    /\b(media|image|video|audio)\b/.test(input.contractText) &&
    /\b(transform|crop|trim|filter|process|edit|enhance|render|transcode|resize)\b/.test(
      input.contractText,
    );
  if (!input.hasOtherPrimary) {
    return standaloneMediaWorkflow || productKindTextPattern('media_tool').test(input.supportText);
  }
  return standaloneMediaWorkflow;
}

function mergeModelAndSurveySurfaces(
  modelSurfaces: DiscoverySurface[],
  surveySurfaces: DiscoverySurface[],
): DiscoverySurface[] {
  if (modelSurfaces.length === 0) return surveySurfaces;
  if (surveySurfaces.length === 0) return modelSurfaces;
  return [...modelSurfaces, ...surveySurfaces];
}

interface IdNormalization<T> {
  items: T[];
  idMap: Map<string, string>;
}

function normalizeDiscoverySurfaces(
  surfaces: DiscoverySurface[],
): IdNormalization<DiscoverySurface> {
  const canonicalIdByKey = new Map<string, string>();
  const usedIds = new Set<string>();
  const out: DiscoverySurface[] = [];
  const idMap = new Map<string, string>();
  for (const surface of surfaces) {
    const key = `${surface.kind}|${surface.url}|${surface.label.toLowerCase()}`;
    const canonicalId = canonicalIdByKey.get(key);
    if (canonicalId) {
      if (!idMap.has(surface.id)) idMap.set(surface.id, canonicalId);
      continue;
    }
    const id = usedIds.has(surface.id) ? nextSyntheticId('S', usedIds, out.length + 1) : surface.id;
    usedIds.add(id);
    canonicalIdByKey.set(key, id);
    if (!idMap.has(surface.id)) idMap.set(surface.id, id);
    out.push({ ...surface, id });
  }
  return { items: out, idMap };
}

function normalizeDiscoveryJourneys(
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
): IdNormalization<DiscoveryJourney> {
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const canonicalIdByKey = new Map<string, string>();
  const usedIds = new Set<string>();
  const out: DiscoveryJourney[] = [];
  const idMap = new Map<string, string>();
  for (const journey of journeys) {
    const key = journey.suggested_goal.toLowerCase().replace(/\s+/g, ' ').trim();
    const canonicalId = canonicalIdByKey.get(key);
    if (canonicalId) {
      if (!idMap.has(journey.id)) idMap.set(journey.id, canonicalId);
      continue;
    }
    const id = usedIds.has(journey.id) ? nextSyntheticId('J', usedIds, out.length + 1) : journey.id;
    usedIds.add(id);
    canonicalIdByKey.set(key, id);
    if (!idMap.has(journey.id)) idMap.set(journey.id, id);
    out.push({
      ...journey,
      id,
      surface_ids: journey.surface_ids.filter((id) => surfaceIds.has(id)),
    });
  }
  return { items: out, idMap };
}

function nextSyntheticId(prefix: string, usedIds: Set<string>, start: number): string {
  let index = Math.max(1, start);
  while (usedIds.has(`${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}

function remapDiscoveryOutputRefs(
  out: DiscoveryOutput,
  surfaceIdMap: Map<string, string>,
  journeyIdMap: Map<string, string>,
): DiscoveryOutput {
  const coveragePlan = out.coverage_plan
    ? {
        ...out.coverage_plan,
        selected_journey_ids: remapUniqueIds(out.coverage_plan.selected_journey_ids, journeyIdMap),
        deferred_surface_ids: remapUniqueIds(out.coverage_plan.deferred_surface_ids, surfaceIdMap),
      }
    : undefined;
  const productUseContract = out.product_use_contract
    ? {
        ...out.product_use_contract,
        user_jobs: out.product_use_contract.user_jobs.map((job) => {
          const journeyId = job.journey_id ? remapId(job.journey_id, journeyIdMap) : undefined;
          return {
            ...job,
            ...(journeyId ? { journey_id: journeyId } : {}),
          };
        }),
      }
    : undefined;
  return {
    ...out,
    goals: remapGoalRefs(out.goals, surfaceIdMap, journeyIdMap),
    capabilities: out.capabilities.map((capability) => ({
      ...capability,
      journey_ids: remapUniqueIds(capability.journey_ids, journeyIdMap),
      surface_ids: remapUniqueIds(capability.surface_ids, surfaceIdMap),
    })),
    ...(coveragePlan ? { coverage_plan: coveragePlan } : {}),
    ...(productUseContract ? { product_use_contract: productUseContract } : {}),
  };
}

function remapJourneySurfaceRefs(
  journeys: DiscoveryJourney[],
  surfaceIdMap: Map<string, string>,
): DiscoveryJourney[] {
  return journeys.map((journey) => ({
    ...journey,
    surface_ids: remapUniqueIds(journey.surface_ids, surfaceIdMap),
  }));
}

function remapGoalRefs(
  goals: DiscoveryGoal[],
  surfaceIdMap: Map<string, string>,
  journeyIdMap: Map<string, string>,
): DiscoveryGoal[] {
  return goals.map((goal) => {
    const journeyId = goal.journey_id ? remapId(goal.journey_id, journeyIdMap) : undefined;
    return {
      ...goal,
      ...(journeyId ? { journey_id: journeyId } : {}),
      surface_ids: remapUniqueIds(goal.surface_ids, surfaceIdMap),
    };
  });
}

function remapUniqueIds(values: string[], idMap: Map<string, string>): string[] {
  return uniqueNonEmptyStrings(values.map((value) => remapId(value, idMap)));
}

function remapId(value: string, idMap: Map<string, string>): string {
  return idMap.get(value) ?? value;
}

function attachPageContextSurfaces(
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
): DiscoveryJourney[] {
  if (journeys.length === 0 || surfaces.length === 0) return journeys;
  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  const referenced = new Set(journeys.flatMap((journey) => journey.surface_ids));
  const pageContextSurfaces = surfaces.filter(
    (surface) => surface.kind === 'page' && !referenced.has(surface.id),
  );
  if (pageContextSurfaces.length === 0) return journeys;
  return journeys.map((journey, index) => {
    const matchingPageIds = pageContextSurfaces
      .filter((pageSurface) =>
        journey.surface_ids.some((surfaceId) => byId.get(surfaceId)?.url === pageSurface.url),
      )
      .map((surface) => surface.id);
    const fallbackPageIds =
      index === 0
        ? pageContextSurfaces
            .filter(
              (pageSurface) =>
                !journeys.some((candidate) =>
                  candidate.surface_ids.some(
                    (surfaceId) => byId.get(surfaceId)?.url === pageSurface.url,
                  ),
                ),
            )
            .map((surface) => surface.id)
        : [];
    const nextSurfaceIds = [
      ...new Set([...matchingPageIds, ...fallbackPageIds, ...journey.surface_ids]),
    ];
    return nextSurfaceIds.length === journey.surface_ids.length
      ? journey
      : { ...journey, surface_ids: nextSurfaceIds };
  });
}

function normalizeDiscoveryCoveragePlan(
  plan: DiscoveryCoveragePlan | undefined,
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
  productUseContract: ProductUseContract | undefined,
): DiscoveryCoveragePlan | undefined {
  if (!plan && journeys.length === 0 && surfaces.length === 0) return undefined;
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const productKinds = normalizedProductKinds(productUseContract);
  const contractJourneyIds = new Set(
    productUseContract?.user_jobs
      .filter(
        (job) => !isSupportWorkflowForConcreteProduct(productUseJobSearchText(job), productKinds),
      )
      .map((job) => job.journey_id)
      .filter((id): id is string => Boolean(id)) ?? [],
  );
  const selected = plan?.selected_journey_ids.filter((id) => journeyIds.has(id)) ?? [];
  const requestedSelection =
    selected.length > 0
      ? selected
      : journeys.filter((j) => j.priority !== 'could').map((j) => j.id);
  const requiredSelection = journeys
    .filter((journey) => journey.priority !== 'could')
    .filter((journey) => {
      const text = journeyScenarioText(journey);
      return (
        journey.goal_class === 'core' ||
        contractJourneyIds.has(journey.id) ||
        isConcreteDataGridWorkflow(text, productKinds) ||
        isImplementationCodeWorkflowForDeveloperExample(text, productKinds)
      );
    })
    .map((journey) => journey.id);
  let selected_journey_ids = [...new Set([...requiredSelection, ...requestedSelection])].filter(
    (id) => {
      const journey = journeys.find((candidate) => candidate.id === id);
      return journey ? isSeedGoalClass(journey.goal_class ?? 'peripheral') : false;
    },
  );
  if (selected_journey_ids.length === 0) {
    selected_journey_ids = journeys
      .filter((journey) => isSeedGoalClass(journey.goal_class ?? 'peripheral'))
      .map((journey) => journey.id);
  }
  const selectedSurfaceIds = new Set(
    journeys
      .filter((journey) => selected_journey_ids.includes(journey.id))
      .flatMap((journey) => journey.surface_ids),
  );
  const unselectedMaterialitySurfaceIds = journeys
    .filter((journey) => !selected_journey_ids.includes(journey.id))
    .filter((journey) => !isSeedGoalClass(journey.goal_class ?? 'peripheral'))
    .flatMap((journey) => journey.surface_ids);
  const requestedDeferred = plan?.deferred_surface_ids.filter((id) => surfaceIds.has(id)) ?? [];
  const defaultDeferred = [
    ...surfaces.filter((surface) => surface.value === 'peripheral').map((surface) => surface.id),
    ...unselectedMaterialitySurfaceIds,
  ];
  const deferred = [...new Set([...requestedDeferred, ...defaultDeferred])].filter(
    (id) => !selectedSurfaceIds.has(id),
  );
  return {
    selected_journey_ids,
    deferred_surface_ids: deferred,
    rationale: plan?.rationale ?? '',
    ...(plan?.recommended_steps_per_goal
      ? { recommended_steps_per_goal: plan.recommended_steps_per_goal }
      : {}),
    coverage_risk: plan?.coverage_risk ?? (surfaces.length > 12 ? 'medium' : 'low'),
  };
}

interface DiscoveryCapabilityPrior {
  key: string;
  label: string;
  productKind: ProductKind;
  importance: DiscoveryCapabilityImportance;
  denominatorReason: string;
  surfacePattern: RegExp;
  textPattern: RegExp;
  requiresSurfaceMatch?: boolean;
  requiresEvidenceAlways?: boolean;
}

interface DiscoveryCapabilitySeed {
  key: string;
  label: string;
  product_kind: ProductKind;
  importance: DiscoveryCapabilityImportance;
  status: DiscoveryCapabilityStatus;
  selection_expectation?: DiscoveryCapabilitySelectionExpectation | undefined;
  skip_reason?: string | undefined;
  confidence: number;
  source: DiscoveryCapability['source'];
  evidence: string[];
  scenario_ids: string[];
  journey_ids: string[];
  surface_ids: string[];
  denominator_reason: string;
  coverage_gap: string;
  surfacePattern?: RegExp;
  textPattern?: RegExp;
}

const DISCOVERY_CAPABILITY_PRIORS: DiscoveryCapabilityPrior[] = [
  {
    key: 'canvas.create_artifact',
    label: 'Create visible canvas content',
    productKind: 'canvas_editor',
    importance: 'core',
    denominatorReason: 'Canvas editors must let users create visible work on the canvas.',
    surfacePattern: /\b(canvas|whiteboard|board|workspace|shape|draw|rectangle|object)\b/i,
    textPattern:
      /\b(create|place|draw|add|make).{0,60}\b(canvas|board|shape|object|artifact|diagram)\b/i,
  },
  {
    key: 'canvas.text_notes',
    label: 'Add readable text or notes',
    productKind: 'canvas_editor',
    importance: 'core',
    denominatorReason: 'Whiteboard and diagram artifacts usually need labels or notes.',
    surfacePattern: /\b(text|note|labels?|caption|annotation|paragraph|Aa)\b/i,
    textPattern: /\b(text|note|labels?|caption|annotation|readable words?)\b/i,
  },
  {
    key: 'canvas.shapes',
    label: 'Use shape-library objects',
    productKind: 'canvas_editor',
    importance: 'core',
    denominatorReason:
      'A canvas editor exposing shape tools should prove more than one default object.',
    surfacePattern:
      /\b(shapes?|rectangle|ellipse|triangle|diamond|cloud|star|heart|hexagon|oval)\b/i,
    textPattern:
      /\b(shapes?|non[- ]default shape|shape library|shape picker|diamond|cloud|ellipse|triangle|star|heart|hexagon)\b/i,
  },
  {
    key: 'canvas.connectors',
    label: 'Connect or draw relationships',
    productKind: 'canvas_editor',
    importance: 'core',
    denominatorReason:
      'Diagram/whiteboard use often depends on connectors, arrows, lines, or freehand marks.',
    surfacePattern: /\b(arrow|connector|line|draw|freehand|pen|stroke)\b/i,
    textPattern: /\b(arrow|connector|line|freehand|draw|relationship|connect)\b/i,
  },
  {
    key: 'canvas.style',
    label: 'Style or format canvas objects',
    productKind: 'canvas_editor',
    importance: 'core',
    denominatorReason:
      'Visible style controls should change artifact content, not just toolbar state.',
    surfacePattern: /\b(color|fill|stroke|dash|opacity|size|font|style|format)\b/i,
    textPattern: /\b(style|restyle|format|color|fill|dash|stroke|opacity|size|font)\b/i,
  },
  {
    key: 'canvas.revise',
    label: 'Revise existing objects',
    productKind: 'canvas_editor',
    importance: 'core',
    denominatorReason:
      'Creation tools should support post-creation changes such as move, resize, duplicate, delete, undo, or redo.',
    surfacePattern: /\b(move|resize|duplicate|delete|undo|redo|arrange|copy|paste|history)\b/i,
    textPattern:
      /\b(move|resize|duplicate|delete|undo|redo|arrange|copy|paste|history|revise|edit)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'canvas.media',
    label: 'Import media or embeds',
    productKind: 'canvas_editor',
    importance: 'important',
    denominatorReason:
      'Media/import surfaces are important secondary artifact-expansion paths when visible.',
    surfacePattern: /\b(media|upload|embed|import|image|file|insert)\b/i,
    textPattern: /\b(media|upload|embed|import|image|file|insert)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'canvas.export',
    label: 'Export or save the board',
    productKind: 'canvas_editor',
    importance: 'important',
    denominatorReason:
      'Durable output matters for artifact editors that expose export, save, download, or print.',
    surfacePattern: /\b(export|download|save as|save|print|output)\b/i,
    textPattern: /\b(export|download|save as|save|print|output)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'canvas.share',
    label: 'Share or collaborate on the board',
    productKind: 'canvas_editor',
    importance: 'important',
    denominatorReason:
      'Share/collaboration is important when the product exposes board-linked sharing or auth entry points.',
    surfacePattern: /\b(share|collaborat|invite|permission|sign in|sign-in|login)\b/i,
    textPattern: /\b(share|collaborat|invite|permission|sign in|sign-in|login)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'document.compose',
    label: 'Compose substantive document content',
    productKind: 'document_editor',
    importance: 'core',
    denominatorReason: 'Document editors must prove authored content, not just an empty editor.',
    surfacePattern: /\b(document|editor|text|paragraph|page|write|compose)\b/i,
    textPattern: /\b(write|compose|draft|document|paragraph|content)\b/i,
  },
  {
    key: 'document.format',
    label: 'Format authored content',
    productKind: 'document_editor',
    importance: 'core',
    denominatorReason: 'Formatting controls should visibly affect authored document content.',
    surfacePattern: /\b(bold|italic|heading|font|format|style|list|align)\b/i,
    textPattern: /\b(format|bold|italic|heading|font|style|list|align)\b/i,
  },
  {
    key: 'document.structure',
    label: 'Organize document structure',
    productKind: 'document_editor',
    importance: 'important',
    denominatorReason:
      'Document products often need headings, lists, sections, or layout structure.',
    surfacePattern: /\b(heading|section|list|table|layout|outline)\b/i,
    textPattern: /\b(heading|section|list|table|layout|outline|structure)\b/i,
  },
  {
    key: 'document.export',
    label: 'Save, export, or share document output',
    productKind: 'document_editor',
    importance: 'important',
    denominatorReason:
      'A document artifact should become durable through save, export, share, or publish.',
    surfacePattern: /\b(save|export|download|publish|share|print)\b/i,
    textPattern: /\b(save|export|download|publish|share|print)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'content.search',
    label: 'Search for specific content',
    productKind: 'search_content',
    importance: 'core',
    denominatorReason:
      'Search/content products should prove a specific query can reach useful content.',
    surfacePattern: /\b(search|query|find|lookup|input)\b/i,
    textPattern: /\b(search|query|find|lookup)\b/i,
  },
  {
    key: 'content.open_result',
    label: 'Open and read a content result',
    productKind: 'search_content',
    importance: 'core',
    denominatorReason:
      'A search result is only useful if the user can open and consume the target content.',
    surfacePattern: /\b(article|result|content|page|read|title)\b/i,
    textPattern: /\b(article|result|content|read|open)\b/i,
  },
  {
    key: 'content.navigate',
    label: 'Navigate within content',
    productKind: 'search_content',
    importance: 'important',
    denominatorReason:
      'Content products often expose sections, contents, citations, related links, or pagination.',
    surfacePattern:
      /\b(section|contents|toc|reference|citation|related|next|previous|pagination)\b/i,
    textPattern: /\b(section|contents|toc|reference|citation|related|navigate|navigation)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'content.language_or_account',
    label: 'Use visible content tools',
    productKind: 'search_content',
    importance: 'important',
    denominatorReason:
      'Language, edit/history, or talk tools are product-native content capabilities when visible.',
    surfacePattern: /\b(language|translate|edit|history|talk)\b/i,
    textPattern: /\b(language|translate|edit|history|talk)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'content.consume_page',
    label: 'Consume visible content',
    productKind: 'content_site',
    importance: 'core',
    denominatorReason:
      'Content sites should prove the user can reach and consume specific content.',
    surfacePattern: /\b(article|content|card|post|documentation|docs|read|media)\b/i,
    textPattern:
      /\b(open|read|consume|inspect).{0,60}\b(content|article|post|documentation|docs|media)\b/i,
  },
  {
    key: 'calculator.calculate',
    label: 'Calculate a concrete result',
    productKind: 'calculator_tool',
    importance: 'core',
    denominatorReason: 'Calculator tools must prove submitted inputs produce a computed result.',
    surfacePattern: /\b(calculator|calculate|input|form|result|bmi|mortgage|payment|converter)\b/i,
    textPattern:
      /\b(calculate|computed?|estimate|convert).{0,80}\b(result|value|category|payment|bmi|output)\b/i,
  },
  {
    key: 'calculator.inputs_units',
    label: 'Use input fields and unit options',
    productKind: 'calculator_tool',
    importance: 'important',
    denominatorReason:
      'Form calculators usually expose unit, option, or input variants that affect the result.',
    surfacePattern: /\b(units?|input|field|height|weight|age|metric|imperial|option|selector)\b/i,
    textPattern: /\b(unit|input|field|metric|imperial|option|selector|non[- ]default)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'crud.create',
    label: 'Create a record or item',
    productKind: 'crud_workflow',
    importance: 'core',
    denominatorReason:
      'CRUD workflows need a saved entity or workflow state, not just an open form.',
    surfacePattern: /\b(create|new|add|submit|save|form|item|record|task)\b/i,
    textPattern: /\b(create|new|add|submit|save).{0,60}\b(item|record|task|entity|row)\b/i,
  },
  {
    key: 'crud.update',
    label: 'Update existing state',
    productKind: 'crud_workflow',
    importance: 'core',
    denominatorReason: 'Workflow products should prove existing records can be changed.',
    surfacePattern: /\b(edit|update|status|assign|complete|save|change)\b/i,
    textPattern: /\b(edit|update|status|assign|complete|change)\b/i,
  },
  {
    key: 'crud.find_filter',
    label: 'Find, filter, or sort records',
    productKind: 'crud_workflow',
    importance: 'important',
    denominatorReason: 'Record systems normally require finding and scanning existing work.',
    surfacePattern: /\b(search|filter|sort|list|table|kanban|board)\b/i,
    textPattern: /\b(search|filter|sort|list|table|kanban)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'dashboard.filter',
    label: 'Change a dashboard view',
    productKind: 'dashboard_filtering',
    importance: 'core',
    denominatorReason: 'Dashboards must prove controls change data, charts, or tables.',
    surfacePattern:
      /\b(filter|sort|date range|segment|facet|pivot|grouping|column control|view control|drilldown)\b/i,
    textPattern:
      /\b(filter|sort|drill|change|apply).{0,60}\b(chart|table|metric|dashboard|data)\b/i,
    requiresSurfaceMatch: true,
    requiresEvidenceAlways: true,
  },
  {
    key: 'dashboard.drilldown',
    label: 'Drill into data details',
    productKind: 'dashboard_filtering',
    importance: 'important',
    denominatorReason: 'Complex dashboards often need drilldowns or detail inspection.',
    surfacePattern: /\b(drill|drilldown|details panel|detail view|expand|breakdown|tooltip)\b/i,
    textPattern: /\b(drill|detail|breakdown|inspect|expand)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'data_grid.search_filter',
    label: 'Filter data-grid rows',
    productKind: 'data_grid',
    importance: 'core',
    denominatorReason:
      'Data grids must prove table search/filter controls change visible rows or counts.',
    surfacePattern:
      /\b(table search|search field|filter input|search input|filter control|data grid|datatable|data table)\b|\b(search|filter)\b.{0,40}\b(table|grid|rows?|entries)\b|\b(table|grid|rows?|entries)\b.{0,40}\b(search|filter)\b/i,
    textPattern: /\b(search|filter).{0,80}\b(table|rows?|entries|data grid|datatable|count)\b/i,
    requiresSurfaceMatch: true,
    requiresEvidenceAlways: true,
  },
  {
    key: 'data_grid.sort_page',
    label: 'Sort or page data-grid rows',
    productKind: 'data_grid',
    importance: 'core',
    denominatorReason:
      'Data grids should prove sorting, page length, pagination, or row order changes.',
    surfacePattern:
      /\b(sortable|sort column|column sort|pagination|page length|entries per page|next page|previous page|row range|data grid|datatable|data table)\b|\b(sort|sortable|page length|pagination|entries per page|next page|previous page)\b.{0,40}\b(table|grid|column|rows?|entries)\b|\b(table|grid|column|rows?|entries)\b.{0,40}\b(sort|sortable|page length|pagination|entries per page|next page|previous page)\b/i,
    textPattern: /\b(sort|page length|entries per page|pagination|row order|column)\b/i,
    requiresSurfaceMatch: true,
    requiresEvidenceAlways: true,
  },
  {
    key: 'developer_docs.read_code',
    label: 'Read implementation code or dependencies',
    productKind: 'developer_documentation',
    importance: 'core',
    denominatorReason:
      'Developer documentation should prove users can find concrete code, API, or dependency instructions.',
    surfacePattern:
      /\b(code|snippet|javascript|html|css|api|docs?|documentation|dependency|cdn|source|example)\b/i,
    textPattern:
      /\b(code|snippet|javascript|html|css|api|dependency|dependencies|cdn|source|initiali[sz]e)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'commerce.browse_detail',
    label: 'Browse products and inspect details',
    productKind: 'commerce_checkout',
    importance: 'core',
    denominatorReason: 'Commerce products need item-specific product selection before checkout.',
    surfacePattern: /\b(product|catalog|item|detail|option|variant|price)\b/i,
    textPattern: /\b(product|catalog|item|detail|option|variant|price)\b/i,
  },
  {
    key: 'commerce.cart_checkout',
    label: 'Reach cart or checkout with a selected item',
    productKind: 'commerce_checkout',
    importance: 'core',
    denominatorReason:
      'Checkout quality requires a product-specific cart or purchase-boundary state.',
    surfacePattern: /\b(cart|checkout|buy|purchase|add to cart|bag|order)\b/i,
    textPattern: /\b(cart|checkout|buy|purchase|add to cart|bag|order)\b/i,
  },
  {
    key: 'developer.configure_run',
    label: 'Configure and run a developer workflow',
    productKind: 'developer_tool',
    importance: 'core',
    denominatorReason:
      'Developer tools should prove configuration or execution, not only documentation navigation.',
    surfacePattern: /\b(run|build|deploy|execute|configure|project|workspace|api|sdk|console)\b/i,
    textPattern: /\b(run|build|deploy|execute|configure|project|workspace|api|sdk|console)\b/i,
  },
  {
    key: 'developer.inspect_output',
    label: 'Inspect logs, output, or errors',
    productKind: 'developer_tool',
    importance: 'important',
    denominatorReason: 'Developer workflows need observable output, logs, or error recovery.',
    surfacePattern: /\b(log|output|error|trace|result|status|debug)\b/i,
    textPattern: /\b(log|output|error|trace|result|status|debug)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'auth.entry',
    label: 'Reach account or sign-in state',
    productKind: 'auth_account',
    importance: 'important',
    denominatorReason: 'Account surfaces should prove a real auth/account boundary when visible.',
    surfacePattern: /\b(sign in|sign-in|login|log in|account|create account|profile|auth)\b/i,
    textPattern: /\b(sign in|sign-in|login|log in|account|create account|profile|auth)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'settings.change',
    label: 'Change or inspect settings',
    productKind: 'settings_tool',
    importance: 'important',
    denominatorReason: 'Settings surfaces should prove a visible configuration state or change.',
    surfacePattern: /\b(settings|preferences|appearance|theme|configure|language|shortcut)\b/i,
    textPattern: /\b(settings|preferences|appearance|theme|configure|language|shortcut)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'communication.share',
    label: 'Share, invite, or collaborate',
    productKind: 'communication_tool',
    importance: 'important',
    denominatorReason:
      'Communication surfaces should prove sharing, invite, message, or collaboration state.',
    surfacePattern: /\b(share|invite|message|comment|collaborat|team|permission)\b/i,
    textPattern: /\b(share|invite|message|comment|collaborat|team|permission)\b/i,
    requiresSurfaceMatch: true,
  },
  {
    key: 'media.transform',
    label: 'Load or transform media',
    productKind: 'media_tool',
    importance: 'core',
    denominatorReason:
      'Media tools need visible media content and an observable transform or output.',
    surfacePattern: /\b(media|image|video|audio|upload|crop|trim|filter|transform|export)\b/i,
    textPattern: /\b(media|image|video|audio|upload|crop|trim|filter|transform|export)\b/i,
  },
];

function normalizeDiscoveryCapabilities(
  modelCapabilities: DiscoveryCapability[],
  productUseContract: ProductUseContract | undefined,
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
  coveragePlan: DiscoveryCoveragePlan | undefined,
  goals: DiscoveryGoal[],
): DiscoveryCapability[] {
  const seeds = new Map<string, DiscoveryCapabilitySeed>();
  const productKinds = normalizedProductKinds(productUseContract);
  for (const capability of filterModelCapabilitiesForProductKinds(
    modelCapabilities,
    productKinds,
  )) {
    mergeCapabilitySeed(seeds, {
      key: capabilityKey(capability.label || capability.id),
      label: capability.label,
      product_kind: capability.product_kind,
      importance: capability.importance,
      status: capability.status,
      selection_expectation: undefined,
      skip_reason: capability.skip_reason,
      confidence: capability.confidence,
      source: 'model',
      evidence: capability.evidence,
      scenario_ids: capability.scenario_ids,
      journey_ids: capability.journey_ids,
      surface_ids: capability.surface_ids,
      denominator_reason: capability.denominator_reason,
      coverage_gap: capability.coverage_gap,
    });
  }

  const surfaceText = surfaces.map(surfaceSearchText).join(' ');
  const journeyText = journeys.map(journeyScenarioText).join(' ');
  const singleKind = productKinds.length === 1;
  for (const prior of DISCOVERY_CAPABILITY_PRIORS) {
    const kindMatches = productKinds.includes(prior.productKind);
    const surfaceInferenceAllowed =
      productKinds.length === 0 ||
      capabilityPriorCompatibleWithKinds(productKinds, prior.productKind);
    const matchingSurfaceIds = surfaces
      .filter((surface) => prior.surfacePattern.test(surfaceSearchText(surface)))
      .map((surface) => surface.id);
    const matchingJourneyIds = journeys
      .filter((journey) => prior.textPattern.test(journeyScenarioText(journey)))
      .map((journey) => journey.id);
    const evidenceMatches =
      matchingSurfaceIds.length > 0 ||
      matchingJourneyIds.length > 0 ||
      prior.surfacePattern.test(surfaceText) ||
      prior.textPattern.test(journeyText);
    if (!kindMatches && !(surfaceInferenceAllowed && evidenceMatches)) continue;
    if (
      (prior.requiresEvidenceAlways || (prior.requiresSurfaceMatch && !singleKind)) &&
      !evidenceMatches
    )
      continue;
    mergeCapabilitySeed(seeds, {
      key: prior.key,
      label: prior.label,
      product_kind: prior.productKind,
      importance: prior.importance,
      status: 'discovered',
      confidence: kindMatches ? 0.75 : 0.62,
      source: kindMatches ? 'product_kind_prior' : 'surface',
      evidence: evidenceMatches
        ? uniqueNonEmptyStrings([
            matchingSurfaceIds.length > 0
              ? `matched surfaces: ${matchingSurfaceIds.slice(0, 5).join(', ')}`
              : '',
            matchingJourneyIds.length > 0
              ? `matched journeys: ${matchingJourneyIds.slice(0, 5).join(', ')}`
              : '',
          ])
        : [],
      scenario_ids: [],
      journey_ids: matchingJourneyIds,
      surface_ids: matchingSurfaceIds,
      denominator_reason: prior.denominatorReason,
      coverage_gap: '',
      surfacePattern: prior.surfacePattern,
      textPattern: prior.textPattern,
    });
  }

  for (const loop of productUseContract?.value_loops ?? []) {
    for (const capabilityText of loop.required_capabilities ?? []) {
      const matchedPrior = compatibleCapabilityPriorForText(capabilityText, productKinds);
      if (matchedPrior) {
        mergeCapabilitySeed(
          seeds,
          seedFromPrior(matchedPrior, {
            confidence: 0.72,
            evidence: [`value loop ${loop.id}: ${capabilityText}`],
            source: 'product_kind_prior',
          }),
        );
      } else if (productKinds.length === 0) {
        mergeCapabilitySeed(
          seeds,
          seedFromFreeformCapability(
            capabilityText,
            productKinds[0] ?? 'unknown',
            'important',
            'user_job',
          ),
        );
      }
    }
  }
  for (const job of productUseContract?.user_jobs ?? []) {
    const text = [
      job.title,
      job.scenario_brief,
      job.expected_artifact,
      ...(job.required_actions ?? []),
      ...(job.required_outputs ?? []),
    ].join(' ');
    const selectedJourneyIds = new Set(coveragePlan?.selected_journey_ids ?? []);
    const jobSelected = job.journey_id ? selectedJourneyIds.has(job.journey_id) : false;
    const matchedPrior = compatibleCapabilityPriorForText(text, productKinds);
    if (matchedPrior) {
      mergeCapabilitySeed(
        seeds,
        seedFromPrior(matchedPrior, {
          confidence: 0.78,
          source: 'product_kind_prior',
          evidence: [`scenario ${job.id}: ${job.title}`],
          journey_ids: job.journey_id ? [job.journey_id] : [],
        }),
      );
      if (!jobSelected && shouldSeedFreeformUserJobCapability(job)) {
        mergeCapabilitySeed(seeds, seedFromUserJobCapability(job, productKinds));
      }
    } else if (
      productKinds.length === 0 ||
      productKinds.includes('unknown') ||
      shouldSeedFreeformUserJobCapability(job)
    ) {
      mergeCapabilitySeed(seeds, seedFromUserJobCapability(job, productKinds));
    }
  }
  if (seeds.size === 0) {
    for (const journey of journeys.filter((journey) =>
      isSeedGoalClass(journey.goal_class ?? 'core'),
    )) {
      mergeCapabilitySeed(seeds, {
        ...seedFromFreeformCapability(
          journey.title,
          productKinds[0] ?? 'unknown',
          journey.priority === 'must' ? 'core' : 'important',
          'journey',
        ),
        journey_ids: [journey.id],
        surface_ids: journey.surface_ids,
      });
    }
  }

  const selectedJourneyIds = new Set(coveragePlan?.selected_journey_ids ?? []);
  return [...seeds.values()]
    .map((seed) =>
      finalizeCapabilitySeed(seed, {
        goals,
        journeys,
        surfaces,
        selectedJourneyIds,
        productKinds,
      }),
    )
    .filter((capability) => capability.label.trim())
    .sort(compareCapabilities)
    .map((capability, index) => ({ ...capability, id: `C${index + 1}` }));
}

export function deriveDiscoveryCapabilitiesForReport(input: {
  capabilities?: DiscoveryCapability[] | undefined;
  product_use_contract?: ProductUseContract | undefined;
  journeys?: DiscoveryJourney[] | undefined;
  surfaces?: DiscoverySurface[] | undefined;
  coverage_plan?: DiscoveryCoveragePlan | undefined;
  goals?: DiscoveryGoal[] | undefined;
}): DiscoveryCapability[] {
  return normalizeDiscoveryCapabilities(
    input.capabilities ?? [],
    input.product_use_contract,
    input.journeys ?? [],
    input.surfaces ?? [],
    input.coverage_plan,
    input.goals ?? [],
  );
}

function filterModelCapabilitiesForProductKinds(
  capabilities: DiscoveryCapability[],
  productKinds: ProductKind[],
): DiscoveryCapability[] {
  if (productKinds.length === 0) return capabilities;
  return capabilities.filter((capability) => {
    const kind = capability.product_kind;
    if (kind === 'unknown') return true;
    if (capabilityPriorCompatibleWithKinds(productKinds, kind)) return true;
    if (kind === 'media_tool' && productKinds.some(isArtifactEditorKind)) return false;
    if (isSupportingProductKind(kind) || kind === 'developer_tool') return false;
    return false;
  });
}

function shouldSeedFreeformUserJobCapability(job: ProductUseJob): boolean {
  if (job.risk === 'low') return false;
  const text = normalizeTextForMatching(
    [
      job.title,
      job.scenario_brief,
      job.expected_artifact,
      ...(job.required_actions ?? []),
      ...(job.proof_obligations ?? []),
      ...(job.required_outputs ?? []),
      ...(job.quality_bar ?? []),
    ].join(' '),
  );
  if (!text || isLowSignalSetupText(text)) return false;
  return true;
}

function seedFromUserJobCapability(
  job: ProductUseJob,
  productKinds: ProductKind[],
): DiscoveryCapabilitySeed {
  return {
    ...seedFromFreeformCapability(
      job.title,
      productKinds.find((kind) => kind !== 'unknown') ?? 'unknown',
      job.risk === 'high' ? 'core' : 'important',
      'user_job',
    ),
    journey_ids: job.journey_id ? [job.journey_id] : [],
    evidence: [`scenario ${job.id}: ${job.title}`],
  };
}

function isArtifactEditorKind(kind: ProductKind): boolean {
  return kind === 'canvas_editor' || kind === 'document_editor' || kind === 'media_tool';
}

function seedFromPrior(
  prior: DiscoveryCapabilityPrior,
  overrides: Partial<
    Pick<
      DiscoveryCapabilitySeed,
      'confidence' | 'source' | 'evidence' | 'scenario_ids' | 'journey_ids' | 'surface_ids'
    >
  > = {},
): DiscoveryCapabilitySeed {
  return {
    key: prior.key,
    label: prior.label,
    product_kind: prior.productKind,
    importance: prior.importance,
    status: 'discovered',
    selection_expectation: undefined,
    skip_reason: '',
    confidence: overrides.confidence ?? 0.75,
    source: overrides.source ?? 'product_kind_prior',
    evidence: overrides.evidence ?? [],
    scenario_ids: overrides.scenario_ids ?? [],
    journey_ids: overrides.journey_ids ?? [],
    surface_ids: overrides.surface_ids ?? [],
    denominator_reason: prior.denominatorReason,
    coverage_gap: '',
    surfacePattern: prior.surfacePattern,
    textPattern: prior.textPattern,
  };
}

function seedFromFreeformCapability(
  label: string,
  productKind: ProductKind,
  importance: DiscoveryCapabilityImportance,
  source: DiscoveryCapability['source'],
): DiscoveryCapabilitySeed {
  const cleanLabel = label.trim() || 'Use visible product capability';
  return {
    key: capabilityKey(cleanLabel),
    label: cleanLabel,
    product_kind: productKind,
    importance,
    status: 'discovered',
    selection_expectation: undefined,
    skip_reason: '',
    confidence: 0.58,
    source,
    evidence: [],
    scenario_ids: [],
    journey_ids: [],
    surface_ids: [],
    denominator_reason: 'Inferred from Discovery scenario planning.',
    coverage_gap: '',
  };
}

function mergeCapabilitySeed(
  seeds: Map<string, DiscoveryCapabilitySeed>,
  seed: DiscoveryCapabilitySeed,
): void {
  const existingKey = matchingCapabilitySeedKey(seeds, seed);
  if (!existingKey) {
    seeds.set(seed.key, {
      ...seed,
      evidence: uniqueNonEmptyStrings(seed.evidence),
      scenario_ids: uniqueNonEmptyStrings(seed.scenario_ids),
      journey_ids: uniqueNonEmptyStrings(seed.journey_ids),
      surface_ids: uniqueNonEmptyStrings(seed.surface_ids),
    });
    return;
  }
  const existing = seeds.get(existingKey);
  if (!existing) return;
  const surfacePattern = existing.surfacePattern ?? seed.surfacePattern;
  const textPattern = existing.textPattern ?? seed.textPattern;
  seeds.set(existingKey, {
    ...existing,
    label: strongerCapabilityLabel(existing, seed),
    product_kind:
      existing.product_kind === 'unknown' && seed.product_kind !== 'unknown'
        ? seed.product_kind
        : existing.product_kind,
    importance: strongerCapabilityImportance(existing.importance, seed.importance),
    status: strongerCapabilityStatus(existing.status, seed.status),
    selection_expectation: strongerCapabilitySelectionExpectation(
      existing.selection_expectation,
      seed.selection_expectation,
    ),
    skip_reason: existing.skip_reason || seed.skip_reason || '',
    confidence: Math.max(existing.confidence, seed.confidence),
    source:
      existing.source === 'model' || seed.source === 'model'
        ? 'model'
        : existing.source === 'product_kind_prior' || seed.source === 'product_kind_prior'
          ? 'product_kind_prior'
          : existing.source,
    evidence: uniqueNonEmptyStrings([...existing.evidence, ...seed.evidence]),
    scenario_ids: uniqueNonEmptyStrings([...existing.scenario_ids, ...seed.scenario_ids]),
    journey_ids: uniqueNonEmptyStrings([...existing.journey_ids, ...seed.journey_ids]),
    surface_ids: uniqueNonEmptyStrings([...existing.surface_ids, ...seed.surface_ids]),
    denominator_reason: existing.denominator_reason || seed.denominator_reason,
    coverage_gap: existing.coverage_gap || seed.coverage_gap,
    ...(surfacePattern ? { surfacePattern } : {}),
    ...(textPattern ? { textPattern } : {}),
  });
}

function matchingCapabilitySeedKey(
  seeds: Map<string, DiscoveryCapabilitySeed>,
  seed: DiscoveryCapabilitySeed,
): string | undefined {
  if (seeds.has(seed.key)) return seed.key;
  const normalizedSeedLabel = normalizeTextForMatching(seed.label);
  const seedTokens = capabilityTokens(seed.label);
  for (const [key, existing] of seeds) {
    if (normalizedSeedLabel && normalizedSeedLabel === normalizeTextForMatching(existing.label))
      return key;
    if (areDistinctCapabilityFamilies(existing, seed)) continue;
    const existingTokens = capabilityTokens(existing.label);
    const shared = seedTokens.filter((token) => existingTokens.includes(token));
    if (seedTokens.length >= 2 && existingTokens.length >= 2 && shared.length >= 2) return key;
    const sameKind =
      existing.product_kind === seed.product_kind ||
      existing.product_kind === 'unknown' ||
      seed.product_kind === 'unknown';
    if (sameKind && shared.length > 0 && seed.textPattern && seed.textPattern.test(existing.label))
      return key;
    if (
      sameKind &&
      shared.length > 0 &&
      existing.textPattern &&
      existing.textPattern.test(seed.label)
    )
      return key;
  }
  return undefined;
}

function areDistinctCapabilityFamilies(
  existing: DiscoveryCapabilitySeed,
  seed: DiscoveryCapabilitySeed,
): boolean {
  if (existing.product_kind !== seed.product_kind) return false;
  if (existing.product_kind === 'data_grid') {
    const existingFamily = dataGridCapabilityFamily(existing);
    const seedFamily = dataGridCapabilityFamily(seed);
    return Boolean(existingFamily && seedFamily && existingFamily !== seedFamily);
  }
  return false;
}

function dataGridCapabilityFamily(seed: DiscoveryCapabilitySeed): 'filter' | 'sort_page' | '' {
  const text = normalizeTextForMatching([seed.key, seed.label, seed.denominator_reason].join(' '));
  if (/\b(search|filter|query)\b/.test(text)) return 'filter';
  if (
    /\b(sort|order|column|page length|entries per page|pagination|next|previous|row range)\b/.test(
      text,
    )
  ) {
    return 'sort_page';
  }
  return '';
}

function finalizeCapabilitySeed(
  seed: DiscoveryCapabilitySeed,
  input: {
    goals: DiscoveryGoal[];
    journeys: DiscoveryJourney[];
    surfaces: DiscoverySurface[];
    selectedJourneyIds: Set<string>;
    productKinds: ProductKind[];
  },
): DiscoveryCapability {
  const goalById = new Map(input.goals.map((goal) => [goal.id, goal]));
  const suppressScenarioMatching = isSupportWorkflowForConcreteProduct(
    [seed.label, seed.denominator_reason, seed.coverage_gap].join(' '),
    input.productKinds,
  );
  const seedJourneyIds = suppressScenarioMatching
    ? seed.journey_ids.filter((journeyId) => !input.selectedJourneyIds.has(journeyId))
    : seed.journey_ids;
  const journeyIds = uniqueNonEmptyStrings([
    ...seedJourneyIds,
    ...(suppressScenarioMatching
      ? []
      : input.journeys
          .filter((journey) => capabilityMatchesScenarioText(seed, journeyScenarioText(journey)))
          .map((journey) => journey.id)),
  ]);
  const surfaceIds = uniqueNonEmptyStrings([
    ...seed.surface_ids,
    ...input.surfaces
      .filter((surface) => seed.surfacePattern?.test(surfaceSearchText(surface)) ?? false)
      .map((surface) => surface.id),
  ]);
  const finalGoalIds = new Set(input.goals.map((goal) => goal.id));
  const rawGapIndicatesUncovered = coverageGapIndicatesUncovered(seed.coverage_gap);
  const matchedGoalIds = suppressScenarioMatching
    ? []
    : input.goals
        .filter((goal) => {
          if (goal.journey_id && journeyIds.includes(goal.journey_id)) return true;
          if (goal.surface_ids.some((surfaceId) => surfaceIds.includes(surfaceId))) {
            return capabilityMatchesScenarioText(seed, goal.description);
          }
          return capabilityMatchesScenarioText(seed, goal.description);
        })
        .map((goal) => goal.id);
  const gapCoveredByStrongGoal =
    rawGapIndicatesUncovered &&
    matchedGoalIds.some((id) => {
      const goal = goalById.get(id);
      return goal ? capabilityStronglyMatchesText(seed, goal.description) : false;
    });
  const gapIndicatesUncovered = rawGapIndicatesUncovered && !gapCoveredByStrongGoal;
  const scenarioIds = uniqueNonEmptyStrings([
    ...(suppressScenarioMatching
      ? []
      : seed.scenario_ids
          .filter((id) => (input.goals.length === 0 ? /^G\d+/i.test(id) : finalGoalIds.has(id)))
          .filter((id) => {
            if (input.goals.length === 0) return true;
            const goal = goalById.get(id);
            return goal ? capabilityMatchesScenarioText(seed, goal.description) : false;
          })),
    ...matchedGoalIds,
  ]).filter(() => !gapIndicatesUncovered);
  const selected =
    !gapIndicatesUncovered &&
    (scenarioIds.length > 0 ||
      journeyIds.some((journeyId) => input.selectedJourneyIds.has(journeyId)));
  const status: DiscoveryCapabilityStatus =
    seed.status === 'not_applicable'
      ? 'not_applicable'
      : selected
        ? 'selected'
        : journeyIds.length > 0 || surfaceIds.length > 0
          ? 'deferred'
          : 'discovered';
  const selection_expectation =
    seed.selection_expectation ??
    deriveCapabilitySelectionExpectation({
      seed,
      status,
      journeyIds,
      surfaceIds,
      journeys: input.journeys,
      surfaces: input.surfaces,
    });
  const skip_reason = normalizedCapabilitySkipReason(
    seed.skip_reason ?? '',
    status,
    selection_expectation,
    seed,
    journeyIds,
    surfaceIds,
    input.journeys,
    input.surfaces,
  );
  const coverage_gap = normalizedCapabilityCoverageGap(
    gapCoveredByStrongGoal ? '' : seed.coverage_gap,
    status,
    scenarioIds,
    skip_reason,
  );
  return {
    id: seed.key,
    label: seed.label,
    product_kind: seed.product_kind,
    importance: seed.importance,
    status,
    selection_expectation,
    skip_reason,
    confidence: Number(seed.confidence.toFixed(2)),
    source: seed.source,
    evidence: seed.evidence,
    scenario_ids: scenarioIds,
    journey_ids: journeyIds,
    surface_ids: surfaceIds,
    denominator_reason: seed.denominator_reason,
    coverage_gap,
  };
}

function coverageGapIndicatesUncovered(rawCoverageGap: string): boolean {
  const raw = rawCoverageGap.trim();
  if (!raw) return false;
  return /\b(not selected|not covered|uncovered|untested|deferred|deeper audit|follow[- ]?up|future audit|future run|not exercised|not attempted|should be covered|needs? (?:separate|deeper|follow[- ]?up)|left for later)\b/i.test(
    raw,
  );
}

function normalizedCapabilityCoverageGap(
  rawCoverageGap: string,
  status: DiscoveryCapabilityStatus,
  scenarioIds: string[],
  skipReason = '',
): string {
  const raw = rawCoverageGap.trim();
  if (status === 'selected') {
    return (
      raw ||
      `Selected for this run${scenarioIds.length > 0 ? ` via ${scenarioIds.join(', ')}` : ''}.`
    );
  }
  if (coverageGapIndicatesUncovered(raw)) return raw;
  if (skipReason) return skipReason;
  if (status === 'deferred') {
    if (!raw || /\b(covers?|covered|selected|none)\b/i.test(raw)) {
      return 'Discovered, but not selected for a scenario in this run.';
    }
    return raw;
  }
  if (status === 'discovered') {
    if (!raw || /\b(covers?|covered|selected|none)\b/i.test(raw)) {
      return 'Expected from the product type, but no concrete scenario exercised it in this run.';
    }
    return raw;
  }
  return raw || 'Not applicable to the observed product state.';
}

function deriveCapabilitySelectionExpectation(input: {
  seed: DiscoveryCapabilitySeed;
  status: DiscoveryCapabilityStatus;
  journeyIds: string[];
  surfaceIds: string[];
  journeys: DiscoveryJourney[];
  surfaces: DiscoverySurface[];
}): DiscoveryCapabilitySelectionExpectation {
  if (input.status === 'not_applicable') return 'not_normally_tested';
  if (input.seed.importance === 'core') return 'must_test';
  if (input.seed.importance === 'important') return 'should_test_or_explain';
  if (input.seed.importance === 'diagnostic') return 'not_normally_tested';
  const relatedJourneys = input.journeys.filter((journey) => input.journeyIds.includes(journey.id));
  const relatedSurfaces = input.surfaces.filter((surface) => input.surfaceIds.includes(surface.id));
  if (
    relatedJourneys.some(isProductNativeJourney) ||
    relatedSurfaces.some(isProductNativeSurface)
  ) {
    return 'should_test_or_explain';
  }
  return 'not_normally_tested';
}

function normalizedCapabilitySkipReason(
  rawSkipReason: string,
  status: DiscoveryCapabilityStatus,
  expectation: DiscoveryCapabilitySelectionExpectation,
  seed: DiscoveryCapabilitySeed,
  journeyIds: string[],
  surfaceIds: string[],
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
): string {
  const raw = rawSkipReason.trim();
  if (status === 'selected' || status === 'not_applicable') return raw;
  if (expectation === 'must_test') {
    return (
      raw ||
      'Central product capability was expected to be tested, but no selected scenario covered it.'
    );
  }
  if (expectation === 'should_test_or_explain') {
    const relatedJourney = journeys.find((journey) => journeyIds.includes(journey.id));
    const relatedSurface = surfaces.find((surface) => surfaceIds.includes(surface.id));
    if (raw) return raw;
    if (relatedJourney) {
      return `Important product-native capability was discovered through "${relatedJourney.title}", but it was not selected for this run.`;
    }
    if (relatedSurface) {
      return `Important product-native capability was discovered on "${relatedSurface.label}", but it was not selected for this run.`;
    }
    return `Important capability "${seed.label}" was inferred, but no selected scenario covered it.`;
  }
  if (raw) return raw;
  return 'Peripheral, setup-only, external, or diagnostic scope is not normally tested unless it blocks product use.';
}

function isProductNativeJourney(journey: DiscoveryJourney): boolean {
  if (journey.goal_class === 'peripheral' || journey.goal_class === 'diagnostic') return false;
  if (journey.priority === 'could') return false;
  const text = journeyScenarioText(journey);
  if (isLowSignalSetupText(text)) return false;
  return true;
}

function isProductNativeSurface(surface: DiscoverySurface): boolean {
  if (surface.value === 'peripheral') return false;
  if (surface.kind === 'banner' || surface.kind === 'footer' || surface.kind === 'external') {
    return false;
  }
  if (surface.source === 'banner_dismiss') return false;
  if (isLowSignalSetupText(surfaceSearchText(surface))) return false;
  return true;
}

function isLowSignalSetupText(text: string): boolean {
  return /\b(cookie|privacy|terms|legal|footer|promo|advert|newsletter|donate|sponsor)\b/i.test(
    text,
  );
}

function normalizedProductKinds(productUseContract: ProductUseContract | undefined): ProductKind[] {
  const kinds = uniqueNonEmptyStrings(productUseContract?.product_kinds ?? []) as ProductKind[];
  return kinds.filter((kind) => kind !== 'unknown');
}

function compatibleCapabilityPriorForText(
  text: string,
  productKinds: ProductKind[],
): DiscoveryCapabilityPrior | undefined {
  return DISCOVERY_CAPABILITY_PRIORS.find((prior) => {
    const compatible =
      productKinds.length === 0 ||
      capabilityPriorCompatibleWithKinds(productKinds, prior.productKind);
    return compatible && prior.textPattern.test(text);
  });
}

function capabilityMatchesScenarioText(seed: DiscoveryCapabilitySeed, text: string): boolean {
  if (seed.product_kind === 'data_grid') {
    const family = dataGridCapabilityFamily(seed);
    if (family === 'filter') return dataGridFilterCoveredByText(text);
    if (family === 'sort_page') return dataGridSortPageCoveredByText(text);
  }
  return capabilityMatchesText(seed, text);
}

function capabilityMatchesText(seed: DiscoveryCapabilitySeed, text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  if (!normalized) return false;
  if (seed.textPattern?.test(normalized)) return true;
  const tokens = capabilityTokens(seed.label);
  if (tokens.length === 0) return false;
  const shared = tokens.filter((token) => normalized.includes(token));
  return shared.length >= Math.min(2, tokens.length);
}

function capabilityStronglyMatchesText(seed: DiscoveryCapabilitySeed, text: string): boolean {
  const normalized = normalizeTextForMatching(text);
  if (!normalized) return false;
  const tokens = capabilityTokens(seed.label);
  if (tokens.length === 0) return false;
  const shared = tokens.filter((token) => normalized.includes(token));
  const required = Math.max(2, Math.min(4, Math.ceil(tokens.length * 0.6)));
  return shared.length >= required;
}

function capabilityTokens(label: string): string[] {
  const generic = new Set([
    'visible',
    'product',
    'capability',
    'content',
    'state',
    'user',
    'current',
    'existing',
    'use',
    'using',
    'create',
    'add',
    'open',
    'inspect',
    'login',
    'account',
    'auth',
    'feedback',
  ]);
  return importantGoalTokens(label)
    .map((token) => token.replace(/s$/i, ''))
    .filter((token) => token.length >= 4 && !generic.has(token));
}

function capabilityKey(label: string): string {
  return `cap:${capabilityTokens(label).join('-') || normalizeTextForMatching(label) || 'unknown'}`;
}

function strongerCapabilityImportance(
  a: DiscoveryCapabilityImportance,
  b: DiscoveryCapabilityImportance,
): DiscoveryCapabilityImportance {
  const rank: Record<DiscoveryCapabilityImportance, number> = {
    core: 0,
    important: 1,
    secondary: 2,
    diagnostic: 3,
  };
  return rank[b] < rank[a] ? b : a;
}

function strongerCapabilityStatus(
  a: DiscoveryCapabilityStatus,
  b: DiscoveryCapabilityStatus,
): DiscoveryCapabilityStatus {
  const rank: Record<DiscoveryCapabilityStatus, number> = {
    selected: 0,
    deferred: 1,
    discovered: 2,
    not_applicable: 3,
  };
  return rank[b] < rank[a] ? b : a;
}

function strongerCapabilitySelectionExpectation(
  a: DiscoveryCapabilitySelectionExpectation | undefined,
  b: DiscoveryCapabilitySelectionExpectation | undefined,
): DiscoveryCapabilitySelectionExpectation | undefined {
  if (!a) return b;
  if (!b) return a;
  const rank: Record<DiscoveryCapabilitySelectionExpectation, number> = {
    must_test: 0,
    should_test_or_explain: 1,
    not_normally_tested: 2,
  };
  return rank[b] < rank[a] ? b : a;
}

function capabilityPriorCompatibleWithKinds(
  productKinds: ProductKind[],
  productKind: ProductKind,
): boolean {
  if (productKinds.includes(productKind)) return true;
  if (productKind === 'content_site' && productKinds.includes('search_content')) return true;
  if (productKind === 'search_content' && productKinds.includes('content_site')) return true;
  if (productKind === 'auth_account')
    return productKinds.length === 1 && productKinds[0] === 'auth_account';
  if (productKind === 'settings_tool')
    return productKinds.length === 1 && productKinds[0] === 'settings_tool';
  if (productKind === 'communication_tool') {
    return productKinds.length === 1 && productKinds[0] === 'communication_tool';
  }
  return false;
}

function strongerCapabilityLabel(
  existing: DiscoveryCapabilitySeed,
  seed: DiscoveryCapabilitySeed,
): string {
  if (!existing.label.trim()) return seed.label;
  if (!seed.label.trim()) return existing.label;
  if (existing.source === 'product_kind_prior') return existing.label;
  if (seed.source === 'product_kind_prior') return seed.label;
  return existing.label.length <= seed.label.length ? existing.label : seed.label;
}

function compareCapabilities(a: DiscoveryCapability, b: DiscoveryCapability): number {
  const importanceRank: Record<DiscoveryCapabilityImportance, number> = {
    core: 0,
    important: 1,
    secondary: 2,
    diagnostic: 3,
  };
  const statusRank: Record<DiscoveryCapabilityStatus, number> = {
    selected: 0,
    deferred: 1,
    discovered: 2,
    not_applicable: 3,
  };
  return (
    importanceRank[a.importance] - importanceRank[b.importance] ||
    statusRank[a.status] - statusRank[b.status] ||
    a.label.localeCompare(b.label)
  );
}

function ensureArtifactEditorCapabilityJourneys(
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
  productUseContract: ProductUseContract | undefined,
): DiscoveryJourney[] {
  const productKinds = productUseContract?.product_kinds ?? [];
  if (!isArtifactEditorProduct(productKinds) || surfaces.length === 0) return journeys;

  const surfaceText = surfaces.map(surfaceSearchText).join(' ');
  const hasCanvasSurface = /\b(canvas|whiteboard|board|document|editor|workspace)\b/i.test(
    surfaceText,
  );
  const hasCreationSurface =
    /\b(draw|shape|rectangle|ellipse|triangle|diamond|text|note|arrow|media|insert|upload)\b/i.test(
      surfaceText,
    );
  const hasMaterialEditorSurface =
    hasCreationSurface ||
    /\b(style|color|fill|dash|size|duplicate|delete|undo|redo|export|download|share)\b/i.test(
      surfaceText,
    );
  if (!hasCanvasSurface || !hasMaterialEditorSurface) return journeys;

  const out = dedupeArtifactEditorCapabilityJourneys(
    journeys
      .map(narrowBroadArtifactEditorJourney)
      .map((journey) => enrichArtifactEditorCreationJourney(journey, productKinds)),
  );
  const addCapability = (capability: ArtifactCapability): void => {
    if (!capability.surfacePattern.test(surfaceText)) return;
    if (
      out.some((journey) => {
        const text = journeyScenarioText(journey);
        const family = primaryArtifactCapabilityFamily(text);
        return (
          capability.existingPattern.test(text) &&
          family === capability.family &&
          journey.priority !== 'could' &&
          isSeedGoalClass(journey.goal_class ?? 'core') &&
          !isBroadArtifactEditorUtilityText(text) &&
          (capability.allowPrimaryCompositionCoverage || !isPrimaryArtifactCompositionJourney(text))
        );
      })
    ) {
      return;
    }
    const surface_ids = selectArtifactCapabilitySurfaces(surfaces, capability.surfacePattern);
    if (surface_ids.length === 0) return;
    out.push({
      id: nextJourneyId(out),
      title: capability.title,
      priority: capability.priority,
      goal_class: capability.goalClass,
      surface_ids,
      user_intent: capability.userIntent,
      suggested_goal: capability.suggestedGoal,
      sample_input: capability.sampleInput,
      expected_evidence: capability.expectedEvidence,
      risk: capability.risk,
    });
  };

  addCapability({
    family: 'style',
    title: 'Restyle an existing artifact object',
    priority: 'should',
    goalClass: 'core',
    risk: 'medium',
    surfacePattern: /\b(style|color|fill|dash|stroke|size|opacity|font|format)\b/i,
    existingPattern: /\b(style|styled|restyle|color|fill|dash|size|opacity|format)\b/i,
    userIntent: 'Prove formatting controls change the artifact itself.',
    suggestedGoal:
      'Select an existing object, change its visible style such as color, fill, dash, or size, and verify the object changes on the canvas.',
    sampleInput: 'Select a shape, change its color or fill, then inspect the canvas result.',
    expectedEvidence: [
      'The selected object visibly changes appearance',
      'The proof is on the artifact, not only a selected toolbar control',
    ],
  });
  addCapability({
    family: 'history',
    title: 'Revise artifact state with edit/history controls',
    priority: 'should',
    goalClass: 'core',
    risk: 'medium',
    surfacePattern: /\b(duplicate|delete|undo|redo|history|copy|paste|arrange)\b/i,
    existingPattern: /\b(duplicate|delete|undo|redo|history|object count|arrange|arrangement)\b/i,
    userIntent: 'Prove the artifact can be changed after creation.',
    suggestedGoal:
      'Duplicate, delete, undo, or redo an artifact object and verify the object count, arrangement, or state changes visibly.',
    sampleInput: 'Duplicate an object, then undo once and inspect the board state.',
    expectedEvidence: [
      'Object count, arrangement, or artifact state visibly changes',
      'The proof is not merely a clicked history/edit button',
    ],
  });
  addCapability({
    family: 'shape_variant',
    title: 'Use a non-default shape from the shape library',
    priority: 'should',
    goalClass: 'core',
    risk: 'medium',
    surfacePattern: /\b(shape picker|more|ellipse|triangle|diamond|hexagon|cloud|heart|star)\b/i,
    existingPattern:
      /\b(non[- ]default shape|shape library|shape picker|diamond|cloud|ellipse|triangle|star|heart)\b/i,
    userIntent: 'Use richer creation controls instead of only the default shape.',
    suggestedGoal:
      'Open the shape library, place a non-default shape such as a diamond, cloud, or ellipse on the canvas, and verify it remains visible.',
    sampleInput: 'Open More/shape picker, choose a non-default shape, then place it on the board.',
    expectedEvidence: [
      'A non-default shape is visible on the canvas',
      'The proof is the placed shape, not only the open shape menu',
    ],
  });
  addCapability({
    family: 'text',
    title: 'Add readable text or a note to the artifact',
    priority: 'should',
    goalClass: 'core',
    risk: 'medium',
    surfacePattern: /\b(text|note|label|paragraph)\b/i,
    existingPattern: /\b(text|note|label|paragraph|caption)\b/i,
    userIntent: 'Annotate the canvas artifact with readable content.',
    suggestedGoal:
      'Add readable text or a note to the canvas artifact and verify the words remain visible on the board.',
    sampleInput: 'Choose Text or Note, type a short label, and confirm it appears on canvas.',
    expectedEvidence: [
      'Readable text or a note is visible on the canvas',
      'The text is part of the board artifact, not just typed into a transient field',
    ],
  });
  addCapability({
    family: 'connector',
    title: 'Draw or connect objects with an arrow/freehand stroke',
    priority: 'should',
    goalClass: 'core',
    risk: 'medium',
    surfacePattern: /\b(arrow|connector|line|draw|freehand|pen|stroke)\b/i,
    existingPattern: /\b(arrow|connector|line|freehand|draw)\b/i,
    userIntent: 'Use relationship or drawing tools to create more than isolated objects.',
    suggestedGoal:
      'Draw a freehand stroke or connect canvas objects with an arrow/line and verify the connector or stroke is visible.',
    sampleInput: 'Use Draw or Arrow, drag on the canvas, and verify the resulting mark/connector.',
    expectedEvidence: [
      'A drawn stroke, connector, arrow, or line is visible on the canvas',
      'The board shows a relationship or drawing mark beyond a single static object',
    ],
  });
  addCapability({
    family: 'media',
    title: 'Insert media or an embed into the artifact',
    priority: 'should',
    goalClass: 'secondary_workflow',
    risk: 'medium',
    surfacePattern: /\b(media|upload|embed|insert)\b/i,
    existingPattern: /\b(media|upload|embed|insert)\b/i,
    userIntent: 'Bring external content into the artifact when the editor exposes that capability.',
    suggestedGoal:
      'Use the media, upload, or embed entry point and verify an inserted object or product-scoped insertion flow appears.',
    sampleInput:
      'Open Media/Upload/Insert embed and complete the strongest available non-destructive insertion step.',
    expectedEvidence: [
      'An inserted media/embed object appears, or a product-scoped insertion flow is visibly reached',
      'The result is tied to the current board/artifact',
    ],
  });
  addCapability({
    family: 'export',
    title: 'Export or download the current artifact',
    priority: 'should',
    goalClass: 'secondary_workflow',
    risk: 'medium',
    surfacePattern: /\b(export|download|save as|print)\b/i,
    existingPattern: /\b(export|download|save as|print)\b/i,
    userIntent: 'Produce an output from the artifact rather than only editing it in-place.',
    suggestedGoal:
      'Export or download the current artifact and verify a board-linked output action is initiated.',
    sampleInput:
      'Open the page/file menu, choose Export or Download, then confirm the output action.',
    expectedEvidence: [
      'An export/download/save state is visible or initiated',
      'The output is associated with the current artifact',
    ],
  });
  addCapability({
    family: 'share',
    title: 'Open artifact share or collaboration entry point',
    priority: 'should',
    goalClass: 'secondary_workflow',
    risk: 'medium',
    surfacePattern: /\b(share|collaborat|invite|sign in|sign-in|login|permission)\b/i,
    existingPattern: /\b(share|collaborat|invite|sign in|sign-in|login|permission)\b/i,
    userIntent: 'Reach the collaboration or account boundary for the current artifact.',
    suggestedGoal:
      'Open the artifact share or collaboration entry point and verify a board-linked share, invite, or sign-in state appears.',
    sampleInput: 'Click Share or Sign in to share and inspect the resulting board-linked UI.',
    expectedEvidence: [
      'A share, collaboration, invite, or auth gate appears',
      'The state is tied to the current artifact rather than a generic marketing page',
    ],
  });

  return dedupeArtifactEditorCapabilityJourneys(out);
}

function ensureJourneysForUnlinkedProductUseJobs(
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
  productUseContract: ProductUseContract | undefined,
): DiscoveryJourney[] {
  const jobs = productUseContract?.user_jobs ?? [];
  if (jobs.length === 0) return journeys;
  const out = [...journeys];
  const reservedJobJourneyIds = jobs
    .map((candidate) => candidate.journey_id)
    .filter((id): id is string => Boolean(id));
  for (const job of jobs) {
    if (job.journey_id && out.some((journey) => journey.id === job.journey_id)) continue;
    if (matchingProductUseJobJourneyId(job, out)) continue;
    const text = [
      job.title,
      job.scenario_brief,
      job.expected_artifact,
      ...job.test_data,
      ...job.required_outputs,
      ...job.quality_bar,
      ...job.required_actions,
      ...job.proof_obligations,
      ...job.acceptable_evidence,
    ].join(' ');
    const surface_ids = selectSurfacesForGoal(
      {
        id: job.id,
        description: text,
        priority: job.risk === 'high' ? 'must' : 'should',
        surface_ids: [],
      },
      surfaces,
    );
    const selectedSurfaces = surfaces.filter((surface) => surface_ids.includes(surface.id));
    const goalClass = classifyMateriality({
      priority: job.risk === 'high' ? 'must' : 'should',
      risk: job.risk,
      title: job.title,
      text,
      surfaces: selectedSurfaces,
      productKinds: productUseContract?.product_kinds ?? [],
    });
    if (!isSeedGoalClass(goalClass)) continue;
    const id =
      job.journey_id && !out.some((journey) => journey.id === job.journey_id)
        ? job.journey_id
        : nextJourneyId(out, reservedJobJourneyIds);
    out.push({
      id,
      title: job.title,
      priority: job.risk === 'high' ? 'must' : 'should',
      goal_class: goalClass,
      surface_ids,
      user_intent: job.scenario_brief || job.title,
      suggested_goal: job.scenario_brief || job.title,
      sample_input:
        job.test_data.length > 0
          ? job.test_data.join('; ')
          : job.required_actions.slice(0, 3).join('; '),
      expected_evidence:
        job.required_outputs.length > 0
          ? job.required_outputs
          : job.acceptable_evidence.length > 0
            ? job.acceptable_evidence
            : [job.expected_artifact || 'visible product outcome'],
      risk: job.risk,
    });
  }
  return dedupeArtifactEditorCapabilityJourneys(out);
}

type ArtifactCapabilityFamily =
  | 'create'
  | 'style'
  | 'history'
  | 'shape_variant'
  | 'text'
  | 'connector'
  | 'media'
  | 'export'
  | 'share';

function narrowBroadArtifactEditorJourney(journey: DiscoveryJourney): DiscoveryJourney {
  const text = journeyScenarioText(journey);
  const families = artifactEditorCapabilityFamilies(text);
  if (families.has('history') && isOverconstrainedHistorySequence(text)) {
    return {
      ...journey,
      title: 'Revise artifact state with edit/history controls',
      user_intent: 'Prove the artifact can be changed after creation.',
      suggested_goal:
        'Duplicate, delete, undo, or redo an artifact object and verify the object count, arrangement, or state changes visibly.',
      sample_input: 'Duplicate an object, then undo once or delete a selected object.',
      expected_evidence: [
        'Object count, arrangement, or artifact state visibly changes',
        'The proof is not merely a clicked history/edit button',
      ],
    };
  }
  if (families.has('style') && families.has('history')) {
    return {
      ...journey,
      title: 'Restyle an existing object',
      user_intent: 'Change the visible formatting of an object already on the artifact.',
      suggested_goal:
        'Select an existing object, change its visible style such as color, fill, dash, or size, and verify the object changes on the canvas.',
      sample_input: 'Select an object, change color or fill, then inspect the artifact.',
      expected_evidence: [
        'The selected object visibly changes appearance',
        'The proof is on the artifact, not only a selected toolbar control',
      ],
    };
  }
  if (families.has('export') && families.has('share')) {
    return {
      ...journey,
      title: 'Export or download the current artifact',
      user_intent: 'Produce an output from the current artifact.',
      suggested_goal:
        'Export or download the current artifact and verify a board-linked output action is initiated.',
      sample_input: 'Open the page/file menu, choose Export or Download, then confirm the output.',
      expected_evidence: [
        'An export/download/save state is visible or initiated',
        'The output is associated with the current artifact',
      ],
    };
  }
  return journey;
}

function isOverconstrainedHistorySequence(text: string): boolean {
  const actionCount = [
    /\bduplicate|duplicated\b/.test(text),
    /\bdelete|deleted|remove|removed\b/.test(text),
    /\bundo\b/.test(text),
    /\bredo\b/.test(text),
  ].filter(Boolean).length;
  return (
    actionCount >= 3 || (actionCount >= 2 && /\bthen\b|\bsequence\b|\bafter that\b/.test(text))
  );
}

function dedupeArtifactEditorCapabilityJourneys(journeys: DiscoveryJourney[]): DiscoveryJourney[] {
  const seenFamilies = new Set<ArtifactCapabilityFamily>();
  const out: DiscoveryJourney[] = [];
  for (const journey of journeys) {
    const text = journeyScenarioText(journey);
    const family = primaryArtifactCapabilityFamily(text);
    const reservesFamily =
      family &&
      journey.priority !== 'could' &&
      isSeedGoalClass(journey.goal_class ?? 'core') &&
      !isBroadArtifactEditorUtilityText(text);
    if (reservesFamily && seenFamilies.has(family)) continue;
    if (reservesFamily) seenFamilies.add(family);
    out.push(journey);
  }
  return out;
}

function primaryArtifactCapabilityFamily(text: string): ArtifactCapabilityFamily | undefined {
  if (isPrimaryArtifactCompositionJourney(text)) return 'create';
  const families = artifactEditorCapabilityFamilies(text);
  const priority: ArtifactCapabilityFamily[] = [
    'media',
    'export',
    'share',
    'history',
    'style',
    'shape_variant',
    'connector',
    'text',
  ];
  for (const family of priority) {
    if (families.has(family)) return family;
  }
  if (/\b(create|make|populate|place|draw|add)\b/.test(text)) return 'create';
  return undefined;
}

function artifactEditorCapabilityFamilies(text: string): Set<ArtifactCapabilityFamily> {
  const out = new Set<ArtifactCapabilityFamily>();
  if (/\b(style|styled|restyle|color|fill|dash|stroke|size|opacity|format)\b/.test(text)) {
    out.add('style');
  }
  if (
    /\b(duplicate|delete|deleted|remove|removed|undo|redo|history|revision|revise|object count|arrange|arrangement|copy|paste)\b/.test(
      text,
    )
  ) {
    out.add('history');
  }
  if (
    /\b(non[- ]default shape|shape library|shape picker|diamond|cloud|ellipse|triangle|star|heart|hexagon)\b/.test(
      text,
    )
  ) {
    out.add('shape_variant');
  }
  if (/\b(text|note|label|paragraph|caption)\b/.test(text)) out.add('text');
  if (/\b(arrow|connector|line|freehand|relationship)\b/.test(text)) out.add('connector');
  if (/\b(media|upload|embed|image|file|import)\b/.test(text)) out.add('media');
  if (/\b(export|download|save as|print|output)\b/.test(text)) out.add('export');
  if (/\b(share|collaborat|invite|sign in|sign-in|login|permission)\b/.test(text)) {
    out.add('share');
  }
  return out;
}

interface ArtifactCapability {
  family: ArtifactCapabilityFamily;
  title: string;
  priority: 'must' | 'should' | 'could';
  goalClass: DiscoveryGoalClass;
  risk: 'high' | 'medium' | 'low';
  surfacePattern: RegExp;
  existingPattern: RegExp;
  userIntent: string;
  suggestedGoal: string;
  sampleInput: string;
  expectedEvidence: string[];
  allowPrimaryCompositionCoverage?: boolean;
}

function enrichArtifactEditorCreationJourney(
  journey: DiscoveryJourney,
  productKinds: ProductKind[],
): DiscoveryJourney {
  if (!isArtifactEditorProduct(productKinds)) return journey;
  const text = journeyScenarioText(journey);
  const specificFamilies = artifactEditorCapabilityFamilies(text);
  const isCreation = /\b(create|first|make|draw|place|add)\b/.test(text);
  const isArtifact = /\b(canvas|whiteboard|board|diagram|artifact|object|shape|document)\b/.test(
    text,
  );
  const hasComposition =
    /\b(text|label|note|arrow|connector|style|color|fill|resize|move|second|multiple|composed|meaningful)\b/.test(
      text,
    );
  if (
    specificFamilies.has('media') ||
    specificFamilies.has('export') ||
    specificFamilies.has('share')
  ) {
    return journey;
  }
  if (!isCreation || !isArtifact || hasComposition) return journey;
  return {
    ...journey,
    title:
      journey.title.replace(/\b(first|simple|visible)\b/gi, '').trim() ||
      'Create a meaningful artifact',
    suggested_goal:
      'Create a small launch planning board titled "Launch plan" with two labeled steps, "Draft" and "Review", a connector or arrow between them, and one visible style change.',
    sample_input:
      'Use "Launch plan", "Draft", and "Review" as the canvas content; connect the steps and style one object.',
    expected_evidence: uniqueNonEmptyStrings([
      ...journey.expected_evidence,
      'The board contains readable "Launch plan", "Draft", and "Review" content',
      'A visible connector or arrow relates the two steps',
      'A visible edit, style, move, resize, or connection proves real manipulation',
    ]),
  };
}

function alignGoalDescriptionWithJourney(
  goal: DiscoveryGoal,
  journey: DiscoveryJourney | undefined,
  productUseContract: ProductUseContract | undefined,
): DiscoveryGoal {
  if (
    selectProductUseJobForGoal(productUseContract?.user_jobs, goal) &&
    !isArtifactEditorProduct(productUseContract?.product_kinds ?? [])
  ) {
    return goal;
  }
  if (
    journey?.suggested_goal &&
    journey.suggested_goal !== goal.description &&
    shouldPreferJourneySuggestedGoal(goal.description, journey)
  ) {
    return { ...goal, description: journey.suggested_goal };
  }
  if (!journey || !isArtifactEditorProduct(productUseContract?.product_kinds ?? [])) return goal;
  if (
    isOverconstrainedHistorySequence(goal.description.toLowerCase()) &&
    journey.suggested_goal &&
    journey.suggested_goal !== goal.description
  ) {
    return { ...goal, description: journey.suggested_goal };
  }
  if (!isShallowArtifactEditorGoal(goal.description)) return goal;
  if (!journey.suggested_goal || journey.suggested_goal === goal.description) return goal;
  return { ...goal, description: journey.suggested_goal };
}

function goalDescriptionForJourney(
  journey: DiscoveryJourney,
  job: ProductUseJob | undefined,
): string {
  if (!job?.scenario_brief.trim()) return journey.suggested_goal;
  return jobScenarioCoversJourney(job, journey) ? job.scenario_brief : journey.suggested_goal;
}

function goalDescriptionForProductUseJob(job: ProductUseJob): string {
  const base =
    job.scenario_brief.trim() ||
    job.title.trim() ||
    job.expected_artifact.trim() ||
    'Use the product scenario and verify the visible outcome.';
  return appendScenarioAcceptanceToGoal(base, job);
}

function jobScenarioCoversJourney(job: ProductUseJob, journey: DiscoveryJourney): boolean {
  return !shouldPreferJourneySuggestedGoal(job.scenario_brief, journey);
}

function shouldPreferJourneySuggestedGoal(description: string, journey: DiscoveryJourney): boolean {
  const suggested = journey.suggested_goal.trim();
  if (!suggested) return false;
  const normalizedDescription = normalizeTextForMatching(description);
  const normalizedSuggested = normalizeTextForMatching(suggested);
  if (!normalizedDescription || !normalizedSuggested) return false;
  if (
    normalizedDescription === normalizedSuggested ||
    normalizedDescription.includes(normalizedSuggested) ||
    normalizedSuggested.includes(normalizedDescription)
  ) {
    return false;
  }
  return !scaffoldCoversAnchor(
    [journey.title, journey.user_intent, journey.suggested_goal, ...journey.expected_evidence].join(
      ' ',
    ),
    description,
  );
}

function applyScenarioBriefToGoal(
  goal: DiscoveryGoal,
  productUseContract: ProductUseContract | undefined,
): DiscoveryGoal {
  const job = selectProductUseJobForGoal(productUseContract?.user_jobs, goal);
  if (!job?.scenario_brief.trim()) return goal;
  const description = isGenericGoalForScenarioReplacement(goal.description, job)
    ? job.scenario_brief
    : goal.description;
  const relaxedDescription = relaxCalculatorProofText(
    description,
    productUseContract?.product_kinds ?? [],
  );
  return { ...goal, description: appendScenarioAcceptanceToGoal(relaxedDescription, job) };
}

function productUseJobsForJourney(
  productUseContract: ProductUseContract | undefined,
  journeyId: string,
): ProductUseJob[] {
  return productUseContract?.user_jobs.filter((job) => job.journey_id === journeyId) ?? [];
}

function hasAmbiguousMultiJobJourney(
  productUseContract: ProductUseContract | undefined,
  goal: DiscoveryGoal,
): boolean {
  if (!goal.journey_id) return false;
  const journeyJobs = productUseJobsForJourney(productUseContract, goal.journey_id);
  if (journeyJobs.length <= 1) return false;
  return !selectProductUseJobForGoal(journeyJobs, goal);
}

function isGenericGoalForScenarioReplacement(description: string, job: ProductUseJob): boolean {
  const text = normalizeTextForMatching(description);
  if (!text) return true;
  const briefTokens = scenarioReplacementTokens(job);
  const overlapsBrief = briefTokens.some((token) => text.includes(token));
  if (overlapsBrief) return false;
  return (
    isGenericProductUseTitle(description) ||
    isGenericProductUseExpected(description) ||
    /\b(use|open|add|create|place|verify|confirm)\b/.test(text)
  );
}

function scenarioReplacementTokens(job: ProductUseJob): string[] {
  const generic = new Set([
    'artifact',
    'artifacts',
    'canvas',
    'board',
    'whiteboard',
    'object',
    'objects',
    'shape',
    'shapes',
    'visible',
    'visibly',
    'readable',
    'label',
    'labeled',
    'labels',
    'small',
    'item',
    'items',
    'step',
    'steps',
    'arrow',
    'connector',
    'line',
    'relationship',
    'between',
    'current',
    'work',
    'workspace',
    'content',
    'state',
    'create',
    'created',
    'place',
    'placed',
    'verify',
    'style',
    'styled',
    'change',
    'changed',
    'using',
  ]);
  return uniqueNonEmptyStrings(
    [job.scenario_brief, ...job.test_data, ...job.required_outputs, ...job.quality_bar].flatMap(
      (text) => importantGoalTokens(text).filter((token) => !generic.has(token)),
    ),
  );
}

function appendScenarioAcceptanceToGoal(description: string, job: ProductUseJob): string {
  const parts: string[] = [];
  const brief = job.scenario_brief.trim();
  const visibleData = scenarioVisibleDataTokens(job.test_data);
  const requiredOutputs = job.required_outputs
    .map((output) => output.trim())
    .filter(Boolean)
    .slice(0, 4);
  const normalizedDescription = normalizeTextForMatching(description);
  if (brief && !normalizedDescription.includes(normalizeTextForMatching(brief))) {
    parts.push(`Scenario: ${brief}`);
  }
  const missingVisibleData = visibleData.filter(
    (item) => !normalizedDescription.includes(normalizeTextForMatching(item)),
  );
  if (missingVisibleData.length > 0) {
    parts.push(`Use exact visible content/data: ${missingVisibleData.join('; ')}`);
  }
  const missingOutputs = requiredOutputs.filter((output) => {
    const normalized = normalizeTextForMatching(output);
    return normalized.length >= 3 && !normalizedDescription.includes(normalized);
  });
  if (missingOutputs.length > 0) {
    parts.push(`Required visible result: ${missingOutputs.join('; ')}`);
  }
  return parts.length > 0 ? `${description} ${parts.join(' ')}` : description;
}

function dedupeDiscoveryGoalsByScenarioFamily(
  goals: DiscoveryGoal[],
  productUseContract: ProductUseContract | undefined,
): DiscoveryGoal[] {
  const seen = new Set<string>();
  const out: DiscoveryGoal[] = [];
  for (const goal of goals) {
    const family =
      duplicateSensitiveScenarioFamily(goal, productUseContract) ??
      productUseJobScenarioFamily(goal, productUseContract) ??
      normalizedFinalGoalFamily(goal);
    if (family && seen.has(family)) continue;
    if (family) seen.add(family);
    out.push(goal);
  }
  return out;
}

function productUseJobScenarioFamily(
  goal: DiscoveryGoal,
  productUseContract: ProductUseContract | undefined,
): string | undefined {
  const job = selectProductUseJobForGoal(productUseContract?.user_jobs, goal);
  if (!job) return undefined;
  return `job:${job.id}`;
}

function normalizedFinalGoalFamily(goal: DiscoveryGoal): string | undefined {
  const text = normalizeTextForMatching(goal.description);
  return text ? `description:${text}` : undefined;
}

function duplicateSensitiveScenarioFamily(
  goal: DiscoveryGoal,
  productUseContract: ProductUseContract | undefined,
): string | undefined {
  const job = selectProductUseJobForGoal(productUseContract?.user_jobs, goal);
  const text = job
    ? [job.title, job.scenario_brief, job.expected_artifact, ...job.required_actions].join(' ')
    : goal.description;
  const dataGridFamily = dataGridScenarioFamily(text);
  if (dataGridFamily) return dataGridFamily;
  const families = artifactEditorCapabilityFamilies(normalizeTextForMatching(text));
  if (families.has('export') && isExplicitExportGoal(goal, job)) return 'export';
  if (families.has('share') && isExplicitShareGoal(goal, job)) return 'share';
  if (families.has('media') && isExplicitMediaGoal(goal, job)) return 'media';
  const family = primaryArtifactCapabilityFamily(text);
  if (family === 'export' && isExplicitExportGoal(goal, job)) return family;
  if (family === 'share' && isExplicitShareGoal(goal, job)) return family;
  if (family === 'media' && isExplicitMediaGoal(goal, job)) return family;
  return undefined;
}

function dataGridScenarioFamily(text: string): string | undefined {
  const normalized = normalizeTextForMatching(text);
  if (!normalized) return undefined;
  if (/\b(search|filter|query)\b/.test(normalized)) {
    if (/\blondon\b/.test(normalized)) return 'data-grid:filter:london';
    if (/\btokyo\b/.test(normalized)) return 'data-grid:filter:tokyo';
    if (/\bsan francisco\b/.test(normalized)) return 'data-grid:filter:san-francisco';
    return 'data-grid:filter';
  }
  if (
    /\b(page length|entries per page|entries per page|pagination|page 2|next page)\b/.test(
      normalized,
    )
  ) {
    return 'data-grid:page-length';
  }
  if (/\b(sort|sorted|order|ordered)\b/.test(normalized)) {
    if (/\bsalary\b/.test(normalized)) return 'data-grid:sort:salary';
    if (/\bage\b/.test(normalized)) return 'data-grid:sort:age';
    return 'data-grid:sort';
  }
  return undefined;
}

function isExplicitExportGoal(goal: DiscoveryGoal, job: ProductUseJob | undefined): boolean {
  const text = normalizeTextForMatching(
    job ? [job.title, job.scenario_brief, job.expected_artifact].join(' ') : goal.description,
  );
  return (
    /\b(export|download|save as|save|print|output)\b/.test(text) && !text.startsWith('create ')
  );
}

function isExplicitShareGoal(goal: DiscoveryGoal, job: ProductUseJob | undefined): boolean {
  const text = normalizeTextForMatching(
    job ? [job.title, job.scenario_brief, job.expected_artifact].join(' ') : goal.description,
  );
  return /\b(share|collaborat|invite|sign in|sign up|login|permission)\b/.test(text);
}

function isExplicitMediaGoal(goal: DiscoveryGoal, job: ProductUseJob | undefined): boolean {
  const text = normalizeTextForMatching(
    job ? [job.title, job.scenario_brief, job.expected_artifact].join(' ') : goal.description,
  );
  return /\b(insert|upload|import|embed|media|image|file)\b/.test(text);
}

function isArtifactEditorProduct(productKinds: ProductKind[]): boolean {
  return (
    productKinds.includes('canvas_editor') ||
    productKinds.includes('document_editor') ||
    productKinds.includes('media_tool')
  );
}

function isShallowArtifactEditorGoal(description: string): boolean {
  const text = description.toLowerCase();
  const creation = /\b(create|make|draw|place|add)\b/.test(text);
  const artifact = /\b(canvas|whiteboard|board|diagram|object|shape|artifact|document)\b/.test(
    text,
  );
  const richProof =
    /\b(text|label|note|arrow|connector|style|color|fill|resize|move|second|multiple|composed|meaningful|format)\b/.test(
      text,
    );
  return creation && artifact && !richProof;
}

function isPrimaryArtifactCompositionJourney(text: string): boolean {
  return /\b(minimally meaningful|at least two|composed artifact|launch planning|launch plan|draft.*review)\b/.test(
    text,
  );
}

function selectArtifactCapabilitySurfaces(
  surfaces: DiscoverySurface[],
  capabilityPattern: RegExp,
): string[] {
  const ids = surfaces
    .filter((surface) => capabilityPattern.test(surfaceSearchText(surface)))
    .map((surface) => surface.id);
  const canvasContext = surfaces
    .filter((surface) =>
      /\b(canvas|whiteboard|board|document|editor)\b/i.test(surfaceSearchText(surface)),
    )
    .slice(0, 2)
    .map((surface) => surface.id);
  return [...new Set([...canvasContext, ...ids])];
}

function nextJourneyId(journeys: DiscoveryJourney[], reservedIds: string[] = []): string {
  const used = new Set([...journeys.map((journey) => journey.id), ...reservedIds]);
  let index = journeys.length + 1;
  while (used.has(`J${index}`)) index++;
  return `J${index}`;
}

function surfaceSearchText(surface: DiscoverySurface): string {
  return [
    surface.label,
    surface.kind,
    surface.value,
    ...(surface.controls ?? []).flatMap((control) => [
      control.name ?? '',
      control.role ?? '',
      control.tag ?? '',
    ]),
  ]
    .join(' ')
    .toLowerCase();
}

function journeySearchText(journey: DiscoveryJourney): string {
  return [
    journey.title,
    journey.user_intent,
    journey.suggested_goal,
    journey.sample_input ?? '',
    ...journey.expected_evidence,
  ]
    .join(' ')
    .toLowerCase();
}

function normalizeTextForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function journeyScenarioText(journey: DiscoveryJourney): string {
  return [journey.title, journey.user_intent, journey.suggested_goal, ...journey.expected_evidence]
    .join(' ')
    .toLowerCase();
}

function attachDiscoveryGoalRefs(
  goal: DiscoveryGoal,
  journeys: DiscoveryJourney[],
  coveragePlan: DiscoveryCoveragePlan | undefined,
): DiscoveryGoal {
  if (goal.journey_id) {
    const journey = journeys.find((candidate) => candidate.id === goal.journey_id);
    if (!journey) return goal;
    return {
      ...goal,
      surface_ids: [...new Set([...goal.surface_ids, ...journey.surface_ids])],
    };
  }
  if (goal.surface_ids.length > 0 || journeys.length === 0) return goal;
  const normalizedGoal = goal.description.toLowerCase();
  const selected = new Set(coveragePlan?.selected_journey_ids ?? []);
  const selectedJourneys = journeys.filter((journey) => selected.has(journey.id));
  const matchingJourney =
    journeys.find(
      (journey) =>
        normalizedGoal.includes(journey.title.toLowerCase()) ||
        journey.suggested_goal.toLowerCase().includes(normalizedGoal.slice(0, 60)) ||
        normalizedGoal.includes(journey.suggested_goal.toLowerCase().slice(0, 60)),
    ) ?? (selectedJourneys.length === 1 ? selectedJourneys[0] : undefined);
  if (!matchingJourney) return goal;
  return {
    ...goal,
    journey_id: matchingJourney.id,
    surface_ids: matchingJourney.surface_ids,
  };
}

function synthesizeJourneysFromGoals(
  goals: DiscoveryGoal[],
  surfaces: DiscoverySurface[],
): DiscoveryJourney[] {
  if (surfaces.length === 0) return [];
  return goals.map((goal, index) => {
    const surfaceIds = selectSurfacesForGoal(goal, surfaces);
    const selectedSurfaces = surfaces.filter((surface) => surfaceIds.includes(surface.id));
    const peripheralOnly =
      selectedSurfaces.length > 0 &&
      selectedSurfaces.every((surface) => surface.value === 'peripheral');
    return {
      id: `J${index + 1}`,
      title: titleFromGoal(goal.description),
      priority: goal.priority === 'must' ? 'must' : 'should',
      surface_ids: surfaceIds,
      user_intent: goal.description,
      suggested_goal: goal.description,
      expected_evidence: ['Visible browser state or destination proves the goal outcome.'],
      risk: goal.priority === 'must' ? 'high' : peripheralOnly ? 'low' : 'medium',
    };
  });
}

function selectSurfacesForGoal(goal: DiscoveryGoal, surfaces: DiscoverySurface[]): string[] {
  const text = goal.description.toLowerCase();
  const scored = surfaces
    .map((surface) => ({ surface, score: scoreSurfaceForGoal(text, goal.priority, surface) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  if (best > 0) {
    return scored
      .filter((entry) => entry.score > 0 && entry.score >= best - 1)
      .slice(0, 3)
      .map((entry) => entry.surface.id);
  }
  const fallback =
    surfaces.find((surface) => surface.value === 'core') ??
    surfaces.find((surface) => surface.value === 'important_secondary') ??
    surfaces[0];
  return fallback ? [fallback.id] : [];
}

function scoreSurfaceForGoal(
  goalText: string,
  priority: DiscoveryGoal['priority'],
  surface: DiscoverySurface,
): number {
  const label = surface.label.toLowerCase();
  const controlText = surface.controls
    .map((control) => `${control.name ?? ''} ${control.href ?? ''} ${control.role ?? ''}`)
    .join(' ')
    .toLowerCase();
  const haystack = `${label} ${surface.kind} ${surface.source} ${surface.url.toLowerCase()} ${controlText}`;
  let score = 0;

  if (surface.value === 'core') score += 3;
  if (surface.value === 'important_secondary') score += 2;
  if (priority === 'must' && surface.value === 'core') score += 1;
  if (surface.source === 'primary_journey') score += 1;

  for (const token of importantGoalTokens(goalText)) {
    if (token.length >= 4 && haystack.includes(token)) score += 4;
  }

  if (/\b(search|find|query|topic|article)\b/.test(goalText)) {
    if (surface.kind === 'search') score += 6;
    if (surface.kind === 'content' && surface.source === 'primary_journey') score += 4;
  }
  if (
    /\b(article|content|read|contents?|section|reference|citation|history|edit|talk)\b/.test(
      goalText,
    )
  ) {
    if (surface.kind === 'content') score += 5;
    if (surface.source === 'primary_journey') score += 4;
    if (surface.kind === 'nav' || surface.kind === 'menu') score += 2;
  }
  if (/\b(account|log\s*in|login|sign[- ]?in|sign[- ]?up|create account)\b/.test(goalText)) {
    if (surface.kind === 'account') score += 7;
  }
  if (/\b(language|edition|translation|localized|locale)\b/.test(goalText)) {
    if (surface.kind === 'menu' || surface.kind === 'nav') score += 4;
    if (/language|english|deutsch|francais|espanol|japanese|chinese/.test(haystack)) score += 5;
  }
  if (/\b(donate|donation|fundraiser|banner|dismiss|close)\b/.test(goalText)) {
    if (surface.kind === 'banner' || surface.kind === 'modal') score += 6;
    if (/donate|fundraiser|banner|close|dismiss/.test(haystack)) score += 5;
  }
  if (/\b(privacy|terms|legal|license|copyright|creative commons)\b/.test(goalText)) {
    if (surface.kind === 'footer') score += 7;
    if (surface.value === 'peripheral') score += 2;
  }
  if (/\b(app store|google play|mobile app|android|ios)\b/.test(goalText)) {
    if (surface.kind === 'external') score += 6;
    if (/app store|google play|android|ios|mobile/.test(haystack)) score += 6;
  }
  if (/\b(settings|preferences|appearance|theme)\b/.test(goalText)) {
    if (surface.kind === 'settings' || surface.kind === 'menu') score += 5;
  }

  return score;
}

function importantGoalTokens(text: string): string[] {
  const stop = new Set([
    'and',
    'the',
    'for',
    'from',
    'with',
    'that',
    'this',
    'page',
    'open',
    'verify',
    'loads',
    'load',
    'works',
    'use',
    'using',
    'check',
    'confirm',
  ]);
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4 && !stop.has(token));
}

function titleFromGoal(description: string): string {
  const trimmed = description.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77).trim()}...`;
}

function discoveryGoalKey(goal: DiscoveryGoal): string {
  const text = goal.description.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/google\s+play(?:\s+store)?/.test(text)) return 'dest:google-play';
  if (/(?:apple\s+)?app\s+store|ios\s+app/.test(text)) return 'dest:apple-app-store';
  if (/already\s+donated/.test(text)) return 'dest:already-donated';
  if (/donate\s+now|donation\s+(?:flow|landing|page)/.test(text)) return 'dest:donate';
  if (/creative\s+commons|cc\s+by/.test(text)) return 'dest:creative-commons';
  if (/terms(?:\s+of\s+use)?/.test(text)) return 'dest:terms';
  if (/privacy(?:\s+policy)?/.test(text)) return 'dest:privacy';
  if (/wikivoyage/.test(text)) return 'dest:wikivoyage';
  if (/wiktionary/.test(text)) return 'dest:wiktionary';
  if (/\bcommons\b/.test(text)) return 'dest:commons';
  if (/account|log\s*in|login|sign[- ]?in|sign[- ]?up|create\s+account/.test(text)) {
    return 'surface:account-entry';
  }
  if (
    /(contents?|table\s+of\s+contents|section\s+links?|within\s+(?:an\s+)?article)/.test(text) &&
    !/(history|edit|talk)/.test(text)
  ) {
    return 'surface:article-section-nav';
  }
  if (/(view\s+history|edit|talk)/.test(text) && !/(contents?|section\s+links?)/.test(text)) {
    return 'surface:article-meta-tools';
  }
  return text;
}

function supplementalDiscoveryGoals(
  sourceText: string,
  existingGoals: DiscoveryGoal[],
): DiscoveryGoal[] {
  const source = sourceText.toLowerCase();
  const out: DiscoveryGoal[] = [];
  const goalTexts = existingGoals.map((g) => g.description.toLowerCase());

  if (/(create account|log in|login|sign in|sign-in|sign up|sign-up)/.test(source)) {
    if (!goalTexts.some((text) => /account|log\s*in|login|sign[- ]?in|sign[- ]?up/.test(text))) {
      out.push({
        id: 'supplement-account',
        description:
          'Open account-related actions such as Create account or Log in and verify the sign-up or sign-in destination loads.',
        priority: 'should',
        surface_ids: [],
      });
    }
  }

  const hasArticleShell =
    /contents\s+(hide|show)|jump to content|from wikipedia|article\s+talk|view history/.test(
      source,
    );
  if (hasArticleShell && /(contents|#founding|#services|section)/.test(source)) {
    const hasDistinctSectionGoal = goalTexts.some(
      (text) =>
        /(contents?|table\s+of\s+contents|section\s+links?|within\s+(?:an\s+)?article)/.test(
          text,
        ) && !/(history|edit|talk)/.test(text),
    );
    if (!hasDistinctSectionGoal) {
      out.push({
        id: 'supplement-article-sections',
        description:
          'Use article table-of-contents or section links to move within an article and verify the visible section or URL hash updates.',
        priority: 'should',
        surface_ids: [],
      });
    }
  }

  if (hasArticleShell && /(view history|edit|talk)/.test(source)) {
    const hasDistinctMetaGoal = goalTexts.some(
      (text) =>
        /(view\s+history|edit|talk)/.test(text) &&
        !/(contents?|table\s+of\s+contents|section\s+links?)/.test(text),
    );
    if (!hasDistinctMetaGoal) {
      out.push({
        id: 'supplement-article-meta',
        description:
          'Open article meta actions such as Talk, Edit, or View history and verify the corresponding article view or destination loads.',
        priority: 'should',
        surface_ids: [],
      });
    }
  }

  return out;
}

/**
 * Run discovery. On parse failure returns null so the caller can fall back to
 * free mode without aborting the whole run.
 */
export async function runDiscovery(inputs: DiscoveryRunInputs): Promise<DiscoveryRunResult | null> {
  const surveyPayloadSummary = formatDiscoverySurveyPayload(inputs.survey_payload);
  const userPrompt = DISCOVERY_USER_TEMPLATE({
    url: inputs.url,
    observation_summary: inputs.observation_summary,
    ...(inputs.survey_summary ? { survey_summary: inputs.survey_summary } : {}),
    ...(surveyPayloadSummary ? { survey_payload_summary: surveyPayloadSummary } : {}),
  });
  let text = '';
  let cost = 0;
  if (inputs.discoverer) {
    const r = await inputs.discoverer({
      systemPrompt: DISCOVERY_SYSTEM,
      userPrompt,
      imagePath: inputs.screenshot_path,
      ...(inputs.model ? { model: inputs.model } : {}),
    });
    text = r.text;
    cost = r.cost_usd;
  } else if (inputs.client) {
    // The legacy LlmClient path. Caller is responsible for reading the
    // screenshot and including it as an image content block; we don't have a
    // direct ergonomic for that here. For now, send the prompt text only — the
    // SDK transport (which always uses `discoverer`) is the primary path.
    const r = await inputs.client.call({
      model: inputs.model ?? 'claude-sonnet-4-6',
      system: DISCOVERY_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 2000,
      temperature: 0,
    });
    text = r.text;
    cost = 0;
  } else {
    throw new Error('runDiscovery requires either `discoverer` or `client`');
  }

  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const out = DiscoveryOutputSchema.parse(parsed);
      const normalized = normalizeDiscoveryOutput(
        out,
        `${inputs.observation_summary}\n${inputs.survey_summary ?? ''}\n${surveyPayloadSummary}`,
        extractSurveySurfaces(inputs.survey_payload),
      );
      return { output: normalized, cost_usd: cost };
    } catch {
      // Keep trying; providers occasionally include example JSON or wrapper
      // objects before the actual discovery payload.
    }
  }
  return null;
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (char !== '}') continue;
    if (depth === 0) continue;
    depth--;
    if (depth === 0 && start >= 0) {
      candidates.push(text.slice(start, i + 1));
      start = -1;
    }
  }
  if (candidates.length > 0) return candidates.sort((a, b) => b.length - a.length);
  const greedy = text.match(/\{[\s\S]*\}/);
  return greedy ? [greedy[0]] : [];
}

function normalizeJourneyMateriality(
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
  productUseContract: ProductUseContract | undefined,
): DiscoveryJourney[] {
  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  return journeys.map((journey) => {
    const selectedSurfaces = journey.surface_ids
      .map((id) => byId.get(id))
      .filter((surface): surface is DiscoverySurface => Boolean(surface));
    return {
      ...journey,
      goal_class: classifyJourneyMateriality(journey, selectedSurfaces, productUseContract),
    };
  });
}

function classifyStandaloneGoal(
  goal: DiscoveryGoal,
  surfaces: DiscoverySurface[],
): DiscoveryGoalClass {
  const selected = surfaces.filter((surface) => goal.surface_ids.includes(surface.id));
  return classifyMateriality({
    priority: goal.priority,
    risk: goal.priority === 'must' ? 'high' : 'medium',
    title: titleFromGoal(goal.description),
    text: goal.description,
    surfaces: selected,
    productKinds: [],
  });
}

function classifyJourneyMateriality(
  journey: DiscoveryJourney,
  surfaces: DiscoverySurface[],
  productUseContract: ProductUseContract | undefined,
): DiscoveryGoalClass {
  const productKinds = productUseContract?.product_kinds ?? [];
  if (
    productKinds.includes('search_content') &&
    /\b(language|translate|edit|history|talk)\b/.test(journeyScenarioText(journey))
  ) {
    return journey.priority === 'must' || journey.risk === 'high' ? 'core' : 'secondary_workflow';
  }
  const contractBacked =
    productUseContract?.user_jobs.some((job) => job.journey_id === journey.id) ?? false;
  if (
    contractBacked &&
    isImplementationCodeWorkflowForDeveloperExample(journeyScenarioText(journey), productKinds)
  ) {
    return journey.priority === 'must' || journey.risk === 'high' ? 'core' : 'secondary_workflow';
  }
  const computed = classifyMateriality({
    priority: journey.priority,
    risk: journey.risk,
    title: journey.title,
    text: [
      journey.title,
      journey.user_intent,
      journey.suggested_goal,
      ...journey.expected_evidence,
    ].join(' '),
    surfaces,
    productKinds,
  });
  if (!journey.goal_class) return computed;
  if (contractBacked && isSeedGoalClass(journey.goal_class)) {
    const text = journeyScenarioText(journey);
    if (isLowSignalSetupText(text)) return computed;
    if (computed === 'setup') return journey.goal_class;
    if (computed === 'peripheral' || computed === 'diagnostic') return computed;
    return computed;
  }
  if (contractBacked && isSeedGoalClass(computed)) return computed;
  if (computed === 'setup' || computed === 'peripheral' || computed === 'diagnostic')
    return computed;
  if (
    isSeedGoalClass(computed) &&
    (journey.goal_class === 'setup' || journey.goal_class === 'peripheral')
  ) {
    return computed;
  }
  if (journey.goal_class === 'setup' || journey.goal_class === 'peripheral')
    return journey.goal_class;
  return computed;
}

function classifyMateriality(input: {
  priority: 'must' | 'should' | 'could';
  risk: 'high' | 'medium' | 'low';
  title: string;
  text: string;
  surfaces: DiscoverySurface[];
  productKinds: ProductKind[];
}): DiscoveryGoalClass {
  const surfaceText = input.surfaces
    .map((surface) => `${surface.kind} ${surface.value} ${surface.label} ${surface.url}`)
    .join(' ');
  const primaryText = `${input.title} ${input.text}`.toLowerCase();
  const text = `${primaryText} ${surfaceText}`.toLowerCase();
  const hasCoreSurface = input.surfaces.some((surface) => surface.value === 'core');
  const hasSecondarySurface = input.surfaces.some(
    (surface) => surface.value === 'important_secondary',
  );
  const allPeripheral =
    input.surfaces.length > 0 && input.surfaces.every((surface) => surface.value === 'peripheral');
  const hasSetupSurface = input.surfaces.some(
    (surface) => surface.kind === 'banner' || surface.kind === 'modal',
  );

  if (isPeripheralText(primaryText) || allPeripheral)
    return primaryText.includes('sample') ? 'sample' : 'peripheral';
  if (isSetupText(primaryText) || (hasSetupSurface && isDismissalText(primaryText))) return 'setup';
  if (isDiagnosticText(primaryText)) return 'diagnostic';
  if (isConcreteDataGridWorkflow(primaryText, input.productKinds)) {
    return input.priority === 'must' || input.risk === 'high' ? 'core' : 'secondary_workflow';
  }
  if (isSupportWorkflowForConcreteProduct(primaryText, input.productKinds)) return 'sample';
  if (
    isArtifactEditorProduct(input.productKinds) &&
    isBroadArtifactEditorUtilityText(primaryText)
  ) {
    return 'sample';
  }

  const productJobScore = productJobTerms(input.productKinds).filter((term) =>
    term.test(text),
  ).length;
  const actionScore = materialActionTerms.filter((term) => term.test(text)).length;
  const evidenceScore = materialEvidenceTerms.filter((term) => term.test(text)).length;

  if (
    input.priority === 'must' ||
    input.risk === 'high' ||
    hasCoreSurface ||
    productJobScore >= 2 ||
    (actionScore > 0 && evidenceScore > 0)
  ) {
    return 'core';
  }
  if (hasSecondarySurface || productJobScore > 0 || actionScore > 0) return 'secondary_workflow';
  return 'sample';
}

function isSeedGoalClass(goalClass: DiscoveryGoalClass): boolean {
  return goalClass === 'core' || goalClass === 'secondary_workflow';
}

function isPeripheralText(text: string): boolean {
  return /\b(privacy|terms|legal|license|copyright|creative commons|cookie|cookies|app store|google play|mobile app|ios app|android app|sister[- ]project|footer link|policy|sdk documentation|developer docs|user manual|send feedback|help center|support page)\b/.test(
    text,
  );
}

function isSetupText(text: string): boolean {
  return /\b(dismiss|close|hide|accept|reject|consent|obstruct|obstructs|obstructing|obstruction|blocking|blocked|banner|modal|popup|pop-up|overlay|promo|promotion|newsletter|donation prompt|fundraiser prompt)\b/.test(
    text,
  );
}

function isDismissalText(text: string): boolean {
  return /\b(dismiss|close|clear|hide|accept|reject|no thanks|skip)\b/.test(text);
}

function isDiagnosticText(text: string): boolean {
  return (
    /\b(diagnostic|smoke|baseline|health check)\b/.test(text) ||
    /\b(check|confirm|verify)\b.*\b(layout|accessibility|axe|console|error state)\b/.test(text)
  );
}

function isSupportWorkflowForConcreteProduct(text: string, productKinds: ProductKind[]): boolean {
  if (!hasConcreteWorkflowProductKind(productKinds)) return false;
  if (isContentOrDocumentationFirstProduct(productKinds)) return false;
  const normalized = normalizeTextForMatching(text);
  if (isImplementationCodeWorkflowForDeveloperExample(normalized, productKinds)) return false;
  if (
    isArtifactEditorProduct(productKinds) &&
    /\b(export|download|save|share|invite)\b/.test(normalized)
  ) {
    return false;
  }
  const developerReference =
    (/\b(javascript|html|css|code|snippet|implementation|cdn|source|api|docs?|documentation|reference)\b/.test(
      normalized,
    ) ||
      (/\bdependenc(?:y|ies)\b/.test(normalized) &&
        /\b(code|javascript|cdn|package|library|implementation)\b/.test(normalized))) &&
    /\b(read|inspect|open|find|search|verify|example|tab|section|reference)\b/.test(normalized);
  const explanatoryReference =
    /\b(reference content|reference table|adult .*table|child(?:ren)?(?:\s+| and )teens?|cdc chart|chart for boys|chart for girls|pdf|interpretation content|supporting article)\b/.test(
      normalized,
    );
  const calculatorUtility =
    productKinds.includes('calculator_tool') &&
    (/\b(print|save|export|download|pdf)\b/.test(normalized) ||
      /\b(clear|reset)\b.{0,50}\b(form|input|calculator|entries|defaults?)\b/.test(normalized));
  const relatedNavigation =
    /\b(related example|related calculator|related link|site search|header search|right-rail search|destination page|navigate to a related|open a related)\b/.test(
      normalized,
    ) || /\brelated\b.{0,50}\b(calculator|example|link|page|destination)\b/.test(normalized);
  return developerReference || explanatoryReference || calculatorUtility || relatedNavigation;
}

function isImplementationCodeWorkflowForDeveloperExample(
  text: string,
  productKinds: ProductKind[],
): boolean {
  if (!productKinds.includes('developer_documentation')) return false;
  if (!(productKinds.includes('data_grid') || productKinds.includes('developer_tool'))) {
    return false;
  }
  const normalized = normalizeTextForMatching(text);
  if (
    /\b(manual|site search|header search|related|server side|server-side|ajax|navigate|destination|download|login|register|account|comments?)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /\b(code|snippet|javascript|html|css|cdn|dependenc(?:y|ies)|implementation|initiali[sz]e|source)\b/.test(
      normalized,
    ) &&
    /\b(read|inspect|open|confirm|connect|learn|copy|visible|tab|section|shown|loaded)\b/.test(
      normalized,
    )
  );
}

function isConcreteDataGridWorkflow(text: string, productKinds: ProductKind[]): boolean {
  if (!productKinds.includes('data_grid')) return false;
  const normalized = normalizeTextForMatching(text);
  const control =
    /\b(search|filter|query|sort|sorted|order|column|salary|age|page length|entries per page|pagination|next|previous|page \d+|row range|showing \d+)\b/.test(
      normalized,
    );
  const tableState = /\b(table|grid|datatable|rows?|entries|employees?|count|range)\b/.test(
    normalized,
  );
  return control && tableState;
}

function hasConcreteWorkflowProductKind(productKinds: ProductKind[]): boolean {
  return productKinds.some(
    (kind) =>
      kind !== 'unknown' &&
      kind !== 'content_site' &&
      kind !== 'search_content' &&
      kind !== 'developer_documentation' &&
      kind !== 'auth_account' &&
      kind !== 'settings_tool',
  );
}

function isContentOrDocumentationFirstProduct(productKinds: ProductKind[]): boolean {
  if (productKinds.length === 0) return false;
  return productKinds.every(
    (kind) =>
      kind === 'content_site' ||
      kind === 'search_content' ||
      kind === 'developer_documentation' ||
      kind === 'unknown',
  );
}

function isBroadArtifactEditorUtilityText(text: string): boolean {
  const mentionsMenuUtility =
    /\b(page menu|utilities?|utility destination|app[- ]level options)\b/.test(text);
  const utilityTerms = [
    /\bpreferences?\b/,
    /\blanguage\b/,
    /\bkeyboard shortcuts?\b/,
    /\bhelp\b|\bmanual\b/,
    /\blegal\b|\bcookies?\b/,
    /\bfeedback\b/,
  ].filter((term) => term.test(text)).length;
  const concreteArtifactOutput = /\b(export|download|save as|print)\b/.test(text);
  const concreteArtifactInput = /\b(media|embed|upload|insert)\b/.test(text);
  const broadExamples =
    /\bsuch as\b.*\b(preferences?|language|keyboard shortcuts?|help|manual)\b/.test(text);
  const destinationInventory =
    /\b(destinations?|surfaces?|subtree|representative|listed)\b/.test(text) ||
    /\b(export|download|media|embed|upload)\b.*\b(preferences?|language|help|manual|shortcuts?)\b/.test(
      text,
    );
  return (
    mentionsMenuUtility &&
    utilityTerms >= 1 &&
    ((utilityTerms >= 2 && (!concreteArtifactOutput || broadExamples)) ||
      (destinationInventory && (concreteArtifactOutput || concreteArtifactInput)))
  );
}

const materialActionTerms = [
  /\b(create|add|write|type|draw|place|insert|upload|import|export|download|save|publish|submit)\b/,
  /\b(edit|modify|format|style|resize|move|duplicate|delete|undo|redo|filter|sort|search|open and read)\b/,
  /\b(share|collaborate|checkout|cart|sign[- ]?in|sign[- ]?up|configure|apply)\b/,
];

const materialEvidenceTerms = [
  /\b(artifact|document|diagram|canvas|board|shape|text|paragraph|note|record|row|item|result|article|table|chart|file|download|state change|updated|appears|visible)\b/,
];

function productJobTerms(productKinds: ProductKind[]): RegExp[] {
  const terms: RegExp[] = [];
  for (const kind of productKinds) {
    switch (kind) {
      case 'canvas_editor':
        terms.push(
          /\b(canvas|whiteboard|diagram|draw|shape|arrow|connector|text|note|style|resize|move|export|share)\b/,
        );
        break;
      case 'document_editor':
        terms.push(/\b(document|paragraph|heading|bold|italic|format|save|export|publish)\b/);
        break;
      case 'search_content':
      case 'content_site':
        terms.push(
          /\b(search|query|result|article|read|section|contents|reference|citation|language|history|edit|talk)\b/,
        );
        break;
      case 'crud_workflow':
        terms.push(/\b(create|record|row|item|edit|update|delete|save|submit|list)\b/);
        break;
      case 'dashboard_filtering':
        terms.push(/\b(filter|sort|drill|chart|table|metric|dashboard|data)\b/);
        break;
      case 'commerce_checkout':
        terms.push(/\b(product|cart|checkout|item|quantity|shipping|payment)\b/);
        break;
      case 'auth_account':
        terms.push(/\b(account|auth|sign[- ]?in|sign[- ]?up|login|share|collaborat|permission)\b/);
        break;
      case 'media_tool':
        terms.push(/\b(upload|media|image|video|transform|process|export|download)\b/);
        break;
      case 'communication_tool':
        terms.push(/\b(message|send|reply|thread|channel|conversation|notification)\b/);
        break;
      case 'developer_tool':
        terms.push(/\b(api|sdk|docs|key|code|example|integration|deploy|build)\b/);
        break;
      default:
        break;
    }
  }
  return terms;
}

const DISCOVERY_SURFACE_KINDS = new Set([
  'page',
  'nav',
  'form',
  'search',
  'menu',
  'modal',
  'banner',
  'content',
  'table',
  'media',
  'toolbar',
  'account',
  'settings',
  'footer',
  'external',
  'unknown',
] as const);
const DISCOVERY_SURFACE_SOURCES = new Set([
  'initial',
  'scroll',
  'menu_peek',
  'banner_dismiss',
  'primary_journey',
  'sample_nav',
] as const);
const DISCOVERY_SURFACE_VALUES = new Set(['core', 'important_secondary', 'peripheral'] as const);

function extractSurveySurfaces(payload: unknown): DiscoverySurface[] {
  if (!payload || typeof payload !== 'object') return [];
  const surfaces = (payload as { surfaces?: unknown }).surfaces;
  if (!Array.isArray(surfaces)) return [];
  const out: DiscoverySurface[] = [];
  for (const [index, surface] of surfaces.entries()) {
    const normalized = normalizeSurveySurface(surface, index);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizeSurveySurface(surface: unknown, index: number): DiscoverySurface | null {
  if (!surface || typeof surface !== 'object') return null;
  const record = surface as Record<string, unknown>;
  const label =
    stringValue(record.label) ?? stringValue(record.url) ?? `Survey surface ${index + 1}`;
  const candidate = {
    id: stringValue(record.id) ?? `S${String(index + 1).padStart(3, '0')}`,
    label,
    kind: enumValue(record.kind, DISCOVERY_SURFACE_KINDS) ?? 'unknown',
    url: stringValue(record.url) ?? '',
    source: enumValue(record.source, DISCOVERY_SURFACE_SOURCES) ?? 'initial',
    value:
      enumValue(record.value, DISCOVERY_SURFACE_VALUES) ??
      inferSurveySurfaceValue(String(record.kind ?? ''), label, stringValue(record.url)),
    confidence: numberValue(record.confidence) ?? 0.65,
    evidence: evidenceValue(record.evidence),
    controls: controlsValue(record.controls),
    prerequisites: stringArrayValue(record.prerequisites),
  };
  const parsed = DiscoverySurfaceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function inferSurveySurfaceValue(
  kind: string,
  label: string,
  url: string | undefined,
): DiscoverySurface['value'] {
  const text = `${kind} ${label} ${url ?? ''}`.toLowerCase();
  if (/external|privacy|terms|legal|license|copyright|app store|google play/.test(text)) {
    return 'peripheral';
  }
  if (/search|form|content|article|table|toolbar/.test(text)) return 'core';
  return 'important_secondary';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : undefined;
}

function evidenceValue(value: unknown): DiscoverySurface['evidence'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const ref = stringValue(record.ref);
      const note = stringValue(record.note) ?? '';
      return ref ? { ref, note } : null;
    })
    .filter((item): item is { ref: string; note: string } => Boolean(item));
}

function controlsValue(value: unknown): DiscoverySurface['controls'] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 20)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      return {
        ...(stringValue(record.role) ? { role: stringValue(record.role) } : {}),
        ...(stringValue(record.tag) ? { tag: stringValue(record.tag) } : {}),
        ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
        ...(stringValue(record.href) ? { href: stringValue(record.href) } : {}),
        ...(stringValue(record.type) ? { type: stringValue(record.type) } : {}),
        ...(stringValue(record.ariaExpanded)
          ? { ariaExpanded: stringValue(record.ariaExpanded) }
          : {}),
      };
    })
    .filter((item): item is DiscoverySurface['controls'][number] => Boolean(item));
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))
    : [];
}

const EXPLORER_CONTEXT_MAX_CHARS = 5000;

export function formatDiscoveryExplorerContext(out: DiscoveryOutput): string {
  const lines: string[] = [];
  if (out.out_of_scope.length > 0) {
    lines.push('OUT OF SCOPE / DO NOT DO:');
    for (const item of out.out_of_scope) {
      lines.push(`- ${item}`);
    }
  }
  if (out.product_use_contract) {
    lines.push(...formatScenarioAcceptanceLines(out));
  }
  const lowerPriorityLines: string[] = [];
  if (out.capabilities.length > 0) {
    lowerPriorityLines.push('PRODUCT CAPABILITY COVERAGE:');
    const productKinds = normalizedProductKinds(out.product_use_contract);
    const selected = out.capabilities.filter((capability) => capability.status === 'selected');
    const gaps = out.capabilities.filter(
      (capability) =>
        capability.status !== 'selected' &&
        capability.status !== 'not_applicable' &&
        capability.selection_expectation !== 'not_normally_tested' &&
        !isSupportWorkflowForConcreteProduct(
          capabilityExplorerContextText(capability),
          productKinds,
        ),
    );
    if (selected.length > 0) {
      lowerPriorityLines.push(
        `- selected capabilities: ${selected
          .slice(0, 10)
          .map((capability) => capability.label)
          .join('; ')}`,
      );
    }
    if (gaps.length > 0) {
      lowerPriorityLines.push(
        `- capability gaps to prefer when proposing follow-up work: ${gaps
          .slice(0, 10)
          .map(
            (capability) =>
              `${capability.label} (${(capability.selection_expectation ?? 'should_test_or_explain').replace(/_/g, ' ')})`,
          )
          .join('; ')}`,
      );
      for (const capability of gaps.slice(0, 5)) {
        if (capability.skip_reason || capability.coverage_gap) {
          lowerPriorityLines.push(
            `  - ${capability.label}: ${capability.skip_reason || capability.coverage_gap}`,
          );
        }
      }
    }
  }
  if (out.surfaces.length > 0) {
    lowerPriorityLines.push('DISCOVERED SURFACES:');
    for (const surface of out.surfaces.slice(0, 24)) {
      lowerPriorityLines.push(
        `- ${surface.id} [${surface.value}/${surface.kind}/${surface.source}]: ${surface.label}`,
      );
    }
  }
  if (out.journeys.length > 0) {
    lowerPriorityLines.push('SELECTED JOURNEY GROUPS:');
    const selected = new Set(out.coverage_plan?.selected_journey_ids ?? []);
    const selectedJourneyContext =
      selected.size > 0 ? out.journeys.filter((journey) => selected.has(journey.id)) : out.journeys;
    for (const journey of selectedJourneyContext.slice(0, 18)) {
      const marker = selected.has(journey.id) ? 'selected' : 'deferred';
      lowerPriorityLines.push(
        `- ${journey.id} [${marker}/${journey.priority}]: ${journey.title} -> ${journey.suggested_goal}`,
      );
    }
  }
  const deferredIds = out.coverage_plan?.deferred_surface_ids ?? [];
  if (deferredIds.length > 0) {
    const labels = new Map(out.surfaces.map((surface) => [surface.id, surface.label]));
    lowerPriorityLines.push(
      `DEFERRED SURFACES: ${deferredIds
        .slice(0, 20)
        .map((id) => `${id}${labels.get(id) ? ` (${labels.get(id)})` : ''}`)
        .join(', ')}`,
    );
  }
  if (out.coverage_plan?.rationale) {
    lowerPriorityLines.push(`DISCOVERY COVERAGE RATIONALE: ${out.coverage_plan.rationale}`);
  }
  appendLinesWithinBudget(lines, lowerPriorityLines, EXPLORER_CONTEXT_MAX_CHARS);
  return lines.join('\n');
}

function formatScenarioAcceptanceLines(out: DiscoveryOutput): string[] {
  const contract = out.product_use_contract;
  if (!contract) return [];
  const lines: string[] = ['SCENARIO ACCEPTANCE CRITERIA:'];
  if (contract.product_kinds.length > 0) {
    lines.push(`- product kinds: ${contract.product_kinds.join(', ')}`);
  }
  const selectedArtifacts = selectedCoreArtifactsForContext(out);
  const selectedJobs = productUseJobsForExplorerContext(out);
  const selectedLoops = valueLoopsForExplorerContext(out);
  const hasSelectedJobContext =
    (out.coverage_plan?.selected_journey_ids ?? []).length > 0 && selectedJobs.length > 0;
  const primaryJourney = hasSelectedJobContext
    ? selectedJobs
        .map((job) => job.scenario_brief || job.title)
        .filter(Boolean)
        .slice(0, 3)
        .join('; ')
    : contract.primary_value_loop;
  if (primaryJourney) {
    lines.push(`- primary journey: ${primaryJourney}`);
  }
  if (selectedArtifacts.length > 0) {
    lines.push(`- core artifacts/state changes: ${selectedArtifacts.join('; ')}`);
  }
  for (const loop of selectedLoops.slice(0, 4)) {
    const artifact = hasSelectedJobContext
      ? selectedArtifacts.join('; ') || loop.artifact || 'visible product outcome'
      : loop.artifact || 'visible product outcome';
    lines.push(`- journey group ${loop.id}: ${loop.title}; artifact: ${artifact}`);
    if (!hasSelectedJobContext && loop.required_capabilities.length > 0) {
      lines.push(`  required capabilities: ${loop.required_capabilities.join('; ')}`);
    }
    if (!hasSelectedJobContext && loop.proof_obligations.length > 0) {
      lines.push(`  proof obligations: ${loop.proof_obligations.join('; ')}`);
    }
    if (!hasSelectedJobContext && loop.weak_evidence.length > 0) {
      lines.push(
        `  weak evidence that must NOT verify this journey: ${loop.weak_evidence.join('; ')}`,
      );
    }
  }
  for (const job of selectedJobs) {
    lines.push(
      `- ${job.id}${job.journey_id ? ` (${job.journey_id})` : ''}: ${job.title}; scenario: ${job.scenario_brief || job.title}; required actions: ${job.required_actions.join(', ') || 'normal user actions'}; expected artifact/state: ${job.expected_artifact || 'visible outcome'}`,
    );
    const visibleData = scenarioVisibleDataTokens(job.test_data);
    const instructionHints = scenarioInstructionHints(job.test_data);
    if (visibleData.length > 0) {
      lines.push(`  exact visible content/data to use: ${visibleData.join('; ')}`);
    }
    if (instructionHints.length > 0) {
      lines.push(`  scenario constraints: ${instructionHints.join('; ')}`);
    }
    if (job.required_outputs.length > 0) {
      lines.push(`  required visible outputs: ${job.required_outputs.join('; ')}`);
    }
    if (job.quality_bar.length > 0) {
      lines.push(`  quality bar: ${job.quality_bar.join('; ')}`);
    }
    if (job.proof_obligations.length > 0) {
      lines.push(`  proof obligations: ${job.proof_obligations.join('; ')}`);
    }
    if (job.acceptable_evidence.length > 0) {
      lines.push(`  acceptable evidence: ${job.acceptable_evidence.join('; ')}`);
    }
    if (job.weak_evidence.length > 0) {
      lines.push(`  weak evidence that must NOT verify: ${job.weak_evidence.join('; ')}`);
    }
  }
  return lines;
}

function productUseJobsForExplorerContext(out: DiscoveryOutput): ProductUseJob[] {
  const jobs = out.product_use_contract?.user_jobs ?? [];
  const selectedJourneyIds = new Set(out.coverage_plan?.selected_journey_ids ?? []);
  const selectedJobs = jobs.filter(
    (job) => job.journey_id && selectedJourneyIds.has(job.journey_id),
  );
  if (selectedJourneyIds.size > 0) {
    if (selectedJobs.length > 0) return selectedJobs.slice(0, 8);
    const textMatchedJobs = jobs.filter((job) => {
      const journeyId = matchingProductUseJobJourneyId(job, out.journeys);
      return Boolean(journeyId && selectedJourneyIds.has(journeyId));
    });
    if (textMatchedJobs.length > 0) return textMatchedJobs.slice(0, 8);
    const unlinkedJobs = jobs.filter((job) => !job.journey_id);
    return (unlinkedJobs.length > 0 ? unlinkedJobs : jobs).slice(0, 8);
  }
  if (selectedJobs.length === 0) return jobs.slice(0, 8);
  return selectedJobs.slice(0, 8);
}

function selectedCoreArtifactsForContext(out: DiscoveryOutput): string[] {
  const contract = out.product_use_contract;
  if (!contract) return [];
  const selectedJobs = productUseJobsForExplorerContext(out);
  const selectedJourneyIds = new Set(out.coverage_plan?.selected_journey_ids ?? []);
  const selectedJobArtifacts = selectedJobs.flatMap((job) => [
    job.expected_artifact,
    ...job.required_outputs,
  ]);
  if (selectedJourneyIds.size > 0 && selectedJobArtifacts.some((item) => item.trim())) {
    return uniqueNonEmptyStrings(selectedJobArtifacts).slice(0, 8);
  }
  if (selectedJourneyIds.size > 0) return [];
  return contract.core_artifacts.slice(0, 8);
}

function valueLoopsForExplorerContext(out: DiscoveryOutput): ProductUseValueLoop[] {
  const contract = out.product_use_contract;
  if (!contract) return [];
  const selectedJourneyIds = new Set(out.coverage_plan?.selected_journey_ids ?? []);
  if (selectedJourneyIds.size === 0) return contract.value_loops;
  const selectedJobs = productUseJobsForExplorerContext(out);
  const selectedLoopIds = new Set(
    selectedJobs.map((job) => job.value_loop_id).filter((id): id is string => Boolean(id)),
  );
  if (selectedLoopIds.size === 0) return [];
  return contract.value_loops.filter((loop) => selectedLoopIds.has(loop.id));
}

function capabilityExplorerContextText(capability: DiscoveryCapability): string {
  return [
    capability.label,
    capability.denominator_reason,
    capability.coverage_gap,
    capability.skip_reason ?? '',
    ...capability.evidence,
  ].join(' ');
}

function appendLinesWithinBudget(
  lines: string[],
  candidates: readonly string[],
  maxChars: number,
): void {
  for (const line of candidates) {
    const separatorLength = lines.length > 0 ? 1 : 0;
    const nextLength = lines.join('\n').length + separatorLength + line.length;
    if (nextLength > maxChars && !isExplorerContextSectionHeader(line)) continue;
    lines.push(line);
  }
}

function isExplorerContextSectionHeader(line: string): boolean {
  return /^[A-Z][A-Z /]+:$/.test(line);
}

function formatDiscoverySurveyPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as {
    surfaces?: unknown;
    captures?: unknown;
    links?: unknown;
    limits?: unknown;
  };
  const compact = {
    ...(Array.isArray(record.surfaces) ? { surfaces: record.surfaces.slice(0, 80) } : {}),
    ...(Array.isArray(record.captures)
      ? {
          captures: record.captures.slice(0, 12).map((capture) => {
            const c = capture as Record<string, unknown>;
            return {
              id: c.id,
              label: c.label,
              url: c.url,
              title: c.title,
              text: typeof c.text === 'string' ? c.text.slice(0, 600) : undefined,
              controls: Array.isArray(c.controls) ? c.controls.slice(0, 20) : undefined,
            };
          }),
        }
      : {}),
    ...(Array.isArray(record.links) ? { links: record.links.slice(0, 60) } : {}),
    ...(record.limits ? { limits: record.limits } : {}),
  };
  return JSON.stringify(compact, null, 2).slice(0, 12000);
}
