import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from 'playwright';
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

  it('reports all responses with a failure count', async () => {
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

    const r = await probe.runProbe('network_all_since', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.count).toBeGreaterThanOrEqual(1);
      expect(r.summary.failure_count).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(r.data)).toBe(true);
    }
  });

  it('captures requestfailed events with first-party API details', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await page.route('**/api/fail', (route) => route.abort('failed'));
    const probe = new NetworkProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    await page.evaluate(async (base) => {
      try {
        await fetch(`${base}/api/fail`);
      } catch {}
    }, server.url);
    await page.waitForTimeout(100);

    const r = await probe.runProbe('network_failures_since', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toMatchObject({
      first_party_failure_count: expect.any(Number),
      api_failure_count: expect.any(Number),
      first_party_api_failure_count: expect.any(Number),
    });
    const failures = r.data as Array<Record<string, unknown>>;
    const apiFailure = failures.find((entry) => String(entry.url).endsWith('/api/fail'));
    expect(apiFailure).toMatchObject({
      status: 0,
      ok: false,
      first_party: true,
      api_like: true,
      failure_kind: 'requestfailed',
    });
    expect(apiFailure?.failure_text).toBeTruthy();
  });

  it('tracks timing by Request object when concurrent requests share a URL', async () => {
    const page = new FakePage('http://app.test/') as unknown as Page;
    const probe = new NetworkProbe(page);
    probe.attach();
    const req1 = fakeRequest('http://app.test/api/items');
    const req2 = fakeRequest('http://app.test/api/items');

    const realNow = Date.now;
    try {
      let now = 1_000;
      Date.now = () => now;
      (page as unknown as FakePage).emit('request', req1);
      now = 1_100;
      (page as unknown as FakePage).emit('request', req2);
      now = 1_150;
      (page as unknown as FakePage).emit('response', fakeResponse(req2, 200));
      now = 1_300;
      (page as unknown as FakePage).emit('response', fakeResponse(req1, 200));
    } finally {
      Date.now = realNow;
    }

    const r = await probe.runProbe('network_all_since', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = r.data as Array<{ ms: number; url: string }>;
    expect(entries.map((entry) => entry.ms)).toEqual([50, 300]);
  });

  it('classifies first-party from request-start page URL and content-type API hints', async () => {
    const page = new FakePage('http://app.test/start') as unknown as Page;
    const probe = new NetworkProbe(page);
    probe.attach();
    const req = fakeRequest('http://app.test/orders', {
      method: 'POST',
      headers: { accept: '*/*', 'content-type': 'application/json' },
      resourceType: 'document',
    });

    (page as unknown as FakePage).emit('request', req);
    (page as unknown as FakePage).setUrl('http://other.test/redirected');
    (page as unknown as FakePage).emit('response', fakeResponse(req, 500));

    const r = await probe.runProbe('network_all_since', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [entry] = r.data as Array<{ first_party: boolean; api_like: boolean }>;
    expect(entry).toMatchObject({ first_party: true, api_like: true });
  });
});

class FakePage extends EventEmitter {
  constructor(private currentUrl: string) {
    super();
  }

  url(): string {
    return this.currentUrl;
  }

  setUrl(url: string): void {
    this.currentUrl = url;
  }
}

function fakeRequest(
  url: string,
  opts: {
    method?: string;
    resourceType?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  return {
    url: () => url,
    method: () => opts.method ?? 'GET',
    resourceType: () => opts.resourceType ?? 'fetch',
    headers: () => opts.headers ?? { accept: 'application/json' },
    failure: () => null,
  } as unknown as Request;
}

function fakeResponse(req: Request, status: number): Response {
  return {
    url: () => req.url(),
    status: () => status,
    request: () => req,
  } as unknown as Response;
}
