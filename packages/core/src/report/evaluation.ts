import type {
  DiscoveryCapability,
  DiscoveryCapabilitySelectionExpectation,
} from '../discovery/discovery.js';
import type { JudgeOutput } from '../judge/judge.js';

type Scores = JudgeOutput['scores'];
type Goal = JudgeOutput['spec_compliance']['goals'][number];
type Finding = JudgeOutput['findings'][number];
type Meta = JudgeOutput['meta'];

export type ScoreAuthority = 'authoritative' | 'provisional' | 'insufficient';
export type EvidenceConfidenceLevel = 'high' | 'medium' | 'low';

export interface ReportEvaluation {
  product_score: {
    value: number;
    label: string;
    authority: ScoreAuthority;
    interpretation: string;
  };
  evidence_confidence: {
    score: number;
    level: EvidenceConfidenceLevel;
    label: string;
    rationale: string;
    reasons: string[];
    goal_counts: GoalEvaluationCounts;
  };
  capability_coverage?: CapabilityCoverageSummary;
}

export interface GoalEvaluationCounts {
  total: number;
  attempted: number;
  verified: number;
  partial: number;
  blocked: number;
  skipped: number;
  untested: number;
}

export interface CapabilityCoverageSummary {
  total: number;
  covered: number;
  partial: number;
  untested: number;
  deferred: number;
  important_total: number;
  important_covered: number;
  important_partial: number;
  important_skipped: number;
  must_total: number;
  must_covered: number;
  must_skipped: number;
  should_total: number;
  should_covered: number;
  should_skipped: number;
  core_total: number;
  core_covered: number;
  core_partial: number;
  ratio: number;
  core_ratio: number;
  level: EvidenceConfidenceLevel;
  label: string;
  summary: string;
  gaps: string[];
  scope_limits: CapabilityScopeLimit[];
}

export interface CapabilityScopeLimit {
  label: string;
  expectation: DiscoveryCapabilitySelectionExpectation;
  importance: DiscoveryCapability['importance'];
  status: DiscoveryCapability['status'];
  coverage: 'covered' | 'partial' | 'untested' | 'deferred';
  reason: string;
}

export interface DeriveReportEvaluationInput {
  score: number;
  scores: Scores;
  goals: Goal[];
  findings: Finding[];
  meta: Meta;
  capabilities?: DiscoveryCapability[] | undefined;
}

export function deriveReportEvaluation(inp: DeriveReportEvaluationInput): ReportEvaluation {
  const goalCounts = countGoals(inp.goals);
  const requestedRubrics = requestedRubricNames(inp.scores);
  const scoredRubrics = requestedRubrics.filter((name) => rubricProfileIsScored(inp.scores, name));
  const rubricCompleteness =
    requestedRubrics.length > 0 ? scoredRubrics.length / requestedRubrics.length : 1;
  const hasGoals = goalCounts.total > 0;
  const attemptedRatio = hasGoals ? goalCounts.attempted / goalCounts.total : 0;
  const verifiedRatio = hasGoals ? goalCounts.verified / goalCounts.total : 0;
  const metaConfidence = clamp01(inp.meta.confidence_overall);
  const capabilityCoverage = deriveCapabilityCoverage(inp.capabilities ?? [], inp.goals);
  const baseEvidenceScore = clamp01(
    0.45 * verifiedRatio + 0.2 * attemptedRatio + 0.25 * metaConfidence + 0.1 * rubricCompleteness,
  );
  const evidenceScore = clamp01(
    baseEvidenceScore * capabilityConfidenceMultiplier(capabilityCoverage),
  );
  const level = confidenceLevel(evidenceScore);
  const authority = scoreAuthority({
    evidenceScore,
    attemptedRatio,
    goalCounts,
    rubricCompleteness,
    metaConfidence,
    hasGoals,
    capabilityCoverage,
  });
  const reasons = evaluationReasons({
    goalCounts,
    findings: inp.findings,
    meta: inp.meta,
    requestedRubrics,
    scoredRubrics,
    capabilityCoverage,
  });
  const label = productScoreLabel(authority);
  const interpretation = productScoreInterpretation(authority, goalCounts, inp.findings);

  return {
    product_score: {
      value: inp.score,
      label,
      authority,
      interpretation,
    },
    evidence_confidence: {
      score: Number(evidenceScore.toFixed(2)),
      level,
      label: `${capitalize(level)} evidence confidence`,
      rationale: evidenceRationale(level, goalCounts, authority),
      reasons,
      goal_counts: goalCounts,
    },
    ...(capabilityCoverage ? { capability_coverage: capabilityCoverage } : {}),
  };
}

