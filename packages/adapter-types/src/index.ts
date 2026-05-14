import { z } from 'zod';

export type TargetKind = 'web' | 'cli' | 'api' | 'desktop';

export type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'suggestion';
export type Category = 'bug' | 'a11y' | 'ux' | 'perf' | 'copy' | 'suggestion';

export interface AdapterConfig {
  kind: TargetKind;
  target: string;
  out_dir: string;
  options?: Record<string, unknown>;
}

export interface AdapterArtifacts {
  evidence_dir: string;
  artifact_files: Record<string, string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProbeSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Phase 7 F7-1: optional retry metadata. The adapter may retry selector-miss
// errors with alternate strategies before returning. If `retried: true`, the
// final success was preceded by at least one failure that the Explorer's
// chosen selector caused; the orchestrator emits retry_attempt events to
// preserve audit trail.
const RetryMetaSchema = z.object({
  retried: z.boolean(),
  retry_count: z.number().int().nonnegative(),
  attempts: z
    .array(
      z.object({
        strategy: z.string(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});

export const ToolResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    observation_ref: z.string().optional(),
    evidence_refs: z.array(z.string()).default([]),
    retry_meta: RetryMetaSchema.optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    retry_meta: RetryMetaSchema.optional(),
  }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ProbeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    probe: z.string(),
    summary: z.record(z.unknown()),
    data: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    probe: z.string(),
    error: z.string(),
  }),
]);
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export interface Observation {
  observation_ref: string;
  summary: string;
  payload?: Record<string, unknown>;
}

// Phase 5: preflight probe. Adapters return raw measurements; the
// preflight/checks module turns these into pass/fail check results.
export interface PreflightProbe {
  httpStatus: number;
  loadFinished: boolean;
  gotoErrorKind?: 'dns' | 'timeout' | 'connection' | 'other';
  consoleMessages: Array<{ level: string; text: string }>;
  bodyStats: { textChars: number; interactiveCount: number };
  screenshot?: string;
}

export interface EvidenceRef {
  finding_id: string;
  event_ids: string[];
}

export interface EvidenceFile {
  finding_id: string;
  path: string;
  kind: 'video' | 'screenshot' | 'cast' | 'har' | 'log';
}

// Phase 9: declared interaction-kit primitive. Adapters publish their full
// set so the Judge sees what was possible and the goal-claim validator can
// flag goals that required an unsupported primitive. Mirrors the schema in
// @iris/core/adapter/interaction-kit.ts but kept here to avoid a package
// cycle.
export interface InteractionPrimitive {
  name: string;
  user_action: string;
  coverage_note?: string;
}

export interface InteractionKit {
  kind: TargetKind;
  primitives: InteractionPrimitive[];
}

// Phase 9: outcome evidence the Judge must cite for `verified` goal claims.
// Adapters return artifacts within a goal window; the goal-claim validator
// checks the Judge actually cited at least one.
export type OutcomeArtifactKind =
  | 'screenshot'
  | 'stdout'
  | 'stderr'
  | 'exit_code'
  | 'fs_diff'
  | 'http_response'
  | 'follow_up_read';

export interface OutcomeArtifact {
  kind: OutcomeArtifactKind;
  ref: string;
  note?: string;
}

// Minimal trace event shape used by OutcomeContract. The real TraceEvent is
// defined in @iris/core; keep this duck-typed to avoid a cycle.
export interface OutcomeContractTraceEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface OutcomeContract {
  kind: TargetKind | string;
  collectOutcomeEvidence(input: {
    goal: { id: string; description: string };
    goal_events: OutcomeContractTraceEvent[];
  }): OutcomeArtifact[];
}

export interface TargetAdapter {
  readonly kind: TargetKind;

  start(config: AdapterConfig): Promise<void>;
  stop(): Promise<AdapterArtifacts>;

  listTools(): ToolSpec[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;

  observe(): Promise<Observation>;

  listProbes(): ProbeSpec[];
  runProbe(name: string, args: Record<string, unknown>): Promise<ProbeResult>;

  sliceEvidence(refs: EvidenceRef[]): Promise<EvidenceFile[]>;

  // Phase 5: optional preflight probe. Adapters that don't implement it
  // skip the preflight phase (treated as pass).
  preflightProbe?(opts: { timeoutS: number }): Promise<PreflightProbe>;

  // Phase 6 F3: optional. Orchestrators that read trace.jsonl directly can
  // hand the adapter the {event_id → wall-clock ts} map needed to compute
  // per-finding video clip windows. Adapters that don't support clipping
  // can omit this.
  injectEventTimestamps?(extra: Record<string, number>): void;

  // Phase 9: optional. Adapters that declare their interaction surface let
  // the Judge see what primitives the agent had access to, and let the
  // goal-claim validator flag goals that needed a missing primitive.
  interactionKit?(): InteractionKit;

  // Phase 9: optional. Adapters that declare an outcome contract enable
  // post-Judge goal-claim validation. Adapters without a contract skip
  // validation (legacy behavior).
  outcomeContract?(): OutcomeContract;

  // Phase 18: optional. Adapters that support session state export (e.g.
  // Playwright's storageState — cookies + localStorage) implement this so
  // an authenticated bootstrap session can hand its state to parallel
  // productive sessions, skipping auth duplication.
  exportStorageState?(outPath: string): Promise<void>;
}

export * from './conformance.js';
