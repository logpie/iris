import { describe, expect, it } from 'vitest';
import {
  type AdapterConfig,
  ProbeResultSchema,
  type TargetAdapter,
  ToolResultSchema,
} from './index.js';

export interface ConformanceConfig {
  /** A factory that returns a fresh adapter for each test. */
  makeAdapter: () => TargetAdapter;
  /** A working AdapterConfig (eager value or lazy factory). */
  startConfig: AdapterConfig | (() => AdapterConfig);
  /** Optional: at least one tool name to call (with valid args). */
  smokeTool?: { name: string; args: Record<string, unknown> };
  /** Optional: at least one probe name to call. */
  smokeProbe?: { name: string; args: Record<string, unknown> };
}

function resolveConfig(cfg: ConformanceConfig): AdapterConfig {
  return typeof cfg.startConfig === 'function' ? cfg.startConfig() : cfg.startConfig;
}

export function runAdapterConformance(cfg: ConformanceConfig): void {
  describe('TargetAdapter conformance', () => {
    it('reports a valid kind', () => {
      const a = cfg.makeAdapter();
      expect(['web', 'cli', 'api', 'desktop']).toContain(a.kind);
    });

    it('listTools returns valid ToolSpec entries', () => {
      const a = cfg.makeAdapter();
      const tools = a.listTools();
      for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(typeof t.description).toBe('string');
        expect(typeof t.input_schema).toBe('object');
      }
    });

    it('listProbes returns valid ProbeSpec entries', () => {
      const a = cfg.makeAdapter();
      const probes = a.listProbes();
      for (const p of probes) {
        expect(typeof p.name).toBe('string');
        expect(typeof p.description).toBe('string');
        expect(typeof p.input_schema).toBe('object');
      }
    });

    it('start → observe → stop roundtrips and observe returns a valid Observation', async () => {
      const a = cfg.makeAdapter();
      await a.start(resolveConfig(cfg));
      try {
        const obs = await a.observe();
        expect(typeof obs.observation_ref).toBe('string');
        expect(obs.observation_ref.length).toBeGreaterThan(0);
        expect(typeof obs.summary).toBe('string');
      } finally {
        const artifacts = await a.stop();
        expect(typeof artifacts.evidence_dir).toBe('string');
      }
    });

    if (cfg.smokeTool) {
      const tool = cfg.smokeTool;
      it(`callTool '${tool.name}' returns a valid ToolResult shape`, async () => {
        const a = cfg.makeAdapter();
        await a.start(resolveConfig(cfg));
        try {
          const r = await a.callTool(tool.name, tool.args);
          ToolResultSchema.parse(r);
        } finally {
          await a.stop();
        }
      });
    }

    if (cfg.smokeProbe) {
      const probe = cfg.smokeProbe;
      it(`runProbe '${probe.name}' returns a valid ProbeResult shape`, async () => {
        const a = cfg.makeAdapter();
        await a.start(resolveConfig(cfg));
        try {
          const r = await a.runProbe(probe.name, probe.args);
          ProbeResultSchema.parse(r);
        } finally {
          await a.stop();
        }
      });
    }

    it('sliceEvidence on empty input returns an empty array', async () => {
      const a = cfg.makeAdapter();
      await a.start(resolveConfig(cfg));
      try {
        const out = await a.sliceEvidence([]);
        expect(Array.isArray(out)).toBe(true);
        expect(out).toHaveLength(0);
      } finally {
        await a.stop();
      }
    });
  });
}