export function deriveReportEvaluationForReport(report: {
  headline: { score: number };
  scores: Scores;
  spec_compliance: { goals: Goal[] };
  findings: Finding[];
  meta: Meta;
  discovery?: { capabilities?: DiscoveryCapability[] | undefined } | undefined;
}): ReportEvaluation {
  return deriveReportEvaluation({
    score: report.headline.score,
    scores: report.scores,
    goals: report.spec_compliance.goals,
    findings: report.findings,
    meta: report.meta,
    capabilities: report.discovery?.capabilities,
  });
}

function countGoals(goals: Goal[]): GoalEvaluationCounts {
  const counts: GoalEvaluationCounts = {
    total: goals.length,
    attempted: 0,
    verified: 0,
    partial: 0,
    blocked: 0,
    skipped: 0,
    untested: 0,
  };
  for (const goal of goals) {
    switch (goal.status) {
      case 'verified':
      case 'satisfied':
        counts.verified++;
        counts.attempted++;
        break;
      case 'partial':
        counts.partial++;
        counts.attempted++;
        break;
      case 'blocked':
      case 'not_satisfied':
        counts.blocked++;
        counts.attempted++;
        break;
      case 'skipped':
        counts.skipped++;
        break;
      default:
        counts.untested++;
        break;
    }
  }
  return counts;
}

function requestedRubricNames(scores: Scores): string[] {
  const requested =
    scores.overall.weighted_from.length > 0
      ? scores.overall.weighted_from
      : Object.keys(scores.profiles);
  return Array.from(new Set(requested));
}

function rubricProfileIsScored(scores: Scores, name: string): boolean {
  const profile = scores.profiles[name];
  if (!profile) return false;
  const dimensions = Object.values(profile.dimensions);
  return dimensions.length === 0 || dimensions.some((dimension) => dimension.score !== null);
}

function scoreAuthority(inp: {
  evidenceScore: number;
  attemptedRatio: number;
  goalCounts: GoalEvaluationCounts;
  rubricCompleteness: number;
  metaConfidence: number;
  hasGoals: boolean;
  capabilityCoverage?: CapabilityCoverageSummary | undefined;
}): ScoreAuthority {
  const coverage = inp.capabilityCoverage;
  if (!inp.hasGoals) return 'insufficient';
  if (
    inp.evidenceScore < 0.45 ||
    (inp.hasGoals && inp.attemptedRatio < 0.5) ||
    (inp.hasGoals && inp.goalCounts.attempted > 0 && inp.goalCounts.verified === 0) ||
    inp.rubricCompleteness < 0.5 ||
    inp.metaConfidence < 0.35 ||
    (coverage && coverage.must_skipped > 0) ||
    (coverage && coverage.core_total >= 4 && coverage.core_ratio < 0.5)
  ) {
    return 'insufficient';
  }
  if (
    inp.evidenceScore >= 0.8 &&
    inp.goalCounts.partial === 0 &&
    inp.goalCounts.untested === 0 &&
    inp.goalCounts.skipped === 0 &&
    inp.rubricCompleteness === 1 &&
    inp.metaConfidence >= 0.7 &&
    (!coverage ||
      coverage.important_total === 0 ||
      coverage.important_covered / coverage.important_total >= 0.8) &&
    (!coverage || coverage.core_total === 0 || coverage.core_ratio >= 0.75)
  ) {
    return 'authoritative';
  }
  return 'provisional';
}

function capabilityConfidenceMultiplier(coverage: CapabilityCoverageSummary | undefined): number {
  if (!coverage) return 1;
  if (coverage.must_skipped > 0) return 0.55;
  if (coverage.should_skipped >= 3) return 0.72;
  if (coverage.should_skipped > 0) return 0.85;
  if (coverage.level === 'low') return 0.75;
  if (coverage.level === 'medium') return 0.92;
  return 1;
}

