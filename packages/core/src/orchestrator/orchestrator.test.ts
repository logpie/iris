import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { RubricProfile } from '@iris/rubrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LlmCallInput, LlmClient, type LlmRawResponse } from '../llm/client.js';
import { Orchestrator } from './orchestrator.js';

class FakeAdapter implements TargetAdapter {
  readonly kind: TargetKind = 'web';
  observeCount = 0;
  async start(_c: AdapterConfig) {}
  async stop(): Promise<AdapterArtifacts> {
    return { evidence_dir: '/tmp/x', artifact_files: { trace_zip: '/tmp/trace.zip' } };
  }
  listTools(): ToolSpec[] {
    return [
      {
        name: 'click',
        description: 'c',
        input_schema: { type: 'object', properties: { selector: { type: 'string' } } },
      },
    ];
  }
  async callTool(_n: string, _a: Record<string, unknown>): Promise<ToolResult> {
    return { ok: true, evidence_refs: [] };
  }
  async observe(): Promise<Observation> {
    this.observeCount++;
    return { observation_ref: `OBS-${this.observeCount}`, summary: 'page' };
  }
  listProbes(): ProbeSpec[] {
    return [];
  }
  async runProbe(n: string): Promise<ProbeResult> {
    return { ok: false, probe: n, error: 'no probes' };
  }
  async sliceEvidence(_r: EvidenceRef[]): Promise<EvidenceFile[]> {
    return [];
  }
}

