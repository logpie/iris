import {
  type discovery as discoveryMod,
  scenarioEvidenceSatisfiesToken,
  scenario as scenarioMod,
  selectProductUseJobForGoal,
} from '@iris/core';

export interface ScenarioCompletionGate {
  goalId: string;
  requiredOutputs: string[];
  requiredVisibleText: string[];
}

export interface ScenarioCompletionGateCheck {
  ok: boolean;
  missing: string[];
  required: string[];
  unknownEvidenceEventIds?: string[];
  unacceptableEvidenceEventIds?: string[];
}

export interface EvidenceEventIdCheck {
  ok: boolean;
  unknown: string[];
  unacceptable: string[];
}

interface RecordedEvidence {
  visible: string;
  structural: string;
  accepted: boolean;
  index: number;
  ownerGoalId?: string;
}

export function buildScenarioCompletionGates(
  discovery: discoveryMod.DiscoveryOutput,
): ScenarioCompletionGate[] {
  const jobs = discovery.product_use_contract?.user_jobs ?? [];
  return discovery.goals
    .map((goal) => {
      const job = selectProductUseJobForGoal(jobs, goal);
      const candidateJobs = job
        ? [job]
        : goal.journey_id
          ? jobs.filter((candidate) => candidate.journey_id === goal.journey_id)
          : jobs;
      if (candidateJobs.length === 0) return null;
      const requiredVisibleText = Array.from(
        new Set(candidateJobs.flatMap((candidate) => scenarioProofVisibleData(candidate))),
      );
      if (requiredVisibleText.length === 0) return null;
      return {
        goalId: goal.id,
        requiredOutputs: Array.from(
          new Set(candidateJobs.flatMap((candidate) => candidate.required_outputs)),
        ),
        requiredVisibleText,
      };
    })
    .filter((gate): gate is ScenarioCompletionGate => Boolean(gate));
}

export function formatScenarioGatePrompt(gates: readonly ScenarioCompletionGate[]): string {
  if (gates.length === 0) return '';
  const lines = [
    'Scenario completion gate is enabled. Before goal_status(status="verified"), cite evidence that contains every required visible output for that goal. If one is missing, repair the product state and observe again, or mark the goal partial with evidence.',
    'If a cited post-action observation/probe contains the exact checklist text, trust that text and mark verified; do not mark partial because a screenshot or vision description omitted the same text.',
    'Gate checklists:',
  ];
  for (const gate of gates) {
    lines.push(`- ${gate.goalId}: ${gate.requiredVisibleText.join('; ')}`);
  }
  return lines.join('\n');
}

export class ScenarioCompletionGateVerifier {
  private readonly gatesByGoal = new Map<string, ScenarioCompletionGate>();
  private readonly evidenceById = new Map<string, RecordedEvidence>();
  private readonly goalStatusIndexes: Array<{ goalId: string; index: number }> = [];
  private hasActionEvidenceMarker = false;
  private nextEventIndex = 0;

  constructor(gates: readonly ScenarioCompletionGate[] | undefined) {
    for (const gate of gates ?? []) {
      if (gate.requiredVisibleText.length > 0) this.gatesByGoal.set(gate.goalId, gate);
    }
  }

  get enabled(): boolean {
    return this.gatesByGoal.size > 0;
  }

  goalIds(): string[] {
    return Array.from(this.gatesByGoal.keys());
  }

  recordTraceEvent(id: string, kind: string, payload: Record<string, unknown>): void {
    const index = this.nextEventIndex++;
    const accepted = this.isAcceptedEvidence(kind, payload);
    const text = tracePayloadEvidenceText(kind, payload);
    this.evidenceById.set(id, { ...text, accepted, index });
    if (kind === 'action_result' && isSuccessfulInteractionResult(payload)) {
      this.hasActionEvidenceMarker = true;
    }
    if (kind === 'goal_status') {
      this.recordGoalStatusEvidenceOwnership(payload);
    }
  }

