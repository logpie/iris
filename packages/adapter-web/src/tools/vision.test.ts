import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llm } from '@iris/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      const path = r.evidence_refs[0]!;
      expect(existsSync(path)).toBe(true);
      expect(path).toMatch(/step-1\.png$/);
    }
  });

  it('vision_click clicks at xy coordinates', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await visionClick(lc.getPage(), { x: 50, y: 50, reason: 'top-left of body' });
    expect(r.ok).toBe(true);
  });

  it('vision_describe without LlmClient returns ok=false', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await visionDescribe(lc.getPage(), { out_dir: outDir, name: 'desc-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/LlmClient/);
  });

  it('vision_describe with LlmClient sends image to model and returns description', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const transport = vi.fn(async () => ({
      id: 'msg',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sign-in form with two inputs and a submit button.' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }));
    const client = new llm.LlmClient({ transport });

    const r = await visionDescribe(lc.getPage(), {
      out_dir: outDir,
      name: 'desc-2',
      llm_client: client,
    });
    expect(r.ok).toBe(true);
    if (r.ok && 'description' in r) {
      expect(r.description).toContain('Sign-in form');
    }
    expect(transport).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing typed mock args for inspection
    const sentInput = (transport.mock.calls as any[][])[0]?.[0] as
      | import('@iris/core').llm.LlmCallInput
      | undefined;
    // Verify the message includes an image content block
    const msg = sentInput?.messages[0];
    if (msg && Array.isArray(msg.content)) {
      const imageBlock = msg.content.find((b) => (b as { type: string }).type === 'image');
      expect(imageBlock).toBeDefined();
    }
  });
});
