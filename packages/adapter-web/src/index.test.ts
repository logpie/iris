import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../test-fixtures/server.js';
import { WebTargetAdapter } from './index.js';

describe('WebTargetAdapter (end-to-end against fixture)', () => {
  let adapter: WebTargetAdapter;
  let server: FixtureServerHandle;
  let outDir: string;

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-adapter-'));
    adapter = new WebTargetAdapter({ headless: true });
    server = await startFixtureServer('form');
  });

  afterEach(async () => {
    await adapter.stop().catch(() => {});
    if (server) await server.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('start → observe → callTool → runProbe → stop full cycle', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });

    const obs = await adapter.observe();
    expect(obs.observation_ref).toBeTruthy();
    expect(obs.summary).toContain('Sign in');

    const tools = adapter.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['click', 'type', 'screenshot']),
    );

    const r1 = await adapter.callTool('type', { selector: '#email', text: 'a@b.co' });
    expect(r1.ok).toBe(true);
    const r2 = await adapter.callTool('type', { selector: '#password', text: 'pw' });
    expect(r2.ok).toBe(true);
    const r3 = await adapter.callTool('click', { selector: '#submit' });
    expect(r3.ok).toBe(true);

    const probes = adapter.listProbes();
    expect(probes.map((p) => p.name)).toEqual(
      expect.arrayContaining(['axe', 'console_errors_since']),
    );
    const axeR = await adapter.runProbe('axe', {});
    expect(axeR.ok).toBe(true);

    const artifacts = await adapter.stop();
    expect(artifacts.evidence_dir).toContain(outDir);
  });

  it('callTool with unknown name returns ok=false', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });
    const r = await adapter.callTool('telekinesis', {});
    expect(r.ok).toBe(false);
  });

  it('runProbe with unknown name returns ok=false', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });
    const r = await adapter.runProbe('quantum', {});
    expect(r.ok).toBe(false);
  });
});
