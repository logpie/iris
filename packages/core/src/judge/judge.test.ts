import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RubricProfile } from '@iris/rubrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LlmCallInput, LlmClient, type LlmRawResponse } from '../llm/client.js';
import type { TraceEvent } from '../trace/schema.js';
import { Judge } from './judge.js';
import { buildTraceDigest } from './prompts.js';

function fakeRsp(text: string): LlmRawResponse {
  return {
    id: 'msg_x',
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 100,
      output_tokens: 200,
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

describe('Judge', () => {
  let dir: string;
  let tracePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-judge-'));
    tracePath = join(dir, 'trace.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a well-formed Judge JSON output', async () => {
    const events: TraceEvent[] = [
      {
        v: 1,
        id: 'T1',
        ts: 1,
        step: 0,
        target_kind: 'web',
        kind: 'run_start',
        actor: 'system',
        payload: {},
      },
      {
        v: 1,
        id: 'T2',
        ts: 2,
        step: 1,
        target_kind: 'web',
        kind: 'observation',
        actor: 'adapter',
        payload: { ref: 'OBS-1', summary: 'login page' },
      },
      {
        v: 1,
        id: 'T3',
        ts: 3,
        step: 2,
        target_kind: 'web',
        kind: 'tentative_finding',
        actor: 'explorer',
        payload: {
          title: 'X',
          category: 'bug',
          severity_hint: 'major',
          evidence_event_ids: ['T2'],
          rationale: 'r',
        },
      },
    ];
    writeFileSync(tracePath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const judgeJson = JSON.stringify({
      v: 1,
      findings: [
        {
          id: 'F-001',
          title: 'Login fails',
          category: 'bug',
          severity: 'major',
          evidence: ['T2'],
          rationale: 'evidence shows it',
          suggested_fix: { type: 'fix', summary: 'do x' },
        },
      ],
      discarded_findings: [],
      scores: {
        overall: { score: 7.0, weighted_from: ['usability'] },
        profiles: {
          usability: {
            score: 7.0,
            dimensions: { clarity: { score: 7.0, rationale: 'r', evidence: ['T2'] } },
          },
        },
      },
      spec_compliance: { applicable: false, goals: [], summary: 'no spec' },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: 'fine' },
      meta: { confidence_overall: 0.8, confidence_caveats: [], would_re_explore_with: [] },
    });

    const transport = vi.fn(
      async (_inp: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(judgeJson),
    );
    const llmClient = new LlmClient({ transport });
    const judge = new Judge(llmClient);
    const out = await judge.run({ trace_path: tracePath, rubric_profiles: [sampleProfile] });

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe('major');
    expect(out.scores.overall.score).toBe(7.0);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('extracts JSON from code-fenced response', async () => {
    writeFileSync(tracePath, '');
    const judgeJson = JSON.stringify({
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: { overall: { score: 0, weighted_from: [] }, profiles: {} },
      spec_compliance: { applicable: false, goals: [], summary: '' },
      coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 0, confidence_caveats: [], would_re_explore_with: [] },
    });
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> => fakeRsp(`\`\`\`json\n${judgeJson}\n\`\`\``),
    );
    const judge = new Judge(new LlmClient({ transport }));
    const out = await judge.run({ trace_path: tracePath, rubric_profiles: [sampleProfile] });
    expect(out.findings).toEqual([]);
  });

  it('throws on schema-invalid response', async () => {
    writeFileSync(tracePath, '');
    const transport = vi.fn(
      async (): Promise<LlmRawResponse> => fakeRsp(JSON.stringify({ v: 99, garbage: true })),
    );
    const judge = new Judge(new LlmClient({ transport }));
    await expect(
      judge.run({ trace_path: tracePath, rubric_profiles: [sampleProfile] }),
    ).rejects.toThrow();
  });

  it('buildTraceDigest produces one line per event with id and kind', () => {
    const events: TraceEvent[] = [
      {
        v: 1,
        id: 'T1',
        ts: 1,
        step: 0,
        target_kind: 'web',
        kind: 'run_start',
        actor: 'system',
        payload: { foo: 'bar' },
      },
      {
        v: 1,
        id: 'T2',
        ts: 2,
        step: 1,
        target_kind: 'web',
        kind: 'action',
        actor: 'explorer',
        payload: { tool: 'click', args: { selector: 'button' } },
      },
    ];
    const digest = buildTraceDigest(events);
    const lines = digest.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('T1');
    expect(lines[0]).toContain('run_start');
    expect(lines[1]).toContain('click');
  });

  it('buildTraceDigest includes goal_status evidence ids', () => {
    const events: TraceEvent[] = [
      {
        v: 1,
        id: 'GSTAT',
        ts: 1,
        step: 1,
        target_kind: 'web',
        kind: 'goal_status',
        actor: 'explorer',
        payload: {
          id: 'G1',
          status: 'verified',
          rationale: 'todo row appeared',
          evidence_event_ids: ['OBS1'],
        },
      },
    ];
    const digest = buildTraceDigest(events);
    expect(digest).toContain('evidence=[OBS1]');
  });
});