  check(goalId: string, evidenceEventIds: readonly string[]): ScenarioCompletionGateCheck {
    const gate = this.gatesByGoal.get(goalId);
    if (!gate) return { ok: true, missing: [], required: [] };
    const idCheck = this.checkEvidenceEventIds(evidenceEventIds, { goalId });
    const observed = evidenceEventIds
      .map((id) => this.evidenceById.get(id))
      .filter((evidence): evidence is RecordedEvidence =>
        Boolean(evidence?.accepted && (!evidence.ownerGoalId || evidence.ownerGoalId === goalId)),
      );
    const missing = gate.requiredVisibleText.filter(
      (item) =>
        !observed.some((evidence) =>
          scenarioEvidenceSatisfiesToken(evidence.visible, item, evidence.structural),
        ),
    );
    const hasCompleteSegment = observed.some((evidence) =>
      gate.requiredVisibleText.every((item) =>
        scenarioEvidenceSatisfiesToken(evidence.visible, item, evidence.structural),
      ),
    );
    const effectiveMissing = hasCompleteSegment
      ? []
      : missing.length > 0
        ? missing
        : gate.requiredVisibleText;
    return {
      ok: idCheck.ok && effectiveMissing.length === 0,
      missing: effectiveMissing,
      required: gate.requiredVisibleText,
      ...(idCheck.unknown.length > 0 ? { unknownEvidenceEventIds: idCheck.unknown } : {}),
      ...(idCheck.unacceptable.length > 0
        ? { unacceptableEvidenceEventIds: idCheck.unacceptable }
        : {}),
    };
  }

  checkEvidenceEventIds(
    evidenceEventIds: readonly string[],
    options: { goalId?: string } = {},
  ): EvidenceEventIdCheck {
    const unknown: string[] = [];
    const unacceptable: string[] = [];
    for (const id of evidenceEventIds) {
      const evidence = this.evidenceById.get(id);
      if (!evidence) {
        unknown.push(id);
      } else if (!evidence.accepted) {
        unacceptable.push(id);
      } else if (evidence.ownerGoalId && evidence.ownerGoalId !== options.goalId) {
        unacceptable.push(id);
      } else if (options.goalId && evidence.index <= this.previousGoalStatusIndex()) {
        unacceptable.push(id);
      }
    }
    return { ok: unknown.length === 0 && unacceptable.length === 0, unknown, unacceptable };
  }

  private recordGoalStatusEvidenceOwnership(payload: Record<string, unknown>): void {
    const goalId = String(payload.id ?? payload.goal_id ?? '');
    if (!goalId) return;
    const goalStatusIndex = this.nextEventIndex - 1;
    this.goalStatusIndexes.push({ goalId, index: goalStatusIndex });
    const evidenceEventIds = Array.isArray(payload.evidence_event_ids)
      ? payload.evidence_event_ids
      : [];
    for (const ref of evidenceEventIds) {
      if (typeof ref !== 'string' || !ref) continue;
      const evidence = this.evidenceById.get(ref);
      if (!evidence) continue;
      if (!evidence.ownerGoalId || evidence.ownerGoalId === goalId) {
        this.evidenceById.set(ref, { ...evidence, ownerGoalId: goalId });
      }
    }
  }

  private previousGoalStatusIndex(): number {
    for (let i = this.goalStatusIndexes.length - 1; i >= 0; i--) {
      const status = this.goalStatusIndexes[i];
      if (!status) continue;
      return status.index;
    }
    return -1;
  }

  private isAcceptedEvidence(kind: string, payload: Record<string, unknown>): boolean {
    if (kind === 'observation') return this.hasActionEvidenceMarker;
    if (kind === 'action_result') {
      return this.hasActionEvidenceMarker && isPassiveEvidenceResult(payload);
    }
    if (kind === 'probe_result') {
      return (
        payload.ok === true && (this.hasActionEvidenceMarker || payload.phase === 'post-explorer')
      );
    }
    return false;
  }
}

const PASSIVE_EVIDENCE_TOOLS = new Set(['screenshot', 'vision_describe']);

function isSuccessfulInteractionResult(payload: Record<string, unknown>): boolean {
  if (payload.ok !== true) return false;
  const tool = String(payload.tool ?? '');
  return tool.length > 0 && !PASSIVE_EVIDENCE_TOOLS.has(tool);
}

