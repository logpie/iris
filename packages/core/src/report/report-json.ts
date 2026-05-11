import type { JudgeOutput } from '../judge/judge.js';
import { findingHash } from '../trace/identity.js';
import type { TraceEvent } from '../trace/schema.js';

export interface ReportRunMeta {
  id: string;
  target: { kind: string; url: string };
  mode: string;
  started_at: string;
  ended_at: string;
  duration_s: number;
  cost_usd: number;
  models: { explorer: string; judge: string };
  termination: string;
  step_count: number;
  spec_input_path?: string;
}

export interface ReportArtifacts {
  report_html?: string;
  report_md?: string;
  trace?: string;
  trace_zip?: string;
  video?: string;
  clips?: Record<string, string>;
}

export interface PreflightReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  screenshot?: string;
}

export interface BuildReportJsonInputs {
  judge: JudgeOutput;
  run: ReportRunMeta;
  threshold?: number;
  artifacts?: ReportArtifacts;
  // Phase 5 additions:
  preflight?: PreflightReport;
  blocked?: { reasons: string[] };
  // Trace events (with content_hash), used to compute stable finding_hash for
  // cross-run diff. If omitted, finding_hash will fall back to per-id strings.
  trace_events?: TraceEvent[];
}

export interface ReportJson {
  // Bumped to v:2 in Phase 5 to signal new schema additions (preflight,
  // evidence_validation, finding_hash, expanded goal status enum,
  // goals_attempted/verified in headline). Old consumers should treat v:1
  // and v:2 as forward-compatible — the additions are all optional.
  v: 2;
  _written_at: string;
  tool: { name: 'iris'; version: string };
  run: ReportRunMeta;
  headline: {
    score: number;
    threshold_passed: boolean;
    blockers: number;
    majors: number;
    minors: number;
    nits: number;
    suggestions: number;
    // Phase 5: honest coverage numbers — score is averaged over attempted
    // goals (verified + partial + blocked). Untested/skipped goals appear
    // in spec_compliance but don't drag the score down.
    goals_attempted?: number;
    goals_verified?: number;
    goals_total?: number;
    blocked?: boolean;
    blocked_reasons?: string[];
  };
  scores: JudgeOutput['scores'];
  spec_compliance: JudgeOutput['spec_compliance'];
  findings: JudgeOutput['findings'];
  coverage_review: JudgeOutput['coverage_review'];
  meta: JudgeOutput['meta'];
  artifacts?: ReportArtifacts;
  preflight?: PreflightReport;
  evidence_validation?: { verified: number; downgraded: number; discarded: number };
  discarded_findings?: JudgeOutput['discarded_findings'];
  // Phase 8: things that blocked Iris from testing parts of the app — bot
  // detection, captchas, auth walls. Surfaced separately from findings
  // because they're not product defects a real user would see.
  access_blocks?: JudgeOutput['access_blocks'];
  next_actions: {
    // Phase 7 F7-3: for_builder entries carry the actionable bits Otto needs:
    // a one-line patch_hint and, when available, a code_pointer (selector +
    // attribute + suggested_value). Both optional — process findings have
    // neither.
    for_builder: Array<{
      finding_id: string;
      fix_priority: number;
      summary: string;
      patch_hint?: string;
      code_pointer?: {
        selector: string;
        attribute?: string | undefined;
        current_value?: string | undefined;
        suggested_value?: string | undefined;
      };
    }>;
    for_re_evaluation: string[];
  };
}

const TOOL_VERSION = '0.0.0';

// Coverage status helpers: which goal statuses count as "attempted" for scoring
// purposes. Untested/skipped are excluded from the denominator.
const ATTEMPTED_STATUSES = new Set([
  'verified',
  'satisfied',
  'partial',
  'blocked',
  'not_satisfied',
]);
const VERIFIED_STATUSES = new Set(['verified', 'satisfied']);

