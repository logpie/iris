import type {
  DiscoveryCapability,
  DiscoveryCoveragePlan,
  DiscoveryGoal,
  DiscoveryJourney,
  DiscoverySurface,
  ProductUseContract,
} from '../discovery/discovery.js';
import { deriveDiscoveryCapabilitiesForReport } from '../discovery/discovery.js';
import {
  type ExpectedJudgeGoal,
  reconcileJudgeGoalStatusesWithTrace,
} from '../judge/goal-status-reconciler.js';
import type { JudgeOutput } from '../judge/judge.js';
import { type TaskRun, buildTaskRuns } from '../task-runs/task-runs.js';
import { findingHash } from '../trace/identity.js';
import { buildTraceIndexById, resolveTraceRefTypo } from '../trace/ref-resolver.js';
import type { TraceEvent } from '../trace/schema.js';
import { type ReportEvaluation, deriveReportEvaluation } from './evaluation.js';
import { normalizeReportMeta, normalizeReportScores } from './score-normalization.js';
import { type TestingPlan, deriveTestingPlan } from './testing-plan.js';

export interface ReportRunMeta {
  id: string;
  target: { kind: string; url: string };
  transport?: string;
  mode: string;
  started_at: string;
  ended_at: string;
  duration_s: number;
  cost_usd: number;
  models: { discovery?: string; explorer: string; judge: string };
  reasoning_efforts?: { discovery?: string; explorer?: string; judge?: string };
  termination: string;
  step_count: number;
  spec_input_path?: string;
  usage?: ReportTokenUsageSummary;
}

export interface ReportTokenUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  non_cached_input_tokens?: number;
  output_tokens: number;
  total_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface ReportTokenUsageSummary {
  total?: ReportTokenUsage;
  last?: ReportTokenUsage;
  phases?: Record<string, { total?: ReportTokenUsage; last?: ReportTokenUsage }>;
}

export interface ReportArtifacts {
  report_html?: string;
  report_md?: string;
  trace?: string;
  trace_zip?: string;
  video?: string;
  judge_error?: string;
  judge_raw?: string;
  clips?: Record<string, string>;
}

export interface PreflightReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  screenshot?: string;
}

export interface DiscoveryReport {
  product_description?: string;
  goals?: DiscoveryGoal[];
  surfaces?: DiscoverySurface[];
  journeys?: DiscoveryJourney[];
  capabilities?: DiscoveryCapability[];
  coverage_plan?: DiscoveryCoveragePlan;
  product_use_contract?: ProductUseContract;
  survey_summary?: string;
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
  expected_goals?: ExpectedJudgeGoal[];
}

export interface ReportJson {
  // Bumped to v:2 in Phase 5 to signal new schema additions (preflight,
  // evidence_validation, finding_hash, expanded goal status enum,
  // goals_attempted/verified in headline). Old consumers should treat v:1
  // and v:2 as forward-compatible — the additions are all optional.
  v: 2;
  _written_at: string;
  tool: { name: 'iris'; version: string };
  threshold?: number;
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
  // Separates the Judge's product-quality score from Iris's confidence in the
  // evidence gathered during this run. Partial/untested goals should lower
  // evidence confidence, not be silently misread as product defects.
  evaluation?: ReportEvaluation;
  discovery?: DiscoveryReport;
  testing_plan?: TestingPlan;
  task_runs?: TaskRun[];
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
  return countGoalsForHeadline(judge.spec_compliance.goals);
}

function countGoalsForHeadline(goals: JudgeOutput['spec_compliance']['goals']): {
  total: number;
  attempted: number;
  verified: number;
} {
  let attempted = 0;
  let verified = 0;
  for (const g of goals) {
    if (ATTEMPTED_STATUSES.has(g.status)) attempted++;
    if (VERIFIED_STATUSES.has(g.status)) verified++;
  }
  return { total: goals.length, attempted, verified };
}

