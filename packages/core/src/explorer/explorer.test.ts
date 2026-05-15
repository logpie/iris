import { mkdtempSync, rmSync } from 'node:fs';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trace as iristrace } from '../index.js';
import { type LlmCallInput, LlmClient, type LlmRawResponse } from '../llm/client.js';
import { Explorer } from './explorer.js';

class FakeAdapter implements TargetAdapter {
  readonly kind: TargetKind = 'web';
  observeCount = 0;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  async start(_c: AdapterConfig) {}
  async stop(): Promise<AdapterArtifacts> {
    return { evidence_dir: '/tmp/x', artifact_files: {} };
  }
  listTools(): ToolSpec[] {
    return [
      {
        name: 'click',
        description: 'click',
        input_schema: {
          type: 'object',
          properties: { selector: { type: 'string' } },
          required: ['selector'],
        },
      },
    ];
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.toolCalls.push({ name, args });
    return { ok: true, evidence_refs: [] };
  }
  async observe(): Promise<Observation> {
    this.observeCount++;
    return { observation_ref: `OBS-${this.observeCount}`, summary: `obs ${this.observeCount}` };
  }
  listProbes(): ProbeSpec[] {
    return [];
  }
  async runProbe(name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    return { ok: false, probe: name, error: 'no probes' };
  }
  async sliceEvidence(_refs: EvidenceRef[]): Promise<EvidenceFile[]> {
    return [];
  }
}

function fakeRsp(content: Array<Record<string, unknown>>): LlmRawResponse {
  return {
    id: 'msg_x',
    model: 'claude-sonnet-4-6',
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

describe('Explorer', () => {
  let dir: string;
  let writer: iristrace.TraceWriter;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-explorer-'));
    path = join(dir, 'trace.jsonl');
    writer = new iristrace.TraceWriter(path);
  });

  afterEach(async () => {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a basic loop: click then done', async () => {
    let callCount = 0;
    const transport = vi.fn(async (_input: LlmCallInput): Promise<LlmRawResponse> => {
      callCount++;
      if (callCount === 1) {
        return fakeRsp([
          { type: 'text', text: 'I will click.' },
          { type: 'tool_use', id: 'tu1', name: 'click', input: { selector: 'button' } },
        ]);
      }
      return fakeRsp([
        { type: 'text', text: 'Done.' },
        { type: 'tool_use', id: 'tu2', name: 'done', input: {} },
      ]);
    });
    const llmClient = new LlmClient({ transport });
    const adapter = new FakeAdapter();
    const explorer = new Explorer({
      adapter,
      llmClient,
      traceWriter: writer,
      config: {
        mode: 'free',
        target_kind: 'web',
        model: 'claude-sonnet-4-6',
        max_steps: 10,
        timeout_s: 60,
      },
    });
    const r = await explorer.run();
    expect(r.termination).toBe('done');
    expect(adapter.toolCalls).toHaveLength(1);
    expect(adapter.toolCalls[0]?.name).toBe('click');
    expect(transport).toHaveBeenCalledTimes(2);

    await writer.close();
    const events = await iristrace.readTraceArray(path);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('run_start')).toBe(true);
    expect(kinds.has('observation')).toBe(true);
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('done')).toBe(true);
    expect(kinds.has('run_end')).toBe(true);
  });

  it('stops on max_steps budget', async () => {
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeRsp([
          { type: 'text', text: 'click' },
          { type: 'tool_use', id: 'tu', name: 'click', input: { selector: 'a' } },
        ]),
    );
    const llmClient = new LlmClient({ transport });
    const adapter = new FakeAdapter();
    const explorer = new Explorer({
      adapter,
      llmClient,
      traceWriter: writer,
      config: {
        mode: 'free',
        target_kind: 'web',
        model: 'claude-sonnet-4-6',
        max_steps: 3,
        timeout_s: 60,
      },
    });
    const r = await explorer.run();
    expect(r.termination).toBe('budget_steps');
    expect(r.steps_taken).toBe(3);
  });

  it('stops on give_up via meta-tool', async () => {
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeRsp([{ type: 'tool_use', id: 'tu', name: 'give_up', input: { reason: 'stuck' } }]),
    );
    const llmClient = new LlmClient({ transport });
    const adapter = new FakeAdapter();
    const explorer = new Explorer({
      adapter,
      llmClient,
      traceWriter: writer,
      config: {
        mode: 'free',
        target_kind: 'web',
        model: 'claude-sonnet-4-6',
        max_steps: 10,
        timeout_s: 60,
      },
    });
    const r = await explorer.run();
    expect(r.termination).toBe('give_up');
    expect(r.state.give_up_reason).toBe('stuck');
  });

  it('seeds plan_stack from initial_plan_stack', async () => {
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> =>
        fakeRsp([{ type: 'tool_use', id: 'tu', name: 'done', input: {} }]),
    );
    const llmClient = new LlmClient({ transport });
    const adapter = new FakeAdapter();
    const explorer = new Explorer({
      adapter,
      llmClient,
      traceWriter: writer,
      config: {
        mode: 'grounded',
        target_kind: 'web',
        model: 'claude-sonnet-4-6',
        max_steps: 10,
        timeout_s: 60,
        initial_plan_stack: ['verify checkout', 'verify signin'],
      },
    });
    const r = await explorer.run();
    expect(r.state.plan_stack).toEqual(
      expect.arrayContaining(['verify checkout', 'verify signin']),
    );
  });
});
