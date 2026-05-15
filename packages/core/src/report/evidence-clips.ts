import type { EvidenceFile, EvidenceRef, TargetAdapter } from '@iris/adapter-types';
import type { TraceEvent } from '../trace/schema.js';
import type { JudgeOutput } from '../judge/judge.js';

export interface ClaimEvidenceArtifactsResult {
  clips: Record<string, string>;
  files: EvidenceFile[];
  refs: EvidenceRef[];
}

type EvidenceSlicingAdapter = Pick<TargetAdapter, 'injectEventTimestamps' | 'sliceEvidence'>;

export async function collectClaimEvidenceArtifacts(input: {
  adapter: EvidenceSlicingAdapter;
  judge: JudgeOutput;
  trace: TraceEvent[];
  includeGoals?: boolean;
}): Promise<ClaimEvidenceArtifactsResult> {
  if (!input.adapter.injectEventTimestamps || !input.adapter.sliceEvidence) {
    return { clips: {}, files: [], refs: [] };
  }

  const tsMap: Record<string, number> = {};
  for (const event of input.trace) {
    tsMap[event.id] = event.ts;
    const ref = observationRef(event);
    if (ref) tsMap[ref] = event.ts;
  }
  input.adapter.injectEventTimestamps(tsMap);

  const eventIndex = new Map(input.trace.map((event) => [event.id, event]));
  const refs = buildClaimEvidenceRefs(input.judge, input.trace, eventIndex, input.includeGoals ?? true);
  if (refs.length === 0) return { clips: {}, files: [], refs };

  const files = await input.adapter.sliceEvidence(refs);
  const clips: Record<string, string> = {};
  for (const file of files) {
    if (file.kind === 'video' || file.kind === 'screenshot') {
      clips[file.finding_id] = file.path;
    }
  }
  return { clips, files, refs };
}

function buildClaimEvidenceRefs(
  judge: JudgeOutput,
  trace: TraceEvent[],
  eventIndex: Map<string, TraceEvent>,
  includeGoals: boolean,
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const finding of judge.findings) {
    const eventIds = unique(resolveEvidenceEventIds(finding.evidence, trace, eventIndex));
    if (eventIds.length > 0) refs.push({ finding_id: finding.id, event_ids: eventIds });
  }
  if (includeGoals && judge.spec_compliance.applicable) {
    for (const goal of judge.spec_compliance.goals) {
      const eventIds = unique(resolveEvidenceEventIds(goal.evidence, trace, eventIndex));
      if (eventIds.length > 0) refs.push({ finding_id: goal.id, event_ids: eventIds });
    }
  }
  return refs;
}

function resolveEvidenceEventIds(
  evidenceIds: string[],
  trace: TraceEvent[],
  eventIndex: Map<string, TraceEvent>,
): string[] {
  const out: string[] = [];
  for (const id of evidenceIds) {
    const event = eventIndex.get(id);
    if (event?.kind === 'goal_status') {
      const payload = event.payload as Record<string, unknown>;
      const nested = Array.isArray(payload.evidence_event_ids)
        ? payload.evidence_event_ids.filter((value): value is string => typeof value === 'string')
        : [];
      out.push(...resolveEvidenceEventIds(nested, trace, eventIndex));
    } else {
      out.push(id);
      const visualRef = visualEvidenceRefForEvent(id, trace, eventIndex);
      if (visualRef) out.push(visualRef);
    }
  }
  return out;
}

function visualEvidenceRefForEvent(
  id: string,
  trace: TraceEvent[],
  eventIndex: Map<string, TraceEvent>,
): string | null {
  const event = eventIndex.get(id);
  const directRef = event ? observationRef(event) : null;
  if (directRef) return directRef;

  const index = trace.findIndex((candidate) => candidate.id === id);
  if (index < 0) return null;
  for (let offset = 1; offset < trace.length; offset++) {
    const before = trace[index - offset];
    const beforeRef = before ? observationRef(before) : null;
    if (beforeRef) return beforeRef;
    const after = trace[index + offset];
    const afterRef = after ? observationRef(after) : null;
    if (afterRef) return afterRef;
  }
  return null;
}

function observationRef(event: TraceEvent): string | null {
  if (event.kind !== 'observation') return null;
  const ref = (event.payload as Record<string, unknown>).ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
