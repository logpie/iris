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

    // Phase 14: include violation rule IDs + impact in the summary so the
    // Judge (which reads the trace digest, not the full data payload) can
    // emit actionable findings. "2 axe violations" without rule names is
    // unactionable; "color-contrast (serious) + aria-required-children
    // (critical)" is.
    const impactRank: Record<string, number> = {
      critical: 4,
      serious: 3,
      moderate: 2,
      minor: 1,
    };
    const rankedViolations = [...results.violations].sort(
      (a, b) => (impactRank[b.impact ?? ''] ?? 0) - (impactRank[a.impact ?? ''] ?? 0),
    );
    const topRules = rankedViolations.slice(0, 8).map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      node_count: v.nodes.length,
    }));
    return {
      ok: true,
      probe: 'axe',
      summary: {
        violations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        inapplicable: results.inapplicable.length,
        top_rules: topRules,
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
