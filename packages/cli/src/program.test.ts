import { describe, expect, it } from 'vitest';
import { buildProgram } from './program.js';

describe('iris CLI program', () => {
  it('exposes four subcommands: eval, judge, report, diff', () => {
    const p = buildProgram();
    const names = p.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['eval', 'judge', 'report', 'diff']));
  });

  it('--help exits with code 0 (smoke)', async () => {
    const p = buildProgram();
    p.exitOverride();
    try {
      await p.parseAsync(['node', 'iris', '--help']);
    } catch (err) {
      const code = (err as { exitCode?: number }).exitCode;
      expect(code).toBe(0);
    }
  });

  it('eval --help mentions --mode and --spec', async () => {
    const p = buildProgram();
    p.exitOverride();
    let helpText = '';
    p.configureOutput({
      writeOut: (s) => {
        helpText += s;
      },
      writeErr: (s) => {
        helpText += s;
      },
    });
    try {
      await p.parseAsync(['node', 'iris', 'eval', '--help']);
    } catch {
      // commander exits via override after writing help
    }
    expect(helpText).toMatch(/--mode/);
    expect(helpText).toMatch(/--spec/);
    expect(helpText).toMatch(/--reasoning-effort/);
  });
});
