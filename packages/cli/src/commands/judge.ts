import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { judge as judgeMod, report as reportMod, trace as traceMod } from '@iris/core';
import { Command } from 'commander';
import { buildLlmClient } from '../llm-factory.js';
import { loadRubricsByNames } from '../load-rubrics.js';
import { buildSummaryLine } from '../render/summary.js';

export function judgeCommand(): Command {
  return new Command('judge')
    .description('Re-run only the Judge against a stored trace')
    .requiredOption('--trace <path>', 'path to trace.jsonl')
    .option('--spec <path>', 'spec file used in original run')
    .option('--rubrics <list>', 'comma-separated rubric profile names')
    .option('--judge-model <id>', 'model for Judge agent', 'claude-opus-4-7')
    .option('--threshold <n>', 'threshold to preserve when replaying a prior run', (s) =>
      Number.parseFloat(s),
    )
    .option('--out <dir>', 'output directory')
    .option('--print-summary', 'print one-line JSON summary to stdout')
    .action(async (opts: Record<string, unknown>) => {
      const tracePath = resolve(opts.trace as string);
      const threshold = resolveJudgeReplayThreshold({
        tracePath,
        explicitThreshold: opts.threshold,
      });
      const specPath = opts.spec as string | undefined;
      const rubricsArg = opts.rubrics as string | undefined;
      const rubricNames = rubricsArg
        ? rubricsArg
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const rubrics = await loadRubricsByNames(rubricNames);
      const outDir =
        (opts.out as string | undefined) ??
        `./iris-runs/judge-${new Date().toISOString().replace(/[:]/g, '-')}`;

      let specText: string | undefined;
      if (specPath) {
        const resolvedSpecPath = resolve(specPath);
        if (!existsSync(resolvedSpecPath)) {
          throw new Error(`iris judge: --spec file not found: ${resolvedSpecPath}`);
        }
        specText = readFileSync(resolvedSpecPath, 'utf8');
      }

      const judgeClient = buildLlmClient();
      const judge = new judgeMod.Judge(judgeClient);
      let out = await judge.run({
        trace_path: tracePath,
        ...(specText !== undefined ? { spec_text: specText } : {}),
        rubric_profiles: rubrics,
        model: opts.judgeModel as string,
      });

      // Phase 12: apply the same validation pipeline as the orchestrator so
      // `iris judge` produces the same shape of report as `iris eval`.
      // Without this, the agent-perspective and notifications-probe filters
      // never run on re-judge invocations.
      const traceEvents = await traceMod.readTraceArray(tracePath);
      const validation = judgeMod.validateFindings(out.findings, traceEvents);
      out = {
        ...out,
        findings: validation.kept,
        discarded_findings: [...(out.discarded_findings ?? []), ...validation.discarded],
        evidence_validation: validation.summary,
      };
      const adapter = new WebTargetAdapter({ headless: true });
      const goalClaimResult = judgeMod.validateGoalClaims({
        judge: out,
        trace: traceEvents,
        outcome_contract: adapter.outcomeContract(),
      });
      out = judgeMod.applyGoalClaimValidationToJudgeOutput(out, goalClaimResult);

      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, 'findings.json'),
        `${JSON.stringify({ findings: out.findings, _written_at: new Date().toISOString() }, null, 2)}\n`,
      );
      writeFileSync(
        join(outDir, 'scores.json'),
        `${JSON.stringify({ ...out.scores, _written_at: new Date().toISOString() }, null, 2)}\n`,
      );

      const reportJson = reportMod.buildReportJson({
        judge: out,
        run: {
          id: `judge-replay-${Date.now()}`,
          target: { kind: 'web', url: 'replay' },
          mode: 'free',
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          duration_s: 0,
          cost_usd: judgeClient.totals().cost_usd,
          models: { explorer: 'replay', judge: opts.judgeModel as string },
          termination: 'replay',
          step_count: 0,
        },
        trace_events: traceEvents,
        ...(threshold !== undefined ? { threshold } : {}),
      });
      writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(reportJson, null, 2)}\n`);
      writeFileSync(join(outDir, 'report.md'), reportMod.buildReportMd(reportJson));

      if (opts.printSummary) {
        const c = reportJson.headline;
        process.stdout.write(
          buildSummaryLine({
            score: c.score,
            threshold_passed: c.threshold_passed,
            findings: {
              blocker: c.blockers,
              major: c.majors,
              minor: c.minors,
              nit: c.nits,
              suggestion: c.suggestions,
            },
            run_dir: outDir,
            duration_s: 0,
            cost_usd: judgeClient.totals().cost_usd,
            caveats: reportJson.meta.confidence_caveats.length,
          }),
        );
      } else {
        process.stdout.write(`iris judge: report → ${outDir}/report.json\n`);
      }
    });
}

export function resolveJudgeReplayThreshold(input: {
  tracePath: string;
  explicitThreshold?: unknown;
}): number | undefined {
  const explicit = numberValue(input.explicitThreshold);
  if (explicit !== undefined) return explicit;
  const configPath = join(dirname(input.tracePath), 'config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    return numberValue(parsed.threshold);
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
