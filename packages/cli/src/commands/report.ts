import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { judge as judgeMod, report as reportMod, trace as traceMod } from '@iris/core';
import { Command } from 'commander';
import { parseJudgeOutput } from '../codex-app-server-orchestrator.js';

type ReportJson = ReturnType<typeof reportMod.buildReportJson> & { threshold?: number };

export function reportCommand(): Command {
  return new Command('report')
    .description('Re-render report.html / report.md from an existing run directory')
    .argument('<run-dir>', 'path to a previous run directory containing report.json')
    .option('--no-html', 'skip HTML render')
    .option(
      '--revalidate',
      'replay stored judge.raw.txt through the current evidence and goal validators before rendering',
    )
    .action(async (runDir: string, opts: Record<string, unknown>) => {
      const dir = resolve(runDir);
      const reportPath = join(dir, 'report.json');
      if (!existsSync(reportPath)) {
        process.stderr.write(`iris report: ${reportPath} not found\n`);
        process.exit(64);
      }
      let report = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportJson;
      const tracePath = join(dir, 'trace.jsonl');
      const traceEvents = existsSync(tracePath)
        ? await traceMod.readTraceArray(tracePath)
        : undefined;
      if (opts.revalidate === true) {
        report = revalidateStoredReport(report, traceEvents, dir);
      }
      if (traceEvents) {
        report = await addTraceStoryboards(report, traceEvents, dir);
      }
      const renderedReport = refreshStoredReportForRender(report, traceEvents, dir);
      writeFileSync(join(dir, 'report.md'), reportMod.buildReportMd(renderedReport));
      if (opts.html !== false) {
        writeFileSync(
          join(dir, 'report.html'),
          reportMod.buildReportHtml(renderedReport, { runDir: dir }),
        );
      }
      if (opts.revalidate === true) {
        writeFileSync(reportPath, `${JSON.stringify(renderedReport, null, 2)}\n`);
        writeFileSync(
          join(dir, 'findings.json'),
          `${JSON.stringify(findingsSnapshotFromReport(renderedReport), null, 2)}\n`,
        );
      }
      process.stdout.write(
        `iris report: ${opts.revalidate === true ? 'revalidated and ' : ''}re-rendered ${runDir}/report.{md,html}\n`,
      );
    });
}

export function findingsSnapshotFromReport(report: ReportJson): {
  findings: ReportJson['findings'];
  discarded_findings: NonNullable<ReportJson['discarded_findings']>;
  evidence_validation: NonNullable<ReportJson['evidence_validation']>;
  _written_at: string;
} {
  return {
    findings: report.findings,
    discarded_findings: report.discarded_findings ?? [],
    evidence_validation: report.evidence_validation ?? {
      verified: report.findings.length,
      downgraded: 0,
      discarded: report.discarded_findings?.length ?? 0,
    },
    _written_at: new Date().toISOString(),
  };
}

export function refreshStoredReportForRender(
  report: ReportJson,
  traceEvents: traceMod.TraceEvent[] | undefined,
  runDir: string,
): ReportJson {
  const threshold = resolveStoredReportThreshold(report, runDir);
  const meta = reportMod.normalizeReportMeta(report.meta, traceEvents);
  const scores = reportMod.normalizeReportScores(report.scores, {
    ...(traceEvents ? { traceEvents } : {}),
    confidenceCaveats: meta.confidence_caveats,
  });
  const counts = countSeverities(report.findings);
  const coverage = countAttemptedGoals(report.spec_compliance.goals);
  const evaluation = reportMod.deriveReportEvaluationForReport({
    ...report,
    headline: { ...report.headline, score: scores.overall.score },
    scores,
    meta,
  });
  return {
    ...report,
    ...(threshold !== undefined ? { threshold } : {}),
    run: enrichRunMetadata(report.run, traceEvents, runDir),
    headline: {
      ...report.headline,
      score: scores.overall.score,
      threshold_passed: computeThresholdPassed({
        score: scores.overall.score,
        blocked: report.headline.blocked === true,
        counts,
        coverage,
        scoreAuthority: evaluation.product_score.authority,
        ...(threshold !== undefined ? { threshold } : {}),
      }),
      blockers: counts.blocker,
      majors: counts.major,
      minors: counts.minor,
      nits: counts.nit,
      suggestions: counts.suggestion,
      ...(report.spec_compliance.applicable
        ? {
            goals_attempted: coverage.attempted,
            goals_verified: coverage.verified,
            goals_total: coverage.total,
          }
        : {}),
    },
    scores,
    meta,
    evaluation,
    next_actions: {
      ...report.next_actions,
      for_re_evaluation: meta.would_re_explore_with,
    },
  };
}

