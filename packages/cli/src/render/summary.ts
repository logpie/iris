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
  // Phase 5 additions
  blocked?: boolean;
  blocked_reasons?: string[];
  goals_attempted?: number;
  goals_verified?: number;
  goals_total?: number;
  evidence_verified?: number;
  evidence_downgraded?: number;
  evidence_discarded?: number;
  exit_code?: number;
}

export function buildSummaryLine(input: SummaryInput): string {
  const out = {
    v: 2,
    score: round2(input.score),
    threshold_passed: input.threshold_passed,
    findings: input.findings,
    run_dir: input.run_dir,
    duration_s: input.duration_s,
    cost_usd: round2(input.cost_usd),
    caveats: input.caveats,
    ...(input.blocked !== undefined ? { blocked: input.blocked } : {}),
    ...(input.blocked_reasons ? { blocked_reasons: input.blocked_reasons } : {}),
    ...(input.goals_total !== undefined
      ? {
          coverage: {
            attempted: input.goals_attempted ?? 0,
            verified: input.goals_verified ?? 0,
            total: input.goals_total,
          },
        }
      : {}),
    ...(input.evidence_verified !== undefined
      ? {
          evidence: {
            verified: input.evidence_verified,
            downgraded: input.evidence_downgraded ?? 0,
            discarded: input.evidence_discarded ?? 0,
          },
        }
      : {}),
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
  };
  return `${JSON.stringify(out)}\n`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
