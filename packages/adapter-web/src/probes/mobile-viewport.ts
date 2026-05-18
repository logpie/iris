import type { ProbeResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

interface MobileViewportArgs {
  width?: number;
  height?: number;
  persist?: boolean;
}

export async function runMobileViewport(
  page: Page,
  args: MobileViewportArgs = {},
): Promise<ProbeResult> {
  const width = boundedInt(args.width, 390, 240, 640);
  const height = boundedInt(args.height, 844, 480, 1200);
  const persist = args.persist === true;
  const previousViewport = page.viewportSize();
  let result: ProbeResult;
  try {
    await page.setViewportSize({ width, height });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
    const data = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const rootWidth = root?.scrollWidth ?? 0;
      const bodyWidth = body?.scrollWidth ?? 0;
      const visibleText = (body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        document: {
          scrollWidth: rootWidth,
          clientWidth: root?.clientWidth ?? window.innerWidth,
          bodyScrollWidth: bodyWidth,
          hasHorizontalOverflow:
            rootWidth > window.innerWidth + 2 || bodyWidth > window.innerWidth + 2,
        },
        visibleText,
      };
    });
    result = {
      ok: true,
      probe: 'mobile_viewport',
      summary: {
        viewport: data.viewport,
        horizontal_overflow: data.document.hasHorizontalOverflow,
        url: data.url,
      },
      data: {
        ...data,
        previousViewport,
      },
    };
  } catch (err) {
    result = {
      ok: false,
      probe: 'mobile_viewport',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!persist && previousViewport) {
      try {
        await page.setViewportSize(previousViewport);
      } catch (err) {
        const restoreError = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          probe: 'mobile_viewport',
          error: `mobile_viewport restore failed: ${restoreError}`,
        };
      }
    }
  }
  return result;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