function evaluationReasons(inp: {
  goalCounts: GoalEvaluationCounts;
  findings: Finding[];
  meta: Meta;
  requestedRubrics: string[];
  scoredRubrics: string[];
  capabilityCoverage?: CapabilityCoverageSummary | undefined;
}): string[] {
  const reasons: string[] = [];
  const counts = inp.goalCounts;
  if (counts.total > 0) {
    reasons.push(`${counts.verified}/${counts.total} scenarios verified`);
    if (counts.partial > 0) {
      reasons.push(
        `${countPhrase(counts.partial, 'partial scenario')} ${counts.partial === 1 ? 'indicates' : 'indicate'} Iris did not fully prove outcomes`,
      );
    }
    if (counts.blocked > 0) {
      reasons.push(`${countPhrase(counts.blocked, 'scenario')} showed blocked or failed outcomes`);
    }
    if (counts.untested > 0) {
      reasons.push(
        `${countPhrase(counts.untested, 'scenario')} ${counts.untested === 1 ? 'was' : 'were'} not exercised`,
      );
    }
    if (counts.skipped > 0) {
      reasons.push(
        `${countPhrase(counts.skipped, 'scenario')} ${counts.skipped === 1 ? 'was' : 'were'} skipped as not applicable or out of scope`,
      );
    }
  } else {
    reasons.push('No product scenarios were available to anchor the product score');
  }

  const highImpactFindings = inp.findings.filter(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major',
  ).length;
  if (inp.findings.length === 0) {
    reasons.push('No confirmed product findings');
  } else if (highImpactFindings > 0) {
    reasons.push(countPhrase(highImpactFindings, 'high-impact product finding'));
  }

  const missingRubrics = inp.requestedRubrics.filter((name) => !inp.scoredRubrics.includes(name));
  if (missingRubrics.length > 0) {
    reasons.push(`${missingRubrics.length} requested rubric profiles missing or unscored`);
  }
  if (inp.capabilityCoverage) {
    const coverage = inp.capabilityCoverage;
    reasons.push(
      `${coverage.core_covered}/${coverage.core_total} core product capabilities covered`,
    );
    if (coverage.important_skipped > 0) {
      reasons.push(`${coverage.important_skipped} important product capabilities skipped`);
    }
    if (coverage.gaps.length > 0) {
      reasons.push(`Capability gaps: ${coverage.gaps.slice(0, 3).join('; ')}`);
    }
  }

  for (const caveat of inp.meta.confidence_caveats.slice(0, 2)) {
    reasons.push(caveat);
  }
  return uniqueStrings(reasons);
}