function countAttemptedGoals(judge: JudgeOutput): {
  total: number;
  attempted: number;
  verified: number;
} {
  const goals = judge.spec_compliance.goals;
  let attempted = 0;
  let verified = 0;
  for (const g of goals) {
    if (ATTEMPTED_STATUSES.has(g.status)) attempted++;
    if (VERIFIED_STATUSES.has(g.status)) verified++;
  }
  return { total: goals.length, attempted, verified };
}

export function buildReportJson(inp: BuildReportJsonInputs): ReportJson {
  const counts = countSeverities(inp.judge.findings);
  const score = inp.judge.scores.overall.score;
  const threshold_passed = inp.threshold === undefined ? true : score >= inp.threshold;
  const coverage = countAttemptedGoals(inp.judge);

  // Phase 5 G4: compute a stable finding_hash for every finding. Uses content
  // hashes of the cited trace events when available, so the same finding from
  // two runs of the same app produces the same hash.
  const eventIndex = new Map<string, { content_hash?: string }>();
  if (inp.trace_events) {
    for (const e of inp.trace_events) {
      eventIndex.set(e.id, { ...(e.content_hash ? { content_hash: e.content_hash } : {}) });
    }
  }
  const findingsWithHash = inp.judge.findings.map((f) => ({
    ...f,
    finding_hash: findingHash(f, eventIndex),
  }));

  const for_builder = findingsWithHash
    .map((f, idx) => ({ f, idx }))
    .sort((a, b) => severityRank(a.f.severity) - severityRank(b.f.severity))
    .slice(0, 10)
    .map(({ f }, i) => ({
      finding_id: f.id,
      fix_priority: i + 1,
      summary: f.suggested_fix?.summary ?? f.title,
      ...(f.suggested_fix?.patch_hint ? { patch_hint: f.suggested_fix.patch_hint } : {}),
      ...(f.suggested_fix?.code_pointer ? { code_pointer: f.suggested_fix.code_pointer } : {}),
    }));

  const headline: ReportJson['headline'] = {
    score,
    threshold_passed,
    blockers: counts.blocker,
    majors: counts.major,
    minors: counts.minor,
    nits: counts.nit,
    suggestions: counts.suggestion,
    ...(inp.judge.spec_compliance.applicable
      ? {
          goals_attempted: coverage.attempted,
          goals_verified: coverage.verified,
          goals_total: coverage.total,
        }
      : {}),
    ...(inp.blocked ? { blocked: true, blocked_reasons: inp.blocked.reasons } : {}),
  };

  return {
    v: 2,
    _written_at: new Date().toISOString(),
    tool: { name: 'iris', version: TOOL_VERSION },
    run: inp.run,
    headline,
    scores: inp.judge.scores,
    spec_compliance: inp.judge.spec_compliance,
    findings: findingsWithHash,
    coverage_review: inp.judge.coverage_review,
    meta: inp.judge.meta,
    ...(inp.artifacts ? { artifacts: inp.artifacts } : {}),
    ...(inp.preflight ? { preflight: inp.preflight } : {}),
    ...(inp.judge.evidence_validation
      ? { evidence_validation: inp.judge.evidence_validation }
      : {}),
    ...(inp.judge.discarded_findings && inp.judge.discarded_findings.length > 0
      ? { discarded_findings: inp.judge.discarded_findings }
      : {}),
    ...(inp.judge.access_blocks && inp.judge.access_blocks.length > 0
      ? { access_blocks: inp.judge.access_blocks }
      : {}),
    next_actions: {
      for_builder,
      for_re_evaluation: inp.judge.meta.would_re_explore_with,
    },
  };
}

function countSeverities(findings: JudgeOutput['findings']): {
  blocker: number;
  major: number;
  minor: number;
  nit: number;
  suggestion: number;
} {
  const out = { blocker: 0, major: 0, minor: 0, nit: 0, suggestion: 0 };
  for (const f of findings) {
    out[f.severity] = (out[f.severity] ?? 0) + 1;
  }
  return out;
}

function severityRank(s: string): number {
  switch (s) {
    case 'blocker':
      return 0;
    case 'major':
      return 1;
    case 'minor':
      return 2;
    case 'nit':
      return 3;
    default:
      return 4;
  }
}
