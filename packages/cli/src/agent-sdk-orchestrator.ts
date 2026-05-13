import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import {
  type Mode,
  discovery as discoveryMod,
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
  /** Phase 17: cost budget removed; field kept optional for backwards-compat
   * parsing of legacy AgentSdkRunConfig literals. Ignored at runtime. */
  max_cost_usd?: number;
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
  /** Phase 10: run discovery pass when no --spec is provided. Default true. */
  discover?: boolean;
  /** Phase 10: allow Explorer to append goals via propose_goal. Default true.
   * Capped at max_expansion_goals (default 6). */
  expand_goals?: boolean;
  max_expansion_goals?: number;
  /** Phase 16: run N parallel Explorer sessions across goal partitions.
   * Default 1 (current single-session behavior). When >1, the orchestrator:
   *   1. Runs discovery on a warmup adapter
   *   2. Stops the warmup adapter
   *   3. Partitions goals into N contiguous slices
   *   4. Spawns N parallel Explorer sessions via createAdapter factory
   *   5. Merges per-session traces into the main trace by ts
   *   6. Judge runs ONCE on the merged trace
   * Requires createAdapter parameter on runIrisViaSdk. Speedup is roughly N×
   * minus per-session auth overhead. */
  parallel?: number;
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
  adapterOrFactory: TargetAdapter | (() => TargetAdapter),
): Promise<AgentSdkRunResult> {
  // Phase 16: accept either a single adapter (legacy) or a factory. Parallel
  // mode (config.parallel > 1) requires the factory form so per-session
  // adapters can be created.
  const createAdapter: () => TargetAdapter =
    typeof adapterOrFactory === 'function' ? adapterOrFactory : () => adapterOrFactory;
  const adapter = createAdapter();
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

  // 4.6. Phase 9: emit interaction_kit event for the Judge.
  if (adapter.interactionKit) {
    const kit = adapter.interactionKit();
    await traceWriter.append({
      v: 1,
      id: ulid(),
      ts: Date.now() / 1000,
      step: 0,
      target_kind: 'web',
      kind: 'interaction_kit',
      actor: 'system',
      payload: { kind: kit.kind, primitives: kit.primitives },
    });
  }

  // 4.7. Phase 10: discovery pass. When no --spec was given (so no
  // interpreted spec), play the role of a new user: capture the landed
  // page and ask one LLM call to propose seed goals. The output looks
  // identical to InterpretedSpec so the rest of the flow doesn't care
  // where the goals came from.
  const wantDiscovery = config.discover !== false && !interpreted;
  if (wantDiscovery) {
    process.stderr.write('iris: running discovery pass via Agent SDK...\n');
    try {
      const obs = await adapter.observe();
      // Capture a screenshot via the adapter so discovery sees what the user sees.
      const ssResult = await adapter.callTool('screenshot', { full_page: false });
      const ssPath =
        ssResult.ok && ssResult.evidence_refs && ssResult.evidence_refs.length > 0
          ? ssResult.evidence_refs[0]
          : undefined;
      if (!ssPath) {
        process.stderr.write('iris: discovery skipped — no screenshot available\n');
      } else {
        const { visionDescribeViaSdk } = await import('./agent-sdk-runner.js');
        const discoveryResult = await discoveryMod.runDiscovery({
          url: config.target.url,
          observation_summary: obs.summary,
          screenshot_path: ssPath,
          model: config.explorer_model,
          discoverer: async (i) =>
            visionDescribeViaSdk({
              systemPrompt: i.systemPrompt,
              imagePath: i.imagePath,
              textPrompt: i.userPrompt,
              ...(i.model ? { model: i.model } : {}),
            }),
        });
        if (!discoveryResult) {
          process.stderr.write('iris: discovery returned no parseable goals — falling back\n');
        } else {
          totalCost += discoveryResult.cost_usd;
          const out = discoveryResult.output;
          process.stderr.write(
            `iris: discovery — ${out.goals.length} seed goals proposed; product: "${out.product_description.slice(0, 100)}"\n`,
          );
          await traceWriter.append({
            v: 1,
            id: ulid(),
            ts: Date.now() / 1000,
            step: 0,
            target_kind: 'web',
            kind: 'discovery',
            actor: 'system',
            payload: {
              product_description: out.product_description,
              goals: out.goals,
              focus_areas: out.focus_areas,
              hints: out.hints,
            },
          });
          writeFileSync(
            join(config.out_dir, 'discovery.json'),
            `${JSON.stringify(out, null, 2)}\n`,
          );
          // Shape into InterpretedSpec so downstream code paths converge.
          interpreted = {
            v: 1,
            target_kind_hint: 'web',
            goals: out.goals,
            focus_areas: out.focus_areas,
            hints: out.hints,
            out_of_scope: out.out_of_scope,
          };
          // Discovery produced goals — upgrade an inferred `free` mode to
          // `grounded` so per-goal budgeting and the grounded Explorer prompt
          // kick in.
          if (config.mode === 'free') {
            (config as { mode: Mode }).mode = 'grounded';
          }
        }
      }
    } catch (err) {
      process.stderr.write(`iris: discovery failed: ${(err as Error).message} — falling back\n`);
    }
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

  // Phase 14: the SDK turn cap IS max_steps directly. The Phase-5 formula
  // (goals × steps_per_goal + free) downward-clamped max_steps, which
  // re-imposed the very cap Phase 13 tried to remove. Now: max_steps is the
  // SDK-level safety upper bound. Per-goal cutover (1.5× steps_per_goal,
  // enforced in runAgentSdkExplorer) handles single-goal grinds. Real budgets
  // remain --max-cost-usd and --timeout.
  const stepsPerGoal = config.steps_per_goal;
  const freeExplorationSteps = config.free_exploration_steps ?? 0;
  const effectiveMaxSteps = config.max_steps;
  if (hasGoals && stepsPerGoal && stepsPerGoal > 0) {
    process.stderr.write(
      `iris: per-goal cutover ~${Math.ceil(stepsPerGoal * 1.5)} turns; total cap ${effectiveMaxSteps} (cost+time are the real budgets)\n`,
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

Tools are prefixed with \`mcp__iris__\` (e.g. \`mcp__iris__click\`, \`mcp__iris__type\`). BUDGET: ${config.timeout_s}s wall-clock. There is NO turn count to race against — focus on doing each goal properly, not on speed. Per-goal auto-cutover at ~${Math.ceil((stepsPerGoal ?? 10) * 1.5)} turns per goal prevents stuck goals from eating the run.`;

  // Phase 16: parallel branch — when config.parallel > 1, split the goals
  // into N contiguous slices and run N Explorer sessions in parallel. Each
  // session has its own adapter+browser+trace, then we merge traces by ts
  // and run Judge once on the merged view.
  const parallelN = Math.max(1, config.parallel ?? 1);
  const hasParallelGoals = parallelN > 1 && hasGoals && goals.length >= 2;

  process.stderr.write(
    parallelN > 1
      ? `iris: starting Explorer — ${parallelN} parallel sessions across ${goals.length} goals\n`
      : 'iris: starting Explorer (Agent SDK session)...\n',
  );
  let explorerResult: Awaited<ReturnType<typeof runAgentSdkExplorer>>;
  try {
    // Phase 10: expansion goal cap. 0 disables propose_goal entirely.
    const maxExpansion = config.expand_goals === false ? 0 : (config.max_expansion_goals ?? 6);

    if (hasParallelGoals) {
      // Close + stop the discovery adapter; its trace already has discovery
      // and interaction_kit events. We'll merge session traces into it later.
      await traceWriter.close();
      await adapter.stop();

      const goalGroups = partitionGoalsContiguous(
        goals.map((g, i) => ({ id: `G${i + 1}`, description: g.description })),
        parallelN,
      );
      // Phase 17: cost budget removed. Each session gets the full timeout.
      const perSessionTimeout = config.timeout_s;

      // Phase 16 robustness: use allSettled so one session crashing (e.g.
      // the SDK transport's "Query closed" race) doesn't kill the whole
      // orchestrator. The surviving sessions' trace + Judge can still
      // produce a useful report.
      const sessionOutcomes = await Promise.allSettled(
        goalGroups.map(async (subset, idx) => {
          const sessionDir = join(config.out_dir, `session-${idx}`);
          mkdirSync(sessionDir, { recursive: true });
          const sessionAdapter = createAdapter();
          await sessionAdapter.start({
            kind: 'web',
            target: config.target.url,
            out_dir: sessionDir,
          });
          const sessionTracePath = join(sessionDir, 'trace.jsonl');
          const sessionTrace = new iristrace.TraceWriter(sessionTracePath);

          // Each session sees ALL goals in its prompt (for context) but is
          // only responsible for verifying its subset.
          const subsetIds = subset.map((g) => g.id).join(', ');
          const subsetPrompt = `Target: ${config.target.url}\n\nAll discovered goals (for context):\n${goalList}\n\nYOUR ASSIGNED GOALS this session: ${subsetIds}\nOther sessions are independently handling the other goals — focus on yours.\n\nFor each assigned goal, in order:\n  1. Find the relevant UI element.\n  2. Interact with it normally.\n  3. Observe what changed via the auto-observation.\n  4. Call mcp__iris__goal_status with the goal id, status, and one-line rationale.\n  5. If you find a bug, ALSO call mcp__iris__note_finding.\n\n${perGoalLine}\n\nBUDGET: ${perSessionTimeout}s wall. Per-goal auto-cutover at ~${Math.ceil((stepsPerGoal ?? 10) * 1.5)} turns.`;

          const result = await runAgentSdkExplorer({
            adapter: sessionAdapter,
            traceWriter: sessionTrace,
            systemPrompt,
            initialUserPrompt: subsetPrompt,
            maxSteps: effectiveMaxSteps,
            timeoutS: perSessionTimeout,
            model: config.explorer_model,
            maxExpansionGoals: 0, // disable expansion in parallel mode for now
            ...(stepsPerGoal && stepsPerGoal > 0 ? { stepsPerGoal } : {}),
            goals: subset,
          });

          // Auto-axe + console for this session
          const sessionEvents = await iristrace.readTraceArray(sessionTracePath);
          const ranAxe = sessionEvents.some(
            (e) => e.kind === 'probe_result' && (e.payload as { probe?: string })?.probe === 'axe',
          );
          if (!ranAxe) {
            const axeResult = await sessionAdapter.runProbe('axe', {}).catch((err) => ({
              ok: false as const,
              probe: 'axe',
              error: err instanceof Error ? err.message : String(err),
            }));
            await sessionTrace.append({
              v: 1,
              id: ulid(),
              ts: Date.now() / 1000,
              step: 0,
              target_kind: 'web',
              kind: 'probe_result',
              actor: 'system',
              payload: axeResult.ok
                ? { probe: 'axe', summary: axeResult.summary, data: axeResult.data, ok: true }
                : { probe: 'axe', error: axeResult.error, ok: false },
            });
          }

          await sessionTrace.close();
          await sessionAdapter.stop();
          return { idx, result, tracePath: sessionTracePath };
        }),
      );

      // Drop failed sessions; log them but proceed with the surviving traces.
      const sessionResults: Array<{
        idx: number;
        result: Awaited<ReturnType<typeof runAgentSdkExplorer>>;
        tracePath: string;
      }> = [];
      for (let i = 0; i < sessionOutcomes.length; i++) {
        const o = sessionOutcomes[i];
        if (!o) continue;
        if (o.status === 'fulfilled') {
          sessionResults.push(o.value);
        } else {
          process.stderr.write(
            `iris: session-${i} failed: ${o.reason instanceof Error ? o.reason.message.slice(0, 200) : String(o.reason).slice(0, 200)}\n`,
          );
          // Try to recover the partial trace if it exists
          const partialPath = join(config.out_dir, `session-${i}`, 'trace.jsonl');
          if (existsSync(partialPath)) {
            sessionResults.push({
              idx: i,
              result: {
                state: {
                  plan_stack: [],
                  surfaces_seen: 0,
                  surfaces_unexplored: 0,
                  hypotheses: 0,
                  done: false,
                  give_up_reason: 'sdk_crash',
                },
                termination: 'give_up',
                cost_usd: 0,
                steps_taken: 0,
                duration_s: 0,
              },
              tracePath: partialPath,
            });
          }
        }
      }
      if (sessionResults.length === 0) {
        throw new Error('All parallel sessions crashed; aborting run');
      }

      // Merge per-session traces back into the main trace.jsonl
      const allTracePaths = [tracePath, ...sessionResults.map((s) => s.tracePath)];
      mergeTraceFiles(allTracePaths, tracePath);
      process.stderr.write(`iris: merged ${allTracePaths.length} trace files into ${tracePath}\n`);

      // Aggregate the per-session results into a single explorerResult
      explorerResult = {
        state: {
          plan_stack: [],
          surfaces_seen: sessionResults.reduce((s, r) => s + r.result.state.surfaces_seen, 0),
          surfaces_unexplored: 0,
          hypotheses: 0,
          done: sessionResults.every((r) => r.result.state.done),
          give_up_reason: null,
        },
        termination: sessionResults.every((r) => r.result.termination === 'done')
          ? 'done'
          : 'max_turns',
        cost_usd: sessionResults.reduce((s, r) => s + r.result.cost_usd, 0),
        steps_taken: sessionResults.reduce((s, r) => s + r.result.steps_taken, 0),
        duration_s: Math.max(...sessionResults.map((r) => r.result.duration_s)),
      };
      totalCost += explorerResult.cost_usd;
      process.stderr.write(
        `iris: parallel Explorer done — ${sessionResults.length} sessions, ${explorerResult.steps_taken} total steps, $${explorerResult.cost_usd.toFixed(2)}, max session wall ${explorerResult.duration_s.toFixed(0)}s\n`,
      );
    } else {
      explorerResult = await runAgentSdkExplorer({
        adapter,
        traceWriter,
        systemPrompt,
        initialUserPrompt,
        maxSteps: effectiveMaxSteps,
        timeoutS: config.timeout_s,
        model: config.explorer_model,
        maxExpansionGoals: maxExpansion,
        ...(stepsPerGoal && stepsPerGoal > 0 ? { stepsPerGoal } : {}),
        ...(hasGoals
          ? { goals: goals.map((g, i) => ({ id: `G${i + 1}`, description: g.description })) }
          : {}),
      });
      totalCost += explorerResult.cost_usd;
      process.stderr.write(
        `iris: Explorer done — termination=${explorerResult.termination}, ${explorerResult.steps_taken} steps, $${explorerResult.cost_usd.toFixed(2)}\n`,
      );

      // Phase 14: programmatically run a11y + console_errors at end of
      // Explorer session so the Judge always has these data points. The
      // Explorer was instructed to run them but skipped on 4 of 5 P13 apps —
      // making "0 findings" partly mean "Iris didn't look." Now Iris always
      // looks, regardless of agent discipline.
      const alreadyRanAxe = (await iristrace.readTraceArray(tracePath)).some(
        (e) => e.kind === 'probe_result' && (e.payload as { probe?: string })?.probe === 'axe',
      );
      if (!alreadyRanAxe) {
        process.stderr.write('iris: auto-running axe (post-Explorer)…\n');
        const axeResult = await adapter.runProbe('axe', {}).catch((err) => ({
          ok: false as const,
          probe: 'axe',
          error: err instanceof Error ? err.message : String(err),
        }));
        await traceWriter.append({
          v: 1,
          id: ulid(),
          ts: Date.now() / 1000,
          step: 0,
          target_kind: 'web',
          kind: 'probe_result',
          actor: 'system',
          payload: axeResult.ok
            ? { probe: 'axe', summary: axeResult.summary, data: axeResult.data, ok: true }
            : { probe: 'axe', error: axeResult.error, ok: false },
        });
      }
      const alreadyRanConsole = (await iristrace.readTraceArray(tracePath)).some(
        (e) =>
          e.kind === 'probe_result' &&
          (e.payload as { probe?: string })?.probe === 'console_errors_since',
      );
      if (!alreadyRanConsole) {
        const cResult = await adapter.runProbe('console_errors_since', {}).catch((err) => ({
          ok: false as const,
          probe: 'console_errors_since',
          error: err instanceof Error ? err.message : String(err),
        }));
        await traceWriter.append({
          v: 1,
          id: ulid(),
          ts: Date.now() / 1000,
          step: 0,
          target_kind: 'web',
          kind: 'probe_result',
          actor: 'system',
          payload: cResult.ok
            ? {
                probe: 'console_errors_since',
                summary: cResult.summary,
                data: cResult.data,
                ok: true,
              }
            : { probe: 'console_errors_since', error: cResult.error, ok: false },
        });
      }
    } // end of single-session else branch (Phase 16)
  } finally {
    // In single-session mode the traceWriter is still open; close it.
    // In parallel mode it was already closed before spawning sessions.
    try {
      await traceWriter.close();
    } catch {
      // already closed by parallel branch
    }
  }

  // 6. Adapter.stop — in parallel mode each session already stopped its
  // own adapter and the discovery adapter was stopped before spawning;
  // emulate an empty artifacts here.
  const artifacts = hasParallelGoals
    ? {
        evidence_dir: join(config.out_dir, 'evidence'),
        artifact_files: {} as Record<string, string>,
      }
    : await adapter.stop();

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

    // Phase 9: goal-claim validator. Downgrades verified→partial when no
    // outcome artifact is cited in the goal window.
    if (adapter.outcomeContract) {
      const goalClaimResult = judgeMod.validateGoalClaims({
        judge: judgeOutput,
        trace: events,
        outcome_contract: adapter.outcomeContract(),
      });
      judgeOutput = judgeMod.applyGoalClaimValidationToJudgeOutput(judgeOutput, goalClaimResult);
      if (goalClaimResult.summary.downgraded > 0) {
        process.stderr.write(
          `iris: goal-claim validator — ${goalClaimResult.summary.verified_kept} kept verified, ${goalClaimResult.summary.downgraded} downgraded to partial\n`,
        );
        for (const r of goalClaimResult.summary.downgrade_reasons) {
          process.stderr.write(`iris:   ${r}\n`);
        }
      }
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
  // Phase 16: clip slicing in parallel mode would need per-session video
  // attribution per finding — skip for now and document as known limitation.
  if (!hasParallelGoals && adapter.injectEventTimestamps && adapter.sliceEvidence) {
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

// Phase 16: split goals into N contiguous slices. Contiguous (not round-robin)
// preserves the natural dependency order discovery produced — e.g., G3 "create
// issue" and G4 "open issue" stay in the same slice so the agent can use what
// G3 created. Discovery orders goals by user-likelihood, so contiguous slices
// also keep "core flow" goals together.
export function partitionGoalsContiguous<T>(goals: T[], n: number): T[][] {
  if (n <= 1) return [goals];
  const groups: T[][] = Array.from({ length: n }, () => []);
  const perGroup = Math.ceil(goals.length / n);
  for (let i = 0; i < goals.length; i++) {
    const g = Math.min(Math.floor(i / perGroup), n - 1);
    groups[g]?.push(goals[i] as T);
  }
  return groups.filter((g) => g.length > 0);
}

// Phase 16: merge multiple trace files into one, sorted by ts (ULID-based ts
// is already monotonic within a single session; we sort across sessions to
// produce a coherent linear trace for the Judge).
export function mergeTraceFiles(inputPaths: string[], outputPath: string): void {
  const all: Array<{ ts: number; line: string }> = [];
  for (const p of inputPaths) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts?: number };
        all.push({ ts: e.ts ?? 0, line });
      } catch {
        // Skip malformed lines (shouldn't happen).
      }
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  writeFileSync(outputPath, `${all.map((e) => e.line).join('\n')}\n`);
}
