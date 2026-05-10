import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { domOutline } from './snapshot.js';

describe('domOutline', () => {
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

  it('produces a non-empty outline for hello fixture', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const outline = await domOutline(lc.getPage());
    expect(outline).toContain('Hello from Iris fixture');
    expect(outline).toMatch(/heading/i);
  });

  it('captures form inputs with their labels', async () => {
    server = await startFixtureServer('form');
    await lc.getPage().goto(`${server.url}/index.html`);
    const outline = await domOutline(lc.getPage());
    expect(outline).toMatch(/Email/);
    expect(outline).toMatch(/Password/);
    expect(outline).toMatch(/button.*Sign in/i);
  });

  it('strips script and style tags from the outline', async () => {
    server = await startFixtureServer('form');
    await lc.getPage().goto(`${server.url}/index.html`);
    const outline = await domOutline(lc.getPage());
    expect(outline).not.toMatch(/addEventListener/);
    expect(outline).not.toMatch(/<script>/i);
  });
});
