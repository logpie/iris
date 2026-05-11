#!/usr/bin/env -S node --experimental-strip-types
/**
 * Iris bench runner.
 *
 * Spawns a static-file server per fixture under fixtures/known-bugs/, runs `iris eval`
 * against each (using REAL Anthropic API), reads report.json, asserts the meta.json
 * expectations. Exits non-zero if any fixture fails its assertions.
 *
 * Requires ANTHROPIC_API_KEY in env. Cost: ~$5-15 per full run depending on
 * exploration depth.
 *
 * Usage: pnpm bench [--filter <fixture-name>] [--max-cost <usd>]
 */
import { execSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const FIXTURES_ROOT = join(REPO_ROOT, 'fixtures', 'known-bugs');
const BROKEN_APPS_ROOT = join(REPO_ROOT, 'fixtures', 'broken-apps');
const IRIS_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

interface FixtureMeta {
  name: string;
  description: string;
  spec: string;
  mode: string;
  // Phase 5: 'preflight' fixtures expect the run to be blocked before Explorer.
  kind?: 'preflight';
  expected_blocked?: boolean;
  expected_failed_checks?: string[];
  expected_exit_code?: number;
  preflight_timeout_s?: number;
  expected_findings?: Array<{
    match: { category?: string | string[]; severity?: string[]; title_contains?: string[] };
    must_find: boolean;
  }>;
  expected_score_range?: { overall?: [number, number] };
  expected_to_NOT_find?: Array<{ category?: string; severity?: string }>;
}

interface BenchResult {
  fixture: string;
  passed: boolean;
  score: number;
  findings_count: number;
  cost_usd: number;
  duration_s: number;
  failures: string[];
}

const args = process.argv.slice(2);
const filter = pickArg(args, '--filter');
const maxCost = pickArg(args, '--max-cost');
const keepDirs = args.includes('--keep');

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const HAS_CLAUDE_CLI = (() => {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (!HAS_API_KEY && !HAS_CLAUDE_CLI) {
  console.error('bench: neither ANTHROPIC_API_KEY nor `claude` CLI is available. Cannot run.');
  process.exit(0);
}
console.log(
  `bench: transport = ${HAS_API_KEY ? 'Anthropic SDK (API key)' : 'claude -p (subscription)'}`,
);
if (!existsSync(IRIS_BIN)) {
  console.error(`bench: ${IRIS_BIN} not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

interface FixtureEntry {
  name: string;
  root: 'known-bugs' | 'broken-apps';
  dir: string;
}

const knownBugFixtures: FixtureEntry[] = readdirSync(FIXTURES_ROOT)
  .filter((n) => statSync(join(FIXTURES_ROOT, n)).isDirectory())
  .filter((n) => !filter || n.includes(filter))
  .map((name) => ({ name, root: 'known-bugs' as const, dir: join(FIXTURES_ROOT, name) }));

const brokenAppFixtures: FixtureEntry[] = existsSync(BROKEN_APPS_ROOT)
  ? readdirSync(BROKEN_APPS_ROOT)
      .filter((n) => statSync(join(BROKEN_APPS_ROOT, n)).isDirectory())
      .filter((n) => !filter || n.includes(filter))
      .map((name) => ({ name, root: 'broken-apps' as const, dir: join(BROKEN_APPS_ROOT, name) }))
  : [];

const fixtures: FixtureEntry[] = [...knownBugFixtures, ...brokenAppFixtures];

if (fixtures.length === 0) {
  console.error('bench: no fixtures matched filter');
  process.exit(1);
}

const results: BenchResult[] = [];
let totalCost = 0;

for (const fixture of fixtures) {
  const { name: fixtureName, dir: fixtureDir, root } = fixture;
  const metaPath = join(fixtureDir, 'meta.json');
  if (!existsSync(metaPath)) {
    console.error(`bench: ${fixtureName} has no meta.json — skipping`);
    continue;
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as FixtureMeta;

  console.log(`\n=== ${fixtureName}${meta.kind ? ` [${meta.kind}]` : ''} ===`);
  console.log(meta.description);

  // Start fixture server. Most fixtures serve /public via static; some
  // broken-app fixtures need a custom server.mjs for HTTP-level behavior.
  let server: ServerHandle;
  const customServer = join(fixtureDir, 'server.mjs');
  if (existsSync(customServer)) {
    server = await startCustomServer(customServer);
  } else {
    server = await startServer(join(fixtureDir, 'public'));
  }
  const outDir = mkdtempSync(join(tmpdir(), `iris-bench-${fixtureName}-`));
  const specPath = join(outDir, 'spec.txt');
  writeFileSync(specPath, meta.spec);

  const start = Date.now();
  let exitCode = 0;
  // Preflight fixtures hit / (no index.html); normal fixtures hit /index.html.
  const targetPath = root === 'broken-apps' ? '' : '/index.html';
  try {
    exitCode = await runIris({
      target: `${server.url}${targetPath}`,
      out_dir: outDir,
      spec: specPath,
      max_cost: maxCost ?? '1',
      ...(meta.preflight_timeout_s !== undefined
        ? { preflight_timeout_s: String(meta.preflight_timeout_s) }
        : {}),
    });
  } catch (err) {
    results.push({
      fixture: fixtureName,
      passed: false,
      score: 0,
      findings_count: 0,
      cost_usd: 0,
      duration_s: (Date.now() - start) / 1000,
      failures: [`run threw: ${err instanceof Error ? err.message : String(err)}`],
    });
    await server.close();
    if (!keepDirs) rmSync(outDir, { recursive: true, force: true });
    else console.log(`  (keeping ${outDir})`);
    continue;
  }

  const reportPath = join(outDir, 'report.json');
  if (!existsSync(reportPath)) {
    results.push({
      fixture: fixtureName,
      passed: false,
      score: 0,
      findings_count: 0,
      cost_usd: 0,
      duration_s: (Date.now() - start) / 1000,
      failures: ['no report.json produced'],
    });
    await server.close();
    if (!keepDirs) rmSync(outDir, { recursive: true, force: true });
    else console.log(`  (keeping ${outDir})`);
    continue;
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const score = report.headline.score;
  const findings = (report.findings ?? []) as Array<{
    category: string;
    severity: string;
    title: string;
  }>;
  const cost = report.run.cost_usd ?? 0;
  totalCost += cost;

  const failures: string[] = [];

  if (meta.kind === 'preflight') {
    // Preflight fixtures: assert blocked + expected failed checks + exit code 4.
    if (!report.headline?.blocked) {
      failures.push('expected headline.blocked=true');
    }
    if (meta.expected_exit_code !== undefined && exitCode !== meta.expected_exit_code) {
      failures.push(`exit code ${exitCode} != expected ${meta.expected_exit_code}`);
    }
    const failedNames = (report.preflight?.checks ?? [])
      .filter((c: { ok: boolean }) => !c.ok)
      .map((c: { name: string }) => c.name);
    for (const expected of meta.expected_failed_checks ?? []) {
      if (!failedNames.includes(expected)) {
        failures.push(`expected failed check "${expected}", got [${failedNames.join(', ')}]`);
      }
    }
  } else {
    // Score range check
    if (meta.expected_score_range?.overall) {
      const [min, max] = meta.expected_score_range.overall;
      if (score < min || score > max) {
        failures.push(`score ${score} outside expected [${min}, ${max}]`);
      }
    }

    // must_find checks
    for (const ef of meta.expected_findings ?? []) {
      if (!ef.must_find) continue;
      const matched = findings.some((f) => matchesFinding(f, ef.match));
      if (!matched) {
        failures.push(`missing required finding: ${JSON.stringify(ef.match)}`);
      }
    }

    // expected_to_NOT_find checks
    for (const ntf of meta.expected_to_NOT_find ?? []) {
      const matched = findings.some(
        (f) =>
          (!ntf.category || f.category === ntf.category) &&
          (!ntf.severity || f.severity === ntf.severity),
      );
      if (matched) {
        failures.push(`unexpected finding present: ${JSON.stringify(ntf)}`);
      }
    }
  }

  // exit codes: 0 = pass, 1 = below threshold, 2 = budget abort (still valid),
  // 3 = error, 4 = preflight blocked. Bench passes if checks succeeded and
  // exit code is in the allowed set for this fixture kind.
  const allowedExit = meta.kind === 'preflight' ? [meta.expected_exit_code ?? 4] : [0, 1, 2];
  const passed = failures.length === 0 && allowedExit.includes(exitCode);
  results.push({
    fixture: fixtureName,
    passed,
    score,
    findings_count: findings.length,
    cost_usd: cost,
    duration_s: (Date.now() - start) / 1000,
    failures,
  });

  console.log(
    passed
      ? `  ✓ PASS (score ${score}, ${findings.length} findings, $${cost.toFixed(2)})`
      : `  ✗ FAIL (score ${score}, ${findings.length} findings, $${cost.toFixed(2)})`,
  );
  for (const f of findings) {
    console.log(`    [${f.severity}/${f.category}] ${f.title}`);
  }
  for (const f of failures) console.log(`    FAIL: ${f}`);

  await server.close();
  if (!keepDirs) rmSync(outDir, { recursive: true, force: true });
  else console.log(`  (keeping ${outDir})`);
}

console.log('\n=== Bench summary ===');
const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;
console.log(`  ${passed}/${results.length} fixtures passed`);
console.log(`  Total cost: $${totalCost.toFixed(2)}`);
for (const r of results) {
  const status = r.passed ? '✓' : '✗';
  console.log(`  ${status} ${r.fixture}: score ${r.score}, $${r.cost_usd.toFixed(2)}`);
}

process.exit(failed > 0 ? 1 : 0);

// --- helpers ---

function pickArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i === args.length - 1) return undefined;
  return args[i + 1];
}

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

function startServer(siteRoot: string): Promise<ServerHandle> {
  return new Promise((resolveStart) => {
    const MIME: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    const server = createServer((req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
      const safePath = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = resolve(siteRoot, `.${safePath}`);
      if (!filePath.startsWith(siteRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
      res.end(readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

interface IrisRunArgs {
  target: string;
  out_dir: string;
  spec: string;
  max_cost: string;
  preflight_timeout_s?: string;
}

function runIris(args: IrisRunArgs): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const cmdArgs = [
      IRIS_BIN,
      'eval',
      args.target,
      '--spec',
      args.spec,
      '--out',
      args.out_dir,
      '--no-html',
      '--no-clips',
      '--max-steps',
      '20',
      '--max-cost-usd',
      args.max_cost,
      '--transport',
      HAS_API_KEY ? 'api' : 'sdk',
      ...(args.preflight_timeout_s ? ['--preflight-timeout-s', args.preflight_timeout_s] : []),
    ];
    const proc = spawn('node', cmdArgs, { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', (code) => resolveRun(code ?? 0));
  });
}

// Start a fixture's custom server.mjs (used for preflight fixtures that need
// HTTP-level behavior like a 404 root or never-ending response stream).
function startCustomServer(serverPath: string): Promise<ServerHandle> {
  return new Promise((resolveSrv, reject) => {
    const proc = spawn('node', [serverPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        const m = line.match(/(https?:\/\/[^\s]+)/);
        if (m) {
          proc.stdout?.off('data', onData);
          resolveSrv({
            url: m[1]!,
            close: () =>
              new Promise<void>((r) => {
                proc.kill('SIGTERM');
                proc.on('exit', () => r());
              }),
          });
          return;
        }
      }
    };
    proc.stdout?.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('custom server did not start within 5s')), 5000);
  });
}

function matchesFinding(
  f: { category: string; severity: string; title: string },
  m: { category?: string | string[]; severity?: string[]; title_contains?: string[] },
): boolean {
  if (m.category) {
    const cats = Array.isArray(m.category) ? m.category : [m.category];
    if (!cats.includes(f.category)) return false;
  }
  if (m.severity && !m.severity.includes(f.severity)) return false;
  if (m.title_contains && m.title_contains.length > 0) {
    const lower = f.title.toLowerCase();
    if (!m.title_contains.some((kw) => lower.includes(kw.toLowerCase()))) return false;
  }
  return true;
}
