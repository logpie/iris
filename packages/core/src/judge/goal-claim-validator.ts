// Phase 9: goal-claim validator. The companion to evidence-validator, but
// for goal_status: verified claims instead of findings.
//
// Why this exists: the Excalidraw audit (2026-05-10) showed the Judge
// claiming `verified` for "draw a rectangle" when the canvas was empty in
// every screenshot. The Explorer used a single click instead of click-drag;
// the Judge cited "properties panel appeared" (a side-effect of tool
// selection) as proof. Phase 5's evidence-validator only inspects findings;
// goal_status claims bypassed it entirely.
//
// The validator is rule-based, no LLM. For each goal the Judge marks
// `verified`:
//   1. Window the trace events for that goal (from goal start to its
//      goal_status event).
//   2. Ask the adapter's OutcomeContract for outcome-shaped artifacts.
//   3. Check the Judge's `evidence` array cites at least one of those
//      artifacts (by file ref OR trace event id).
//   4. If the rationale is dominated by side-effect language and no outcome
//      artifact is cited, downgrade verified → partial with a caveat.
//
// The adapter contract picks the artifacts; the validator picks the verdict.

import type { OutcomeContract, OutcomeContractTraceEvent } from '@iris/adapter-types';
import { scenarioProofVisibleTextTokens } from '../scenario/scenario-data.js';
import { resolveTraceRefTypo } from '../trace/ref-resolver.js';
import type { TraceEvent } from '../trace/schema.js';
import type { JudgeOutput } from './judge.js';

// Phrases that, if they appear in a rationale, are SIDE-EFFECT language. If
// the rationale is only side-effects with no outcome citation, we downgrade.
// Kept short and specific; we are looking for confident proof-by-side-effect.
const SIDE_EFFECT_PATTERNS: RegExp[] = [
  /panel\s+(appeared|opened|rendered|shown)/i,
  /tool\s+(was\s+)?(selected|chosen|activated|highlighted)/i,
  /properties\s+panel/i,
  /button\s+(was\s+)?(focused|highlighted)/i,
  /focus\s+(moved|shifted)/i,
  /(prompt|dialog|modal)\s+(appeared|opened|rendered)/i,
  /request\s+(returned|fired|sent)/i,
  /200\s+(ok|response|returned)/i,
];

export interface GoalClaimValidationOutput {
  goals: JudgeOutput['spec_compliance']['goals'];
  summary: {
    verified_kept: number;
    downgraded: number;
    downgrade_reasons: string[];
  };
}

export interface ValidateGoalClaimsInputs {
  judge: JudgeOutput;
  trace: TraceEvent[];
  outcome_contract?: OutcomeContract;
}

export function validateGoalClaims(input: ValidateGoalClaimsInputs): GoalClaimValidationOutput {
  const { judge, trace, outcome_contract } = input;
  const goals = judge.spec_compliance.goals;

  // If no contract is declared, skip validation — adapters opt in.
  if (!outcome_contract) {
    return {
      goals,
      summary: { verified_kept: 0, downgraded: 0, downgrade_reasons: [] },
    };
  }

  const goalWindows = sliceGoalWindows(trace, goals);
  const goalStatusInfo = latestGoalStatusInfo(trace, goals);
  const traceIndexById = new Map(trace.map((e, idx) => [e.id, idx]));
  let verifiedKept = 0;
  let downgraded = 0;
  const reasons: string[] = [];

  const next = goals.map((g) => {
    if (g.status !== 'verified' && g.status !== 'partial') return g;
    const wasPartial = g.status === 'partial';
    const statusInfo = goalStatusInfo.get(g.id);
    // Phase 14: every verified goal MUST have a notes field with substantive
    // explanation. Empty notes are how audit drift starts — verifications
    // get accepted without a paper trail tying claim to evidence. Downgrade
    // verified→partial when notes is empty/trivial. If the Judge wrote a
    // terse note but the Explorer's goal_status rationale is substantive, use
    // that trace-backed rationale as the audit note instead of downgrading.
    const notes = (g.notes ?? '').trim();
    const statusRationale = (statusInfo?.rationale ?? '').trim();
    const noteBackfill = notes.length < 20 && statusRationale.length >= 20 ? statusRationale : '';
    if (notes.length < 20 && !noteBackfill) {
      if (wasPartial) return g;
      downgraded++;
      const reason = `${g.id}: verified without substantive notes (mandatory under Phase 14)`;
      reasons.push(reason);
      const caveat = '[goal-claim validator: missing audit notes]';
      return {
        ...g,
        status: 'partial' as const,
        notes: g.notes ? `${g.notes} ${caveat}` : caveat,
      };
    }
    const citedSet = collectCitedRefs({
      goal: g,
      trace,
      traceIndexById,
      statusInfo,
    });
    const window = goalWindows.get(g.id) ?? [];
    const productUseWindow = productUseWindowForCitedEvidence({
      trace,
      traceIndexById,
      citedRefs: citedSet,
      statusInfo,
      fallbackWindow: window,
    });
    const productUseCheck = evaluateProductUseContract({
      goal: g,
      trace,
      goalWindow: productUseWindow,
      statusRationale,
    });
    if (!productUseCheck.ok) {
      if (wasPartial) return g;
      downgraded++;
      reasons.push(`${g.id}: ${productUseCheck.reason}`);
      const caveat = `[goal-claim validator: ${productUseCheck.reason}]`;
      return {
        ...g,
        status: 'partial' as const,
        notes: g.notes ? `${g.notes} ${caveat}` : caveat,
      };
    }
    const artifacts = [
      ...outcome_contract.collectOutcomeEvidence({
        goal: { id: g.id, description: g.description },
        goal_events: window,
      }),
      ...collectCitedOutcomeEvidence({
        goal: g,
        citedRefs: citedSet,
        trace,
        traceIndexById,
        statusInfo,
        outcome_contract,
      }),
    ];
    const uniqueArtifacts = uniqueArtifactsByRef(artifacts);
    const cited = uniqueArtifacts.some((a) => citedSet.has(a.ref));
    const hasSideEffectOnly =
      !cited &&
      ((g.notes && SIDE_EFFECT_PATTERNS.some((p) => p.test(g.notes ?? ''))) ||
        // Also downgrade when there's no outcome artifact available at all —
        // means the goal window contained no interaction or no post-interaction
        // observation. Indistinguishable from "agent didn't really do it."
        uniqueArtifacts.length === 0);

    if (cited) {
      verifiedKept++;
      if (wasPartial) {
        const upgradeNote = '[goal-claim validator: partial upgraded after cited outcome evidence satisfied the product-use contract]';
        return {
          ...g,
          status: 'verified' as const,
          notes: notes ? `${notes} ${upgradeNote}` : upgradeNote,
        };
      }
      return noteBackfill
        ? {
            ...g,
            notes: notes ? `${notes} Explorer rationale: ${noteBackfill}` : noteBackfill,
          }
        : g;
    }
    if (hasSideEffectOnly || uniqueArtifacts.length === 0) {
      if (wasPartial) return g;
      downgraded++;
      const reason =
        uniqueArtifacts.length === 0
          ? `${g.id}: no outcome-shaped evidence in goal window`
          : `${g.id}: rationale cites side-effects only; no outcome artifact cited`;
      reasons.push(reason);
      const caveat = '[goal-claim validator: outcome not confirmed]';
      return {
        ...g,
        status: 'partial' as const,
        notes: g.notes ? `${g.notes} ${caveat}` : caveat,
      };
    }
    // Outcome artifacts exist but the Judge did not cite them. Treat as
    // downgrade — Judge needs to cite outcome to claim verified.
    if (wasPartial) return g;
    downgraded++;
    reasons.push(`${g.id}: outcome artifacts exist but none cited in evidence`);
    const caveat = '[goal-claim validator: outcome artifact uncited]';
    return {
      ...g,
      status: 'partial' as const,
      notes: g.notes ? `${g.notes} ${caveat}` : caveat,
    };
  });

  return {
    goals: next,
    summary: { verified_kept: verifiedKept, downgraded, downgrade_reasons: reasons },
  };
}