function countPhrase(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function productScoreLabel(authority: ScoreAuthority): string {
  switch (authority) {
    case 'authoritative':
      return 'Product score';
    case 'insufficient':
      return 'Not enough evidence to score fairly';
    default:
      return 'Provisional product score';
  }
}

function productScoreInterpretation(
  authority: ScoreAuthority,
  counts: GoalEvaluationCounts,
  findings: Finding[],
): string {
  const confirmedDefects = findings.filter((finding) => !isSuggestionFinding(finding));
  if (authority === 'insufficient') {
    return 'Iris did not gather enough evidence to grade product quality fairly.';
  }
  if (authority === 'authoritative') {
    return 'The score is backed by completed scenario evidence for the exercised scope.';
  }
  if (findings.length === 0 && counts.partial > 0) {
    return 'No product defects were confirmed; partial scenarios should be read as Iris proof gaps, not product failures.';
  }
  if (findings.length === 0) {
    return 'No product defects were confirmed, but the run still has coverage or confidence limits.';
  }
  if (confirmedDefects.length === 0) {
    return 'No product defects were confirmed; suggestions were recorded, and coverage or evidence limits make the numeric score provisional.';
  }
  return 'Product issues were found, but coverage or evidence limits make the numeric score provisional.';
}

function isSuggestionFinding(finding: Finding): boolean {
  return finding.severity === 'suggestion' || finding.category === 'suggestion';
}

function deriveCapabilityCoverage(
  capabilities: DiscoveryCapability[],
  goals: Goal[],
): CapabilityCoverageSummary | undefined {
  const relevant = capabilities.filter((capability) => capability.status !== 'not_applicable');
  if (relevant.length === 0) return undefined;
  const statusByGoalId = new Map(goals.map((goal) => [goal.id, goal.status]));
  const classified = relevant.map((capability) => ({
    capability,
    coverage: capabilityRuntimeStatus(capability, statusByGoalId, goals),
  }));
  const covered = classified.filter((item) => item.coverage === 'covered').length;
  const partial = classified.filter((item) => item.coverage === 'partial').length;
  const untested = classified.filter((item) => item.coverage === 'untested').length;
  const deferred = classified.filter((item) => item.coverage === 'deferred').length;
  const core = classified.filter((item) => item.capability.importance === 'core');
  const coreCovered = core.filter((item) => item.coverage === 'covered').length;
  const corePartial = core.filter((item) => item.coverage === 'partial').length;
  const must = classified.filter((item) => capabilityExpectation(item.capability) === 'must_test');
  const should = classified.filter(
    (item) => capabilityExpectation(item.capability) === 'should_test_or_explain',
  );
  const important = [...must, ...should];
  const mustCovered = must.filter((item) => item.coverage === 'covered').length;
  const shouldCovered = should.filter((item) => item.coverage === 'covered').length;
  const importantCovered = important.filter((item) => item.coverage === 'covered').length;
  const importantPartial = important.filter((item) => item.coverage === 'partial').length;
  const scopeLimits = classified
    .filter((item) => capabilityExpectation(item.capability) !== 'not_normally_tested')
    .filter((item) => item.coverage !== 'covered')
    .sort((a, b) => capabilityImportanceRank(a.capability) - capabilityImportanceRank(b.capability))
    .map((item) => capabilityScopeLimit(item.capability, item.coverage))
    .slice(0, 10);
  const mustSkipped = scopeLimits.filter(
    (item) => item.expectation === 'must_test' && item.coverage !== 'partial',
  ).length;
  const shouldSkipped = scopeLimits.filter(
    (item) => item.expectation === 'should_test_or_explain' && item.coverage !== 'partial',
  ).length;
  const importantSkipped = scopeLimits.filter((item) => item.coverage !== 'partial').length;
  const ratio = relevant.length > 0 ? covered / relevant.length : 1;
  const coreRatio = core.length > 0 ? coreCovered / core.length : ratio;
  const level = capabilityCoverageLevel(coreRatio, ratio, mustSkipped, shouldSkipped);
  const gaps = scopeLimits.map((item) => item.label).slice(0, 8);
  const summary =
    core.length > 0
      ? `${coreCovered}/${core.length} core capabilities covered; ${importantCovered}/${important.length} important capabilities covered; ${importantSkipped} important skipped.`
      : `${covered}/${relevant.length} capabilities covered; ${importantSkipped} important skipped.`;
  return {
    total: relevant.length,
    covered,
    partial,
    untested,
    deferred,
    important_total: important.length,
    important_covered: importantCovered,
    important_partial: importantPartial,
    important_skipped: importantSkipped,
    must_total: must.length,
    must_covered: mustCovered,
    must_skipped: mustSkipped,
    should_total: should.length,
    should_covered: shouldCovered,
    should_skipped: shouldSkipped,
    core_total: core.length,
    core_covered: coreCovered,
    core_partial: corePartial,
    ratio: Number(ratio.toFixed(2)),
    core_ratio: Number(coreRatio.toFixed(2)),
    level,
    label: `${capitalize(level)} product coverage`,
    summary,
    gaps,
    scope_limits: scopeLimits,
  };
}

function capabilityRuntimeStatus(
  capability: DiscoveryCapability,
  statusByGoalId: Map<string, Goal['status']>,
  goals: Goal[],
): 'covered' | 'partial' | 'untested' | 'deferred' {
  const statuses = capability.scenario_ids
    .map((id) => statusByGoalId.get(id))
    .filter((status): status is Goal['status'] => Boolean(status));
  if (
    statuses.some(
      (status) => status === 'partial' || status === 'blocked' || status === 'not_satisfied',
    )
  ) {
    return 'partial';
  }
  if (statuses.some((status) => status === 'verified' || status === 'satisfied')) return 'covered';
  const inferred = inferCapabilityRuntimeStatusFromGoals(capability, goals);
  if (inferred) return inferred;
  if (capability.status === 'selected') return 'untested';
  return 'deferred';
}

function inferCapabilityRuntimeStatusFromGoals(
  capability: DiscoveryCapability,
  goals: Goal[],
): 'covered' | 'partial' | undefined {
  const matching = goals.filter((goal) => goalProvesCapability(capability, goal));
  if (matching.length === 0) return undefined;
  if (matching.some((goal) => goal.status === 'verified' || goal.status === 'satisfied')) {
    return 'covered';
  }
  if (
    matching.some(
      (goal) =>
        goal.status === 'partial' || goal.status === 'blocked' || goal.status === 'not_satisfied',
    )
  ) {
    return 'partial';
  }
  return undefined;
}

function goalProvesCapability(capability: DiscoveryCapability, goal: Goal): boolean {
  if (isImplementationCodeCapability(capability))
    return goalProvesImplementationCodeCapability(goal);
  if (isCalculatorInputCapability(capability)) return goalProvesCalculatorInputCapability(goal);
  return false;
}

function isImplementationCodeCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'developer_documentation') return false;
  const text = normalizeCapabilityText(
    [
      capability.label,
      capability.denominator_reason,
      capability.coverage_gap,
      ...capability.evidence,
    ].join(' '),
  );
  return (
    /\b(implementation|source code|code|dependency|dependencies|library|api)\b/.test(text) &&
    /\b(read|inspect|visible|example|implementation|dependency|dependencies|library|code)\b/.test(
      text,
    )
  );
}

