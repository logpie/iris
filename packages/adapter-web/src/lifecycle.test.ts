import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebLifecycle } from './lifecycle.js';

describe('WebLifecycle', () => {
  let lc: WebLifecycle;
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-lifecycle-'));
    lc = new WebLifecycle({ headless: true });
  });

  afterEach(async () => {
    await lc.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('start launches Chromium and exposes a Page', async () => {
    await lc.start();
    const page = lc.getPage();
    expect(page).toBeDefined();
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
  });

  it('stop closes the browser; getPage after stop throws', async () => {
    await lc.start();
    await lc.stop();
    expect(() => lc.getPage()).toThrow(/not running/i);
  });

  it('start is idempotent (second call is a no-op)', async () => {
    await lc.start();
    const p1 = lc.getPage();
    await lc.start();
    const p2 = lc.getPage();
    expect(p1).toBe(p2);
  });

  it('tracks a newly opened tab as the active page', async () => {
    await lc.start();
    const firstPage = lc.getPage();
    await firstPage.goto('about:blank');
    const newPage = await lc.getContext().newPage();
    await newPage.setContent('<title>Store</title><main>Store page</main>');

    expect(lc.getPage()).toBe(newPage);
    expect(await lc.getPage().title()).toBe('Store');
  });

  it('shows an Iris cursor overlay when video recording is enabled', async () => {
    await lc.stop();
    const videoDir = join(outDir, 'videos');
    mkdirSync(videoDir, { recursive: true });
    lc = new WebLifecycle({ headless: true, record_video_dir: videoDir });
    await lc.start();

    const page = lc.getPage();
    await page.goto('data:text/html,<main style="height:200px">record me</main>');
    await page.mouse.move(120, 80);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-iris-recording-cursor="true"]');
      return el ? getComputedStyle(el).opacity === '1' : false;
    });

    const cursor = await page.locator('[data-iris-recording-cursor="true"]').evaluate((el) => ({
      opacity: getComputedStyle(el).opacity,
      transform: getComputedStyle(el).transform,
      pointerEvents: getComputedStyle(el).pointerEvents,
      width: getComputedStyle(el).width,
      height: getComputedStyle(el).height,
      shapeCount: el.querySelectorAll('[data-iris-recording-cursor-shape="true"]').length,
    }));

    expect(cursor.opacity).toBe('1');
    expect(cursor.pointerEvents).toBe('none');
    expect(cursor.transform).not.toBe('none');
    expect(cursor.width).toBe('28px');
    expect(cursor.height).toBe('34px');
    expect(cursor.shapeCount).toBe(1);
    await page.mouse.move(160, 110);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-iris-recording-cursor-trail="true"]').length > 0,
    );
  });

  it('does not inject the cursor overlay when video recording is disabled', async () => {
    await lc.start();
    const page = lc.getPage();
    await page.goto('data:text/html,<main>not recorded</main>');
    await page.mouse.move(120, 80);

    expect(await page.locator('[data-iris-recording-cursor="true"]').count()).toBe(0);
  });
});