interface ProductUseJobLike {
  id?: string;
  title?: string;
  value_loop_id?: string;
  journey_id?: string;
  scenario_brief?: string;
  test_data?: string[];
  required_actions?: string[];
  proof_obligations?: string[];
  expected_artifact?: string;
  required_outputs?: string[];
  quality_bar?: string[];
  acceptable_evidence?: string[];
  weak_evidence?: string[];
}

interface ProductUseValueLoopLike {
  id?: string;
  title?: string;
  artifact?: string;
  required_capabilities?: string[];
  proof_obligations?: string[];
  weak_evidence?: string[];
}

interface ProductUseContractLike {
  product_kinds?: string[];
  primary_value_loop?: string;
  core_artifacts?: string[];
  value_loops?: ProductUseValueLoopLike[];
  user_jobs?: ProductUseJobLike[];
}

const PRODUCT_USE_CITATION_LOOKBACK_EVENTS = 80;

function productUseWindowForCitedEvidence(input: {
  trace: TraceEvent[];
  traceIndexById: Map<string, number>;
  citedRefs: Set<string>;
  statusInfo: GoalStatusInfo | undefined;
  fallbackWindow: OutcomeContractTraceEvent[];
}): OutcomeContractTraceEvent[] {
  if (!input.statusInfo || input.citedRefs.size === 0) return input.fallbackWindow;
  const statusInfo = input.statusInfo;
  const citedIndices = Array.from(input.citedRefs)
    .map((ref) => input.traceIndexById.get(ref))
    .filter((idx): idx is number => idx !== undefined && idx <= statusInfo.idx);
  if (citedIndices.length === 0) return input.fallbackWindow;
  const maxCitedIdx = Math.max(...citedIndices);
  const start = Math.max(0, maxCitedIdx - PRODUCT_USE_CITATION_LOOKBACK_EVENTS);
  const citationWindow = input.trace
    .slice(start, maxCitedIdx + 1)
    .filter((event) => sessionIdOf(event) === statusInfo.session_id)
    .map(toContractEvent);
  if (citationWindow.length === 0) return input.fallbackWindow;

  const out: OutcomeContractTraceEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...input.fallbackWindow, ...citationWindow]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}

