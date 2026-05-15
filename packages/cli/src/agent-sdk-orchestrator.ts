import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
import {
  type SingleShotResult,
  runAgentSdkExplorer,
  runAgentSdkSingleShot,
} from './agent-sdk-runner.js';

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
  initial_tasks?: Array<{ description: string; priority?: string }>;
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
  no_clips?: boolean;
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
  /** Phase 18: when parallel>1 and the app has auth, run ONE bootstrap
   * Explorer session focused only on signing up/in, export Playwright
   * storageState, then launch N productive sessions hydrated with that
   * state. Prevents per-session auth duplication, email-collision retry
   * thrash, and the email-verification gate blocking late sessions. */
  share_auth?: boolean;
}

export interface AgentSdkRunResult {
  report: ReturnType<typeof reportMod.buildReportJson>;
  out_dir: string;
  duration_s: number;
  cost_usd: number;
  termination: string;
  exit_code: 0 | 1 | 2 | 3 | 4;
}

/** Phase 18: adapter factory may take an optional storage_state_path to
 * hydrate the BrowserContext with cookies + localStorage from a previous
 * authenticated session. Used by --share-auth to skip per-session auth. */
export type AdapterFactory = (opts?: { storage_state_path?: string }) => TargetAdapter;

type JudgeResponseForDiagnostics = Pick<
  SingleShotResult,
  'text' | 'partial' | 'partial_error' | 'hit_output_cap'
>;

export class JudgeResponseParseError extends Error {
  readonly label: string;
  readonly parseError: unknown;
  readonly response: JudgeResponseForDiagnostics;

  constructor(label: string, parseError: unknown, response: JudgeResponseForDiagnostics) {
    super(`${label} parse failed: ${errorMessage(parseError)}`);
    this.name = 'JudgeResponseParseError';
    this.label = label;
    this.parseError = parseError;
    this.response = response;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function extractJsonObjectCandidate(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return text
    .slice(start)
    .replace(/```(?:json)?\s*$/i, '')
    .trim();
}

function repairTruncatedJsonCandidate(candidate: string): string {
  let repaired = candidate
    .trim()
    .replace(/```(?:json)?\s*$/i, '')
    .trim();
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of repaired) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      const expected = stack[stack.length - 1];
      if (expected === ch) stack.pop();
    }
  }

  if (escaped) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  while (stack.length > 0) {
    repaired = repaired.replace(/,\s*$/, '');
    repaired += stack.pop();
  }
  return repaired;
}

function parseJsonCandidateWithSalvage(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    const repaired = repairTruncatedJsonCandidate(candidate);
    if (repaired !== candidate) {
      try {
        return JSON.parse(repaired);
      } catch {
        // Preserve the original parser error; it points at the real failure.
      }
    }
    throw firstErr;
  }
}

function parseJudgeOutputFromResponse(
  response: JudgeResponseForDiagnostics,
  label: string,
): judgeMod.JudgeOutput {
  try {
    const jsonCandidate = extractJsonObjectCandidate(response.text);
    if (!jsonCandidate) throw new Error(`${label} returned no JSON`);
    const parsed = parseJsonCandidateWithSalvage(jsonCandidate);
    return judgeMod.JudgeOutputSchema.parse(parsed);
  } catch (err) {
    throw new JudgeResponseParseError(label, err, response);
  }
}

const TRUNCATION_ERROR_PATTERNS = [
  /Expected ',' or '\}'/i,
  /Unexpected end of JSON input/i,
  /unterminated string/i,
  /after property value in JSON/i,
  /max[_ -]?output[_ -]?tokens/i,
  /output cap/i,
];

export function isTruncationShapedJudgeError(
  err: unknown,
  response?: JudgeResponseForDiagnostics,
): boolean {
  if (response?.partial || response?.hit_output_cap) return true;
  const msg = errorMessage(err);
  if (TRUNCATION_ERROR_PATTERNS.some((pattern) => pattern.test(msg))) return true;

  const candidate = response?.text ? extractJsonObjectCandidate(response.text) : null;
  if (!candidate) return false;
  const trimmed = candidate.trim();
  return trimmed.startsWith('{') && !trimmed.endsWith('}');
}

