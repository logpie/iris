// Phase 10: discovery pass. Runs after preflight, before Explorer. Takes the
// landed page (URL + observation + screenshot) and asks an LLM to play the
// role of a new user proposing what to try. Returns a spec-shaped object
// that downstream code already knows how to consume.

import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import { DISCOVERY_SYSTEM, DISCOVERY_USER_TEMPLATE } from './prompts.js';

export const DiscoveryGoalSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['must', 'should']),
  journey_id: z.string().min(1).optional(),
  surface_ids: z.array(z.string()).default([]),
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
  'commerce_checkout',
  'auth_account',
  'media_tool',
  'settings_tool',
  'content_site',
  'communication_tool',
  'developer_tool',
  'unknown',
]);
export type ProductKind = z.infer<typeof ProductKindSchema>;

export const ProductUseJobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  journey_id: z.string().min(1).optional(),
  required_actions: z.array(z.string().min(1)).default([]),
  expected_artifact: z.string().default(''),
  acceptable_evidence: z.array(z.string().min(1)).default([]),
  weak_evidence: z.array(z.string().min(1)).default([]),
  risk: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type ProductUseJob = z.infer<typeof ProductUseJobSchema>;

export const ProductUseContractSchema = z.object({
  product_kinds: z.array(ProductKindSchema).default(['unknown']),
  primary_value_loop: z.string().default(''),
  core_artifacts: z.array(z.string().min(1)).default([]),
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
  const surfaces = normalizeDiscoverySurfaces(
    out.surfaces.length > 0 ? out.surfaces : surveySurfaces,
  );
  const journeys = attachPageContextSurfaces(
    normalizeDiscoveryJourneys(
      out.journeys.length > 0 ? out.journeys : synthesizeJourneysFromGoals(out.goals, surfaces),
      surfaces,
    ),
    surfaces,
  );
  const coveragePlan = normalizeDiscoveryCoveragePlan(out.coverage_plan, journeys, surfaces);
  const productUseContract = normalizeProductUseContract(out.product_use_contract, journeys);
  const goals: DiscoveryGoal[] = [];
  const seenDescriptions = new Set<string>();

  for (const goal of out.goals) {
    const key = discoveryGoalKey(goal);
    if (seenDescriptions.has(key)) continue;
    seenDescriptions.add(key);
    goals.push(attachDiscoveryGoalRefs(goal, journeys, coveragePlan));
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

  return {
    ...out,
    v: out.v === 2 || surfaces.length > 0 || journeys.length > 0 ? 2 : 1,
    surfaces,
    journeys,
    ...(coveragePlan ? { coverage_plan: coveragePlan } : {}),
    ...(productUseContract ? { product_use_contract: productUseContract } : {}),
    goals: goals.map((goal, index) => ({ ...goal, id: `G${index + 1}` })),
  };
}

function normalizeProductUseContract(
  contract: ProductUseContract | undefined,
  journeys: DiscoveryJourney[],
): ProductUseContract | undefined {
  if (!contract) return undefined;
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  const userJobs = contract.user_jobs
    .filter((job) => job.title.trim() || job.expected_artifact.trim())
    .map((job, index) => {
      const { journey_id, ...rest } = job;
      return {
        ...rest,
        id: job.id || `PU${index + 1}`,
        ...(journey_id && journeyIds.has(journey_id) ? { journey_id } : {}),
        required_actions: uniqueNonEmptyStrings(job.required_actions),
        acceptable_evidence: uniqueNonEmptyStrings(job.acceptable_evidence),
        weak_evidence: uniqueNonEmptyStrings(job.weak_evidence),
      };
    });
  const normalized: ProductUseContract = {
    product_kinds: contract.product_kinds.length > 0 ? contract.product_kinds : ['unknown'],
    primary_value_loop: contract.primary_value_loop,
    core_artifacts: uniqueNonEmptyStrings(contract.core_artifacts),
    user_jobs: userJobs,
  };
  const hasContent =
    normalized.primary_value_loop.trim().length > 0 ||
    normalized.core_artifacts.length > 0 ||
    normalized.user_jobs.length > 0 ||
    normalized.product_kinds.some((kind) => kind !== 'unknown');
  return hasContent ? normalized : undefined;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeDiscoverySurfaces(surfaces: DiscoverySurface[]): DiscoverySurface[] {
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const out: DiscoverySurface[] = [];
  for (const surface of surfaces) {
    const key = `${surface.kind}|${surface.url}|${surface.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = usedIds.has(surface.id) ? `S${out.length + 1}` : surface.id;
    usedIds.add(id);
    out.push({ ...surface, id });
  }
  return out;
}

function normalizeDiscoveryJourneys(
  journeys: DiscoveryJourney[],
  surfaces: DiscoverySurface[],
): DiscoveryJourney[] {
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const out: DiscoveryJourney[] = [];
  for (const journey of journeys) {
    const key = journey.suggested_goal.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = usedIds.has(journey.id) ? `J${out.length + 1}` : journey.id;
    usedIds.add(id);
    out.push({
      ...journey,
      id,
      surface_ids: journey.surface_ids.filter((id) => surfaceIds.has(id)),
    });
  }
  return out;
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
): DiscoveryCoveragePlan | undefined {
  if (!plan && journeys.length === 0 && surfaces.length === 0) return undefined;
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const selected = plan?.selected_journey_ids.filter((id) => journeyIds.has(id)) ?? [];
  const selected_journey_ids =
    selected.length > 0
      ? selected
      : journeys.filter((j) => j.priority !== 'could').map((j) => j.id);
  const selectedSurfaceIds = new Set(
    journeys
      .filter((journey) => selected_journey_ids.includes(journey.id))
      .flatMap((journey) => journey.surface_ids),
  );
  const deferred = (
    plan?.deferred_surface_ids.length
      ? plan.deferred_surface_ids.filter((id) => surfaceIds.has(id))
      : surfaces.filter((surface) => surface.value === 'peripheral').map((surface) => surface.id)
  ).filter((id) => !selectedSurfaceIds.has(id));
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
  const matchingJourney =
    journeys.find(
      (journey) =>
        selected.has(journey.id) &&
        (normalizedGoal.includes(journey.title.toLowerCase()) ||
          journey.suggested_goal.toLowerCase().includes(normalizedGoal.slice(0, 60)) ||
          normalizedGoal.includes(journey.suggested_goal.toLowerCase().slice(0, 60))),
    ) ?? journeys.find((journey) => selected.has(journey.id));
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

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const out = DiscoveryOutputSchema.parse(parsed);
    const normalized = normalizeDiscoveryOutput(
      out,
      `${inputs.observation_summary}\n${inputs.survey_summary ?? ''}\n${surveyPayloadSummary}`,
      extractSurveySurfaces(inputs.survey_payload),
    );
    return { output: normalized, cost_usd: cost };
  } catch {
    return null;
  }
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
  if (/search|form|content|article|table/.test(text)) return 'core';
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

export function formatDiscoveryExplorerContext(out: DiscoveryOutput): string {
  const lines: string[] = [];
  if (out.product_use_contract) {
    const contract = out.product_use_contract;
    lines.push('PRODUCT USE CONTRACT:');
    if (contract.product_kinds.length > 0) {
      lines.push(`- product kinds: ${contract.product_kinds.join(', ')}`);
    }
    if (contract.primary_value_loop) {
      lines.push(`- primary value loop: ${contract.primary_value_loop}`);
    }
    if (contract.core_artifacts.length > 0) {
      lines.push(`- core artifacts/state changes: ${contract.core_artifacts.join('; ')}`);
    }
    for (const job of contract.user_jobs.slice(0, 8)) {
      lines.push(
        `- ${job.id}${job.journey_id ? ` (${job.journey_id})` : ''}: ${job.title}; required actions: ${job.required_actions.join(', ') || 'normal user actions'}; expected artifact/state: ${job.expected_artifact || 'visible outcome'}`,
      );
      if (job.acceptable_evidence.length > 0) {
        lines.push(`  acceptable evidence: ${job.acceptable_evidence.join('; ')}`);
      }
      if (job.weak_evidence.length > 0) {
        lines.push(`  weak evidence that must NOT verify: ${job.weak_evidence.join('; ')}`);
      }
    }
  }
  if (out.surfaces.length > 0) {
    lines.push('DISCOVERED SURFACES:');
    for (const surface of out.surfaces.slice(0, 24)) {
      lines.push(
        `- ${surface.id} [${surface.value}/${surface.kind}/${surface.source}]: ${surface.label}`,
      );
    }
  }
  if (out.journeys.length > 0) {
    lines.push('SELECTED USER JOURNEYS:');
    const selected = new Set(out.coverage_plan?.selected_journey_ids ?? []);
    for (const journey of out.journeys.slice(0, 18)) {
      const marker = selected.has(journey.id) ? 'selected' : 'deferred';
      lines.push(
        `- ${journey.id} [${marker}/${journey.priority}]: ${journey.title} -> ${journey.suggested_goal}`,
      );
    }
  }
  const deferredIds = out.coverage_plan?.deferred_surface_ids ?? [];
  if (deferredIds.length > 0) {
    const labels = new Map(out.surfaces.map((surface) => [surface.id, surface.label]));
    lines.push(
      `DEFERRED SURFACES: ${deferredIds
        .slice(0, 20)
        .map((id) => `${id}${labels.get(id) ? ` (${labels.get(id)})` : ''}`)
        .join(', ')}`,
    );
  }
  if (out.coverage_plan?.rationale) {
    lines.push(`DISCOVERY COVERAGE RATIONALE: ${out.coverage_plan.rationale}`);
  }
  return lines.join('\n').slice(0, 5000);
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