function evaluateProductUseContract(input: {
  goal: JudgeOutput['spec_compliance']['goals'][number];
  trace: TraceEvent[];
  goalWindow: OutcomeContractTraceEvent[];
  statusRationale: string;
}): { ok: true } | { ok: false; reason: string } {
  const contract = latestProductUseContract(input.trace);
  if (!contract) return { ok: true };
  const discoveryGoal = latestDiscoveryGoal(input.trace, input.goal.id);
  const job = productUseJobForGoal(contract, input.goal, discoveryGoal?.journey_id);
  if (!job) return { ok: true };
  const loop = productUseValueLoopForJob(contract, job);
  const jobActions = job.required_actions ?? [];
  const requiredActions = requiredActionsForProductUseJob({
    job,
    loop,
    actions: uniqueStrings(
      jobActions.length > 0 ? jobActions : (loop?.required_capabilities ?? []),
    ),
  });
  const missingActions = requiredActionsMissing(requiredActions, input.goalWindow);
  if (missingActions.length > 0) {
    return {
      ok: false,
      reason: `product-use contract missing required actions: ${missingActions.join(', ')}`,
    };
  }
  const claimText = `${input.goal.notes ?? ''}\n${input.statusRationale}`;
  const proofText = `${input.goal.description}\n${claimText}`;
  const weakProof = matchingWeakEvidence(
    [
      ...(loop?.weak_evidence ?? []),
      ...(job.weak_evidence ?? []),
      ...genericWeakEvidencePhrases(contract),
    ],
    claimText,
  );
  if (weakProof && !hasOutcomeLanguage(claimText)) {
    return { ok: false, reason: `product-use contract rejected weak evidence: ${weakProof}` };
  }
  const materiality = evaluateMaterialityFloor({
    contract,
    job,
    loop,
    goalWindow: input.goalWindow,
    proofText,
    claimText,
  });
  if (!materiality.ok) return materiality;
  const scenarioProof = evaluateScenarioSpecificProof({
    job,
    goalWindow: input.goalWindow,
  });
  if (!scenarioProof.ok) return scenarioProof;
  return { ok: true };
}

function requiredActionsForProductUseJob(input: {
  job: ProductUseJobLike;
  loop: ProductUseValueLoopLike | undefined;
  actions: string[];
}): string[] {
  const jobIntentText = specificProductUseJobIntent(input.job, input.loop);
  if (isArtifactMediaImportJob(jobIntentText)) {
    return input.actions.filter((action) => !isGenericArtifactRevisionRequirement(action));
  }
  if (!isArtifactStateRevisionJob(jobIntentText)) return input.actions;
  return input.actions.filter((action) => !isGenericArtifactCompositionRequirement(action));
}

function specificProductUseJobIntent(
  job: ProductUseJobLike,
  _loop: ProductUseValueLoopLike | undefined,
): string {
  return normalizeText(
    [
      job.title ?? '',
      job.scenario_brief ?? '',
      job.expected_artifact ?? '',
      ...(job.test_data ?? []),
      ...(job.proof_obligations ?? []),
      ...(job.required_outputs ?? []),
      ...(job.quality_bar ?? []),
      ...(job.acceptable_evidence ?? []),
    ].join(' '),
  );
}

function isGenericArtifactRevisionRequirement(action: string): boolean {
  const text = normalizeText(action);
  return (
    /\bstart from an existing artifact or object\b/.test(text) ||
    /\bperform a visible edit history duplicate delete undo redo or arrangement action\b/.test(
      text,
    ) ||
    /\binspect the artifact state after the action\b/.test(text)
  );
}

function isGenericArtifactCompositionRequirement(action: string): boolean {
  const text = normalizeText(action);
  return (
    /\badd readable text\b/.test(text) ||
    /\b(label|connector|media|second object)\b/.test(text) ||
    /\bmodify an existing object with style size position or structure change\b/.test(text)
  );
}

function latestProductUseContract(trace: TraceEvent[]): ProductUseContractLike | undefined {
  for (let i = trace.length - 1; i >= 0; i--) {
    const event = trace[i];
    if (!event || event.kind !== 'discovery') continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const contract = payload.product_use_contract;
    if (contract && typeof contract === 'object') return contract as ProductUseContractLike;
  }
  return undefined;
}

function latestDiscoveryGoal(
  trace: TraceEvent[],
  goalId: string,
): { id?: string; journey_id?: string; description?: string } | undefined {
  for (let i = trace.length - 1; i >= 0; i--) {
    const event = trace[i];
    if (!event || event.kind !== 'discovery') continue;
    const payload = (event.payload ?? {}) as { goals?: unknown };
    if (!Array.isArray(payload.goals)) continue;
    const goal = payload.goals.find((candidate) => {
      return (
        candidate &&
        typeof candidate === 'object' &&
        String((candidate as { id?: unknown }).id ?? '') === goalId
      );
    });
    return goal as { id?: string; journey_id?: string; description?: string } | undefined;
  }
  return undefined;
}

function productUseJobForGoal(
  contract: ProductUseContractLike,
  goal: JudgeOutput['spec_compliance']['goals'][number],
  journeyId: string | undefined,
): ProductUseJobLike | undefined {
  const jobs = contract.user_jobs ?? [];
  if (journeyId) {
    const byJourney = jobs.find((job) => job.journey_id === journeyId);
    if (byJourney) return byJourney;
  }
  const normalizedGoal = normalizeText(`${goal.id} ${goal.description}`);
  return jobs.find((job) => {
    const candidate = normalizeText(
      `${job.id ?? ''} ${job.title ?? ''} ${job.expected_artifact ?? ''}`,
    );
    return (
      candidate.length > 0 &&
      (normalizedGoal.includes(candidate) || candidate.includes(normalizedGoal.slice(0, 80)))
    );
  });
}

