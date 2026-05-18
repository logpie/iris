import { type discovery as discoveryMod, scenario as scenarioMod } from '@iris/core';

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

export function buildScenarioCompletionGates(
  discovery: discoveryMod.DiscoveryOutput,
): ScenarioCompletionGate[] {
  const jobs = discovery.product_use_contract?.user_jobs ?? [];
  return discovery.goals
    .map((goal, index) => {
      const job =
        jobs.find(
          (candidate) => candidate.journey_id && candidate.journey_id === goal.journey_id,
        ) ?? jobs[index];
      if (!job) return null;
      const requiredVisibleText = scenarioProofVisibleData(job);
      if (requiredVisibleText.length === 0) return null;
      return {
        goalId: goal.id,
        requiredOutputs: job.required_outputs,
        requiredVisibleText,
      };
    })
    .filter((gate): gate is ScenarioCompletionGate => Boolean(gate));
}

export function formatScenarioGatePrompt(gates: readonly ScenarioCompletionGate[]): string {
  if (gates.length === 0) return '';
  const lines = [
    'Scenario completion gate is enabled. Before goal_status(status="verified"), cite evidence that contains every required visible output for that goal. If one is missing, repair the product state and observe again, or mark the goal partial with evidence.',
    'Gate checklists:',
  ];
  for (const gate of gates) {
    lines.push(`- ${gate.goalId}: ${gate.requiredVisibleText.join('; ')}`);
  }
  return lines.join('\n');
}

export class ScenarioCompletionGateVerifier {
  private readonly gatesByGoal = new Map<string, ScenarioCompletionGate>();
  private readonly evidenceById = new Map<string, { text: string; accepted: boolean }>();
  private hasActionEvidenceMarker = false;

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
    const accepted = this.isAcceptedEvidence(kind, payload);
    const text = tracePayloadEvidenceText(kind, payload);
    this.evidenceById.set(id, { text, accepted });
    if (kind === 'action_result' && isSuccessfulInteractionResult(payload)) {
      this.hasActionEvidenceMarker = true;
    }
  }

  check(goalId: string, evidenceEventIds: readonly string[]): ScenarioCompletionGateCheck {
    const gate = this.gatesByGoal.get(goalId);
    if (!gate) return { ok: true, missing: [], required: [] };
    const idCheck = this.checkEvidenceEventIds(evidenceEventIds);
    const observed = normalizeText(
      evidenceEventIds
        .map((id) => {
          const evidence = this.evidenceById.get(id);
          return evidence?.accepted ? evidence.text : '';
        })
        .join(' '),
    );
    const missing = gate.requiredVisibleText.filter(
      (item) => !containsVisiblePhrase(observed, item),
    );
    return {
      ok: idCheck.ok && missing.length === 0,
      missing,
      required: gate.requiredVisibleText,
      ...(idCheck.unknown.length > 0 ? { unknownEvidenceEventIds: idCheck.unknown } : {}),
      ...(idCheck.unacceptable.length > 0
        ? { unacceptableEvidenceEventIds: idCheck.unacceptable }
        : {}),
    };
  }

  checkEvidenceEventIds(evidenceEventIds: readonly string[]): EvidenceEventIdCheck {
    const unknown: string[] = [];
    const unacceptable: string[] = [];
    for (const id of evidenceEventIds) {
      const evidence = this.evidenceById.get(id);
      if (!evidence) {
        unknown.push(id);
      } else if (!evidence.accepted) {
        unacceptable.push(id);
      }
    }
    return { ok: unknown.length === 0 && unacceptable.length === 0, unknown, unacceptable };
  }

  private isAcceptedEvidence(kind: string, payload: Record<string, unknown>): boolean {
    if (kind === 'observation') return this.hasActionEvidenceMarker;
    if (kind === 'action_result') {
      return (
        (payload.tool === 'screenshot' || payload.tool === 'vision_describe') &&
        payload.ok !== false
      );
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
  if (requiredOutputData.length > 0) return requiredOutputData;
  return scenarioMod.scenarioProofVisibleTextTokens(job.test_data);
}

function tracePayloadEvidenceText(kind: string, payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  if (kind === 'observation') {
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
  if (kind === 'action_result' && typeof payload.description === 'string') {
    chunks.push(payload.description);
  }
  if (kind === 'probe_result') {
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
            name?: unknown;
            text?: unknown;
            value?: unknown;
            selector?: unknown;
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
  return chunks.join(' ');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsVisiblePhrase(observed: string, required: string): boolean {
  const needle = normalizeText(required);
  if (!needle) return true;
  let index = observed.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? observed.charAt(index - 1) : '';
    const afterIndex = index + needle.length;
    const after = afterIndex < observed.length ? observed.charAt(afterIndex) : '';
    if (!isTokenChar(before) && !isTokenChar(after)) return true;
    index = observed.indexOf(needle, index + 1);
  }
  return false;
}

function isTokenChar(value: string): boolean {
  return /^[a-z0-9]$/i.test(value);
}
