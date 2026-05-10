import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebLifecycle } from './lifecycle.js';

describe('WebLifecycle', () => {
  let lc: WebLifecycle;

  beforeEach(() => {
    lc = new WebLifecycle({ headless: true });
  });

  afterEach(async () => {
    await lc.stop();
  });

  it('start launches Chromium and exposes a Page', async () => {
    await lc.start();
    const page = lc.getPage();
    expect(page).toBeDefined();
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
  });

  it('stop closes the browser; getPage after stop throws', async () => {
    await lc.start();
    await lc.stop();
    expect(() => lc.getPage()).toThrow(/not running/i);
  });

  it('start is idempotent (second call is a no-op)', async () => {
    await lc.start();
    const p1 = lc.getPage();
    await lc.start();
    const p2 = lc.getPage();
    expect(p1).toBe(p2);
  });
});
