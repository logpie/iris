import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { NetworkProbe } from './network.js';

describe('NetworkProbe', () => {
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

  it('captures responses and exposes failures via probe', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new NetworkProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    await page.evaluate(async (base) => {
      try {
        await fetch(`${base}/no-such.html`);
      } catch {}
    }, server.url);
    await page.waitForTimeout(100);

    const r = await probe.runProbe('network_failures_since', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.failure_count).toBeGreaterThanOrEqual(1);
    }
  });
});
