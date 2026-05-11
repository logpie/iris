import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import {
  type Mode,
  explorer as explorerMod,
  trace as iristrace,
  judge as judgeMod,
  preflight as preflightMod,
  report as reportMod,
  specInterpreter,
} from '@iris/core';
import type { RubricProfile } from '@iris/rubrics';
import { ulid } from 'ulid';
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
  /** Phase 5: per-goal budget. If set, max_steps is recomputed as
   * goals * steps_per_goal + free_exploration_steps. */
  steps_per_goal?: number;
  free_exploration_steps?: number;
  /** Phase 5: preflight skip-flag for debugging. */
  no_preflight?: boolean;
  preflight_timeout_s?: number;
  /** Phase 6 F2: run Judge twice in parallel and intersect critical findings. */
  judge_ensemble?: boolean;
}

export interface AgentSdkRunResult {
  report: ReturnType<typeof reportMod.buildReportJson>;
  out_dir: string;
  duration_s: number;
  cost_usd: number;
  termination: string;
  exit_code: 0 | 1 | 2 | 3 | 4;
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

  // 4.5. Phase 5 preflight (skip if --no-preflight or adapter doesn't support).
  const tracePath = join(config.out_dir, 'trace.jsonl');
  const traceWriter = new iristrace.TraceWriter(tracePath);

