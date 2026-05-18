import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { runMobileViewport } from './mobile-viewport.js';

describe('runMobileViewport', () => {
  it('restores the original viewport after capture by default', async () => {
    const page = fakePage({ width: 1280, height: 720 });

    const r = await runMobileViewport(page, { width: 375, height: 667 });

    expect(r.ok).toBe(true);
    expect(page.setCalls).toEqual([
      { width: 375, height: 667 },
      { width: 1280, height: 720 },
    ]);
    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  });

  it('leaves the mobile viewport active when explicitly persisted', async () => {
    const page = fakePage({ width: 1280, height: 720 });

    const r = await runMobileViewport(page, { width: 390, height: 844, persist: true });

    expect(r.ok).toBe(true);
    expect(page.setCalls).toEqual([{ width: 390, height: 844 }]);
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  });

  it('restores the original viewport even when capture fails', async () => {
    const page = fakePage({ width: 1280, height: 720 }, { evaluateError: new Error('boom') });

    const r = await runMobileViewport(page, { width: 375, height: 667 });

    expect(r.ok).toBe(false);
    expect(page.setCalls).toEqual([
      { width: 375, height: 667 },
      { width: 1280, height: 720 },
    ]);
    expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  });
});

function fakePage(
  initialViewport: { width: number; height: number },
  opts: { evaluateError?: Error } = {},
) {
  let viewport = initialViewport;
  const page = {
    setCalls: [] as Array<{ width: number; height: number }>,
    viewportSize: () => viewport,
    setViewportSize: async (next: { width: number; height: number }) => {
      viewport = next;
      page.setCalls.push(next);
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => {
      if (opts.evaluateError) throw opts.evaluateError;
      return {
        url: 'http://example.test/',
        title: 'Example',
        viewport,
        scroll: { x: 0, y: 0 },
        document: {
          scrollWidth: viewport.width,
          clientWidth: viewport.width,
          bodyScrollWidth: viewport.width,
          hasHorizontalOverflow: false,
        },
        visibleText: 'Example',
      };
    },
  } as unknown as Page & {
    setCalls: Array<{ width: number; height: number }>;
  };
  return page;
}