function productUseValueLoopForJob(
  contract: ProductUseContractLike,
  job: ProductUseJobLike,
): ProductUseValueLoopLike | undefined {
  const loops = contract.value_loops ?? [];
  if (job.value_loop_id) {
    const byId = loops.find((loop) => loop.id === job.value_loop_id);
    if (byId) return byId;
  }
  if (loops.length === 1) return loops[0];
  return undefined;
}

function evaluateMaterialityFloor(input: {
  contract: ProductUseContractLike;
  job: ProductUseJobLike;
  loop: ProductUseValueLoopLike | undefined;
  goalWindow: OutcomeContractTraceEvent[];
  proofText: string;
  claimText: string;
}): { ok: true } | { ok: false; reason: string } {
  const kinds = input.contract.product_kinds ?? [];
  const requiredJobActions = (input.job.required_actions ?? []).filter(
    (action) => !isOptionalRequiredAction(action.toLowerCase()),
  );
  const filteredJobActions = requiredActionsForProductUseJob({
    job: input.job,
    loop: input.loop,
    actions: requiredJobActions,
  });
  const jobRequirementText = normalizeText(
    [specificProductUseJobIntent(input.job, input.loop), ...filteredJobActions].join(' '),
  );
  const loopRequirementText = normalizeText(
    [
      input.loop?.title ?? '',
      input.loop?.artifact ?? '',
      ...(input.loop?.required_capabilities ?? []),
      ...(input.loop?.proof_obligations ?? []),
    ].join(' '),
  );
  const requirementText = normalizeText([jobRequirementText, loopRequirementText].join(' '));
  const classificationText = jobRequirementText || loopRequirementText || requirementText;
  if (!isArtifactEditorPrimaryJob(kinds, classificationText)) return { ok: true };

  const required = materialityCategories(jobRequirementText || requirementText);
  const observed = observedMaterialityCategories(input.goalWindow, input.proofText);
  if (isArtifactMediaImportJob(classificationText)) {
    if (!observed.has('create') || !observed.has('media')) {
      return {
        ok: false,
        reason:
          'product-use contract materiality floor not met: media import evidence is too shallow',
      };
    }
    return { ok: true };
  }
  if (isArtifactStateRevisionJob(classificationText)) {
    const proof = normalizeText(input.proofText);
    const hasArtifactContext =
      observed.has('create') ||
      /\b(canvas|board|document|artifact|object|shape|note|text|media|image|row|content)\b/.test(
        proof,
      );
    const hasRevisionAction =
      observed.has('manipulate') ||
      /\b(duplicate|duplicated|delete|deleted|remove|removed|undo|redo|history|revised|revision|arrange|arranged|move|moved|resize|resized|object count|state)\b/.test(
        proof,
      );
    const hasStateOutcome =
      hasOutcomeLanguage(input.proofText) ||
      /\b(object count|arrangement|position|state|changed|changes|visible delta|appeared|disappeared|persisted|after the action)\b/.test(
        proof,
      );
    if (!hasArtifactContext || !hasRevisionAction || !hasStateOutcome) {
      return {
        ok: false,
        reason:
          'product-use contract materiality floor not met: artifact revision evidence is too shallow',
      };
    }
    return { ok: true };
  }
  if (isNonDefaultShapeJob(classificationText)) {
    const claim = normalizeText(input.claimText);
    if (!hasConcreteNonDefaultShapeOutcome(claim)) {
      return {
        ok: false,
        reason:
          'product-use contract materiality floor not met: non-default shape evidence is too shallow',
      };
    }
  }
  const hasCreate = observed.has('create');
  const hasComposition =
    observed.has('text') ||
    observed.has('style') ||
    observed.has('manipulate') ||
    observed.has('media') ||
    observed.has('connector') ||
    observed.has('export') ||
    observed.has('share');
  if (!hasCreate || !hasComposition) {
    return {
      ok: false,
      reason: 'product-use contract materiality floor not met: artifact evidence is too shallow',
    };
  }

  const missing = Array.from(required).filter((category) => !observed.has(category));
  const materialMissing = missing.filter((category) =>
    ['text', 'style', 'manipulate', 'media', 'connector'].includes(category),
  );
  if (materialMissing.length > 0 && observed.size < 3) {
    return {
      ok: false,
      reason: `product-use contract materiality floor missing: ${materialMissing.join(', ')}`,
    };
  }
  return { ok: true };
}

function evaluateScenarioSpecificProof(input: {
  job: ProductUseJobLike;
  goalWindow: OutcomeContractTraceEvent[];
}): { ok: true } | { ok: false; reason: string } {
  const requiredData = scenarioProofVisibleData(input.job);
  if (requiredData.length === 0) return { ok: true };

  const observed = observedUserVisibleScenarioText(input.goalWindow);
  if (!observed) {
    return {
      ok: false,
      reason: 'scenario-specific proof missing: no user-visible evidence text was captured',
    };
  }
  const missing = requiredData.filter((item) => !observed.includes(normalizeText(item)));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `scenario-specific proof missing required content: ${missing.join(', ')}`,
    };
  }
  return { ok: true };
}

function scenarioProofVisibleData(job: ProductUseJobLike): string[] {
  const requiredOutputData = scenarioProofVisibleTextTokens(job.required_outputs ?? []);
  if (requiredOutputData.length > 0) return requiredOutputData;
  return scenarioProofVisibleTextTokens(job.test_data ?? []);
}

