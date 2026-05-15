import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import type { RubricProfile } from '@iris/rubrics';
import { ulid } from 'ulid';
import { Explorer, type ExplorerResult } from '../explorer/explorer.js';
import type { PersonaName } from '../explorer/personas/index.js';
import { judgeWithEnsemble } from '../judge/ensemble.js';
import { validateFindings } from '../judge/evidence-validator.js';
import { ensureRubricScoreCoverage } from '../judge/score-coverage.js';
import {
  applyGoalClaimValidationToJudgeOutput,
  validateGoalClaims,
} from '../judge/goal-claim-validator.js';
import { Judge, type JudgeOutput } from '../judge/judge.js';
import type { LlmClient } from '../llm/client.js';
import { runPreflight } from '../preflight/preflight.js';
import { buildReportHtml } from '../report/report-html.js';
import { type ReportJson, buildReportJson } from '../report/report-json.js';
import { buildReportMd } from '../report/report-md.js';
import { collectClaimEvidenceArtifacts } from '../report/evidence-clips.js';
import { type InterpretedSpec, interpretSpec } from '../spec-interpreter/interpreter.js';
import { readTraceArray } from '../trace/reader.js';
import { TraceWriter } from '../trace/writer.js';
import type { Mode, TargetKind } from '../types.js';

export interface OrchestratorRunConfig {
  target: { kind: TargetKind; url: string };
  transport?: string;
  mode: Mode;
  out_dir: string;
  spec_text?: string;
  spec_path?: string;
  initial_tasks?: string[];
  rubric_profiles: RubricProfile[];
  max_steps: number;
  /** Phase 17: cost budget removed. Field kept optional for backwards
   * compat with old config callers; ignored at runtime. */
  max_cost_usd?: number;
  timeout_s: number;
  threshold?: number;
  explorer_model: string;
  judge_model: string;
  no_html: boolean;
  no_clips?: boolean;
  persona?: PersonaName;
  // Phase 5 additions
  steps_per_goal?: number;
  free_exploration_steps?: number;
  no_preflight?: boolean;
  preflight_timeout_s?: number;
  // Phase 6 additions
  judge_ensemble?: boolean;
}

export interface OrchestratorResult {
  report: ReportJson;
  out_dir: string;
  duration_s: number;
  cost_usd: number;
  termination: ExplorerResult['termination'];
  exit_code: 0 | 1 | 2 | 3 | 4;
}

