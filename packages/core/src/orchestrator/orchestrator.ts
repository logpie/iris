import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import type { RubricProfile } from '@iris/rubrics';
import { Explorer, type ExplorerResult } from '../explorer/explorer.js';
import type { PersonaName } from '../explorer/personas/index.js';
import { Judge, type JudgeOutput } from '../judge/judge.js';
import type { LlmClient } from '../llm/client.js';
import { buildReportHtml } from '../report/report-html.js';
import { type ReportJson, buildReportJson } from '../report/report-json.js';
import { buildReportMd } from '../report/report-md.js';
import { type InterpretedSpec, interpretSpec } from '../spec-interpreter/interpreter.js';
import { TraceWriter } from '../trace/writer.js';
import type { Mode, TargetKind } from '../types.js';

export interface OrchestratorRunConfig {
  target: { kind: TargetKind; url: string };
  mode: Mode;
  out_dir: string;
  spec_text?: string;
  spec_path?: string;
  initial_tasks?: string[];
  rubric_profiles: RubricProfile[];
  max_steps: number;
  max_cost_usd: number;
  timeout_s: number;
  threshold?: number;
  explorer_model: string;
  judge_model: string;
  no_html: boolean;
  persona?: PersonaName;
}

export interface OrchestratorResult {
  report: ReportJson;
  out_dir: string;
  duration_s: number;
  cost_usd: number;
  termination: ExplorerResult['termination'];
  exit_code: 0 | 1 | 2 | 3;
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
    let exitCode: 0 | 1 | 2 | 3 = 0;
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

    // 5. Explorer
    const tracePath = join(config.out_dir, 'trace.jsonl');
    const traceWriter = new TraceWriter(tracePath);
    const initialPlanStack: string[] = [];
    if (interpreted) {
      for (const g of interpreted.goals) initialPlanStack.push(`verify: ${g.description}`);
    } else if (config.initial_tasks) {
      initialPlanStack.push(...config.initial_tasks);
    }

    const explorer = new Explorer({
      adapter: this.deps.adapter,
      llmClient: this.deps.explorerClient,
      traceWriter,
      config: {
        mode: config.mode,
        target_kind: config.target.kind,
        model: config.explorer_model,
        max_steps: config.max_steps,
        max_cost_usd: config.max_cost_usd,
        timeout_s: config.timeout_s,
        ...(initialPlanStack.length > 0 ? { initial_plan_stack: initialPlanStack } : {}),
        ...(config.persona !== undefined ? { persona: config.persona } : {}),
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
    try {
      judgeOutput = await judge.run({
        trace_path: tracePath,
        ...(specText !== undefined ? { spec_text: specText } : {}),
        ...(interpreted ? { spec_goals: interpreted.goals } : {}),
        rubric_profiles: config.rubric_profiles,
        model: config.judge_model,
      });
      writeFileSync(
        join(config.out_dir, 'findings.json'),
        `${JSON.stringify({ findings: judgeOutput.findings, discarded_findings: judgeOutput.discarded_findings, _written_at: new Date().toISOString() }, null, 2)}\n`,
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

    // 8. Build report.json
    const endedAt = new Date();
    const duration_s = (Date.now() - startMs) / 1000;
    const cost_usd =
      this.deps.explorerClient.totals().cost_usd + this.deps.judgeClient.totals().cost_usd;
    const report = buildReportJson({
      judge: judgeOutput,
      run: {
        id: startedAt.toISOString().replace(/[:]/g, '-'),
        target: { kind: config.target.kind, url: config.target.url },
        mode: config.mode,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_s,
        cost_usd,
        models: { explorer: config.explorer_model, judge: config.judge_model },
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
      },
    });

    writeFileSync(join(config.out_dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(config.out_dir, 'report.md'), buildReportMd(report));
    if (!config.no_html) {
      writeFileSync(join(config.out_dir, 'report.html'), buildReportHtml(report));
    }

    // 9. Determine exit code
    if (
      explorerResult.termination === 'budget_steps' ||
      explorerResult.termination === 'budget_cost' ||
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
        models: { explorer: config.explorer_model, judge: config.judge_model },
        termination,
        step_count: steps,
      },
    });
  }
}
