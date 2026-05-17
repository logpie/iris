import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { EngineSchema, ModeSchema, type PersonaName, orchestrator } from '@iris/core';
import { Command } from 'commander';
import { runIrisViaSdk } from '../agent-sdk-orchestrator.js';
import { runIrisViaCodexAppServer } from '../codex-app-server-orchestrator.js';
import { parseCodexReasoningEffort } from '../codex-app-server-runner.js';
import { inferMode } from '../flags.js';
import { buildLlmClient } from '../llm-factory.js';
import { loadRubricsByNames } from '../load-rubrics.js';
import { buildSummaryLine } from '../render/summary.js';

export function evalCommand(): Command {
  return new Command('eval')
    .description('Evaluate a target end-to-end (Explorer + Judge + Report)')
    .argument('<target>', 'URL (web), shell command (cli), OpenAPI URL (api), app name (desktop)')
    .option('--mode <mode>', 'free | grounded | targeted (inferred from inputs if omitted)')
    .option('--spec <path>', 'free-form spec file (md/yaml/html/txt/prose)')
    .option('--task <text>', 'single targeted task; repeat for multiple', collect, [])
    .option('--tasks <path>', 'newline-separated tasks file')
    .option('--rubrics <list>', 'comma-separated rubric profile names')
    .option('--engine <engine>', 'dom | vision | hybrid (web-only)', 'hybrid')
    .option(
      '--max-steps <n>',
      'hard cap on Explorer actions. Defaults to 500 — effectively unbounded for normal runs. The real budget is --timeout; per-goal auto-cutover (1.5× steps-per-goal) prevents single-goal grinds.',
      (s) => Number.parseInt(s, 10),
      500,
    )
    .option(
      '--steps-per-goal <n>',
      'per-goal turn budget for Explorer auto-cutover. --max-steps remains the hard run cap.',
      (s) => Number.parseInt(s, 10),
      10,
    )
    .option(
      '--free-exploration-steps <n>',
      'free-exploration tail budget after all goals are attempted (Phase 5)',
      (s) => Number.parseInt(s, 10),
      8,
    )
    .option(
      '--preflight-timeout-s <n>',
      'preflight per-check timeout in seconds (Phase 5)',
      (s) => Number.parseInt(s, 10),
      15,
    )
    .option('--no-preflight', 'skip preflight checks (debugging only) (Phase 5)')
    .option(
      '--judge-ensemble',
      'run Judge twice in parallel and intersect critical findings (Phase 6 F2). Reduces score variance on borderline ship decisions. Doubles Judge cost.',
    )
    .option(
      '--no-discover',
      'skip the Phase 10 discovery pass (default: discovery runs when no --spec is given)',
    )
    .option(
      '--no-expand',
      'disable propose_goal — Explorer cannot append goals mid-run (default: up to 6 expansion goals allowed)',
    )
    .option(
      '--max-expansion-goals <n>',
      'cap on dynamic goal expansion (Phase 10)',
      (s) => Number.parseInt(s, 10),
      6,
    )
    .option(
      '--parallel <n>',
      'run N parallel Explorer sessions across goal partitions. Default 2 — the empirical sweet spot for auth-gated apps (P17 tracker: 786s/4 verified). N=3+ adds Anthropic-API + target-server contention that nets slower per Phase 18 tracker scaling tests. Pass 1 for single-session runs.',
      (s) => Number.parseInt(s, 10),
      2,
    )
    .option(
      '--share-auth',
      'Phase 18: when --parallel >1, run ONE bootstrap session focused only on sign-up/in, export Playwright storageState, then auto-decide: if bootstrap got cookies/localStorage, downstream sessions hydrate from it; if not (email-verification, captcha, no-auth app), they auth individually. Off by default — costs ~50s of sequential bootstrap time on email-verification-gated apps where the cookies will end up empty anyway. Recommended for apps with one-shot signup (no email confirmation).',
    )
    .option(
      '--timeout <s>',
      'total wall-clock seconds. Phase 17: time is the only budget — cost was removed because it was hard to reason about (especially in parallel mode). In practice ~$0.04 per agent turn × turns-per-second × N parallel sessions ≈ cost, so cap time and you cap spend.',
      (s) => Number.parseInt(s, 10),
      900,
    )
    .option('--explorer-model <id>', 'model for Explorer agent', 'claude-sonnet-4-6')
    .option('--judge-model <id>', 'model for Judge agent', 'claude-opus-4-7')
    .option(
      '--reasoning-effort <effort>',
      'Codex App Server reasoning effort: low | medium | high | xhigh',
    )
    .option('--out <dir>', 'run output directory')
    .option('--no-html', 'skip HTML report')
    .option('--no-clips', 'skip per-finding video clips')
    .option(
      '--scenario-gate',
      'enable an opt-in scenario completion gate that rejects verified goal_status calls when cited evidence is missing required visible outputs',
    )
    .option('--threshold <n>', 'exit non-zero if overall score below this', (s) =>
      Number.parseFloat(s),
    )
    .option('--print-summary', 'print one-line JSON summary to stdout')
    .option('--dry-run', 'validate inputs, print the run plan, and exit before browser/LLM work')
    .option('--verbose', 'reserved for trace streaming; currently accepted for compatibility')
    .option(
      '--json-logs',
      'reserved for structured progress logs; currently accepted for compatibility',
    )
    .option(
      '--persona <name>',
      'persona for the Explorer (default | power_user | novice | adversarial | keyboard_only)',
      'default',
    )
    .option(
      '--transport <kind>',
      'sdk | api | cli | codex-appserver | codex — which LLM transport to use. sdk = local Claude Code subscription via Agent SDK. api = raw Anthropic API. cli = `claude -p` fallback. codex/codex-appserver = Codex App Server dynamic-tool harness. Default: sdk if no API key set, else api.',
    )
    .action(async (target: string, opts: Record<string, unknown>) => {
      const explicitMode = opts.mode as string | undefined;
      const specPath = opts.spec as string | undefined;
      const tasks = opts.task as string[];
      const tasksPath = opts.tasks as string | undefined;
      const mode = inferMode({
        ...(explicitMode !== undefined ? { explicit_mode: explicitMode } : {}),
        ...(specPath !== undefined ? { spec_path: specPath } : {}),
        ...(tasks.length > 0 ? { tasks } : {}),
        ...(tasksPath !== undefined ? { tasks_path: tasksPath } : {}),
      });
      ModeSchema.parse(mode); // sanity
      const engineResult = EngineSchema.safeParse(opts.engine);
      if (!engineResult.success) {
        throw new Error(`invalid --engine ${String(opts.engine)}; expected dom, vision, or hybrid`);
      }
      const engine = engineResult.data;

      const outDir =
        (opts.out as string | undefined) ??
        `./iris-runs/${new Date().toISOString().replace(/[:]/g, '-')}`;
      const rubricsArg = opts.rubrics as string | undefined;
      const rubricNames = rubricsArg
        ? rubricsArg
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const rubricProfiles = await loadRubricsByNames(rubricNames);

      let specText: string | undefined;
      if (specPath) {
        specText = readRequiredInputFile(specPath, '--spec');
      }

      const initialTasks = (tasks as string[]).slice();
      if (tasksPath) {
        const lines = readRequiredInputFile(tasksPath, '--tasks')
          .split(/\r?\n/)
          .filter((s) => s.trim().length > 0);
        initialTasks.push(...lines);
      }

      // Choose transport
      const explicitTransport = opts.transport as string | undefined;
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
      const transportRaw = explicitTransport ?? (hasApiKey ? 'api' : 'sdk');
      const transport = transportRaw === 'codex' ? 'codex-appserver' : transportRaw;
      if (!['sdk', 'api', 'cli', 'codex-appserver'].includes(transport)) {
        throw new Error(
          `unknown --transport ${transportRaw}; expected sdk, api, cli, codex-appserver, or codex`,
        );
      }
      process.stderr.write(`iris: transport=${transport}\n`);

      if (opts.dryRun) {
        process.stdout.write(
          `${JSON.stringify(
            {
              dry_run: true,
              target: { kind: 'web', url: target },
              mode,
              out_dir: outDir,
              transport,
              engine,
              ...(specPath ? { spec_path: resolve(specPath) } : {}),
              tasks: initialTasks,
              rubrics: rubricNames ?? 'default',
              max_steps: opts.maxSteps as number,
              steps_per_goal: opts.stepsPerGoal as number,
              free_exploration_steps: opts.freeExplorationSteps as number,
              timeout_s: opts.timeout as number,
              discover: opts.discover !== false,
              expand_goals: opts.expand !== false,
              scenario_gate: !!opts.scenarioGate,
              parallel: opts.parallel as number,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      let sdkVisionDescribe:
        | ((input: {
            systemPrompt: string;
            imagePath: string;
            textPrompt: string;
            model?: string;
          }) => Promise<{ text: string; cost_usd: number }>)
        | undefined;
      if (transport === 'sdk') {
        ({ visionDescribeViaSdk: sdkVisionDescribe } = await import('../agent-sdk-runner.js'));
      }
      const attachSdkVisionDescriber = (a: WebTargetAdapter) => {
        const describe = sdkVisionDescribe;
        if (!describe) return;
        (
          a as unknown as {
            opts: {
              vision_describer?: (i: {
                imagePath: string;
                prompt: string;
                model?: string;
              }) => Promise<{ text: string }>;
            };
          }
        ).opts.vision_describer = async (i) =>
          describe({
            systemPrompt: '',
            imagePath: i.imagePath,
            textPrompt: i.prompt,
            ...(i.model ? { model: i.model } : {}),
          });
      };

      // Phase 16: build an adapter factory so the SDK orchestrator can
      // create as many adapters as it needs (1 for single-session, N for
      // --parallel N). Each adapter has its own browser + own vision_describer
      // wiring.
      const buildAdapter = async () => {
        const a = new WebTargetAdapter({ headless: true });
        attachSdkVisionDescriber(a);
        return a;
      };
      // Pre-build the first adapter for the api/cli transports + for
      // backwards-compat when SDK consumer expects an adapter directly.
      const adapter = await buildAdapter();
      // Wrap into a synchronous factory by warming a queue. For N=1, the
      // existing adapter is reused; for N>1, additional adapters are
      // synchronously constructed (no vision_describer wiring needed because
      // the factory closure recreates it — but the SDK uses one path so we
      // build sync replicas).
      let _adapterIdx = 0;
      const createAdapter = (factoryOpts?: { storage_state_path?: string }): typeof adapter => {
        // Phase 18: a storage_state_path means the caller wants a NEW adapter
        // hydrated with shared auth — never reuse the pre-built one (which
        // was constructed without storage state). The pre-built adapter only
        // applies on the very first non-stateful call.
        if (_adapterIdx === 0 && !factoryOpts?.storage_state_path) {
          _adapterIdx++;
          return adapter;
        }
        // For parallel sessions, construct a fresh WebTargetAdapter without
        // awaiting (the factory closure for SDK wiring is sync — we use the
        // already-imported visionDescribeViaSdk reference if needed).
        _adapterIdx++;
        const a = new WebTargetAdapter({
          headless: true,
          ...(factoryOpts?.storage_state_path
            ? { storage_state_path: factoryOpts.storage_state_path }
            : {}),
        });
        attachSdkVisionDescriber(a);
        return a;
      };

      let result: {
        report: {
          headline: {
            score: number;
            threshold_passed: boolean;
            blockers: number;
            majors: number;
            minors: number;
            nits: number;
            suggestions: number;
            goals_attempted?: number;
            goals_verified?: number;
            goals_total?: number;
            blocked?: boolean;
            blocked_reasons?: string[];
          };
          meta: { confidence_caveats: string[] };
          spec_compliance?: {
            goal_claim_validation?:
              | {
                  verified_kept: number;
                  partial_upgraded?: number;
                  partial_kept?: number;
                  downgraded: number;
                  downgrade_reasons?: string[];
                  partial_reasons?: string[];
                }
              | undefined;
          };
          evidence_validation?: { verified: number; downgraded: number; discarded: number };
        };
        out_dir: string;
        duration_s: number;
        cost_usd: number;
        exit_code: 0 | 1 | 2 | 3 | 4;
      };

      if (transport === 'sdk') {
        result = await runIrisViaSdk(
          {
            target: { kind: 'web', url: target },
            mode,
            out_dir: outDir,
            ...(specText !== undefined ? { spec_text: specText } : {}),
            ...(specPath !== undefined ? { spec_path: specPath } : {}),
            rubric_profiles: rubricProfiles,
            max_steps: opts.maxSteps as number,
            steps_per_goal: opts.stepsPerGoal as number,
            free_exploration_steps: opts.freeExplorationSteps as number,
            timeout_s: opts.timeout as number,
            ...(opts.threshold !== undefined ? { threshold: opts.threshold as number } : {}),
            explorer_model: opts.explorerModel as string,
            judge_model: opts.judgeModel as string,
            no_html: opts.html === false,
            no_clips: opts.clips === false,
            no_preflight: opts.preflight === false,
            preflight_timeout_s: opts.preflightTimeoutS as number,
            judge_ensemble: !!opts.judgeEnsemble,
            discover: opts.discover !== false,
            expand_goals: opts.expand !== false,
            max_expansion_goals: opts.maxExpansionGoals as number,
            scenario_gate: !!opts.scenarioGate,
            parallel: opts.parallel as number,
            ...(initialTasks.length > 0
              ? { initial_tasks: initialTasks.map((description) => ({ description })) }
              : {}),
            ...(opts.shareAuth ? { share_auth: true } : {}),
            ...(opts.persona !== undefined ? { persona: opts.persona as string } : {}),
          },
          // Phase 16: pass a factory so the orchestrator can create per-session
          // adapters when --parallel N>1. For N=1 the factory returns the
          // already-created adapter on first call.
          createAdapter,
        );
      } else if (transport === 'codex-appserver') {
        result = await runIrisViaCodexAppServer(
          {
            target: { kind: 'web', url: target },
            mode,
            out_dir: outDir,
            ...(specText !== undefined ? { spec_text: specText } : {}),
            ...(specPath !== undefined ? { spec_path: specPath } : {}),
            rubric_profiles: rubricProfiles,
            max_steps: opts.maxSteps as number,
            steps_per_goal: opts.stepsPerGoal as number,
            free_exploration_steps: opts.freeExplorationSteps as number,
            timeout_s: opts.timeout as number,
            ...(opts.threshold !== undefined ? { threshold: opts.threshold as number } : {}),
            explorer_model: opts.explorerModel as string,
            judge_model: opts.judgeModel as string,
            ...(opts.reasoningEffort
              ? { reasoning_effort: parseCodexReasoningEffort(opts.reasoningEffort as string) }
              : {}),
            no_html: opts.html === false,
            no_clips: opts.clips === false,
            no_preflight: opts.preflight === false,
            preflight_timeout_s: opts.preflightTimeoutS as number,
            discover: opts.discover !== false,
            expand_goals: opts.expand !== false,
            max_expansion_goals: opts.maxExpansionGoals as number,
            scenario_gate: !!opts.scenarioGate,
            ...(initialTasks.length > 0
              ? { initial_tasks: initialTasks.map((description) => ({ description })) }
              : {}),
            ...(opts.persona !== undefined ? { persona: opts.persona as string } : {}),
          },
          adapter,
        );
      } else {
        const explorerClient = buildLlmClient({ use_claude_cli: transport === 'cli' });
        const judgeClient = buildLlmClient({ use_claude_cli: transport === 'cli' });
        // Vision client only makes sense for api/cli; sdk path doesn't currently use vision_describe.
        (
          adapter as unknown as { opts: { vision_llm_client?: typeof explorerClient } }
        ).opts.vision_llm_client = explorerClient;
        const orch = new orchestrator.Orchestrator({ adapter, explorerClient, judgeClient });
        result = await orch.run({
          target: { kind: 'web', url: target },
          transport,
          mode,
          out_dir: outDir,
          ...(specText !== undefined ? { spec_text: specText } : {}),
          ...(specPath !== undefined ? { spec_path: specPath } : {}),
          ...(initialTasks.length > 0 ? { initial_tasks: initialTasks } : {}),
          rubric_profiles: rubricProfiles,
          max_steps: opts.maxSteps as number,
          steps_per_goal: opts.stepsPerGoal as number,
          free_exploration_steps: opts.freeExplorationSteps as number,
          timeout_s: opts.timeout as number,
          ...(opts.threshold !== undefined ? { threshold: opts.threshold as number } : {}),
          explorer_model: opts.explorerModel as string,
          judge_model: opts.judgeModel as string,
          no_html: opts.html === false,
          no_clips: opts.clips === false,
          no_preflight: opts.preflight === false,
          preflight_timeout_s: opts.preflightTimeoutS as number,
          persona: opts.persona as PersonaName,
        });
      }

      if (opts.printSummary) {
        const counts = result.report.headline;
        const ev = (
          result.report as unknown as {
            evidence_validation?: { verified: number; downgraded: number; discarded: number };
          }
        ).evidence_validation;
        const goalClaimValidation = result.report.spec_compliance?.goal_claim_validation;
        process.stdout.write(
          buildSummaryLine({
            score: counts.score,
            threshold_passed: counts.threshold_passed,
            findings: {
              blocker: counts.blockers,
              major: counts.majors,
              minor: counts.minors,
              nit: counts.nits,
              suggestion: counts.suggestions,
            },
            run_dir: result.out_dir,
            duration_s: result.duration_s,
            cost_usd: result.cost_usd,
            caveats: result.report.meta.confidence_caveats.length,
            ...(counts.blocked !== undefined ? { blocked: counts.blocked } : {}),
            ...(counts.blocked_reasons ? { blocked_reasons: counts.blocked_reasons } : {}),
            ...(counts.goals_total !== undefined
              ? {
                  goals_attempted: counts.goals_attempted ?? 0,
                  goals_verified: counts.goals_verified ?? 0,
                  goals_total: counts.goals_total,
                }
              : {}),
            ...(goalClaimValidation
              ? {
                  scenario_evidence_verified_kept: goalClaimValidation.verified_kept,
                  scenario_evidence_partial_upgraded: goalClaimValidation.partial_upgraded ?? 0,
                  scenario_evidence_partial_kept: goalClaimValidation.partial_kept ?? 0,
                  scenario_evidence_downgraded: goalClaimValidation.downgraded,
                  scenario_evidence_downgrade_reasons: goalClaimValidation.downgrade_reasons ?? [],
                  scenario_evidence_partial_reasons: goalClaimValidation.partial_reasons ?? [],
                }
              : {}),
            ...(ev
              ? {
                  finding_evidence_verified: ev.verified,
                  finding_evidence_downgraded: ev.downgraded,
                  unsupported_finding_drafts_discarded: ev.discarded,
                }
              : {}),
            exit_code: result.exit_code,
          }),
        );
      } else {
        process.stdout.write(
          `iris: report → ${result.out_dir}/report.json (score ${result.report.headline.score})\n`,
        );
      }

      process.exit(result.exit_code);
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function readRequiredInputFile(path: string, flag: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`iris eval: ${flag} file not found: ${resolved}`);
  }
  return readFileSync(resolved, 'utf8');
}