function observedUserVisibleScenarioText(goalWindow: OutcomeContractTraceEvent[]): string {
  const chunks: string[] = [];
  for (const event of goalWindow) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.kind === 'observation') {
      chunks.push(String(payload.summary ?? ''));
      const rich = payload.rich_content;
      if (Array.isArray(rich)) {
        for (const entry of rich) {
          if (entry && typeof entry === 'object') {
            chunks.push(String((entry as { text?: unknown }).text ?? ''));
          }
        }
      }
      const perception = payload.perception_state;
      if (perception && typeof perception === 'object') {
        const elements = (perception as { elements?: unknown }).elements;
        if (Array.isArray(elements)) {
          for (const element of elements.slice(0, 80)) {
            if (!element || typeof element !== 'object') continue;
            const e = element as { name?: unknown; text?: unknown };
            chunks.push(String(e.name ?? ''));
            chunks.push(String(e.text ?? ''));
          }
        }
      }
    }
    if (event.kind === 'action_result' && typeof payload.description === 'string') {
      chunks.push(payload.description);
    }
    if (event.kind === 'probe_result') {
      chunks.push(String(payload.probe ?? ''));
      chunks.push(String(payload.summary ?? ''));
      const data = payload.data;
      if (data && typeof data === 'object') {
        const d = data as {
          visibleText?: unknown;
          text_sample?: unknown;
          outline_sample?: unknown;
          selectors?: unknown;
          activeElement?: unknown;
        };
        chunks.push(String(d.visibleText ?? ''));
        chunks.push(String(d.text_sample ?? ''));
        chunks.push(String(d.outline_sample ?? ''));
        if (Array.isArray(d.selectors)) {
          for (const selector of d.selectors.slice(0, 80)) {
            if (!selector || typeof selector !== 'object') continue;
            const s = selector as {
              selector?: unknown;
              name?: unknown;
              text?: unknown;
              value?: unknown;
            };
            chunks.push(String(s.selector ?? ''));
            chunks.push(String(s.name ?? ''));
            chunks.push(String(s.text ?? ''));
            chunks.push(String(s.value ?? ''));
          }
        }
        if (d.activeElement && typeof d.activeElement === 'object') {
          const active = d.activeElement as { name?: unknown; text?: unknown; value?: unknown };
          chunks.push(String(active.name ?? ''));
          chunks.push(String(active.text ?? ''));
          chunks.push(String(active.value ?? ''));
        }
      }
    }
  }
  return normalizeText(chunks.join(' '));
}

function isArtifactStateRevisionJob(text: string): boolean {
  return /\b(duplicate|delete|deleted|remove|removed|undo|redo|history|revision|revise|revised|object count|arrange|arrangement|board state|document state|state change|state changes|copy|paste)\b/.test(
    text,
  );
}

function isArtifactMediaImportJob(text: string): boolean {
  return /\b(media|image|video|upload|embed|file|import)\b/.test(text);
}

function isNonDefaultShapeJob(text: string): boolean {
  return /\b(non default shape|shape library|shape picker|more shapes|diamond|cloud|ellipse|triangle|star|heart|hexagon|oval|rhombus|x box|check box)\b/.test(
    text,
  );
}

function hasConcreteNonDefaultShapeOutcome(text: string): boolean {
  return /\b(ellipse|triangle|diamond|hexagon|cloud|star|heart|oval|rhombus|x box|check box)\b/.test(
    text,
  );
}

function isArtifactEditorPrimaryJob(kinds: string[], text: string): boolean {
  if (
    !(
      kinds.includes('canvas_editor') ||
      kinds.includes('document_editor') ||
      kinds.includes('media_tool')
    )
  ) {
    return false;
  }
  if (/\b(export|download|share|collaborat|invite|sign in|sign up|login|auth)\b/.test(text)) {
    return false;
  }
  return /\b(artifact|canvas|board|document|diagram|draw|shape|text|paragraph|media|edit|style|format|move|resize|create|place)\b/.test(
    text,
  );
}

type MaterialityCategory =
  | 'create'
  | 'text'
  | 'style'
  | 'manipulate'
  | 'media'
  | 'connector'
  | 'export'
  | 'share';

function materialityCategories(text: string): Set<MaterialityCategory> {
  const out = new Set<MaterialityCategory>();
  if (
    /\b(create|created|add|added|draw|drawn|place|placed|insert|object|shape|artifact|canvas|board|document|paragraph|media)\b/.test(
      text,
    )
  ) {
    out.add('create');
  }
  if (/\b(text|label|note|paragraph|readable|type|typed|write|written|heading)\b/.test(text)) {
    out.add('text');
  }
  if (/\b(style|styled|color|fill|stroke|dash|opacity|format|bold|italic|font)\b/.test(text)) {
    out.add('style');
  }
  if (
    /\b(move|moved|resize|resized|size|position|duplicate|delete|deleted|remove|removed|undo|redo|group|arrange|edit|edited|modify|modified)\b/.test(
      text,
    )
  ) {
    out.add('manipulate');
  }
  if (/\b(media|image|video|upload|embed|file)\b/.test(text)) out.add('media');
  if (/\b(arrow|connector|line|link|connected|connection)\b/.test(text)) out.add('connector');
  if (/\b(export|download|save|output)\b/.test(text)) out.add('export');
  if (/\b(share|collaborat|invite|permission)\b/.test(text)) out.add('share');
  return out;
}

