import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebTargetAdapter } from '@iris/adapter-web';
import { ModeSchema, type PersonaName, orchestrator } from '@iris/core';
import { Command } from 'commander';
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

      const explorerClient = buildLlmClient();
      const judgeClient = buildLlmClient();
      const adapter = new WebTargetAdapter({ headless: true });

      const orch = new orchestrator.Orchestrator({ adapter, explorerClient, judgeClient });
      const result = await orch.run({
        target: { kind: 'web', url: target },
        mode,
        out_dir: outDir,
        ...(specText !== undefined ? { spec_text: specText } : {}),
        ...(specPath !== undefined ? { spec_path: specPath } : {}),
        ...(initialTasks.length > 0 ? { initial_tasks: initialTasks } : {}),
        rubric_profiles: rubricProfiles,
        max_steps: opts.maxSteps as number,
        max_cost_usd: opts.maxCostUsd as number,
        timeout_s: opts.timeout as number,
        ...(opts.threshold !== undefined ? { threshold: opts.threshold as number } : {}),
        explorer_model: opts.explorerModel as string,
        judge_model: opts.judgeModel as string,
        no_html: opts.html === false,
        persona: opts.persona as PersonaName,
      });

      if (opts.printSummary) {
        const counts = result.report.headline;
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
