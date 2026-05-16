import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import { trace as iristrace } from '@iris/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runMissingPostExplorerProbes } from './post-explorer-probes.js';

describe('runMissingPostExplorerProbes', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('runs supported missing probes once and records mobile viewport evidence', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iris-post-probes-'));
    const tracePath = join(dir, 'trace.jsonl');
    writeFileSync(
      tracePath,
      `${JSON.stringify({
        v: 1,
        id: 'AXE_ALREADY',
        ts: 1,
        step: 0,
        target_kind: 'web',
        kind: 'probe_result',
        actor: 'system',
        payload: { probe: 'axe', ok: true, summary: { violations: 0 }, data: {} },
      })}\n`,
    );
    const traceWriter = new iristrace.TraceWriter(tracePath);
    const calls: string[] = [];
    const adapter = fakeAdapter(calls);

    await runMissingPostExplorerProbes({
      adapter,
      traceWriter,
      tracePath,
      log: () => {},
    });
    await traceWriter.close();

    expect(calls).toEqual(['console_errors_since', 'network_all_since', 'mobile_viewport']);
    const events = await iristrace.readTraceArray(tracePath);
    expect(events.map((event) => (event.payload as { probe?: string }).probe)).toEqual([
      'axe',
      'console_errors_since',
      'network_all_since',
      'mobile_viewport',
    ]);
    const mobile = events.find(
      (event) => (event.payload as { probe?: string }).probe === 'mobile_viewport',
    );
    expect(mobile?.payload).toMatchObject({
      probe: 'mobile_viewport',
      ok: true,
      viewport: { width: 390, height: 844 },
    });
  });
});

function fakeAdapter(calls: string[]): TargetAdapter {
  return {
    kind: 'web',
    async start() {},
    async stop() {
      return { evidence_dir: '', artifact_files: {} };
    },
    listTools() {
      return [];
    },
    async callTool() {
      return { ok: false, error: 'unused' };
    },
    async observe() {
      return { observation_ref: 'OBS', summary: '' };
    },
    listProbes() {
      return [
        { name: 'axe', description: '', input_schema: {} },
        { name: 'console_errors_since', description: '', input_schema: {} },
        { name: 'network_all_since', description: '', input_schema: {} },
        { name: 'mobile_viewport', description: '', input_schema: {} },
      ];
    },
    async runProbe(name) {
      calls.push(name);
      if (name === 'mobile_viewport') {
        return {
          ok: true,
          probe: name,
          summary: { viewport: { width: 390, height: 844 }, horizontal_overflow: false },
          data: { viewport: { width: 390, height: 844 } },
        };
      }
      if (name === 'network_all_since') {
        return {
          ok: true,
          probe: name,
          summary: { count: 2, failure_count: 0 },
          data: [{ url: 'https://example.test', status: 200, ok: true, ms: 5, ts: 1 }],
        };
      }
      return { ok: true, probe: name, summary: {}, data: {} };
    },
    async sliceEvidence() {
      return [];
    },
  };
}
