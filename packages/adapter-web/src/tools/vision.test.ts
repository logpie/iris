import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { screenshot, visionClick, visionDescribe } from './vision.js';

describe('vision tools', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;
  let outDir: string;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    outDir = mkdtempSync(join(tmpdir(), 'iris-vision-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('screenshot writes a PNG and returns the path in evidence_refs', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await screenshot(lc.getPage(), { out_dir: outDir, name: 'step-1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence_refs).toHaveLength(1);
      const path = r.evidence_refs[0]!;
      expect(existsSync(path)).toBe(true);
      expect(path).toMatch(/step-1\.png$/);
    }
  });

  it('vision_click clicks at xy coordinates (smoke: no throw)', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await visionClick(lc.getPage(), { x: 50, y: 50, reason: 'top-left of body' });
    expect(r.ok).toBe(true);
  });

  it('vision_describe is a phase-2 stub that returns ok=false', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await visionDescribe(lc.getPage(), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/phase 3/i);
  });
});