function observedMaterialityCategories(
  goalWindow: OutcomeContractTraceEvent[],
  proofText: string,
): Set<MaterialityCategory> {
  const out = materialityCategories(normalizeText(proofText));
  for (const event of goalWindow) {
    if (event.kind !== 'action_result') continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.ok !== true) continue;
    const tool = String(payload.tool ?? '');
    if (tool === 'drag' || tool === 'vision_drag') {
      out.add('create');
      out.add('manipulate');
    }
    if (tool === 'type' || tool === 'paste' || tool === 'vision_paste') {
      out.add('create');
      out.add('text');
    }
    if (tool === 'upload' || tool === 'click_upload') {
      out.add('create');
      out.add('media');
    }
    if (tool === 'click_download') {
      out.add('export');
    }
  }
  return out;
}

function requiredActionsMissing(
  requiredActions: string[],
  goalWindow: OutcomeContractTraceEvent[],
): string[] {
  const normalizedRequired = requiredActions
    .map((action) => action.toLowerCase())
    .filter((action) => !isOptionalRequiredAction(action));
  const missing: string[] = [];
  for (const required of normalizedRequired) {
    const toolSet = requiredActionTools(required);
    if (toolSet.length === 0) continue;
    if (!goalWindow.some((event) => successfulActionTool(event, toolSet))) missing.push(required);
  }
  return missing;
}

function isOptionalRequiredAction(requiredAction: string): boolean {
  return /\b(optional|optionally|if available|when available|where available|if exposed|when exposed)\b/.test(
    requiredAction,
  );
}

function requiredActionTools(requiredAction: string): string[] {
  if (/\b(vision[_ -]?drag|drag|draw|sketch|resize|move\s+object)\b/.test(requiredAction)) {
    return ['drag', 'vision_drag'];
  }
  if (/\b(style|color|fill|dash|stroke|size|opacity|font|align)\b/.test(requiredAction)) {
    return ['click', 'vision_click', 'select_option', 'drag', 'vision_drag', 'press', 'key_chord'];
  }
  if (/\b(type|enter|write|text|input|query|fill)\b/.test(requiredAction)) {
    return ['type', 'paste', 'vision_paste', 'press', 'key_chord'];
  }
  if (
    /\b(duplicate|delete|remove|undo|redo|copy|cut|move|resize|edit|modify|group|arrange)\b/.test(
      requiredAction,
    )
  ) {
    return [
      'click',
      'vision_click',
      'double_click',
      'vision_double_click',
      'right_click',
      'vision_right_click',
      'press',
      'key_chord',
      'drag',
      'vision_drag',
    ];
  }
  if (/\b(create|place|draw|sketch|object|shape|artifact|content)\b/.test(requiredAction)) {
    return [
      'drag',
      'vision_drag',
      'click',
      'vision_click',
      'double_click',
      'vision_double_click',
      'type',
      'paste',
      'vision_paste',
      'upload',
      'click_upload',
    ];
  }
  if (/\b(export|download|submit|save|publish|send|share|confirm|create)\b/.test(requiredAction)) {
    return [
      'click',
      'vision_click',
      'double_click',
      'vision_double_click',
      'press',
      'key_chord',
      'click_download',
    ];
  }
  if (/\b(upload|media|file)\b/.test(requiredAction)) {
    if (
      /\b(select|choose|click|open|pick|activate|invoke|toggle|menu|button|link|start|initiat)\b/.test(
        requiredAction,
      )
    ) {
      return [
        'click',
        'vision_click',
        'double_click',
        'vision_double_click',
        'press',
        'key_chord',
        'upload',
        'click_upload',
      ];
    }
    return ['upload', 'click_upload'];
  }
  if (
    /\b(select|choose|click|open|pick|activate|invoke|toggle|menu|button|link)\b/.test(
      requiredAction,
    )
  ) {
    return [
      'click',
      'vision_click',
      'double_click',
      'vision_double_click',
      'select_option',
      'press',
      'key_chord',
    ];
  }
  if (/\b(filter|sort|slider|range)\b/.test(requiredAction)) {
    return ['click', 'vision_click', 'select_option', 'drag', 'vision_drag', 'press', 'key_chord'];
  }
  return [];
}

function successfulActionTool(event: OutcomeContractTraceEvent, tools: string[]): boolean {
  if (event.kind !== 'action_result') return false;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return payload.ok === true && tools.includes(String(payload.tool ?? ''));
}

function matchingWeakEvidence(weakEvidence: string[], text: string): string | undefined {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return undefined;
  for (const weak of weakEvidence) {
    const normalizedWeak = normalizeText(weak);
    if (normalizedWeak.length >= 4 && normalizedText.includes(normalizedWeak)) return weak;
  }
  return undefined;
}

function hasOutcomeLanguage(text: string): boolean {
  const normalized = normalizeText(text);
  const outcomeVerb =
    /\b(visible|visibly|created|drew|drawn|placed|added|appeared|updated|changed|loaded|opened|exported|downloaded|authenticated)\b/.test(
      normalized,
    );
  const outcomeObject =
    /\b(canvas|object|artifact|rectangle|content|board|dialog|surface|page|flow|panel|result|record|chart|table|cart|account|style|color|fill|stroke)\b/.test(
      normalized,
    );
  return outcomeVerb && outcomeObject;
}

