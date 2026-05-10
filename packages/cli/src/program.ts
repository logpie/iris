import { Command, type OutputConfiguration } from 'commander';
import { evalCommand } from './commands/eval.js';
import { judgeCommand } from './commands/judge.js';
import { reportCommand } from './commands/report.js';

export function buildProgram(): Command {
  const program = new Command('iris')
    .description('Iris — autonomous evaluator for built software products')
    .version('0.0.0', '-v, --version')
    .showHelpAfterError(true);
  program.addCommand(evalCommand());
  program.addCommand(judgeCommand());
  program.addCommand(reportCommand());

  // Share the root program's _outputConfiguration object with all subcommands
  // so that test helpers calling program.configureOutput() also affect subcommand
  // help output (Commander only does this automatically for .command() string API).
  const sharedConfig = program.configureOutput() as OutputConfiguration;
  for (const cmd of program.commands) {
    // Assign the same object reference so Object.assign in configureOutput propagates.
    (cmd as unknown as { _outputConfiguration: OutputConfiguration })._outputConfiguration =
      sharedConfig;
  }

  return program;
}
