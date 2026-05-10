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

export const ToolResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    observation_ref: z.string().optional(),
    evidence_refs: z.array(z.string()).default([]),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
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

export interface EvidenceRef {
  finding_id: string;
  event_ids: string[];
}

export interface EvidenceFile {
  finding_id: string;
  path: string;
  kind: 'video' | 'screenshot' | 'cast' | 'har' | 'log';
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
}

export * from './conformance.js';
