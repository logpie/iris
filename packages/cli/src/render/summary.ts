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
  scenario_evidence_verified?: number;
  scenario_evidence_downgraded?: number;
  finding_evidence_verified?: number;
  finding_evidence_downgraded?: number;
  unsupported_finding_drafts_discarded?: number;
  /** @deprecated Use finding_evidence_* fields. */
  evidence_verified?: number;
  /** @deprecated Use finding_evidence_* fields. */
  evidence_downgraded?: number;
  /** @deprecated Use unsupported_finding_drafts_discarded. */
  evidence_discarded?: number;
  exit_code?: number;
}

export function buildSummaryLine(input: SummaryInput): string {
  const findingEvidenceVerified = input.finding_evidence_verified ?? input.evidence_verified;
  const findingEvidenceDowngraded =
    input.finding_evidence_downgraded ?? input.evidence_downgraded;
  const findingDraftsDiscarded =
    input.unsupported_finding_drafts_discarded ?? input.evidence_discarded;
  const out = {
    v: 3,
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
    ...(input.scenario_evidence_verified !== undefined
      ? {
          scenario_evidence: {
            verified: input.scenario_evidence_verified,
            downgraded: input.scenario_evidence_downgraded ?? 0,
          },
        }
      : {}),
    ...(findingEvidenceVerified !== undefined || findingDraftsDiscarded !== undefined
      ? {
          finding_evidence: {
            verified: findingEvidenceVerified ?? 0,
            downgraded: findingEvidenceDowngraded ?? 0,
            unsupported_drafts_discarded: findingDraftsDiscarded ?? 0,
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