export function buildReportJson(inp: BuildReportJsonInputs): ReportJson {
  const reconciledJudge = inp.trace_events
    ? reconcileJudgeGoalStatusesWithTrace({
        judge: inp.judge,
        trace: inp.trace_events,
        ...(inp.expected_goals ? { expected_goals: inp.expected_goals } : {}),
      }).judge
    : inp.judge;
  const judge = resolveJudgeEvidenceRefs(reconciledJudge, inp.trace_events);
  const counts = countSeverities(judge.findings);
  const scores = normalizeReportScores(judge.scores, {
    traceEvents: inp.trace_events,
    confidenceCaveats: judge.meta.confidence_caveats,
  });
  const meta = normalizeReportMeta(judge.meta, inp.trace_events);
  const score = scores.overall.score;
  const coverage = countAttemptedGoals(judge);
  // Phase 12: threshold check is no longer just "score ≥ threshold." A high
  // score on a barely-tested product was passing — Dillinger scored 5.2 with
  // 3/12 coverage and "passed" because the (default null) threshold check
  // returned true. Now: threshold passes only if score meets the bar AND at
  // least 50% of goals were attempted AND there are no blocker findings.
  // No explicit threshold means "passes with caveats" only when coverage and
  // findings are clean.
  const baseThresholdPassed = computeBaseThresholdPassed({
    score,
    blocked: Boolean(inp.blocked),
    counts,
    coverage,
    ...(inp.threshold !== undefined ? { threshold: inp.threshold } : {}),
  });

  // Phase 5 G4: compute a stable finding_hash for every finding. Uses content
  // hashes of the cited trace events when available, so the same finding from
  // two runs of the same app produces the same hash.
  const eventIndex = new Map<string, { content_hash?: string }>();
  if (inp.trace_events) {
    for (const e of inp.trace_events) {
      eventIndex.set(e.id, { ...(e.content_hash ? { content_hash: e.content_hash } : {}) });
    }
  }
  const findingsWithHash = judge.findings.map((f) => ({
    ...f,
    finding_hash: findingHash(f, eventIndex),
  }));
  const discovery = extractDiscoveryReport(inp.trace_events);
  const testingPlan = deriveTestingPlan({
    discovery,
    goals: judge.spec_compliance.applicable ? judge.spec_compliance.goals : [],
  });
  const taskRuns =
    inp.trace_events && judge.spec_compliance.applicable && inp.run.termination !== 'judge_failed'
      ? buildTaskRuns({ goals: judge.spec_compliance.goals, trace: inp.trace_events })
      : [];

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

  const evaluation = deriveReportEvaluation({
    score,
    scores,
    goals: judge.spec_compliance.goals,
    findings: findingsWithHash,
    meta,
    capabilities: discovery?.capabilities,
  });
  const threshold_passed =
    baseThresholdPassed && evaluation.product_score.authority === 'authoritative';

  const headline: ReportJson['headline'] = {
    score,
    threshold_passed,
    blockers: counts.blocker,
    majors: counts.major,
    minors: counts.minor,
    nits: counts.nit,
    suggestions: counts.suggestion,
    ...(judge.spec_compliance.applicable
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
    ...(inp.threshold !== undefined ? { threshold: inp.threshold } : {}),
    run: inp.run,
    headline,
    scores,
    spec_compliance: judge.spec_compliance,
    findings: findingsWithHash,
    coverage_review: judge.coverage_review,
    meta,
    evaluation,
    ...(discovery ? { discovery } : {}),
    ...(testingPlan ? { testing_plan: testingPlan } : {}),
    ...(taskRuns.length > 0 ? { task_runs: taskRuns } : {}),
    ...(inp.artifacts ? { artifacts: inp.artifacts } : {}),
    ...(inp.preflight ? { preflight: inp.preflight } : {}),
    ...(judge.evidence_validation ? { evidence_validation: judge.evidence_validation } : {}),
    ...(judge.discarded_findings && judge.discarded_findings.length > 0
      ? { discarded_findings: judge.discarded_findings }
      : {}),
    ...(judge.access_blocks && judge.access_blocks.length > 0
      ? { access_blocks: judge.access_blocks }
      : {}),
    next_actions: {
      for_builder,
      for_re_evaluation: meta.would_re_explore_with,
    },
  };
}

function computeThresholdPassed(inp: {
  score: number;
  threshold?: number;
  blocked: boolean;
  counts: ReturnType<typeof countSeverities>;
  coverage: ReturnType<typeof countGoalsForHeadline>;
  scoreAuthority: ReportEvaluation['product_score']['authority'];
}): boolean {
  return computeBaseThresholdPassed(inp) && inp.scoreAuthority === 'authoritative';
}

function computeBaseThresholdPassed(inp: {
  score: number;
  threshold?: number;
  blocked: boolean;
  counts: ReturnType<typeof countSeverities>;
  coverage: ReturnType<typeof countGoalsForHeadline>;
}): boolean {
  const COVERAGE_FLOOR = 0.5;
  const coverageRatio = inp.coverage.total > 0 ? inp.coverage.attempted / inp.coverage.total : 1;
  const scorePass = inp.threshold === undefined ? true : inp.score >= inp.threshold;
  const coveragePass = inp.coverage.total === 0 || coverageRatio >= COVERAGE_FLOOR;
  const noBlockingFindings = inp.counts.blocker === 0 && inp.counts.major === 0;
  return !inp.blocked && scorePass && coveragePass && noBlockingFindings;
}

export function refreshReportJsonDerivedFields(
  report: ReportJson,
  opts: {
    threshold?: number;
    run?: ReportRunMeta;
    trace_events?: TraceEvent[];
    expected_goals?: ExpectedJudgeGoal[];
  } = {},
): ReportJson {
  const threshold = opts.threshold ?? report.threshold;
  const run = opts.run ?? report.run;
  const reportJudge = reportJsonToJudgeOutput(report);
  const reconciledJudge = opts.trace_events
    ? reconcileJudgeGoalStatusesWithTrace({
        judge: reportJudge,
        trace: opts.trace_events,
        ...(opts.expected_goals ? { expected_goals: opts.expected_goals } : {}),
      }).judge
    : reportJudge;
  const specCompliance = reconciledJudge.spec_compliance;
  const meta = normalizeReportMeta(report.meta, opts.trace_events);
  const scores = normalizeReportScores(report.scores, {
    ...(opts.trace_events ? { traceEvents: opts.trace_events } : {}),
    confidenceCaveats: meta.confidence_caveats,
  });
  const score = scores.overall.score;
  const counts = countSeverities(report.findings);
  const coverage = countGoalsForHeadline(specCompliance.goals);
  const evaluation = deriveReportEvaluation({
    score,
    scores,
    goals: specCompliance.goals,
    findings: report.findings,
    meta,
    capabilities: report.discovery?.capabilities,
  });
  const blocked = report.headline.blocked === true;
  const threshold_passed = computeThresholdPassed({
    score,
    blocked,
    counts,
    coverage,
    scoreAuthority: evaluation.product_score.authority,
    ...(threshold !== undefined ? { threshold } : {}),
  });
  return {
    ...report,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(opts.run ? { run } : {}),
    headline: {
      ...report.headline,
      score,
      threshold_passed,
      blockers: counts.blocker,
      majors: counts.major,
      minors: counts.minor,
      nits: counts.nit,
      suggestions: counts.suggestion,
      ...(specCompliance.applicable
        ? {
            goals_attempted: coverage.attempted,
            goals_verified: coverage.verified,
            goals_total: coverage.total,
          }
        : {}),
    },
    spec_compliance: specCompliance,
    scores,
    meta,
    evaluation,
    ...(opts.trace_events
      ? {
          task_runs:
            specCompliance.applicable && run.termination !== 'judge_failed'
              ? buildTaskRuns({ goals: specCompliance.goals, trace: opts.trace_events })
              : [],
        }
      : {}),
    next_actions: {
      ...report.next_actions,
      for_re_evaluation: meta.would_re_explore_with,
    },
  };
}

function reportJsonToJudgeOutput(report: ReportJson): JudgeOutput {
  return {
    v: 1,
    findings: report.findings,
    discarded_findings: report.discarded_findings ?? [],
    scores: report.scores,
    spec_compliance: report.spec_compliance,
    coverage_review: report.coverage_review,
    meta: report.meta,
    access_blocks: report.access_blocks ?? [],
    ...(report.evidence_validation ? { evidence_validation: report.evidence_validation } : {}),
  };
}

function resolveJudgeEvidenceRefs(
  judge: JudgeOutput,
  traceEvents: TraceEvent[] | undefined,
): JudgeOutput {
  if (!traceEvents || traceEvents.length === 0) return judge;
  const traceIndexById = buildTraceIndexById(traceEvents);
  const resolveRefs = (refs: string[]) =>
    refs.map((ref) => resolveTraceRefTypo(ref, traceEvents, traceIndexById) ?? ref);
  return {
    ...judge,
    findings: judge.findings.map((finding) => ({
      ...finding,
      evidence: resolveRefs(finding.evidence),
    })),
    scores: {
      ...judge.scores,
      profiles: Object.fromEntries(
        Object.entries(judge.scores.profiles).map(([profileName, profile]) => [
          profileName,
          {
            ...profile,
            dimensions: Object.fromEntries(
              Object.entries(profile.dimensions).map(([dimensionName, dimension]) => [
                dimensionName,
                { ...dimension, evidence: resolveRefs(dimension.evidence) },
              ]),
            ),
          },
        ]),
      ),
    },
    spec_compliance: {
      ...judge.spec_compliance,
      goals: judge.spec_compliance.goals.map((goal) => ({
        ...goal,
        evidence: resolveRefs(goal.evidence),
      })),
    },
    ...(judge.access_blocks
      ? {
          access_blocks: judge.access_blocks.map((block) => ({
            ...block,
            evidence: resolveRefs(block.evidence),
          })),
        }
      : {}),
  };
}

function extractDiscoveryReport(events: TraceEvent[] | undefined): DiscoveryReport | undefined {
  const discoveryEvent = [...(events ?? [])].reverse().find((event) => event.kind === 'discovery');
  if (!discoveryEvent) return undefined;
  const payload = discoveryEvent.payload as Record<string, unknown>;
  const discovery: DiscoveryReport = {
    ...(typeof payload.product_description === 'string'
      ? { product_description: payload.product_description }
      : {}),
    ...(Array.isArray(payload.goals) ? { goals: payload.goals as DiscoveryGoal[] } : {}),
    ...(Array.isArray(payload.surfaces)
      ? { surfaces: payload.surfaces as DiscoverySurface[] }
      : {}),
    ...(Array.isArray(payload.journeys)
      ? { journeys: payload.journeys as DiscoveryJourney[] }
      : {}),
    ...(Array.isArray(payload.capabilities)
      ? { capabilities: payload.capabilities as DiscoveryCapability[] }
      : {}),
    ...(payload.coverage_plan && typeof payload.coverage_plan === 'object'
      ? { coverage_plan: payload.coverage_plan as DiscoveryCoveragePlan }
      : {}),
    ...(payload.product_use_contract && typeof payload.product_use_contract === 'object'
      ? { product_use_contract: payload.product_use_contract as ProductUseContract }
      : {}),
    ...(typeof payload.survey_summary === 'string'
      ? { survey_summary: payload.survey_summary }
      : {}),
  };
  const capabilities = deriveDiscoveryCapabilitiesForReport({
    capabilities: discovery.capabilities,
    product_use_contract: discovery.product_use_contract,
    journeys: discovery.journeys,
    surfaces: discovery.surfaces,
    coverage_plan: discovery.coverage_plan,
    goals: discovery.goals,
  });
  return capabilities.length > 0 ? { ...discovery, capabilities } : discovery;
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