function scenarioProofVisibleData(job: discoveryMod.ProductUseJob): string[] {
  const requiredOutputData = scenarioMod.scenarioProofVisibleTextTokens(job.required_outputs);
  const sortSupplement = sortProofSupplementalVisibleData(job);
  const data =
    requiredOutputData.length > 0
      ? [...requiredOutputData, ...sortSupplement]
      : [...scenarioMod.scenarioProofVisibleTextTokens(job.test_data), ...sortSupplement];
  return Array.from(new Set(data));
}

function sortProofSupplementalVisibleData(job: discoveryMod.ProductUseJob): string[] {
  const requirementText = [
    job.title,
    job.scenario_brief,
    ...job.required_outputs,
    ...job.proof_obligations,
    ...job.quality_bar,
  ]
    .join(' ')
    .toLowerCase();
  if (
    !/\b(sort|sorted|order|ordered|monotonic|age|salary|numeric|currency)\b/.test(requirementText)
  ) {
    return [];
  }
  return Array.from(job.test_data.join(' ').matchAll(/\$[\d,]+(?:\.\d+)?|\b\d{2,3}\b/g)).map(
    (match) => match[0],
  );
}

function tracePayloadEvidenceText(
  kind: string,
  payload: Record<string, unknown>,
): { visible: string; structural: string } {
  const visible: string[] = [];
  const structural: string[] = [];
  if (kind === 'observation') {
    visible.push(String(payload.summary ?? ''));
    const rich = payload.rich_content;
    if (Array.isArray(rich)) {
      for (const entry of rich) {
        if (entry && typeof entry === 'object') {
          visible.push(String((entry as { text?: unknown }).text ?? ''));
        }
      }
    }
    const perception = payload.perception_state;
    if (perception && typeof perception === 'object') {
      const state = perception as { elements?: unknown; url?: unknown; title?: unknown };
      structural.push(String(state.url ?? ''));
      structural.push(String(state.title ?? ''));
      const elements = state.elements;
      if (Array.isArray(elements)) {
        for (const element of elements.slice(0, 80)) {
          if (!element || typeof element !== 'object') continue;
          const e = element as {
            name?: unknown;
            text?: unknown;
            selector?: unknown;
            value?: unknown;
            role?: unknown;
          };
          structural.push(String(e.selector ?? ''));
          visible.push(String(e.name ?? ''));
          visible.push(String(e.text ?? ''));
          structural.push(String(e.value ?? ''));
          structural.push(String(e.role ?? ''));
        }
      }
    }
  }
  if (kind === 'action_result' && typeof payload.description === 'string') {
    if (isPassiveEvidenceResult(payload)) visible.push(payload.description);
  }
  if (kind === 'probe_result') {
    structural.push(String(payload.probe ?? ''));
    visible.push(String(payload.summary ?? ''));
    const data = payload.data;
    if (data && typeof data === 'object') {
      const d = data as {
        visibleText?: unknown;
        text_sample?: unknown;
        outline_sample?: unknown;
        selectors?: unknown;
        activeElement?: unknown;
      };
      visible.push(String(d.visibleText ?? ''));
      visible.push(String(d.text_sample ?? ''));
      visible.push(String(d.outline_sample ?? ''));
      if (Array.isArray(d.selectors)) {
        for (const selector of d.selectors.slice(0, 80)) {
          if (!selector || typeof selector !== 'object') continue;
          const s = selector as {
            name?: unknown;
            text?: unknown;
            value?: unknown;
            selector?: unknown;
          };
          structural.push(String(s.selector ?? ''));
          visible.push(String(s.name ?? ''));
          visible.push(String(s.text ?? ''));
          structural.push(String(s.value ?? ''));
        }
      }
      if (d.activeElement && typeof d.activeElement === 'object') {
        const active = d.activeElement as { name?: unknown; text?: unknown; value?: unknown };
        visible.push(String(active.name ?? ''));
        visible.push(String(active.text ?? ''));
        structural.push(String(active.value ?? ''));
      }
    }
  }
  return { visible: visible.join(' '), structural: structural.join(' ') };
}

function isPassiveEvidenceResult(payload: Record<string, unknown>): boolean {
  return (
    (payload.tool === 'screenshot' || payload.tool === 'vision_describe') && payload.ok !== false
  );
}
