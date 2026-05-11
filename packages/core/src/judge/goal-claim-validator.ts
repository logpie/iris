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
  let verifiedKept = 0;
  let downgraded = 0;
  const reasons: string[] = [];

  const next = goals.map((g) => {
    if (g.status !== 'verified') return g;
    const window = goalWindows.get(g.id) ?? [];
    const artifacts = outcome_contract.collectOutcomeEvidence({
      goal: { id: g.id, description: g.description },
      goal_events: window,
    });
    const citedSet = new Set(g.evidence ?? []);
    const cited = artifacts.some((a) => citedSet.has(a.ref));
    const hasSideEffectOnly =
      !cited &&
      ((g.notes && SIDE_EFFECT_PATTERNS.some((p) => p.test(g.notes ?? ''))) ||
        // Also downgrade when there's no outcome artifact available at all —
        // means the goal window contained no interaction or no post-interaction
        // observation. Indistinguishable from "agent didn't really do it."
        artifacts.length === 0);

    if (cited) {
      verifiedKept++;
      return g;
    }
    if (hasSideEffectOnly || artifacts.length === 0) {
      downgraded++;
      const reason =
        artifacts.length === 0
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

// Slice trace events into per-goal windows. A goal's window starts at the
// first event after the previous goal's goal_status (or trace start), and
// ends at this goal's goal_status event (inclusive).
//
// This is approximate — the Explorer doesn't tag every event with goal_id —
// but it captures the natural "what was the agent doing before it claimed
// this goal done" window, which is what we want to validate against.
export function sliceGoalWindows(
  trace: TraceEvent[],
  goals: JudgeOutput['spec_compliance']['goals'],
): Map<string, OutcomeContractTraceEvent[]> {
  const out = new Map<string, OutcomeContractTraceEvent[]>();
  // Build an ordered list of goal_status events keyed by goal id.
  const goalIdSet = new Set(goals.map((g) => g.id));
  const goalStatusIdx: Array<{ idx: number; id: string }> = [];
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (!e || e.kind !== 'goal_status') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const gid = String(p.id ?? '');
    if (!gid || !goalIdSet.has(gid)) continue;
    goalStatusIdx.push({ idx: i, id: gid });
  }
  let lastEnd = -1;
  for (const { idx, id } of goalStatusIdx) {
    const window = trace.slice(lastEnd + 1, idx + 1).map(toContractEvent);
    out.set(id, window);
    lastEnd = idx;
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
