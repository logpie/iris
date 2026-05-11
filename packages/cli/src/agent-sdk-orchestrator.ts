import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import {
  type Mode,
  explorer as explorerMod,
  trace as iristrace,
  judge as judgeMod,
  report as reportMod,
  specInterpreter,
} from '@iris/core';
import type { RubricProfile } from '@iris/rubrics';
import { runAgentSdkExplorer, runAgentSdkSingleShot } from './agent-sdk-runner.js';

/**
 * SDK-driven orchestrator. Runs the full iris pipeline (spec interp + Explorer + Judge + Report)
 * using @anthropic-ai/claude-agent-sdk for all LLM calls. Uses local Claude Code subscription
 * (no API key required). Each query() session reuses the subprocess across turns, so per-turn
 * latency is API-speed (~2-3s) instead of subprocess-spawn-speed (~30-60s with `claude -p`).
 */

export interface AgentSdkRunConfig {
  target: { kind: 'web'; url: string };
  mode: Mode;
  out_dir: string;
  spec_text?: string;
  spec_path?: string;
  rubric_profiles: RubricProfile[];
  max_steps: number;
  max_cost_usd: number;
  timeout_s: number;
  threshold?: number;
  explorer_model: string;
  judge_model: string;
  no_html: boolean;
  persona?: string;
}

export interface AgentSdkRunResult {
  report: ReturnType<typeof reportMod.buildReportJson>;
  out_dir: string;
  duration_s: number;
  cost_usd: number;
  termination: string;
  exit_code: 0 | 1 | 2 | 3;
}

