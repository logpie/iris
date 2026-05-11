import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diff as diffMod, type report as reportMod } from '@iris/core';
import { Command } from 'commander';

type ReportJson = ReturnType<typeof reportMod.buildReportJson>;

export function diffCommand(): Command {
  return new Command('diff')
    .description('Compute delta between two Iris runs (same target).')
    .argument('<prev-run-dir>', 'previous run directory')
    .argument('<curr-run-dir>', 'current run directory')
    .option('--out <dir>', 'output directory for diff artifacts (default: cwd)', '.')
    .option('--allow-target-mismatch', 'skip the same-target check')
    .option('--no-html', 'skip diff.html render')
    .option('--print-summary', 'print one-line JSON summary to stdout')
    .action((prevDirArg: string, currDirArg: string, opts: Record<string, unknown>) => {
      const prevDir = resolve(prevDirArg);
      const currDir = resolve(currDirArg);
      const prevPath = join(prevDir, 'report.json');
      const currPath = join(currDir, 'report.json');
      if (!existsSync(prevPath)) {
        process.stderr.write(`iris diff: ${prevPath} not found\n`);
        process.exit(64);
      }
      if (!existsSync(currPath)) {
        process.stderr.write(`iris diff: ${currPath} not found\n`);
        process.exit(64);
      }
      const prev = JSON.parse(readFileSync(prevPath, 'utf8')) as ReportJson;
      const curr = JSON.parse(readFileSync(currPath, 'utf8')) as ReportJson;

      if (!opts.allowTargetMismatch) {
        const a = diffMod.normalizeTargetUrl(prev.run.target.url);
        const b = diffMod.normalizeTargetUrl(curr.run.target.url);
        if (a !== b) {
          process.stderr.write(
            `iris diff: target mismatch (${prev.run.target.url} vs ${curr.run.target.url}). Pass --allow-target-mismatch to override.\n`,
          );
          process.exit(64);
        }
      }

      const result = diffMod.computeDiff(prev, curr);
      const outDir = resolve(opts.out as string);
      writeFileSync(join(outDir, 'diff.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(outDir, 'diff.md'), diffMod.buildDiffMd(result));
      if (opts.html !== false) {
        writeFileSync(join(outDir, 'diff.html'), diffMod.buildDiffHtml(result));
      }

      if (opts.printSummary) {
        const summary = {
          fixed: result.findings.fixed.length,
          new: result.findings.new.length,
          persistent: result.findings.persistent.length,
          score_delta: Number(result.score_delta.overall.toFixed(2)),
          coverage_delta:
            result.coverage_delta.newly_tested_goals.length -
            result.coverage_delta.no_longer_tested.length,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      }
      process.stderr.write(
        `iris diff: wrote ${outDir}/diff.{json,md${opts.html === false ? '' : ',html'}}\n`,
      );
    });
}