function errorTextExcerpt(text: string): string {
  const max = 100_000;
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... omitted ${text.length - max} chars ...]\n\n${text.slice(-half)}`;
}

export function formatJudgeErrorForFile(err: unknown): string {
  const parseErr = err instanceof JudgeResponseParseError ? err : undefined;
  const label = parseErr?.label ?? 'Judge';
  const rootErr = parseErr?.parseError ?? err;
  const response = parseErr?.response;
  const rootMessage = errorMessage(rootErr);
  const likelyTruncated = isTruncationShapedJudgeError(rootErr, response);
  const lines: string[] = [];

  if (likelyTruncated && response) {
    lines.push(
      `${label} output was truncated at ${response.text.length} chars - likely hit model output cap.`,
    );
    lines.push(`Original error: ${rootMessage}`);
    lines.push(
      'Recovery: shorten the Judge prompt/trace digest or rerun Judge from the saved trace. SingleShotInput.maxTokens is currently not forwarded because the Agent SDK exposes taskBudget.total, not an output-only cap.',
    );
  } else {
    lines.push(`${label} failed: ${rootMessage}`);
  }

  if (response?.hit_output_cap) lines.push('SDK signal: max_output_tokens.');
  if (response?.partial_error) lines.push(`SDK partial error: ${response.partial_error}`);
  if (response?.text) {
    const descriptor = response.partial ? 'partial Judge output' : 'Judge output';
    lines.push(
      '',
      `--- ${descriptor} (${response.text.length} chars) ---`,
      errorTextExcerpt(response.text),
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function runIrisViaSdk(
  config: AgentSdkRunConfig,
  adapterOrFactory: TargetAdapter | AdapterFactory,
): Promise<AgentSdkRunResult> {
  // Phase 16: accept either a single adapter (legacy) or a factory. Parallel
  // mode (config.parallel > 1) requires the factory form so per-session
  // adapters can be created.
  const createAdapter: AdapterFactory =
    typeof adapterOrFactory === 'function' ? adapterOrFactory : () => adapterOrFactory;

  // Phase 18.1: The Agent SDK transport has a known race where the spawned
  // `claude` subprocess fires an "exit"/"error" event after the awaited
  // query promise has already settled. The cleanup path inside the SDK
  // rejects an INTERNAL promise nobody is awaiting, which surfaces as an
  // unhandledRejection. Under Node 25's default policy that crashes the
  // orchestrator AFTER Explorer succeeded — losing the merged trace + Judge
  // + report. Catch and log; the awaited code paths handle real failures
  // through normal rejection.
  const sdkNoiseHandler = (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/Query closed before response received|Claude Code process|ProcessTransport/i.test(msg)) {
      process.stderr.write(`iris: swallowed SDK cleanup noise: ${msg.slice(0, 200)}\n`);
      return;
    }
    // Non-SDK rejections: re-throw on next tick so Node logs them normally.
    process.stderr.write(`iris: unhandledRejection (non-SDK): ${msg.slice(0, 200)}\n`);
  };
  process.on('unhandledRejection', sdkNoiseHandler);

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
  let discoveryExplorerContext = '';
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

  if (!interpreted && config.initial_tasks && config.initial_tasks.length > 0) {
    interpreted = {
      v: 1,
      target_kind_hint: 'web',
      goals: config.initial_tasks.map((task, i) => ({
        id: `G${i + 1}`,
        description: task.description,
        priority: task.priority === 'should' ? 'should' : 'must',
      })),
      focus_areas: [],
      hints: [],
      out_of_scope: [],
    };
    process.stderr.write(`iris: targeted run — ${interpreted.goals.length} initial tasks\n`);
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
          transport: 'agent-sdk',
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
      process.off('unhandledRejection', sdkNoiseHandler);
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
      const survey = await adapter
        .discoverySurvey?.({ max_scrolls: 2, peek_menus: true, dismiss_banners: true })
        .catch((err: unknown) => {
          process.stderr.write(
            `iris: discovery survey failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return undefined;
        });
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
          ...(survey?.summary ? { survey_summary: survey.summary } : {}),
          ...(survey?.payload ? { survey_payload: survey.payload } : {}),
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
              surfaces: out.surfaces,
              journeys: out.journeys,
              ...(out.product_use_contract
                ? { product_use_contract: out.product_use_contract }
                : {}),
              ...(out.coverage_plan ? { coverage_plan: out.coverage_plan } : {}),
              focus_areas: out.focus_areas,
              hints: out.hints,
              ...(survey?.summary ? { survey_summary: survey.summary.slice(0, 4000) } : {}),
              ...(survey?.payload ? { survey_payload: survey.payload } : {}),
            },
          });
          if (survey?.payload) {
            writeFileSync(
              join(config.out_dir, 'discovery-survey.json'),
              `${JSON.stringify(survey.payload, null, 2)}\n`,
            );
          }
          writeFileSync(
            join(config.out_dir, 'discovery.json'),
            `${JSON.stringify(out, null, 2)}\n`,
          );
          discoveryExplorerContext = discoveryMod.formatDiscoveryExplorerContext(out);
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
      ? `Per-goal budget: ~${stepsPerGoal} turns per goal. When a goal is finished (verified, partial, blocked, or skipped), call \`mcp__iris__goal_status\` with that status and move to the next goal. For verified goals, include evidence_event_ids with the post-action observation/screenshot/vision_describe event id that shows the outcome. If you don't call it, the system will auto-mark the goal as partial after ~${Math.ceil(stepsPerGoal * 1.5)} turns and move on. Do not mark a goal partial until you have tried the strongest cheap proof available; for focus, layout, sidebar, collapse, selected-state, text-size, width, or color-mode goals, use the ui_state probe after interaction. If Iris reports that budget remains for partial retries, retry only those partial goals before stopping.`
      : '';

  const initialUserPrompt = `Target: ${config.target.url}

${hasGoals ? `What this app is supposed to do (from the spec):\n${goalList}\n\n${discoveryExplorerContext ? `${discoveryExplorerContext}\n\n` : ''}Your job: USE THIS APP. Verify each spec goal by performing it as a normal user would.\n\nFor each goal, in order:\n  1. Find the relevant UI element (input, button, link).\n  2. Interact with it normally — type text, click, submit. Don't just look.\n  3. Observe what changed.\n  4. Call \`mcp__iris__goal_status\` with the goal id (G1, G2, …), status (verified / partial / blocked / skipped), a one-line rationale, and for verified goals evidence_event_ids containing the post-action observation/screenshot/vision_describe event id that shows the outcome.\n  5. If you find a bug, ALSO call \`mcp__iris__note_finding\` with category="bug".\n\n${perGoalLine}\n` : `Your job: USE THIS APP. Open it, find the primary feature, exercise it like a curious new user. Type real text. Click real buttons. Don't just look at the page.\n`}
PRIORITY ORDER:
  1. HAPPY PATHS FIRST. Make the primary features work before anything else. If the app is a TODO list, your first action is to add a todo. If it's a sign-in form, your first action is to fill it in and submit.
  2. AFTER happy paths complete, run \`mcp__iris__axe\` and \`mcp__iris__console_errors_since\` once to catch passive issues.
  3. THEN try edge cases: empty submits, very long inputs, special characters, the destructive action.

AVOID:
  - Reading the page after the primary affordance or surface inventory is understood. Continue observing only when a new modal, panel, dense nav, or content area appears that materially changes what's actionable.
  - Calling probes before any user interaction. Probes are useful AFTER you've exercised the flows, not before.
  - Defaulting to screenshot when DOM observation already shows what you need.
  - Treating a selector miss as product evidence. A selector miss is automation evidence; try an alternative user path (different visible element, keyboard alternative, or vision-driven action). Only file note_finding when the user-visible behavior is confirmed inaccessible across multiple paths.
  - Using direct URL navigation after initial load to satisfy product feature goals such as search, auth, donate, or settings. Interact with visible UI like a user. Direct navigation is only acceptable for initial target load, browser back/forward/reload, or explicit URL-handling goals.
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

      // Phase 18: optional auth-bootstrap. Run ONE session focused only on
      // sign-up/sign-in, export Playwright storageState, then start the N
      // productive sessions hydrated with that state. Avoids per-session
      // auth duplication (each session creating colliding accounts, hitting
      // email-verification gates, etc.).
      let sharedStatePath: string | undefined;
      if (config.share_auth) {
        const bootDir = join(config.out_dir, 'auth-bootstrap');
        mkdirSync(bootDir, { recursive: true });
        const bootAdapter = createAdapter();
        if (typeof bootAdapter.exportStorageState !== 'function') {
          process.stderr.write(
            'iris: share_auth=true but adapter does not support exportStorageState; skipping bootstrap\n',
          );
        } else {
          process.stderr.write('iris: auth bootstrap — running focused sign-up/in session...\n');
          await bootAdapter.start({
            kind: 'web',
            target: config.target.url,
            out_dir: bootDir,
          });
          const bootTracePath = join(bootDir, 'trace.jsonl');
          const bootTrace = new iristrace.TraceWriter(bootTracePath);
          const bootPrompt = `Target: ${config.target.url}\n\nYOUR ONLY MISSION: get this browser session authenticated. Sign up or sign in. Use a UNIQUE email (include a random suffix). If the app has NO auth, stop immediately and call mcp__iris__goal_status with id=auth status=verified rationale="no auth required". \n\nWhen authenticated (you can see the post-login UI), call mcp__iris__goal_status with id=auth status=verified and STOP. Do NOT explore features. Do NOT verify other goals. Just auth and exit.\n\nIMPORTANT: if the app gates registration behind email verification you cannot satisfy, call mcp__iris__goal_status with id=auth status=blocked and STOP. Other sessions will proceed without auth.\n\nBUDGET: 180s wall. Maximum 25 turns.`;
          try {
            await runAgentSdkExplorer({
              adapter: bootAdapter,
              traceWriter: bootTrace,
              systemPrompt,
              initialUserPrompt: bootPrompt,
              maxSteps: 25,
              timeoutS: 180,
              model: config.explorer_model,
              maxExpansionGoals: 0,
              goals: [{ id: 'auth', description: 'Authenticate (sign up or sign in)' }],
            });
          } catch (err) {
            process.stderr.write(
              `iris: auth bootstrap raised: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)} — continuing\n`,
            );
          }
          await bootTrace.close();
          const stateFile = join(bootDir, 'storage-state.json');
          try {
            await bootAdapter.exportStorageState(stateFile);
            // Phase 18.1: only hydrate downstream sessions if the bootstrap
            // actually captured reusable auth state. Empty cookies+origins
            // means the bootstrap couldn't auth (email verification gate,
            // captcha, OAuth redirect failure, or an app that just has no
            // auth at all) — fall back to per-session auth in that case.
            // This is a generic "did we get usable state" check, not a
            // failure-mode-specific heuristic.
            if (existsSync(stateFile)) {
              try {
                const s = JSON.parse(readFileSync(stateFile, 'utf8')) as {
                  cookies?: unknown[];
                  origins?: Array<{ localStorage?: unknown[] }>;
                };
                const cookieCount = s.cookies?.length ?? 0;
                const lsCount =
                  s.origins?.reduce((n, o) => n + (o.localStorage?.length ?? 0), 0) ?? 0;
                if (cookieCount > 0 || lsCount > 0) {
                  sharedStatePath = stateFile;
                  process.stderr.write(
                    `iris: auth bootstrap succeeded — ${cookieCount} cookies, ${lsCount} localStorage entries; sessions will hydrate\n`,
                  );
                } else {
                  process.stderr.write(
                    'iris: auth bootstrap produced empty storageState (likely email-verification, captcha, or no-auth app) — sessions will auth individually\n',
                  );
                }
              } catch (parseErr) {
                process.stderr.write(
                  `iris: storageState parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)} — sessions will auth individually\n`,
                );
              }
            }
          } catch (err) {
            process.stderr.write(
              `iris: storageState export failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
          await bootAdapter.stop();
        }
      }

      // Phase 16 robustness: use allSettled so one session crashing (e.g.
      // the SDK transport's "Query closed" race) doesn't kill the whole
      // orchestrator. The surviving sessions' trace + Judge can still
      // produce a useful report.
      const sessionOutcomes = await Promise.allSettled(
        goalGroups.map(async (subset, idx) => {
          const sessionDir = join(config.out_dir, `session-${idx}`);
          mkdirSync(sessionDir, { recursive: true });
          const sessionAdapter = sharedStatePath
            ? createAdapter({ storage_state_path: sharedStatePath })
            : createAdapter();
          const sessionTracePath = join(sessionDir, 'trace.jsonl');
          const sessionTrace = new iristrace.TraceWriter(sessionTracePath);
          try {
            await sessionAdapter.start({
              kind: 'web',
              target: config.target.url,
              out_dir: sessionDir,
            });

            // Each session sees ALL goals in its prompt (for context) but is
            // only responsible for verifying its subset.
            const subsetIds = subset.map((g) => g.id).join(', ');
            const subsetPrompt = `Target: ${config.target.url}\n\nAll discovered goals (for context):\n${goalList}\n\nYOUR ASSIGNED GOALS this session: ${subsetIds}\nOther sessions are independently handling the other goals — focus on yours.\n\nFor each assigned goal, in order:\n  1. Find the relevant UI element.\n  2. Interact with it normally.\n  3. Observe what changed via the auto-observation.\n  4. Call mcp__iris__goal_status with the goal id, status, one-line rationale, and for verified goals evidence_event_ids containing the post-action observation/screenshot/vision_describe event id that shows the outcome.\n  5. If you find a bug, ALSO call mcp__iris__note_finding.\n\n${perGoalLine}\n\nBUDGET: ${perSessionTimeout}s wall. Per-goal auto-cutover at ~${Math.ceil((stepsPerGoal ?? 10) * 1.5)} turns.`;
            const perSessionMaxSteps = Math.max(
              30,
              Math.ceil(subset.length * (stepsPerGoal ?? 10) * 1.5) +
                (config.free_exploration_steps ?? 8),
            );

            const result = await runAgentSdkExplorer({
              adapter: sessionAdapter,
              traceWriter: sessionTrace,
              systemPrompt,
              initialUserPrompt: subsetPrompt,
              maxSteps: perSessionMaxSteps,
              timeoutS: perSessionTimeout,
              model: config.explorer_model,
              maxExpansionGoals: 0, // disable expansion in parallel mode for now
              ...(stepsPerGoal && stepsPerGoal > 0 ? { stepsPerGoal } : {}),
              goals: subset,
            });

            // Auto-axe + console for this session
            const sessionEvents = await iristrace.readTraceArray(sessionTracePath);
            const ranAxe = sessionEvents.some(
              (e) =>
                e.kind === 'probe_result' && (e.payload as { probe?: string })?.probe === 'axe',
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
            const ranConsole = sessionEvents.some(
              (e) =>
                e.kind === 'probe_result' &&
                (e.payload as { probe?: string })?.probe === 'console_errors_since',
            );
            if (!ranConsole) {
              const cResult = await sessionAdapter
                .runProbe('console_errors_since', {})
                .catch((err) => ({
                  ok: false as const,
                  probe: 'console_errors_since',
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

            return { idx, result, tracePath: sessionTracePath };
          } finally {
            try {
              await sessionTrace.close();
            } catch {
              // Preserve the original session outcome.
            }
            try {
              await sessionAdapter.stop();
            } catch {
              // Preserve the original session outcome.
            }
          }
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
      const p1 = parseJudgeOutputFromResponse(r1, 'Judge ensemble pass 1');
      const p2 = parseJudgeOutputFromResponse(r2, 'Judge ensemble pass 2');
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
      judgeOutput = parseJudgeOutputFromResponse(judgeResp, 'Judge');
    }
    judgeOutput = judgeMod.ensureRubricScoreCoverage(judgeOutput, config.rubric_profiles);

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
    writeFileSync(join(config.out_dir, 'judge-error.txt'), formatJudgeErrorForFile(err));
    process.off('unhandledRejection', sdkNoiseHandler);
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

  const clipPaths: Record<string, string> = {};
  // Phase 16: clip slicing in parallel mode would need per-session video
  // attribution per finding — skip for now and document as known limitation.
  if (!config.no_clips && !hasParallelGoals) {
    try {
      const evidence = await reportMod.collectClaimEvidenceArtifacts({
        adapter,
        judge: judgeOutput,
        trace: events,
        runDir: config.out_dir,
      });
      Object.assign(clipPaths, evidence.clips);
      if (evidence.files.length > 0) {
        process.stderr.write(`iris: sliced ${evidence.files.length} claim evidence files\n`);
      }
    } catch (err) {
      writeFileSync(
        join(config.out_dir, 'clips-error.txt'),
        err instanceof Error ? err.message : String(err),
      );
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
      transport: 'agent-sdk',
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

  process.off('unhandledRejection', sdkNoiseHandler);
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
      transport: 'agent-sdk',
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
    const session_id = sessionIdForTracePath(p, outputPath);
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { ts?: number; payload?: Record<string, unknown> };
        e.payload = { ...(e.payload ?? {}), session_id };
        all.push({ ts: e.ts ?? 0, line: JSON.stringify(e) });
      } catch {
        // Skip malformed lines (shouldn't happen).
      }
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  writeFileSync(outputPath, `${all.map((e) => e.line).join('\n')}\n`);
}

function sessionIdForTracePath(path: string, outputPath: string): string {
  if (path === outputPath) return 'main';
  const parent = basename(dirname(path));
  if (/^session-\d+$/.test(parent) || parent === 'auth-bootstrap') return parent;
  return parent || 'main';
}
