import { describe, expect, it, vi } from 'vitest';
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
    await expectHelpExit(p.parseAsync(['node', 'iris', '--help']));
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
    await expectHelpExit(p.parseAsync(['node', 'iris', 'eval', '--help']));
    expect(helpText).toMatch(/--mode/);
    expect(helpText).toMatch(/--spec/);
    expect(helpText).toMatch(/--reasoning-effort/);
  });

  it('eval --dry-run validates inputs without starting a run', async () => {
    const p = buildProgram();
    p.exitOverride();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let output = '';
    try {
      await p.parseAsync(['node', 'iris', 'eval', 'https://example.com', '--dry-run']);
      output = stdout.mock.calls.map((call) => String(call[0])).join('');
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(output)).toMatchObject({
      dry_run: true,
      target: { kind: 'web', url: 'https://example.com' },
      mode: 'free',
    });
  });

  it('eval --dry-run reports Codex App Server aliases and scenario gate without ignored parallelism', async () => {
    const p = buildProgram();
    p.exitOverride();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let output = '';
    try {
      await p.parseAsync([
        'node',
        'iris',
        'eval',
        'https://example.com',
        '--transport',
        'codex',
        '--scenario-gate',
        '--dry-run',
      ]);
      output = stdout.mock.calls.map((call) => String(call[0])).join('');
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(output)).toMatchObject({
      dry_run: true,
      transport: 'codex-appserver',
      scenario_gate: true,
      parallel: 1,
    });
  });

  it('eval rejects explicit parallel Codex App Server runs instead of silently ignoring them', async () => {
    const p = buildProgram();
    p.exitOverride();

    await expect(
      p.parseAsync([
        'node',
        'iris',
        'eval',
        'https://example.com',
        '--transport',
        'codex-appserver',
        '--parallel',
        '2',
        '--dry-run',
      ]),
    ).rejects.toThrow(/--parallel >1 is only implemented/);
  });

  it('eval fails when a user-provided spec path is missing', async () => {
    const p = buildProgram();
    p.exitOverride();

    await expect(
      p.parseAsync([
        'node',
        'iris',
        'eval',
        'https://example.com',
        '--spec',
        '/tmp/iris-missing-spec-file.md',
        '--dry-run',
      ]),
    ).rejects.toThrow(/--spec file not found/);
  });
});

async function expectHelpExit(parse: Promise<unknown>): Promise<void> {
  try {
    await parse;
    throw new Error('expected help command to exit');
  } catch (err) {
    const exitCode =
      (err as { exitCode?: number }).exitCode ??
      ((err as Error).message.includes('"0"') ? 0 : undefined);
    expect(exitCode).toBe(0);
  }
}
