import { createRequire } from 'node:module';
import type { ProbeResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const require = createRequire(import.meta.url);
const AXE_SOURCE_PATH = require.resolve('axe-core/axe.min.js');

interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
}

interface AxeResults {
  violations: AxeViolation[];
  passes: Array<{ id: string }>;
  incomplete: Array<{ id: string }>;
  inapplicable: Array<{ id: string }>;
}

export async function runAxe(page: Page): Promise<ProbeResult> {
  try {
    await page.addScriptTag({ path: AXE_SOURCE_PATH });
    const results = (await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: () => Promise<unknown> } }).axe;
      return await axe.run();
    })) as AxeResults;

    return {
      ok: true,
      probe: 'axe',
      summary: {
        violations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        inapplicable: results.inapplicable.length,
      },
      data: {
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          help_url: v.helpUrl,
          nodes: v.nodes.map((n) => ({ html: n.html, target: n.target })),
        })),
      },
    };
  } catch (err) {
    return {
      ok: false,
      probe: 'axe',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