  if (!config.no_preflight && adapter.preflightProbe) {
    process.stderr.write('iris: running preflight...\n');
    const preflight = await preflightMod.runPreflight(adapter, {
      timeoutS: config.preflight_timeout_s ?? 15,
    });
    await traceWriter.append({
      v: 1,
      id: ulid(),
      ts: Date.now() / 1000,
      step: 0,
      target_kind: 'web',
      kind: 'preflight',
      actor: 'system',
      payload: {
        ok: preflight.ok,
        checks: preflight.checks,
        ...(preflight.screenshot ? { screenshot: preflight.screenshot } : {}),
      },
    });
    if (!preflight.ok) {
      await traceWriter.close();
      const artifacts = await adapter.stop();
      const failedReasons = preflight.checks.filter((c) => !c.ok).map((c) => c.name);
      process.stderr.write(`iris: preflight blocked — ${failedReasons.join(', ')}\n`);
      const blockedReport = reportMod.buildReportJson({
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
          target: { kind: 'web', url: config.target.url },
          mode: config.mode,
          started_at: startedAt.toISOString(),
          ended_at: new Date().toISOString(),
          duration_s: (Date.now() - startMs) / 1000,
          cost_usd: totalCost,
          models: { explorer: config.explorer_model, judge: config.judge_model },
          termination: 'blocked',
          step_count: 0,
        },
        preflight,
        blocked: { reasons: failedReasons },
        artifacts: {
          trace: './trace.jsonl',
          ...(artifacts.artifact_files.trace_zip
            ? { trace_zip: artifacts.artifact_files.trace_zip }
            : {}),
        },
      });
      writeFileSync(
        join(config.out_dir, 'report.json'),
        `${JSON.stringify(blockedReport, null, 2)}\n`,
      );
      writeFileSync(join(config.out_dir, 'report.md'), reportMod.buildReportMd(blockedReport));
      if (!config.no_html) {
        writeFileSync(
          join(config.out_dir, 'report.html'),
          reportMod.buildReportHtml(blockedReport, { runDir: config.out_dir }),
        );
      }
      return {
        report: blockedReport,
        out_dir: config.out_dir,
        duration_s: (Date.now() - startMs) / 1000,
        cost_usd: totalCost,
        termination: 'blocked',
        exit_code: 4,
      };
    }
    process.stderr.write('iris: preflight passed\n');
  }

  // 5. Explorer via Agent SDK

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

  const goals = interpreted?.goals ?? [];
  const hasGoals = goals.length > 0;

  // Phase 5: per-goal budget. If steps_per_goal is set, compute an effective
  // max_steps that scales with the goal count.
  const stepsPerGoal = config.steps_per_goal;
  const freeExplorationSteps = config.free_exploration_steps ?? 0;
  const effectiveMaxSteps =
    hasGoals && stepsPerGoal && stepsPerGoal > 0
      ? Math.min(config.max_steps, goals.length * stepsPerGoal + freeExplorationSteps)
      : config.max_steps;
  if (effectiveMaxSteps !== config.max_steps) {
    process.stderr.write(
      `iris: per-goal budget — ${goals.length} goals × ${stepsPerGoal} + ${freeExplorationSteps} free = ${effectiveMaxSteps} turns (max_steps cap: ${config.max_steps})\n`,
    );
  }

  const goalList = hasGoals ? goals.map((g, i) => `  G${i + 1}. ${g.description}`).join('\n') : '';
  const perGoalLine =
    stepsPerGoal && stepsPerGoal > 0
      ? `Per-goal budget: ~${stepsPerGoal} turns per goal. When a goal is finished (verified, partial, blocked, or skipped), call \`mcp__iris__goal_status\` with that status and move to the next goal. If you don't call it, the system will auto-mark the goal as partial after ~${Math.ceil(stepsPerGoal * 1.5)} turns and move on.`
      : '';

  const initialUserPrompt = `Target: ${config.target.url}

${hasGoals ? `What this app is supposed to do (from the spec):\n${goalList}\n\nYour job: USE THIS APP. Verify each spec goal by performing it as a normal user would.\n\nFor each goal, in order:\n  1. Find the relevant UI element (input, button, link).\n  2. Interact with it normally — type text, click, submit. Don't just look.\n  3. Observe what changed.\n  4. Call \`mcp__iris__goal_status\` with the goal id (G1, G2, …), status (verified / partial / blocked / skipped), and a one-line rationale.\n  5. If you find a bug, ALSO call \`mcp__iris__note_finding\` with category="bug".\n\n${perGoalLine}\n` : `Your job: USE THIS APP. Open it, find the primary feature, exercise it like a curious new user. Type real text. Click real buttons. Don't just look at the page.\n`}
PRIORITY ORDER:
  1. HAPPY PATHS FIRST. Make the primary features work before anything else. If the app is a TODO list, your first action is to add a todo. If it's a sign-in form, your first action is to fill it in and submit.
  2. AFTER happy paths complete, run \`mcp__iris__axe\` and \`mcp__iris__console_errors_since\` once to catch passive issues.
  3. THEN try edge cases: empty submits, very long inputs, special characters, the destructive action.

AVOID:
  - Reading the page for 2+ turns before acting. ONE observe, then act.
  - Calling probes before any user interaction. Probes are useful AFTER you've exercised the flows, not before.
  - Defaulting to screenshot when DOM observation already shows what you need.
  - Trying many alternate selectors when the first failed. After one selector miss, try a different approach (different element, different action, or note_finding "I expected X but couldn't find it").
  - Spending more than the per-goal budget on one goal. Call goal_status and move on — you can come back later if there's time.

Tools are prefixed with \`mcp__iris__\` (e.g. \`mcp__iris__click\`, \`mcp__iris__type\`). Total budget: ~${effectiveMaxSteps} interaction turns, $${config.max_cost_usd.toFixed(2)} cost cap.`;

  process.stderr.write('iris: starting Explorer (Agent SDK session)...\n');
  let explorerResult: Awaited<ReturnType<typeof runAgentSdkExplorer>>;
  try {
    explorerResult = await runAgentSdkExplorer({
      adapter,
      traceWriter,
      systemPrompt,
      initialUserPrompt,
      maxSteps: effectiveMaxSteps,
      maxCostUsd: config.max_cost_usd - totalCost,
      timeoutS: config.timeout_s,
      model: config.explorer_model,
      ...(hasGoals
        ? { goals: goals.map((g, i) => ({ id: `G${i + 1}`, description: g.description })) }
        : {}),
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
    // Phase 6 F2: if ensemble enabled, run Judge twice in parallel and merge.
    if (config.judge_ensemble) {
      process.stderr.write('iris: Judge ensemble (2 parallel passes)...\n');
      const [r1, r2] = await Promise.all([
        runAgentSdkSingleShot({
          systemPrompt: judgeMod.JUDGE_SYSTEM,
          userPrompt: judgeUserPrompt,
          model: config.judge_model,
          maxTokens: 8000,
        }),
        runAgentSdkSingleShot({
          systemPrompt: judgeMod.JUDGE_SYSTEM,
          userPrompt: judgeUserPrompt,
          model: config.judge_model,
          maxTokens: 8000,
        }),
      ]);
      totalCost += r1.cost_usd + r2.cost_usd;
      const m1 = r1.text.match(/\{[\s\S]*\}/);
      const m2 = r2.text.match(/\{[\s\S]*\}/);
      if (!m1 || !m2) throw new Error('Judge ensemble: one or both passes returned no JSON');
      const p1 = judgeMod.JudgeOutputSchema.parse(JSON.parse(m1[0]));
      const p2 = judgeMod.JudgeOutputSchema.parse(JSON.parse(m2[0]));
      const merged = judgeMod.mergeJudgePasses(p1, p2, events);
      judgeOutput = merged.output;
      process.stderr.write(
        `iris: Judge ensemble — ${merged.metadata.agreed_critical} agreed critical, ${merged.metadata.disagreed_critical} disagreed; $${(r1.cost_usd + r2.cost_usd).toFixed(2)}\n`,
      );
    } else {
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
    }

    // Phase 5 G3: validate findings against the trace.
    const validation = judgeMod.validateFindings(judgeOutput.findings, events);
    judgeOutput = {
      ...judgeOutput,
      findings: validation.kept,
      discarded_findings: [...(judgeOutput.discarded_findings ?? []), ...validation.discarded],
      evidence_validation: validation.summary,
    };
    if (validation.summary.discarded + validation.summary.downgraded > 0) {
      process.stderr.write(
        `iris: validator — ${validation.summary.verified} verified, ${validation.summary.downgraded} downgraded, ${validation.summary.discarded} discarded\n`,
      );
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

  // 7.5. Phase 6 F3: per-finding video clips.
  const clipPaths: Record<string, string> = {};
  if (adapter.injectEventTimestamps && adapter.sliceEvidence) {
    const tsMap: Record<string, number> = {};
    for (const e of events) tsMap[e.id] = e.ts;
    adapter.injectEventTimestamps(tsMap);
    const refs = judgeOutput.findings
      .filter((f) => f.evidence.length > 0)
      .map((f) => ({ finding_id: f.id, event_ids: f.evidence }));
    if (refs.length > 0) {
      try {
        const evidenceFiles = await adapter.sliceEvidence(refs);
        for (const ef of evidenceFiles) {
          if (ef.kind === 'video' || ef.kind === 'screenshot') {
            clipPaths[ef.finding_id] = ef.path;
          }
        }
        process.stderr.write(`iris: sliced ${evidenceFiles.length} per-finding evidence files\n`);
      } catch (err) {
        writeFileSync(
          join(config.out_dir, 'clips-error.txt'),
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // 8. Build report
  const endedAt = new Date();
  const duration_s = (Date.now() - startMs) / 1000;
  const report = reportMod.buildReportJson({
    judge: judgeOutput,
    trace_events: events,
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
      ...(Object.keys(clipPaths).length > 0 ? { clips: clipPaths } : {}),
    },
  });

  writeFileSync(join(config.out_dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(config.out_dir, 'report.md'), reportMod.buildReportMd(report));
  if (!config.no_html) {
    writeFileSync(
      join(config.out_dir, 'report.html'),
      reportMod.buildReportHtml(report, { runDir: config.out_dir }),
    );
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