function fakeRsp(content: Array<Record<string, unknown>>): LlmRawResponse {
  return {
    id: 'msg',
    model: 'm',
    stop_reason: 'tool_use',
    content,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function fakeText(text: string): LlmRawResponse {
  return {
    id: 'msg',
    model: 'm',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 10,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

const sampleProfile: RubricProfile = {
  name: 'usability',
  applies_to_targets: ['web'],
  applies_to_modes: ['free', 'grounded', 'targeted'],
  weight_in_overall: 1.0,
  dimensions: [{ id: 'clarity', weight: 1.0, description: 'is it clear' }],
};

describe('Orchestrator', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-orch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs end-to-end and writes report.json + report.md', async () => {
    // Explorer LLM: one click then done
    let explorerCount = 0;
    const explorerTransport = vi.fn(async (): Promise<LlmRawResponse> => {
      explorerCount++;
      if (explorerCount === 1) {
        return fakeRsp([{ type: 'tool_use', id: 't1', name: 'click', input: { selector: 'a' } }]);
      }
      return fakeRsp([{ type: 'tool_use', id: 't2', name: 'done', input: {} }]);
    });

    // Judge LLM: returns valid output
    const judgeJson = {
      v: 1,
      findings: [
        {
          id: 'F-001',
          title: 'X',
          category: 'bug',
          severity: 'minor',
          evidence: ['T1'],
          rationale: 'r',
        },
      ],
      discarded_findings: [],
      scores: {
        overall: { score: 7.5, weighted_from: ['usability'] },
        profiles: {
          usability: {
            score: 7.5,
            dimensions: { clarity: { score: 7.5, rationale: 'r', evidence: ['T1'] } },
          },
        },
      },
      spec_compliance: { applicable: false, goals: [], summary: 'no spec' },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: 'ok' },
      meta: { confidence_overall: 0.8, confidence_caveats: [], would_re_explore_with: [] },
    };
    const judgeTransport = vi.fn(
      async (): Promise<LlmRawResponse> => fakeText(JSON.stringify(judgeJson)),
    );

    const orch = new Orchestrator({
      adapter: new FakeAdapter(),
      explorerClient: new LlmClient({ transport: explorerTransport }),
      judgeClient: new LlmClient({ transport: judgeTransport }),
    });

    const r = await orch.run({
      target: { kind: 'web', url: 'http://example.com' },
      mode: 'free',
      out_dir: dir,
      rubric_profiles: [sampleProfile],
      max_steps: 5,
      max_cost_usd: 1,
      timeout_s: 60,
      explorer_model: 'claude-sonnet-4-6',
      judge_model: 'claude-opus-4-7',
      no_html: false,
    });

    expect(r.exit_code).toBe(0);
    expect(r.report.headline.score).toBe(7.5);
    expect(existsSync(join(dir, 'report.json'))).toBe(true);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(existsSync(join(dir, 'report.html'))).toBe(true);
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'findings.json'))).toBe(true);
    expect(existsSync(join(dir, 'scores.json'))).toBe(true);
    expect(existsSync(join(dir, 'config.json'))).toBe(true);

    const reportText = readFileSync(join(dir, 'report.json'), 'utf8');
    const report = JSON.parse(reportText);
    expect(report.v).toBe(2);
    // Phase 5: the Judge cited 'T1' as evidence, but T1 doesn't exist in the
    // real trace (real ULIDs are generated). The evidence validator correctly
    // discards the finding. discarded_findings carries the audit trail.
    expect(report.findings).toHaveLength(0);
    expect(report.discarded_findings).toBeDefined();
    expect(report.discarded_findings).toHaveLength(1);
    expect(report.discarded_findings[0]?.reason).toBe('all_evidence_ids_invalid');
    expect(report.evidence_validation).toEqual({ verified: 0, downgraded: 0, discarded: 1 });
  });

  it('exit code 1 when score below threshold', async () => {
    const explorerTransport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeRsp([{ type: 'tool_use', id: 't', name: 'done', input: {} }]),
    );
    const judgeJson = {
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: {
        overall: { score: 5.0, weighted_from: ['usability'] },
        profiles: {
          usability: {
            score: 5.0,
            dimensions: { clarity: { score: 5.0, rationale: 'r', evidence: [] } },
          },
        },
      },
      spec_compliance: { applicable: false, goals: [], summary: '' },
      coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 0.5, confidence_caveats: [], would_re_explore_with: [] },
    };
    const judgeTransport = vi.fn(
      async (): Promise<LlmRawResponse> => fakeText(JSON.stringify(judgeJson)),
    );

    const orch = new Orchestrator({
      adapter: new FakeAdapter(),
      explorerClient: new LlmClient({ transport: explorerTransport }),
      judgeClient: new LlmClient({ transport: judgeTransport }),
    });

    const r = await orch.run({
      target: { kind: 'web', url: 'http://example.com' },
      mode: 'free',
      out_dir: dir,
      rubric_profiles: [sampleProfile],
      max_steps: 5,
      max_cost_usd: 1,
      timeout_s: 60,
      threshold: 7.0,
      explorer_model: 'claude-sonnet-4-6',
      judge_model: 'claude-opus-4-7',
      no_html: true,
    });

    expect(r.exit_code).toBe(1);
    expect(r.report.headline.threshold_passed).toBe(false);
  });

  it('exit code 2 when budget exhausted', async () => {
    const explorerTransport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeRsp([{ type: 'tool_use', id: 't', name: 'click', input: { selector: 'a' } }]),
    );
    const judgeJson = {
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: {
        overall: { score: 8.0, weighted_from: ['usability'] },
        profiles: {
          usability: {
            score: 8.0,
            dimensions: { clarity: { score: 8.0, rationale: 'r', evidence: [] } },
          },
        },
      },
      spec_compliance: { applicable: false, goals: [], summary: '' },
      coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 0.5, confidence_caveats: [], would_re_explore_with: [] },
    };
    const judgeTransport = vi.fn(
      async (): Promise<LlmRawResponse> => fakeText(JSON.stringify(judgeJson)),
    );

    const orch = new Orchestrator({
      adapter: new FakeAdapter(),
      explorerClient: new LlmClient({ transport: explorerTransport }),
      judgeClient: new LlmClient({ transport: judgeTransport }),
    });

    const r = await orch.run({
      target: { kind: 'web', url: 'http://example.com' },
      mode: 'free',
      out_dir: dir,
      rubric_profiles: [sampleProfile],
      max_steps: 2,
      max_cost_usd: 1,
      timeout_s: 60,
      explorer_model: 'claude-sonnet-4-6',
      judge_model: 'claude-opus-4-7',
      no_html: true,
    });

    expect(r.exit_code).toBe(2);
    expect(r.termination).toBe('budget_steps');
  });
});
