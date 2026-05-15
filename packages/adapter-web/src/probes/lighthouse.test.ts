import { describe, expect, it } from 'vitest';
import { clearLighthouseCache, runLighthouse } from './lighthouse.js';

const RUN_HEAVY = process.env.IRIS_RUN_HEAVY_TESTS === '1';

describe('lighthouse probe', () => {
  it('clearLighthouseCache is callable', () => {
    expect(() => clearLighthouseCache()).not.toThrow();
  });

  it.skipIf(!RUN_HEAVY)(
    'runs against a real URL when IRIS_RUN_HEAVY_TESTS=1',
    async () => {
      // This test only runs when explicitly opted in. It launches a heavy lighthouse process.
      // Requires lighthouse to be installed and Chrome available.
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto('https://example.com');
        const r = await runLighthouse(page);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(r.summary).toBeDefined();
      } finally {
        await browser.close();
      }
    },
    120000,
  );
});
