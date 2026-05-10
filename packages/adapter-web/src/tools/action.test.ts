import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { click, hover, press, type } from './action.js';

describe('action tools', () => {
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

  it('type fills an input', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await type(page, { selector: '#email', text: 'a@b.co' });
    expect(r.ok).toBe(true);
    const value = await page.locator('#email').inputValue();
    expect(value).toBe('a@b.co');
  });

  it('click submits a form (and the result text appears)', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    await type(page, { selector: '#email', text: 'a@b.co' });
    await type(page, { selector: '#password', text: 'pw' });
    const r = await click(page, { selector: '#submit' });
    expect(r.ok).toBe(true);
    await page.waitForFunction(() => document.getElementById('result')?.textContent !== '');
    const text = await page.locator('#result').textContent();
    expect(text).toContain('Signed in');
  });

  it('press sends a key (Enter on focused input submits the form)', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    await type(page, { selector: '#email', text: 'a@b.co' });
    await type(page, { selector: '#password', text: 'pw' });
    await page.locator('#password').focus();
    const r = await press(page, { key: 'Enter' });
    expect(r.ok).toBe(true);
  });

  it('hover does not throw on a present element', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await hover(page, { selector: '#email' });
    expect(r.ok).toBe(true);
  });

  it(
    'click on missing selector returns ok=false with error',
    async () => {
      server = await startFixtureServer('form');
      const page = lc.getPage();
      await page.goto(`${server.url}/index.html`);
      const r = await click(page, { selector: '#does-not-exist' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/timeout|not found/i);
    },
    { timeout: 10000 },
  );
});
