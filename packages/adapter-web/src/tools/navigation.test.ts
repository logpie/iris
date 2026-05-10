import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { back, forward, navigate, reload, scroll, waitFor } from './navigation.js';

describe('navigation tools', () => {
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

  it('navigate moves to a URL', async () => {
    server = await startFixtureServer('two-pages');
    const r = await navigate(lc.getPage(), { url: `${server.url}/index.html` });
    expect(r.ok).toBe(true);
    expect(lc.getPage().url()).toBe(`${server.url}/index.html`);
  });

  it('back / forward navigate history', async () => {
    server = await startFixtureServer('two-pages');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    await navigate(page, { url: `${server.url}/about.html` });
    expect((await back(page, {})).ok).toBe(true);
    expect(page.url()).toBe(`${server.url}/index.html`);
    expect((await forward(page, {})).ok).toBe(true);
    expect(page.url()).toBe(`${server.url}/about.html`);
  });

  it('reload re-fetches the current page', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await reload(page, {});
    expect(r.ok).toBe(true);
    expect(page.url()).toBe(`${server.url}/index.html`);
  });

  it('scroll moves the page (pixel offsets)', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await scroll(page, { dx: 0, dy: 200 });
    expect(r.ok).toBe(true);
  });

  it('waitFor a present selector resolves quickly', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await waitFor(page, { selector: '#greeting', timeout_ms: 2000 });
    expect(r.ok).toBe(true);
  });

  it('waitFor a missing selector returns ok=false on timeout', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await waitFor(page, { selector: '#nothing-here', timeout_ms: 500 });
    expect(r.ok).toBe(false);
  });
});