function genericWeakEvidencePhrases(contract: ProductUseContractLike): string[] {
  const kinds = contract.product_kinds ?? [];
  const generic = [
    'toolbar selected',
    'tool selected',
    'mode activated',
    'button highlighted',
    'focus moved',
  ];
  if (kinds.includes('canvas_editor') || kinds.includes('document_editor')) {
    return [...generic, 'properties panel opened', 'tool palette activates'];
  }
  if (kinds.includes('search_content'))
    return [...generic, 'search box visible', 'homepage loaded'];
  if (kinds.includes('crud_workflow')) return [...generic, 'form opened', 'modal opened'];
  if (kinds.includes('dashboard_filtering')) return [...generic, 'filter menu opened'];
  return generic;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface GoalStatusInfo {
  idx: number;
  session_id: string;
  rationale: string;
}

function latestGoalStatusInfo(
  trace: TraceEvent[],
  goals: JudgeOutput['spec_compliance']['goals'],
): Map<string, GoalStatusInfo> {
  const out = new Map<string, GoalStatusInfo>();
  const goalIdSet = new Set(goals.map((g) => g.id));
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (!e || e.kind !== 'goal_status') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const gid = String(p.id ?? '');
    if (!gid || !goalIdSet.has(gid)) continue;
    const rationale =
      typeof p.rationale === 'string' && p.rationale.trim().length > 0 ? p.rationale : '';
    out.set(gid, { idx: i, session_id: sessionIdOf(e), rationale });
  }
  return out;
}

function collectCitedRefs(input: {
  goal: JudgeOutput['spec_compliance']['goals'][number];
  trace: TraceEvent[];
  traceIndexById: Map<string, number>;
  statusInfo: GoalStatusInfo | undefined;
}): Set<string> {
  const cited = new Set<string>();
  for (const ref of input.goal.evidence ?? []) {
    cited.add(
      resolveTraceRefTypo(ref, input.trace, input.traceIndexById, {
        maxIdx: input.statusInfo?.idx,
      }) ?? ref,
    );
  }
  if (!input.statusInfo) return cited;

  for (const ref of Array.from(cited)) {
    const idx = input.traceIndexById.get(ref);
    if (idx === undefined || idx > input.statusInfo.idx) continue;
    const event = input.trace[idx];
    if (!event || event.kind !== 'goal_status') continue;
    if (sessionIdOf(event) !== input.statusInfo.session_id) continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (String(payload.id ?? '') !== input.goal.id) continue;
    const evidenceEventIds = Array.isArray(payload.evidence_event_ids)
      ? payload.evidence_event_ids
      : [];
    for (const evidenceRef of evidenceEventIds) {
      if (typeof evidenceRef === 'string' && evidenceRef) cited.add(evidenceRef);
    }
  }

  return cited;
}

function collectCitedOutcomeEvidence(input: {
  goal: JudgeOutput['spec_compliance']['goals'][number];
  citedRefs: Set<string>;
  trace: TraceEvent[];
  traceIndexById: Map<string, number>;
  statusInfo: GoalStatusInfo | undefined;
  outcome_contract: OutcomeContract;
}): ReturnType<OutcomeContract['collectOutcomeEvidence']> {
  const statusInfo = input.statusInfo;
  if (!statusInfo) return [];
  const out: ReturnType<OutcomeContract['collectOutcomeEvidence']> = [];
  for (const ref of input.citedRefs) {
    const evidenceIdx = input.traceIndexById.get(ref);
    if (evidenceIdx === undefined || evidenceIdx > statusInfo.idx) continue;
    const evidenceEvent = input.trace[evidenceIdx];
    if (!evidenceEvent || sessionIdOf(evidenceEvent) !== statusInfo.session_id) continue;
    // App Server explorers can finish goals out of order and emit goal_status
    // calls in a later batch. The sequential window then excludes the cited
    // post-action observation even though the citation is valid and predates
    // the goal_status. Re-run the adapter contract on the same-session prefix
    // ending at the cited event, then accept only the artifact that was cited.
    const prefix = input.trace
      .slice(0, evidenceIdx + 1)
      .filter((e) => sessionIdOf(e) === statusInfo.session_id)
      .map(toContractEvent);
    const artifacts = input.outcome_contract.collectOutcomeEvidence({
      goal: { id: input.goal.id, description: input.goal.description },
      goal_events: prefix,
    });
    out.push(...artifacts.filter((a) => a.ref === ref));
  }
  return out;
}

function uniqueArtifactsByRef(
  artifacts: ReturnType<OutcomeContract['collectOutcomeEvidence']>,
): ReturnType<OutcomeContract['collectOutcomeEvidence']> {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.ref)) return false;
    seen.add(artifact.ref);
    return true;
  });
}

