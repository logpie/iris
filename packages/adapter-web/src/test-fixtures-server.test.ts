import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../test-fixtures/server.js';

describe('startFixtureServer', () => {
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  it('serves a known fixture site and reports its URL', async () => {
    const handle = await startFixtureServer('hello');
    stop = handle.close;
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const r = await fetch(`${handle.url}/index.html`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('Hello from Iris fixture');
  });

  it('serves a sub-page for two-pages site', async () => {
    const handle = await startFixtureServer('two-pages');
    stop = handle.close;
    const r = await fetch(`${handle.url}/about.html`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('About');
  });

  it('returns 404 for a missing path', async () => {
    const handle = await startFixtureServer('hello');
    stop = handle.close;
    const r = await fetch(`${handle.url}/no-such-thing.html`);
    expect(r.status).toBe(404);
  });

  it('rejects unknown site names', async () => {
    await expect(startFixtureServer('nope-not-real')).rejects.toThrow(/site not found/i);
  });
});
