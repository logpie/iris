import type {
  AdapterArtifacts,
  AdapterConfig,
  EvidenceFile,
  EvidenceRef,
  Observation,
  ProbeResult,
  ProbeSpec,
  TargetAdapter,
  TargetKind,
  ToolResult,
  ToolSpec,
} from '@iris/adapter-types';

const NOT_IMPL = 'WebTargetAdapter: not implemented in phase 1 — see plans/2026-05-09-iris-phase-1-foundations.md';

export class WebTargetAdapter implements TargetAdapter {
  readonly kind: TargetKind = 'web';

  async start(_config: AdapterConfig): Promise<void> {
    throw new Error(NOT_IMPL);
  }

  async stop(): Promise<AdapterArtifacts> {
    throw new Error(NOT_IMPL);
  }

  listTools(): ToolSpec[] {
    throw new Error(NOT_IMPL);
  }

  async callTool(_name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    throw new Error(NOT_IMPL);
  }

  async observe(): Promise<Observation> {
    throw new Error(NOT_IMPL);
  }

  listProbes(): ProbeSpec[] {
    throw new Error(NOT_IMPL);
  }

  async runProbe(_name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    throw new Error(NOT_IMPL);
  }

  async sliceEvidence(_refs: EvidenceRef[]): Promise<EvidenceFile[]> {
    throw new Error(NOT_IMPL);
  }
}
