export interface SummaryInput {
  score: number;
  threshold_passed: boolean;
  findings: {
    blocker: number;
    major: number;
    minor: number;
    nit: number;
    suggestion: number;
  };
  run_dir: string;
  duration_s: number;
  cost_usd: number;
  caveats: number;
}

export function buildSummaryLine(input: SummaryInput): string {
  const out = {
    v: 1,
    score: round2(input.score),
    threshold_passed: input.threshold_passed,
    findings: input.findings,
    run_dir: input.run_dir,
    duration_s: input.duration_s,
    cost_usd: round2(input.cost_usd),
    caveats: input.caveats,
  };
  return `${JSON.stringify(out)}\n`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
