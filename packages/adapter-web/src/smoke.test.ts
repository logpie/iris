import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace as iristrace } from '@iris/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../test-fixtures/server.js';
import { runSmoke } from './smoke.js';

describe('smoke driver', () => {
  let outDir: string;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-smoke-'));
    server = await startFixtureServer('form');
  });

  afterEach(async () => {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces a trace.jsonl with at least observation, action, probe events', async () => {
    await runSmoke({
      target: `${server.url}/index.html`,
      out_dir: outDir,
      headless: true,
    });

    const tracePath = join(outDir, 'trace.jsonl');
    expect(existsSync(tracePath)).toBe(true);
    const events = await iristrace.readTraceArray(tracePath);
    expect(events.length).toBeGreaterThan(3);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('observation')).toBe(true);
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('probe_result')).toBe(true);
    expect(kinds.has('run_start')).toBe(true);
    expect(kinds.has('run_end')).toBe(true);
  });
});