export interface OrchestratorDeps {
  adapter: TargetAdapter;
  explorerClient: LlmClient;
  judgeClient: LlmClient;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(config: OrchestratorRunConfig): Promise<OrchestratorResult> {
    const startedAt = new Date();
    const startMs = Date.now();
    mkdirSync(config.out_dir, { recursive: true });

    // 1. Write resolved config
    writeFileSync(
      join(config.out_dir, 'config.json'),
      `${JSON.stringify({ ...config, _written_at: startedAt.toISOString() }, null, 2)}\n`,
    );

    // 2. Save spec input verbatim
    let specText: string | undefined;
    if (config.spec_text !== undefined) {
      specText = config.spec_text;
      writeFileSync(join(config.out_dir, 'spec.input.txt'), specText);
    } else if (config.spec_path && existsSync(config.spec_path)) {
      specText = readFileSync(config.spec_path, 'utf8');
      copyFileSync(config.spec_path, join(config.out_dir, 'spec.input.txt'));
    }

    // 3. Spec interpreter (only in grounded mode with spec)
    let interpreted: InterpretedSpec | undefined;
    if (config.mode === 'grounded' && specText) {
      interpreted = await interpretSpec(specText, this.deps.explorerClient, config.explorer_model);
      writeFileSync(
        join(config.out_dir, 'spec.interpreted.json'),
        `${JSON.stringify(interpreted, null, 2)}\n`,
      );
    }

    // 4. Adapter.start
    const adapterConfig = {
      kind: config.target.kind,
      target: config.target.url,
      out_dir: config.out_dir,
    };
    let exitCode: 0 | 1 | 2 | 3 | 4 = 0;
    try {
      await this.deps.adapter.start(adapterConfig);
    } catch (err) {
      writeFileSync(
        join(config.out_dir, 'error.txt'),
        err instanceof Error ? err.message : String(err),
      );
      exitCode = 3;
      const reportEarly = this.buildEmptyReport(
        config,
        startedAt,
        Date.now() - startMs,
        'budget_steps' as const,
        0,
      );
      writeFileSync(
        join(config.out_dir, 'report.json'),
        `${JSON.stringify(reportEarly, null, 2)}\n`,
      );
      return {
        report: reportEarly,
        out_dir: config.out_dir,
        duration_s: (Date.now() - startMs) / 1000,
        cost_usd: 0,
        termination: 'budget_steps',
        exit_code: exitCode,
      };
    }

    // 4.5. Phase 5 preflight (web targets only — other adapters return early).
    const tracePath = join(config.out_dir, 'trace.jsonl');
    const traceWriter = new TraceWriter(tracePath);

    if (!config.no_preflight && this.deps.adapter.preflightProbe) {
      const preflightResult = await runPreflight(this.deps.adapter, {
        timeoutS: config.preflight_timeout_s ?? 15,
      });
      await traceWriter.append({
        v: 1,
        id: ulid(),
        ts: Date.now() / 1000,
        step: 0,
        target_kind: config.target.kind,
        kind: 'preflight',
        actor: 'system',
        payload: {
          ok: preflightResult.ok,
          checks: preflightResult.checks,
          ...(preflightResult.screenshot ? { screenshot: preflightResult.screenshot } : {}),
        },
      });
      if (!preflightResult.ok) {
        // Block — skip Explorer and Judge entirely.
        await traceWriter.close();
        const artifacts = await this.deps.adapter.stop();
        const failedReasons = preflightResult.checks.filter((c) => !c.ok).map((c) => c.name);
        const blockedReport = this.buildBlockedReport({
          config,
          startedAt,
          startMs,
          preflight: preflightResult,
          artifacts: artifacts.artifact_files,
        });
        writeFileSync(
          join(config.out_dir, 'report.json'),
          `${JSON.stringify(blockedReport, null, 2)}\n`,
        );
        writeFileSync(join(config.out_dir, 'report.md'), buildReportMd(blockedReport));
        if (!config.no_html) {
          writeFileSync(
            join(config.out_dir, 'report.html'),
            buildReportHtml(blockedReport, { runDir: config.out_dir }),
          );
        }
        return {
          report: blockedReport,
          out_dir: config.out_dir,
          duration_s: (Date.now() - startMs) / 1000,
          cost_usd: 0,
          termination: 'budget_steps',
          exit_code: 4,
        };
      }
    }

    // 4.6. Phase 9: emit interaction_kit event so the Judge sees the
    // adapter's interaction surface and the goal-claim validator has the
    // kit available for diagnostics.
    if (this.deps.adapter.interactionKit) {
      const kit = this.deps.adapter.interactionKit();
      await traceWriter.append({
        v: 1,
        id: ulid(),
        ts: Date.now() / 1000,
        step: 0,
        target_kind: config.target.kind,
        kind: 'interaction_kit',
        actor: 'system',
        payload: { kind: kit.kind, primitives: kit.primitives },
      });
    }

    // 5. Explorer
    const initialPlanStack: string[] = [];
    if (interpreted) {
      for (const g of interpreted.goals) initialPlanStack.push(`verify: ${g.description}`);
    } else if (config.initial_tasks) {
      initialPlanStack.push(...config.initial_tasks);
    }

    // Phase 5: when a spec is interpreted, normalize goals to {id, description}
    // and pass to Explorer for per-goal budgeting.
    const specGoals: Array<{ id: string; description: string }> | undefined = interpreted
      ? interpreted.goals.map((g, i) => ({ id: `G${i + 1}`, description: g.description }))
      : undefined;
    const stepsPerGoal = config.steps_per_goal;
    const freeExplorationSteps = config.free_exploration_steps ?? 0;
    const effectiveMaxSteps =
      specGoals && stepsPerGoal && stepsPerGoal > 0
        ? Math.min(config.max_steps, specGoals.length * stepsPerGoal + freeExplorationSteps)
        : config.max_steps;

    const explorer = new Explorer({
      adapter: this.deps.adapter,
      llmClient: this.deps.explorerClient,
      traceWriter,
      config: {
        mode: config.mode,
        target_kind: config.target.kind,
        model: config.explorer_model,
        max_steps: effectiveMaxSteps,
        timeout_s: config.timeout_s,
        ...(initialPlanStack.length > 0 ? { initial_plan_stack: initialPlanStack } : {}),
        ...(config.persona !== undefined ? { persona: config.persona } : {}),
        ...(specGoals && stepsPerGoal && stepsPerGoal > 0
          ? {
              spec_goals: specGoals,
              steps_per_goal: stepsPerGoal,
              free_exploration_steps: freeExplorationSteps,
            }
          : {}),
      },
    });

    let explorerResult: ExplorerResult;
    try {
      explorerResult = await explorer.run();
    } finally {
      await traceWriter.close();
    }

    // 6. Adapter.stop
    const artifacts = await this.deps.adapter.stop();

    // 7. Judge
    const judge = new Judge(this.deps.judgeClient);
    let judgeOutput: JudgeOutput;
    let traceEvents: Awaited<ReturnType<typeof readTraceArray>> = [];
    try {
      // Phase 6 F2: optional ensemble — two parallel Judge calls, intersect
      // critical findings, average scores. Reduces variance on borderline
      // ship-decisions. Doubles Judge cost when enabled.
      if (config.judge_ensemble) {
        traceEvents = await readTraceArray(tracePath);
        const ensembleResult = await judgeWithEnsemble(
          judge,
          {
            trace_path: tracePath,
            ...(specText !== undefined ? { spec_text: specText } : {}),
            ...(interpreted ? { spec_goals: interpreted.goals } : {}),
            rubric_profiles: config.rubric_profiles,
            model: config.judge_model,
          },
          traceEvents,
        );
        judgeOutput = ensembleResult.output;
      } else {
        judgeOutput = await judge.run({
          trace_path: tracePath,
          ...(specText !== undefined ? { spec_text: specText } : {}),
          ...(interpreted ? { spec_goals: interpreted.goals } : {}),
          rubric_profiles: config.rubric_profiles,
          model: config.judge_model,
        });
      }
      judgeOutput = ensureRubricScoreCoverage(judgeOutput, config.rubric_profiles);

      // Phase 5 G3: validate findings against the trace. Deterministic step;
      // drops findings whose cited event ids don't exist and downgrades severe
      // findings without concrete backing.
      if (traceEvents.length === 0) traceEvents = await readTraceArray(tracePath);
      const validation = validateFindings(judgeOutput.findings, traceEvents);
      judgeOutput = {
        ...judgeOutput,
        findings: validation.kept,
        discarded_findings: [...(judgeOutput.discarded_findings ?? []), ...validation.discarded],
        evidence_validation: validation.summary,
      };

      // Phase 9: validate goal claims. Mirrors the evidence validator but for
      // goal_status: verified claims. Adapters opt in by implementing
      // outcomeContract(). Downgrades verified → partial when no outcome
      // artifact is cited.
      if (this.deps.adapter.outcomeContract) {
        const goalClaimResult = validateGoalClaims({
          judge: judgeOutput,
          trace: traceEvents,
          outcome_contract: this.deps.adapter.outcomeContract(),
        });
        judgeOutput = applyGoalClaimValidationToJudgeOutput(judgeOutput, goalClaimResult);
      }

      writeFileSync(
        join(config.out_dir, 'findings.json'),
        `${JSON.stringify({ findings: judgeOutput.findings, discarded_findings: judgeOutput.discarded_findings, evidence_validation: validation.summary, _written_at: new Date().toISOString() }, null, 2)}\n`,
      );
      writeFileSync(
        join(config.out_dir, 'scores.json'),
        `${JSON.stringify({ ...judgeOutput.scores, _written_at: new Date().toISOString() }, null, 2)}\n`,
      );
    } catch (err) {
      writeFileSync(
        join(config.out_dir, 'judge-error.txt'),
        err instanceof Error ? err.message : String(err),
      );
      const reportEarly = this.buildEmptyReport(
        config,
        startedAt,
        Date.now() - startMs,
        explorerResult.termination,
        explorerResult.steps_taken,
      );
      writeFileSync(
        join(config.out_dir, 'report.json'),
        `${JSON.stringify(reportEarly, null, 2)}\n`,
      );
      return {
        report: reportEarly,
        out_dir: config.out_dir,
        duration_s: (Date.now() - startMs) / 1000,
        cost_usd: explorerResult.cost_usd,
        termination: explorerResult.termination,
        exit_code: 3,
      };
    }

    const clipPaths: Record<string, string> = {};
    if (!config.no_clips) {
      try {
        const evidence = await collectClaimEvidenceArtifacts({
          adapter: this.deps.adapter,
          judge: judgeOutput,
          trace: traceEvents,
          runDir: config.out_dir,
        });
        Object.assign(clipPaths, evidence.clips);
      } catch (err) {
        // Slicing is best-effort. Don't fail the run if ffmpeg breaks.
        writeFileSync(
          join(config.out_dir, 'clips-error.txt'),
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // 8. Build report.json
    const endedAt = new Date();
    const duration_s = (Date.now() - startMs) / 1000;
    const cost_usd =
      this.deps.explorerClient.totals().cost_usd + this.deps.judgeClient.totals().cost_usd;
    const report = buildReportJson({
      judge: judgeOutput,
      trace_events: traceEvents,
      run: {
        id: startedAt.toISOString().replace(/[:]/g, '-'),
        target: { kind: config.target.kind, url: config.target.url },
        mode: config.mode,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_s,
        cost_usd,
        ...(config.transport ? { transport: config.transport } : {}),
        models: {
          discovery: config.explorer_model,
          explorer: config.explorer_model,
          judge: config.judge_model,
        },
        termination: explorerResult.termination,
        step_count: explorerResult.steps_taken,
      },
      ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
      artifacts: {
        ...(config.no_html ? {} : { report_html: './report.html' }),
        report_md: './report.md',
        trace: './trace.jsonl',
        ...(artifacts.artifact_files.trace_zip
          ? { trace_zip: artifacts.artifact_files.trace_zip }
          : {}),
        ...(artifacts.artifact_files.full_recording
          ? { video: artifacts.artifact_files.full_recording }
          : {}),
        ...(Object.keys(clipPaths).length > 0 ? { clips: clipPaths } : {}),
      },
    });

    writeFileSync(join(config.out_dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(config.out_dir, 'report.md'), buildReportMd(report));
    if (!config.no_html) {
      writeFileSync(
        join(config.out_dir, 'report.html'),
        buildReportHtml(report, { runDir: config.out_dir }),
      );
    }

    // 9. Determine exit code
    if (
      explorerResult.termination === 'budget_steps' ||
      explorerResult.termination === 'budget_time'
    ) {
      exitCode = 2;
    } else if (!report.headline.threshold_passed) {
      exitCode = 1;
    } else {
      exitCode = 0;
    }

    return {
      report,
      out_dir: config.out_dir,
      duration_s,
      cost_usd,
      termination: explorerResult.termination,
      exit_code: exitCode,
    };
  }

  private buildEmptyReport(
    config: OrchestratorRunConfig,
    startedAt: Date,
    elapsedMs: number,
    termination: ExplorerResult['termination'],
    steps: number,
  ): ReportJson {
    return buildReportJson({
      judge: {
        v: 1,
        findings: [],
        discarded_findings: [],
        scores: { overall: { score: 0, weighted_from: [] }, profiles: {} },
        spec_compliance: { applicable: false, goals: [], summary: 'run aborted before judge' },
        coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: 'aborted' },
        meta: {
          confidence_overall: 0,
          confidence_caveats: ['run aborted'],
          would_re_explore_with: [],
        },
      },
      run: {
        id: startedAt.toISOString().replace(/[:]/g, '-'),
        target: { kind: config.target.kind, url: config.target.url },
        mode: config.mode,
        started_at: startedAt.toISOString(),
        ended_at: new Date().toISOString(),
        duration_s: elapsedMs / 1000,
        cost_usd: 0,
        ...(config.transport ? { transport: config.transport } : {}),
        models: {
          discovery: config.explorer_model,
          explorer: config.explorer_model,
          judge: config.judge_model,
        },
        termination,
        step_count: steps,
      },
    });
  }

  // Phase 5: assemble a report when preflight fails. No score, no rubric —
  // just a banner explaining what failed and a screenshot.
  private buildBlockedReport(args: {
    config: OrchestratorRunConfig;
    startedAt: Date;
    startMs: number;
    preflight: {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
      screenshot?: string;
    };
    artifacts: Record<string, string>;
  }): ReportJson {
    const { config, startedAt, startMs, preflight, artifacts } = args;
    const failedReasons = preflight.checks.filter((c) => !c.ok).map((c) => c.name);
    return buildReportJson({
      judge: {
        v: 1,
        findings: [],
        discarded_findings: [],
        scores: { overall: { score: 0, weighted_from: [] }, profiles: {} },
        spec_compliance: { applicable: false, goals: [], summary: 'blocked at preflight' },
        coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: 'blocked' },
        meta: {
          confidence_overall: 0,
          confidence_caveats: [`Run blocked at preflight: ${failedReasons.join(', ')}`],
          would_re_explore_with: [],
        },
      },
      run: {
        id: startedAt.toISOString().replace(/[:]/g, '-'),
        target: { kind: config.target.kind, url: config.target.url },
        mode: config.mode,
        started_at: startedAt.toISOString(),
        ended_at: new Date().toISOString(),
        duration_s: (Date.now() - startMs) / 1000,
        cost_usd: 0,
        ...(config.transport ? { transport: config.transport } : {}),
        models: {
          discovery: config.explorer_model,
          explorer: config.explorer_model,
          judge: config.judge_model,
        },
        termination: 'blocked',
        step_count: 0,
      },
      preflight,
      blocked: { reasons: failedReasons },
      artifacts: {
        trace: './trace.jsonl',
        ...(artifacts.trace_zip ? { trace_zip: artifacts.trace_zip } : {}),
      },
    });
  }
}
