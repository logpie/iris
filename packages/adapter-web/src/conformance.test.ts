import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterConformance } from '@iris/adapter-types';
import { afterAll, beforeAll } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../test-fixtures/server.js';
import { WebTargetAdapter } from './index.js';

let server: FixtureServerHandle;
let outDir: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'iris-conformance-'));
  server = await startFixtureServer('form');
});

afterAll(async () => {
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

runAdapterConformance({
  makeAdapter: () => new WebTargetAdapter({ headless: true }),
  startConfig: () => ({
    kind: 'web',
    target: `${server.url}/index.html`,
    out_dir: outDir,
  }),
  smokeTool: { name: 'screenshot', args: {} },
  smokeProbe: { name: 'axe', args: {} },
});
