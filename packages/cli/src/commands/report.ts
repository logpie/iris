import { Command } from 'commander';

export function reportCommand(): Command {
  return new Command('report')
    .description('Re-render report.html / clips from an existing run directory')
    .argument('<run-dir>', 'path to a previous run directory')
    .option('--no-clips', 'skip clip slicing')
    .option('--template <path>', 'custom HTML template')
    .action(async (runDir: string, opts: Record<string, unknown>) => {
      process.stdout.write(`${JSON.stringify({ runDir, ...opts }, null, 2)}\n`);
      process.stdout.write('\n[iris] report not implemented in phase 1\n');
    });
}
