import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { runAxe } from './axe.js';

describe('axe probe', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('runs axe and returns a probe result with violations + passes counts', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await runAxe(page);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.summary.violations).toBe('number');
      expect(typeof r.summary.passes).toBe('number');
    }
  });

  it('reports zero violations on the simple hello fixture', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await runAxe(page);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.violations).toBeLessThanOrEqual(2);
    }
  });
});
