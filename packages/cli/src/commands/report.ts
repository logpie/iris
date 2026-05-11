import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { report as reportMod } from '@iris/core';
import { Command } from 'commander';

type ReportJson = ReturnType<typeof reportMod.buildReportJson>;

export function reportCommand(): Command {
  return new Command('report')
    .description('Re-render report.html / report.md from an existing run directory')
    .argument('<run-dir>', 'path to a previous run directory containing report.json')
    .option('--no-html', 'skip HTML render')
    .action(async (runDir: string, opts: Record<string, unknown>) => {
      const dir = resolve(runDir);
      const reportPath = join(dir, 'report.json');
      if (!existsSync(reportPath)) {
        process.stderr.write(`iris report: ${reportPath} not found\n`);
        process.exit(64);
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportJson;
      writeFileSync(join(dir, 'report.md'), reportMod.buildReportMd(report));
      if (opts.html !== false) {
        writeFileSync(join(dir, 'report.html'), reportMod.buildReportHtml(report, { runDir: dir }));
      }
      process.stdout.write(`iris report: re-rendered ${runDir}/report.{md,html}\n`);
    });
}
