import type { ProbeResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

interface LighthouseRunner {
  default: (
    url: string,
    flags: { port?: number; output?: string; logLevel?: string },
  ) => Promise<{ lhr: LighthouseResult } | null>;
}

interface LighthouseResult {
  categories: Record<string, { id: string; title: string; score: number | null }>;
  audits: Record<string, { id: string; title: string; score: number | null; description?: string }>;
  finalUrl?: string;
  lighthouseVersion?: string;
}

/**
 * Run lighthouse against the current page URL. This is HEAVY — it spawns its own
 * headless Chromium. Cache results per URL for 10 minutes to avoid re-running.
 */
const cache = new Map<string, { ts: number; result: ProbeResult }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function runLighthouse(page: Page): Promise<ProbeResult> {
  const url = page.url();
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    // Dynamic import: lighthouse is ESM-only and heavy; load lazily so import cost is paid only when used.
    const lh = (await import('lighthouse')) as unknown as LighthouseRunner;
    const result = await lh.default(url, { output: 'json', logLevel: 'error' });
    if (!result) {
      const r: ProbeResult = { ok: false, probe: 'lighthouse', error: 'lighthouse returned null' };
      cache.set(url, { ts: Date.now(), result: r });
      return r;
    }
    const lhr = result.lhr;
    const summary: Record<string, number | null> = {};
    for (const [name, cat] of Object.entries(lhr.categories)) {
      summary[name] = cat.score === null ? null : Math.round(cat.score * 100);
    }
    const probeResult: ProbeResult = {
      ok: true,
      probe: 'lighthouse',
      summary,
      data: {
        categories: lhr.categories,
        url: lhr.finalUrl,
        version: lhr.lighthouseVersion,
        // Don't include full audit detail — too heavy. Just a few key audit IDs.
        key_audits: {
          'first-contentful-paint': lhr.audits['first-contentful-paint'],
          'largest-contentful-paint': lhr.audits['largest-contentful-paint'],
          'cumulative-layout-shift': lhr.audits['cumulative-layout-shift'],
          'total-blocking-time': lhr.audits['total-blocking-time'],
        },
      },
    };
    cache.set(url, { ts: Date.now(), result: probeResult });
    return probeResult;
  } catch (err) {
    return {
      ok: false,
      probe: 'lighthouse',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function clearLighthouseCache(): void {
  cache.clear();
}
