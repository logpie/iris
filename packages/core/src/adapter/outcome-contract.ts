// Phase 9: per-adapter declaration of what counts as user-visible outcome
// evidence. The goal-claim validator uses this to check that `verified` goal
// claims are backed by an outcome artifact (not just a side-effect).
//
// The contract does NOT itself judge "did the goal succeed?" — that's the
// Judge's job. The contract locates the artifacts the Judge is required to
// cite. The validator separately checks the Judge actually cited at least
// one.

import type { TraceEvent } from '../trace/schema.js';

export type OutcomeArtifactKind =
  | 'screenshot' // post-action visual state (web, desktop)
  | 'stdout' // command output (CLI)
  | 'stderr' // command error stream (CLI)
  | 'exit_code' // CLI exit code event
  | 'fs_diff' // filesystem state change (CLI)
  | 'http_response' // response body of the action call (API)
  | 'follow_up_read'; // confirming GET / list after a write (API)

export interface OutcomeArtifact {
  kind: OutcomeArtifactKind;
  // Either a file path (screenshot/log) or a trace event id. The Judge cites
  // these via the `evidence` array on the goal.
  ref: string;
  note?: string;
}

export interface OutcomeContractInput {
  goal: { id: string; description: string };
  // Events scoped to the goal window (between goal start and goal_status).
  goal_events: TraceEvent[];
}

export interface OutcomeContract {
  kind: string; // TargetKind, but kept as string here to avoid a cycle.
  collectOutcomeEvidence(input: OutcomeContractInput): OutcomeArtifact[];
}

// Default no-op contract for adapters that don't declare one. Returns empty
// array → goal-claim validator will downgrade every `verified` goal, which is
// the safe default (forces adapters to opt in).
//
// Adapters that explicitly want the legacy behavior (no goal-claim validation)
// can opt out at the orchestrator level via `skip_goal_claim_validation`.
export const NO_OP_OUTCOME_CONTRACT: OutcomeContract = {
  kind: 'noop',
  collectOutcomeEvidence: () => [],
};
