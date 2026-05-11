// Preflight orchestration — runs all four checks against an adapter's
// preflightProbe() result. Returns a structured result the orchestrator
// translates into either an early-exit blocked report or a continue-as-normal
// trace event.

import type { PreflightProbe, TargetAdapter } from '@iris/adapter-types';
import {
  checkBodyHasContent,
  checkConsoleClean,
  checkHttpStatus,
  checkPageReady,
} from './checks.js';

export interface PreflightResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  screenshot?: string;
  probe: PreflightProbe;
}

export async function runPreflight(
  adapter: TargetAdapter,
  opts: { timeoutS: number },
): Promise<PreflightResult> {
  if (!adapter.preflightProbe) {
    // Adapter doesn't support preflight — treat as pass.
    return {
      ok: true,
      checks: [],
      probe: {
        httpStatus: 0,
        loadFinished: true,
        consoleMessages: [],
        bodyStats: { textChars: 0, interactiveCount: 0 },
      },
    };
  }

  const probe = await adapter.preflightProbe(opts);

  // Run all four checks regardless of individual failures — the user benefits
  // from seeing the full set of failed checks, not just the first one.
  const checks = [
    checkHttpStatus(probe.httpStatus, probe.gotoErrorKind),
    checkPageReady(probe.loadFinished, opts.timeoutS),
    checkConsoleClean(probe.consoleMessages),
    checkBodyHasContent(probe.bodyStats),
  ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
    ...(probe.screenshot ? { screenshot: probe.screenshot } : {}),
    probe,
  };
}
