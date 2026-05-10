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
});
