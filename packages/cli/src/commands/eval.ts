import { Command } from 'commander';

export function evalCommand(): Command {
  return new Command('eval')
    .description('Evaluate a target end-to-end (Explorer + Judge + Report)')
    .argument('<target>', 'URL (web), shell command (cli), OpenAPI URL (api), app name (desktop)')
    .option('--mode <mode>', 'free | grounded | targeted (inferred from inputs if omitted)')
    .option('--spec <path>', 'free-form spec file (md/yaml/html/txt/prose)')
    .option('--task <text>', 'single targeted task; repeat for multiple', collect, [])
    .option('--tasks <path>', 'newline-separated tasks file')
    .option('--rubrics <list>', 'comma-separated rubric profile names')
    .option('--focus <list>', 'comma-separated focus directives')
    .option('--engine <engine>', 'dom | vision | hybrid (web-only)', 'hybrid')
    .option('--auth <path>', 'Playwright storageState.json (web-only)')
    .option('--viewport <wxh>', 'web viewport e.g. 1280x800', '1280x800')
    .option('--user-agent <ua>', 'browser user agent (web-only)')
    .option('--max-steps <n>', 'hard cap on Explorer actions', (s) => Number.parseInt(s, 10), 60)
    .option(
      '--max-cost-usd <n>',
      'abort when LLM cost exceeds this',
      (s) => Number.parseFloat(s),
      5,
    )
    .option('--timeout <s>', 'total wall-clock seconds', (s) => Number.parseInt(s, 10), 600)
    .option(
      '--explore-budget <0..1>',
      'grounded mode: fraction for free exploration',
      (s) => Number.parseFloat(s),
      0.3,
    )
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
    .action(async (target: string, opts: Record<string, unknown>) => {
      // Phase 1 stub: print resolved args + exit
      const resolved = { target, ...opts };
      process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
      process.stdout.write(
        '\n[iris] eval not implemented in phase 1 — see plans/2026-05-09-iris-phase-1-foundations.md\n',
      );
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