export async function runIrisViaSdk(
  config: AgentSdkRunConfig,
  adapter: TargetAdapter,
): Promise<AgentSdkRunResult> {
  const startedAt = new Date();
  const startMs = Date.now();
  mkdirSync(config.out_dir, { recursive: true });

  // 1. Save config
  writeFileSync(
    join(config.out_dir, 'config.json'),
    `${JSON.stringify({ ...config, transport: 'agent-sdk', _written_at: startedAt.toISOString() }, null, 2)}\n`,
  );

  // 2. Spec text
  let specText: string | undefined;
  if (config.spec_text !== undefined) {
    specText = config.spec_text;
    writeFileSync(join(config.out_dir, 'spec.input.txt'), specText);
  } else if (config.spec_path && existsSync(config.spec_path)) {
    specText = readFileSync(config.spec_path, 'utf8');
    copyFileSync(config.spec_path, join(config.out_dir, 'spec.input.txt'));
  }

  // 3. Spec interpreter (one SDK single-shot call)
  let interpreted: specInterpreter.InterpretedSpec | undefined;
  let totalCost = 0;
  if (config.mode === 'grounded' && specText) {
    process.stderr.write('iris: running spec interpreter via Agent SDK...\n');
    const r = await runAgentSdkSingleShot({
      systemPrompt: specInterpreter.SPEC_INTERPRETER_SYSTEM,
      userPrompt: specInterpreter.SPEC_INTERPRETER_USER_TEMPLATE(specText),
      model: config.explorer_model,
    });
    totalCost += r.cost_usd;
    const jsonMatch = r.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        interpreted = specInterpreter.InterpretedSpecSchema.parse(JSON.parse(jsonMatch[0]));
        writeFileSync(
          join(config.out_dir, 'spec.interpreted.json'),
          `${JSON.stringify(interpreted, null, 2)}\n`,
        );
        process.stderr.write(`iris: spec interpreter done — ${interpreted.goals.length} goals\n`);
      } catch (err) {
        process.stderr.write(`iris: spec interpreter parse failed: ${(err as Error).message}\n`);
      }
    }
  }

  // 4. Adapter.start
  await adapter.start({ kind: 'web', target: config.target.url, out_dir: config.out_dir });

  // 5. Explorer via Agent SDK
  const tracePath = join(config.out_dir, 'trace.jsonl');
  const traceWriter = new iristrace.TraceWriter(tracePath);

  const personaName = (config.persona ?? 'default') as
    | 'default'
    | 'power_user'
    | 'novice'
    | 'adversarial'
    | 'keyboard_only';
  const systemPrompt = explorerMod.buildSystemPrompt({
    core: explorerMod.EXPLORER_CORE,
    target_kind: 'web',
    mode: config.mode,
    persona: personaName,
  });

  const initialPlanLines: string[] = [];
  if (interpreted) {
    for (const g of interpreted.goals) initialPlanLines.push(`verify: ${g.description}`);
  }

  const initialUserPrompt = `You are exploring this target: ${config.target.url}

${initialPlanLines.length > 0 ? `Initial plan:\n${initialPlanLines.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}\n\n` : ''}Start by calling \`mcp__iris__observe\` to see the current page, then act.

ON FIRST OBSERVATION, ALWAYS call these probes (cheap, high-signal):
- \`mcp__iris__console_errors_since\` — checks for JS console errors / warnings
- \`mcp__iris__network_failures_since\` — checks for 4xx/5xx HTTP responses
- \`mcp__iris__axe\` — runs axe-core a11y audit

These probes seed evidence the judge will use. Skipping them means missing whole categories of bugs.

Available tool naming: all tools are prefixed with mcp__iris__ (e.g. mcp__iris__click, mcp__iris__type, mcp__iris__note_finding, mcp__iris__done).

Budget: ~${config.max_steps} steps, $${config.max_cost_usd.toFixed(2)} max cost. Use note_finding LIBERALLY when something looks off; the judge dedupes false positives. Call done when goals are satisfied or you've completed thorough exploration; call give_up if stuck.`;

  process.stderr.write('iris: starting Explorer (Agent SDK session)...\n');
  let explorerResult: Awaited<ReturnType<typeof runAgentSdkExplorer>>;
  try {
    explorerResult = await runAgentSdkExplorer({
      adapter,
      traceWriter,
      systemPrompt,
      initialUserPrompt,
      maxSteps: config.max_steps,
      maxCostUsd: config.max_cost_usd - totalCost,
      timeoutS: config.timeout_s,
      model: config.explorer_model,
    });
    totalCost += explorerResult.cost_usd;
    process.stderr.write(
      `iris: Explorer done — termination=${explorerResult.termination}, ${explorerResult.steps_taken} steps, $${explorerResult.cost_usd.toFixed(2)}\n`,
    );
  } finally {
    await traceWriter.close();
  }

  // 6. Adapter.stop
  const artifacts = await adapter.stop();

  // 7. Judge via SDK single-shot
  process.stderr.write('iris: running Judge via Agent SDK...\n');
  const events = await iristrace.readTraceArray(tracePath);
  const tentativeCount = events.filter((e) => e.kind === 'tentative_finding').length;
  const digest = judgeMod.buildTraceDigest(events);
  const judgeUserPrompt = judgeMod.buildJudgeUserPrompt({
    trace_digest: digest,
    ...(specText !== undefined ? { spec_text: specText } : {}),
    ...(interpreted ? { spec_goals: interpreted.goals } : {}),
    rubric_profiles: config.rubric_profiles,
    tentative_findings_count: tentativeCount,
  });

  let judgeOutput: judgeMod.JudgeOutput;
  try {
    const judgeResp = await runAgentSdkSingleShot({
      systemPrompt: judgeMod.JUDGE_SYSTEM,
      userPrompt: judgeUserPrompt,
      model: config.judge_model,
      maxTokens: 8000,
    });
    totalCost += judgeResp.cost_usd;
    process.stderr.write(`iris: Judge done — $${judgeResp.cost_usd.toFixed(2)}\n`);
    const jsonMatch = judgeResp.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Judge returned no JSON');
    judgeOutput = judgeMod.JudgeOutputSchema.parse(JSON.parse(jsonMatch[0]));
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
    return {
      report: emptyReport(
        config,
        startedAt,
        totalCost,
        explorerResult.termination,
        explorerResult.steps_taken,
      ),
      out_dir: config.out_dir,
      duration_s: (Date.now() - startMs) / 1000,
      cost_usd: totalCost,
      termination: explorerResult.termination,
      exit_code: 3,
    };
  }

  // 8. Build report
  const endedAt = new Date();
  const duration_s = (Date.now() - startMs) / 1000;
  const report = reportMod.buildReportJson({
    judge: judgeOutput,
    run: {
      id: startedAt.toISOString().replace(/[:]/g, '-'),
      target: { kind: 'web', url: config.target.url },
      mode: config.mode,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_s,
      cost_usd: totalCost,
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
  writeFileSync(join(config.out_dir, 'report.md'), reportMod.buildReportMd(report));
  if (!config.no_html) {
    writeFileSync(join(config.out_dir, 'report.html'), reportMod.buildReportHtml(report, { runDir: config.out_dir }));
  }

  let exitCode: 0 | 1 | 2 | 3 = 0;
  if (
    explorerResult.termination === 'budget_steps' ||
    explorerResult.termination === 'budget_cost' ||
    explorerResult.termination === 'budget_time' ||
    explorerResult.termination === 'max_turns'
  ) {
    exitCode = 2;
  } else if (!report.headline.threshold_passed) {
    exitCode = 1;
  }

  return {
    report,
    out_dir: config.out_dir,
    duration_s,
    cost_usd: totalCost,
    termination: explorerResult.termination,
    exit_code: exitCode,
  };
}

function emptyReport(
  config: AgentSdkRunConfig,
  startedAt: Date,
  cost_usd: number,
  termination: string,
  steps: number,
): ReturnType<typeof reportMod.buildReportJson> {
  return reportMod.buildReportJson({
    judge: {
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: { overall: { score: 0, weighted_from: [] }, profiles: {} },
      spec_compliance: { applicable: false, goals: [], summary: 'judge failed' },
      coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: 'aborted' },
      meta: {
        confidence_overall: 0,
        confidence_caveats: ['judge failed'],
        would_re_explore_with: [],
      },
    },
    run: {
      id: startedAt.toISOString().replace(/[:]/g, '-'),
      target: { kind: 'web', url: config.target.url },
      mode: config.mode,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      duration_s: (Date.now() - startedAt.getTime()) / 1000,
      cost_usd,
      models: { explorer: config.explorer_model, judge: config.judge_model },
      termination,
      step_count: steps,
    },
  });
}
