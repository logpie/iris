import { describe, expect, it } from 'vitest';
import {
  type AdapterArtifacts,
  type AdapterConfig,
  type EvidenceRef,
  type Observation,
  type ProbeResult,
  type ProbeSpec,
  type TargetAdapter,
  type TargetKind,
  type ToolResult,
  type ToolSpec,
  ToolResultSchema,
  ProbeResultSchema,
} from './index.js';

describe('adapter-types', () => {
  it('TargetKind has all four kinds', () => {
    const kinds: TargetKind[] = ['web', 'cli', 'api', 'desktop'];
    expect(kinds).toHaveLength(4);
  });

  it('ToolResultSchema validates a successful tool result', () => {
    const r: ToolResult = { ok: true, observation_ref: 'T000001', evidence_refs: [] };
    expect(ToolResultSchema.parse(r)).toEqual(r);
  });

  it('ToolResultSchema validates a failed tool result', () => {
    const r: ToolResult = { ok: false, error: 'selector not found' };
    expect(ToolResultSchema.parse(r)).toEqual(r);
  });

  it('ProbeResultSchema validates an axe-shaped probe result', () => {
    const r: ProbeResult = { ok: true, probe: 'axe', summary: { violations: 3 }, data: {} };
    expect(ProbeResultSchema.parse(r)).toEqual(r);
  });

  it('a fake adapter satisfies TargetAdapter', () => {
    const adapter: TargetAdapter = {
      kind: 'web',
      async start(_config: AdapterConfig) {},
      async stop(): Promise<AdapterArtifacts> {
        return { evidence_dir: '/tmp/x', artifact_files: {} };
      },
      listTools(): ToolSpec[] {
        return [];
      },
      async callTool(_name, _args): Promise<ToolResult> {
        return { ok: true, evidence_refs: [] };
      },
      async observe(): Promise<Observation> {
        return { observation_ref: 'T1', summary: 'empty' };
      },
      listProbes(): ProbeSpec[] {
        return [];
      },
      async runProbe(_name, _args): Promise<ProbeResult> {
        return { ok: true, probe: 'noop', summary: {}, data: {} };
      },
      async sliceEvidence(_refs: EvidenceRef[]) {
        return [];
      },
    };
    expect(adapter.kind).toBe('web');
  });
});
