import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { judge as judgeMod, report as reportMod, trace as traceMod } from '@iris/core';
import { Command } from 'commander';

type ReportJson = ReturnType<typeof reportMod.buildReportJson>;

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
      const confidenceCaveats = uniqueStrings([
        ...report.meta.confidence_caveats,
        ...reportMod.deriveProbeConfidenceCaveats(traceEvents),
      ]);
      const renderedReport: ReportJson = {
        ...report,
        run: enrichRunMetadata(report.run, traceEvents, dir),
        meta: {
          ...report.meta,
          confidence_caveats: confidenceCaveats,
        },
        scores: reportMod.normalizeReportScores(report.scores, {
          ...(traceEvents ? { traceEvents } : {}),
          confidenceCaveats,
        }),
      };
      writeFileSync(join(dir, 'report.md'), reportMod.buildReportMd(renderedReport));
      if (opts.html !== false) {
        writeFileSync(
          join(dir, 'report.html'),
          reportMod.buildReportHtml(renderedReport, { runDir: dir }),
        );
      }
      if (opts.revalidate === true) {
        writeFileSync(reportPath, `${JSON.stringify(renderedReport, null, 2)}\n`);
      }
      process.stdout.write(
        `iris report: ${opts.revalidate === true ? 'revalidated and ' : ''}re-rendered ${runDir}/report.{md,html}\n`,
      );
  });
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
    discarded_findings: [
      ...(rawJudge.discarded_findings ?? []),
      ...findingValidation.discarded,
    ],
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
  return reportMod.buildReportJson({
    judge,
    run: enrichRunMetadata(report.run, traceEvents, runDir),
    ...(report.artifacts ? { artifacts: report.artifacts } : {}),
    ...(report.preflight ? { preflight: report.preflight } : {}),
    ...(report.headline.blocked
      ? { blocked: { reasons: report.headline.blocked_reasons ?? [] } }
      : {}),
    trace_events: traceEvents,
  });
}

function readRawJudgeOutput(runDir: string): judgeMod.JudgeOutput | undefined {
  const rawPath = join(runDir, 'judge.raw.txt');
  if (!existsSync(rawPath)) return undefined;
  const raw = readFileSync(rawPath, 'utf8');
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return undefined;
  return JSON.parse(raw.slice(jsonStart)) as judgeMod.JudgeOutput;
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

function enrichRunMetadata(
  run: ReportJson['run'],
  traceEvents: traceMod.TraceEvent[] | undefined,
  runDir: string,
): ReportJson['run'] {
  const runStart = traceEvents?.find((event) => event.kind === 'run_start');
  const runStartPayload = (runStart?.payload ?? {}) as Record<string, unknown>;
  const config = readRunConfig(runDir);
  const transport = stringValue(run.transport) ?? stringValue(config.transport) ?? stringValue(runStartPayload.transport);
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
