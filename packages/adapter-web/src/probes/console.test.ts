import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { ConsoleProbe } from './console.js';

describe('ConsoleProbe', () => {
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

  it('captures console.error messages and consume() drains them', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new ConsoleProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    await page.evaluate(() => console.error('boom one'));
    await page.evaluate(() => console.error('boom two'));
    await page.waitForTimeout(50);

    const errs = probe.consume('error');
    expect(errs.map((e) => e.text)).toEqual(expect.arrayContaining(['boom one', 'boom two']));
    expect(probe.consume('error')).toHaveLength(0);
  });

  it('runProbe summary returns count', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new ConsoleProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    await page.evaluate(() => console.error('x'));
    await page.waitForTimeout(50);

    const r = await probe.runProbe('console_errors_since', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.error_count).toBe(1);
    }
  });

  // Phase 12: categorize app_error vs resource_error so "Failed to load
  // resource: net::ERR_CONNECTION_CLOSED" noise doesn't count as a product
  // bug. Dillinger had 15 of these from blocked third-party trackers.
  it('classifies "Failed to load resource: net::ERR_..." as resource_error, not app_error', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new ConsoleProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    probe.pushExternal('error', 'Failed to load resource: net::ERR_CONNECTION_CLOSED');
    probe.pushExternal('error', 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED');
    await page.evaluate(() => console.error('actual app bug'));
    await page.waitForTimeout(50);

    const r = await probe.runProbe('console_errors_since', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.app_error_count).toBe(1);
    expect(r.summary.resource_error_count).toBe(2);
    // Backwards-compat: error_count now reflects ONLY app errors.
    expect(r.summary.error_count).toBe(1);
  });

  it('classifies Iris probe-injection CSP errors as instrumentation, not product app errors', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new ConsoleProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    probe.pushExternal(
      'error',
      "Executing inline script violates the following Content Security Policy directive 'script-src self'. The action has been blocked.",
    );

    const r = await probe.runProbe('console_errors_since', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.error_count).toBe(0);
    expect(r.summary.app_error_count).toBe(0);
    expect(r.summary.instrumentation_error_count).toBe(1);
  });
});