// Slice trace events into per-goal windows. A goal's window starts at the
// first event after the previous goal's goal_status in the same session (or
// session trace start), and ends at this goal's goal_status event (inclusive).
//
// This is approximate — the Explorer doesn't tag every event with goal_id.
// Parallel Agent SDK runs do tag merged events with payload.session_id; using
// that keeps unrelated sessions' goal_status events from truncating each
// other's outcome windows.
export function sliceGoalWindows(
  trace: TraceEvent[],
  goals: JudgeOutput['spec_compliance']['goals'],
): Map<string, OutcomeContractTraceEvent[]> {
  const out = new Map<string, OutcomeContractTraceEvent[]>();
  // Build an ordered list of goal_status events keyed by goal id.
  const goalIdSet = new Set(goals.map((g) => g.id));
  const goalStatusIdx: Array<{ idx: number; id: string; session_id: string }> = [];
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (!e || e.kind !== 'goal_status') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const gid = String(p.id ?? '');
    if (!gid || !goalIdSet.has(gid)) continue;
    goalStatusIdx.push({ idx: i, id: gid, session_id: sessionIdOf(e) });
  }
  const lastEndBySession = new Map<string, number>();
  for (const { idx, id, session_id } of goalStatusIdx) {
    const lastEnd = lastEndBySession.get(session_id) ?? -1;
    const window = trace
      .slice(lastEnd + 1, idx + 1)
      .filter((e) => sessionIdOf(e) === session_id)
      .map(toContractEvent);
    out.set(id, mergeContractEventWindows(out.get(id) ?? [], window));
    lastEndBySession.set(session_id, idx);
  }
  // Goals with no goal_status event in the trace get an empty window.
  for (const g of goals) {
    if (!out.has(g.id)) out.set(g.id, []);
  }
  return out;
}

function mergeContractEventWindows(
  prev: OutcomeContractTraceEvent[],
  next: OutcomeContractTraceEvent[],
): OutcomeContractTraceEvent[] {
  if (prev.length === 0) return next;
  if (next.length === 0) return prev;
  const seen = new Set<string>();
  const out: OutcomeContractTraceEvent[] = [];
  for (const event of [...prev, ...next]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}

function toContractEvent(e: TraceEvent): OutcomeContractTraceEvent {
  return { id: e.id, kind: e.kind, payload: e.payload };
}

function sessionIdOf(e: TraceEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return typeof p.session_id === 'string' && p.session_id ? p.session_id : '__default__';
}

export function applyGoalClaimValidationToJudgeOutput(
  judge: JudgeOutput,
  result: GoalClaimValidationOutput,
): JudgeOutput {
  const summary =
    result.summary.downgraded > 0
      ? summarizeValidatedGoalStatuses(result.goals, result.summary.downgraded)
      : judge.spec_compliance.summary;
  return {
    ...judge,
    scores: calibrateScoresForGoalStatuses(judge.scores, result.goals),
    spec_compliance: {
      ...judge.spec_compliance,
      goals: result.goals,
      summary,
      goal_claim_validation: result.summary,
    },
    meta: {
      ...judge.meta,
      confidence_caveats:
        result.summary.downgraded > 0
          ? uniqueStrings([
              ...judge.meta.confidence_caveats,
              `${result.summary.downgraded} verified goal claim(s) were downgraded by deterministic evidence validation.`,
            ])
          : judge.meta.confidence_caveats,
    },
  };
}

function calibrateScoresForGoalStatuses(
  scores: JudgeOutput['scores'],
  goals: JudgeOutput['spec_compliance']['goals'],
): JudgeOutput['scores'] {
  if (goals.length === 0) return scores;
  const verified = goals.filter((goal) => goal.status === 'verified').length;
  const partial = goals.filter((goal) => goal.status === 'partial').length;
  const incomplete = goals.length - verified - partial;
  const cap = roundScore(((verified + partial * 0.5) / goals.length) * 10);
  if (cap >= 10) return scores;
  const evidence = uniqueStrings(goals.flatMap((goal) => goal.evidence)).slice(0, 8);
  const rationale = `Calibrated after goal validation: ${verified}/${goals.length} verified, ${partial} partial, ${incomplete} incomplete.`;
  const targetDimensions = new Set(['correctness', 'completeness', 'depth']);
  let cappedAnyProfile = false;
  const profiles = Object.fromEntries(
    Object.entries(scores.profiles).map(([profileName, profile]) => {
      let cappedDimension = false;
      const dimensions = Object.fromEntries(
        Object.entries(profile.dimensions).map(([dimensionName, dimension]) => {
          if (!targetDimensions.has(dimensionName) || dimension.score === null) {
            return [dimensionName, dimension];
          }
          if (dimension.score <= cap) return [dimensionName, dimension];
          cappedDimension = true;
          return [
            dimensionName,
            {
              ...dimension,
              score: cap,
              rationale,
              evidence: evidence.length > 0 ? evidence : dimension.evidence,
            },
          ];
        }),
      );
      const shouldCapProfile =
        cappedDimension || profileName === 'quality' || profileName === 'coverage';
      let score = profile.score;
      if (shouldCapProfile && profile.score > cap) {
        cappedAnyProfile = true;
        score = cap;
      }
      return [profileName, { ...profile, score, dimensions }];
    }),
  );
  const overallScore =
    scores.overall.score > cap && (cappedAnyProfile || goals.length > 0)
      ? cap
      : scores.overall.score;
  return {
    ...scores,
    overall: { ...scores.overall, score: overallScore },
    profiles,
  };
}

function roundScore(score: number): number {
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

function summarizeValidatedGoalStatuses(
  goals: JudgeOutput['spec_compliance']['goals'],
  downgraded: number,
): string {
  const counts = goals.reduce<Record<string, number>>((acc, goal) => {
    acc[goal.status] = (acc[goal.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts = ['verified', 'partial', 'blocked', 'skipped', 'untested']
    .map((status) => {
      const count = counts[status] ?? 0;
      return count > 0 ? `${count} ${status}` : '';
    })
    .filter(Boolean);
  const noun = downgraded === 1 ? 'claim' : 'claims';
  return `Goal evidence validation downgraded ${downgraded} verified ${noun}. Final goal status: ${parts.join(', ')}.`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