function goalProvesImplementationCodeCapability(goal: Goal): boolean {
  const text = normalizeCapabilityText([goal.description, goal.notes ?? ''].join(' '));
  if (
    !/\b(inspect|read|show|verify|visible|implementation|javascript|code|dependency|dependencies|library)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(new datatable|datatable|jquery|cdn|data tables|datatables|dependency|dependencies|library|javascript tab|source code|code snippet)\b/.test(
    text,
  );
}

function isCalculatorInputCapability(capability: DiscoveryCapability): boolean {
  if (capability.product_kind !== 'calculator_tool') return false;
  const text = normalizeCapabilityText(
    [
      capability.label,
      capability.denominator_reason,
      capability.coverage_gap,
      ...capability.evidence,
    ].join(' '),
  );
  if (/\b(print|save|export|download|related|reference|article|table|chart)\b/.test(text)) {
    return false;
  }
  return (
    /\b(input|field|form|unit|option|metric|imperial|us unit|other unit)\b/.test(text) &&
    /\b(calculate|calculator|bmi|result|conversion|height|weight|value)\b/.test(text)
  );
}

function goalProvesCalculatorInputCapability(goal: Goal): boolean {
  const text = normalizeCapabilityText([goal.description, goal.notes ?? ''].join(' '));
  const usesInputs =
    /\b(height|weight|age|feet|inch|in|lb|pound|cm|kg|kilogram|metric|unit|male|female)\b/.test(
      text,
    );
  const calculatesResult = /\b(calculate|bmi|result|normal|overweight|kg m2|healthy)\b/.test(text);
  return usesInputs && calculatesResult;
}

function normalizeCapabilityText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9.#/:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capabilityCoverageLevel(
  coreRatio: number,
  ratio: number,
  mustSkipped: number,
  shouldSkipped: number,
): EvidenceConfidenceLevel {
  if (mustSkipped > 0) return 'low';
  if (shouldSkipped >= 3) return 'medium';
  if (coreRatio >= 0.75 && ratio >= 0.55) return 'high';
  if (coreRatio >= 0.5 && ratio >= 0.35) return 'medium';
  return 'low';
}

function capabilityExpectation(
  capability: DiscoveryCapability,
): DiscoveryCapabilitySelectionExpectation {
  if (capability.selection_expectation) return capability.selection_expectation;
  if (capability.importance === 'core') return 'must_test';
  if (capability.importance === 'important') return 'should_test_or_explain';
  return 'not_normally_tested';
}

function capabilityScopeLimit(
  capability: DiscoveryCapability,
  coverage: 'covered' | 'partial' | 'untested' | 'deferred',
): CapabilityScopeLimit {
  const expectation = capabilityExpectation(capability);
  return {
    label: capability.label,
    expectation,
    importance: capability.importance,
    status: capability.status,
    coverage,
    reason:
      capability.skip_reason ||
      capability.coverage_gap ||
      capability.denominator_reason ||
      (expectation === 'must_test'
        ? 'Central product capability was expected but not covered by selected evidence.'
        : 'Important product capability was not covered by selected evidence.'),
  };
}

function capabilityImportanceRank(capability: DiscoveryCapability): number {
  switch (capability.importance) {
    case 'core':
      return 0;
    case 'important':
      return 1;
    case 'secondary':
      return 2;
    default:
      return 3;
  }
}

function evidenceRationale(
  level: EvidenceConfidenceLevel,
  counts: GoalEvaluationCounts,
  authority: ScoreAuthority,
): string {
  if (authority === 'insufficient') {
    return 'The run is useful for debugging Iris, but not for a fair product-quality judgement.';
  }
  if (counts.total > 0 && counts.partial > 0) {
    return `${capitalize(level)} confidence because Iris attempted all or most scenarios but left outcome proof incomplete.`;
  }
  return `${capitalize(level)} confidence in the observed product score.`;
}

function confidenceLevel(score: number): EvidenceConfidenceLevel {
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
