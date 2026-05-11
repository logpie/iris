import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionWithRetry } from './retry.js';

const HTML = `<!doctype html>
<html><body>
  <h1>Title A</h1>
  <h1>Title B</h1>
  <button id="primary">Sign in</button>
  <button>Sign in</button>
  <a href="#signup">Sign up here</a>
</body></html>
`;

describe('actionWithRetry', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(HTML);
  });
  afterEach(async () => {
    await page.close();
  });

  it('succeeds first try when selector is unambiguous', async () => {
    const r = await actionWithRetry(page, '#primary', (l) => l.click({ timeout: 2000 }));
    expect(r.ok).toBe(true);
    expect(r.retried).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toEqual({ strategy: 'original', ok: true });
  });

  it('retries with .first() on strict-mode-violation, succeeds', async () => {
    const r = await actionWithRetry(page, 'h1', (l) =>
      l.waitFor({ state: 'visible', timeout: 2000 }),
    );
    expect(r.ok).toBe(true);
    expect(r.retried).toBe(true);
    expect(r.retry_count).toBe(1);
    expect(r.attempts[1]).toEqual({ strategy: 'first', ok: true });
  });

  it('retries with .first() when two buttons match', async () => {
    const r = await actionWithRetry(page, 'button', (l) => l.click({ timeout: 2000 }));
    expect(r.ok).toBe(true);
    expect(r.retried).toBe(true);
    expect(r.attempts.find((a) => a.strategy === 'first')?.ok).toBe(true);
  });

  it('returns failure when no retry strategy resolves the issue', async () => {
    const r = await actionWithRetry(page, '#does-not-exist', (l) => l.click({ timeout: 1000 }));
    expect(r.ok).toBe(false);
    expect(r.retried).toBe(true);
    // The original error should bubble up, not a downstream retry error
    expect(r.error).toMatch(/Timeout|does-not-exist|no element/i);
  });

  it('respects allowRetry: false', async () => {
    const r = await actionWithRetry(page, 'h1', (l) => l.click({ timeout: 1000 }), {
      timeoutMs: 1000,
      allowRetry: false,
    });
    expect(r.ok).toBe(false);
    expect(r.retried).toBe(false);
    expect(r.attempts).toHaveLength(1);
  });
});
