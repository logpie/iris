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
    if (g.status !== 'verified') return g;
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
    const window = goalWindows.get(g.id) ?? [];
    const citedSet = collectCitedRefs({
      goal: g,
      trace,
      traceIndexById,
      statusInfo,
    });
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
      return noteBackfill
        ? {
            ...g,
            notes: notes ? `${notes} Explorer rationale: ${noteBackfill}` : noteBackfill,
          }
        : g;
    }
    if (hasSideEffectOnly || uniqueArtifacts.length === 0) {
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
    cited.add(resolveTraceRefTypo(ref, input.trace, input.traceIndexById, input.statusInfo?.idx) ?? ref);
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

function resolveTraceRefTypo(
  ref: string,
  trace: TraceEvent[],
  traceIndexById: Map<string, number>,
  maxIdx: number | undefined,
): string | undefined {
  if (traceIndexById.has(ref)) return ref;
  if (!looksLikeTraceId(ref)) return undefined;
  const candidates = trace.filter((event, idx) => {
    if (maxIdx !== undefined && idx > maxIdx) return false;
    if (event.id.slice(0, 18) === ref.slice(0, 18) && Math.abs(event.id.length - ref.length) <= 2) {
      return true;
    }
    return event.id.slice(0, 10) === ref.slice(0, 10) && editDistanceAtMostOne(event.id, ref);
  });
  return candidates.length === 1 ? candidates[0]?.id : undefined;
}

function looksLikeTraceId(ref: string): boolean {
  return /^01[0-9A-HJKMNP-TV-Z]{20,28}$/i.test(ref);
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let mismatches = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) mismatches++;
      if (mismatches > 1) return false;
    }
    return true;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    j++;
  }
  return true;
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
    out.set(id, window);
    lastEndBySession.set(session_id, idx);
  }
  // Goals with no goal_status event in the trace get an empty window.
  for (const g of goals) {
    if (!out.has(g.id)) out.set(g.id, []);
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
  return {
    ...judge,
    spec_compliance: {
      ...judge.spec_compliance,
      goals: result.goals,
      goal_claim_validation: result.summary,
    },
  };
}
