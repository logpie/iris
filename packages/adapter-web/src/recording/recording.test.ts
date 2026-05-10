import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';

describe('recording (video + trace.zip)', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-rec-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    if (lc) await lc.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces a video file and a trace.zip when configured', async () => {
    const videoDir = join(outDir, 'videos');
    const tracePath = join(outDir, 'trace.zip');
    lc = new WebLifecycle({
      headless: true,
      record_video_dir: videoDir,
      trace_out_path: tracePath,
    });
    await lc.start();
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    await lc.stop();

    expect(existsSync(tracePath)).toBe(true);
    const videos = readdirSync(videoDir);
    expect(videos.some((f) => f.endsWith('.webm'))).toBe(true);
  });

  it('does not record video or trace when not configured', async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    await lc.stop();
    expect(readdirSync(outDir)).toHaveLength(0);
  });
});