async function addTraceStoryboards(
  report: ReportJson,
  traceEvents: traceMod.TraceEvent[],
  runDir: string,
): Promise<ReportJson> {
  const judge = judgeOutputFromReport(report);
  const evidence = await reportMod.collectTraceEvidenceArtifacts({
    judge,
    trace: traceEvents,
    runDir,
  });
  const validClaimIds = new Set([
    ...report.findings.map((finding) => finding.id),
    ...report.spec_compliance.goals.map((goal) => goal.id),
  ]);
  const keptExistingClips = Object.fromEntries(
    Object.entries(report.artifacts?.clips ?? {}).filter(([id]) => validClaimIds.has(id)),
  );
  if (Object.keys(evidence.clips).length === 0) {
    return {
      ...report,
      artifacts: {
        ...(report.artifacts ?? {}),
        clips: keptExistingClips,
      },
    };
  }
  return {
    ...report,
    artifacts: {
      ...(report.artifacts ?? {}),
      clips: {
        ...keptExistingClips,
        ...evidence.clips,
      },
    },
  };
}

function judgeOutputFromReport(report: ReportJson): judgeMod.JudgeOutput {
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

function revalidateStoredReport(
  report: ReportJson,
  traceEvents: traceMod.TraceEvent[] | undefined,
  runDir: string,
): ReportJson {
  if (!traceEvents) return report;
  const rawJudge = readRawJudgeOutput(runDir);
  if (!rawJudge) return report;
  const findingValidation = judgeMod.validateFindings(rawJudge.findings, traceEvents);
  let judge: judgeMod.JudgeOutput = {
    ...rawJudge,
    findings: findingValidation.kept,
    discarded_findings: [...(rawJudge.discarded_findings ?? []), ...findingValidation.discarded],
    evidence_validation: findingValidation.summary,
  };
  if (report.run.target.kind === 'web') {
    const adapter = new WebTargetAdapter({ headless: true });
    const goalClaimResult = judgeMod.validateGoalClaims({
      judge,
      trace: traceEvents,
      outcome_contract: adapter.outcomeContract(),
    });
    judge = judgeMod.applyGoalClaimValidationToJudgeOutput(judge, goalClaimResult);
  }
  const initiallyPreserveBlocked = shouldPreserveBlockedState(report);
  const run = normalizeRevalidatedRunMetadata(
    report.run,
    traceEvents,
    runDir,
    initiallyPreserveBlocked,
  );
  const preserveBlocked = initiallyPreserveBlocked || run.termination === 'judge_failed';
  const threshold = resolveStoredReportThreshold(report, runDir);
  return reportMod.buildReportJson({
    judge,
    run,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(report.artifacts ? { artifacts: report.artifacts } : {}),
    ...(report.preflight ? { preflight: report.preflight } : {}),
    ...(preserveBlocked ? { blocked: { reasons: report.headline.blocked_reasons ?? [] } } : {}),
    trace_events: traceEvents,
  });
}

export function resolveStoredReportThreshold(
  report: ReportJson,
  runDir: string,
): number | undefined {
  return numberValue(report.threshold) ?? numberValue(readRunConfig(runDir).threshold);
}

function shouldPreserveBlockedState(report: ReportJson): boolean {
  if (!report.headline.blocked) return false;
  const reasons = report.headline.blocked_reasons ?? [];
  if (reasons.length === 0) return true;
  return !reasons.every((reason) =>
    /judge returned no json object|judge did not complete/i.test(reason),
  );
}

export function normalizeRevalidatedRunMetadata(
  run: ReportJson['run'],
  traceEvents: traceMod.TraceEvent[] | undefined,
  runDir: string,
  preserveBlocked: boolean,
): ReportJson['run'] {
  const enriched = enrichRunMetadata(run, traceEvents, runDir);
  if (preserveBlocked || enriched.termination !== 'judge_failed') {
    return enriched;
  }
  const traceTermination = latestTraceRunTermination(traceEvents);
  return {
    ...enriched,
    termination:
      traceTermination && traceTermination !== 'judge_failed' ? traceTermination : 'judge_failed',
  };
}

function latestTraceRunTermination(
  traceEvents: traceMod.TraceEvent[] | undefined,
): string | undefined {
  if (!traceEvents) return undefined;
  for (let i = traceEvents.length - 1; i >= 0; i -= 1) {
    const event = traceEvents[i];
    if (event?.kind !== 'run_end') continue;
    const payload = event.payload as Record<string, unknown>;
    const termination = payload.termination;
    if (typeof termination === 'string' && termination.trim()) {
      return termination;
    }
  }
  return undefined;
}

function readRawJudgeOutput(runDir: string): judgeMod.JudgeOutput | undefined {
  const rawPath = join(runDir, 'judge.raw.txt');
  if (!existsSync(rawPath)) return undefined;
  const raw = readFileSync(rawPath, 'utf8');
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return undefined;
  return parseJudgeOutput(raw.slice(jsonStart));
}

function enrichRunMetadata(
  run: ReportJson['run'],
  traceEvents: traceMod.TraceEvent[] | undefined,
  runDir: string,
): ReportJson['run'] {
  const runStart = traceEvents?.find((event) => event.kind === 'run_start');
  const runStartPayload = (runStart?.payload ?? {}) as Record<string, unknown>;
  const config = readRunConfig(runDir);
  const transport =
    stringValue(run.transport) ??
    stringValue(config.transport) ??
    stringValue(runStartPayload.transport);
  const discoveryModel =
    stringValue(run.models.discovery) ??
    run.models.explorer ??
    stringValue(config.discovery_model) ??
    stringValue(config.explorer_model) ??
    stringValue(runStartPayload.model) ??
    run.models.explorer;
  const explorerModel = run.models.explorer ?? stringValue(config.explorer_model);
  const judgeModel = run.models.judge ?? stringValue(config.judge_model);
  const traceReasoningEffort = stringValue(runStartPayload.reasoning_effort);
  const configReasoningEffort = stringValue(config.reasoning_effort);
  const sharedReasoningEffort =
    configReasoningEffort ??
    traceReasoningEffort ??
    (transport === 'codex-appserver' ? 'low' : undefined);
  return {
    ...run,
    ...(transport ? { transport } : {}),
    models: {
      discovery: discoveryModel,
      explorer: explorerModel,
      judge: judgeModel,
    },
    reasoning_efforts: {
      ...(run.reasoning_efforts ?? {}),
      ...(sharedReasoningEffort
        ? {
            discovery: run.reasoning_efforts?.discovery ?? sharedReasoningEffort,
            explorer: run.reasoning_efforts?.explorer ?? sharedReasoningEffort,
            judge: run.reasoning_efforts?.judge ?? sharedReasoningEffort,
          }
        : {}),
    },
  };
}

function readRunConfig(runDir: string): Record<string, unknown> {
  const configPath = join(runDir, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function countAttemptedGoals(goals: ReportJson['spec_compliance']['goals']): {
  total: number;
  attempted: number;
  verified: number;
} {
  let attempted = 0;
  let verified = 0;
  for (const goal of goals) {
    if (
      goal.status === 'verified' ||
      goal.status === 'satisfied' ||
      goal.status === 'partial' ||
      goal.status === 'blocked' ||
      goal.status === 'not_satisfied'
    ) {
      attempted += 1;
    }
    if (goal.status === 'verified' || goal.status === 'satisfied') {
      verified += 1;
    }
  }
  return { total: goals.length, attempted, verified };
}

function countSeverities(findings: ReportJson['findings']): {
  blocker: number;
  major: number;
  minor: number;
  nit: number;
  suggestion: number;
} {
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, suggestion: 0 };
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

function computeThresholdPassed(input: {
  score: number;
  threshold?: number;
  blocked: boolean;
  counts: ReturnType<typeof countSeverities>;
  coverage: ReturnType<typeof countAttemptedGoals>;
  scoreAuthority: 'authoritative' | 'provisional' | 'insufficient';
}): boolean {
  const coverageRatio =
    input.coverage.total > 0 ? input.coverage.attempted / input.coverage.total : 1;
  const scorePass = input.threshold === undefined ? true : input.score >= input.threshold;
  const coveragePass = input.coverage.total === 0 || coverageRatio >= 0.5;
  const noBlockingFindings = input.counts.blocker === 0 && input.counts.major === 0;
  return (
    !input.blocked &&
    scorePass &&
    coveragePass &&
    noBlockingFindings &&
    input.scoreAuthority !== 'insufficient'
  );
}
