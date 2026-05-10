import { Command } from 'commander';

export function judgeCommand(): Command {
  return new Command('judge')
    .description('Re-run only the Judge against a stored trace')
    .requiredOption('--trace <path>', 'path to trace.jsonl')
    .option('--spec <path>', 'spec file used in original run')
    .option('--rubrics <list>', 'comma-separated rubric profile names')
    .option('--judge-model <id>', 'model for Judge agent', 'claude-opus-4-7')
    .option('--out <dir>', 'output directory')
    .option('--print-summary', 'print one-line JSON summary to stdout')
    .action(async (opts: Record<string, unknown>) => {
      process.stdout.write(`${JSON.stringify(opts, null, 2)}\n`);
      process.stdout.write('\n[iris] judge not implemented in phase 1\n');
    });
}
