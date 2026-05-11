import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { ModeSchema, type PersonaName, orchestrator } from '@iris/core';
import { Command } from 'commander';
import { runIrisViaSdk } from '../agent-sdk-orchestrator.js';
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
    .option('--max-steps <n>', 'hard cap on Explorer actions', (s) => Number.parseInt(s, 10), 60)
    .option(
      '--steps-per-goal <n>',
      'per-goal turn budget (Phase 5). When set with a spec, max_steps is recomputed as goals × steps_per_goal + free_exploration_steps (capped by --max-steps).',
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
      '--max-cost-usd <n>',
      'abort when LLM cost exceeds this',
      (s) => Number.parseFloat(s),
      5,
    )
    .option('--timeout <s>', 'total wall-clock seconds', (s) => Number.parseInt(s, 10), 600)
    .option('--explorer-model <id>', 'model for Explorer agent', 'claude-sonnet-4-6')
    .option('--judge-model <id>', 'model for Judge agent', 'claude-opus-4-7')
    .option('--out <dir>', 'run output directory')
    .option('--no-html', 'skip HTML report')
    .option('--no-clips', 'skip per-finding video clips')
    .option('--threshold <n>', 'exit non-zero if overall score below this', (s) =>
      Number.parseFloat(s),
    )
    .option('--print-summary', 'print one-line JSON summary to stdout')
    .option('--dry-run', 'run spec interpreter only, print plan, exit')
    .option('--verbose', 'stream trace events to stderr as they happen')
    .option('--json-logs', 'structured logs to stderr (skill consumers)')
    .option(
      '--persona <name>',
      'persona for the Explorer (default | power_user | novice | adversarial | keyboard_only)',
      'default',
    )
    .option(
      '--transport <kind>',
      'sdk | api | cli — which LLM transport to use. sdk = local Claude Code subscription via Agent SDK (fast, no API key). api = raw Anthropic API (needs ANTHROPIC_API_KEY). cli = `claude -p` subprocess (slow, no API key, fallback). Default: sdk if no API key set, else api.',
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
      if (specPath && existsSync(resolve(specPath))) {
        specText = readFileSync(resolve(specPath), 'utf8');
      }

      const initialTasks = (tasks as string[]).slice();
      if (tasksPath && existsSync(resolve(tasksPath))) {
        const lines = readFileSync(resolve(tasksPath), 'utf8')
          .split(/\r?\n/)
          .filter((s) => s.trim().length > 0);
        initialTasks.push(...lines);
      }

      // Choose transport
      const explicitTransport = opts.transport as string | undefined;
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
      const transport = explicitTransport ?? (hasApiKey ? 'api' : 'sdk');
      process.stderr.write(`iris: transport=${transport}\n`);

      const adapter = new WebTargetAdapter({ headless: true });

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
            max_cost_usd: opts.maxCostUsd as number,
            timeout_s: opts.timeout as number,
            ...(opts.threshold !== undefined ? { threshold: opts.threshold as number } : {}),
            explorer_model: opts.explorerModel as string,
            judge_model: opts.judgeModel as string,
            no_html: opts.html === false,
            no_preflight: opts.preflight === false,
            preflight_timeout_s: opts.preflightTimeoutS as number,
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
          mode,
          out_dir: outDir,
          ...(specText !== undefined ? { spec_text: specText } : {}),
          ...(specPath !== undefined ? { spec_path: specPath } : {}),
          ...(initialTasks.length > 0 ? { initial_tasks: initialTasks } : {}),
          rubric_profiles: rubricProfiles,
          max_steps: opts.maxSteps as number,
          steps_per_goal: opts.stepsPerGoal as number,
          free_exploration_steps: opts.freeExplorationSteps as number,
          max_cost_usd: opts.maxCostUsd as number,
          timeout_s: opts.timeout as number,
          ...(opts.threshold !== undefined ? { threshold: opts.threshold as number } : {}),
          explorer_model: opts.explorerModel as string,
          judge_model: opts.judgeModel as string,
          no_html: opts.html === false,
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
            ...(ev
              ? {
                  evidence_verified: ev.verified,
                  evidence_downgraded: ev.downgraded,
                  evidence_discarded: ev.discarded,
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
