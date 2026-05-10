# Iris — Phase 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Iris monorepo with all shared infrastructure — types, trace, LLM wrapper with deterministic cassettes, rubric loader, CLI skeleton, and a stub web adapter — so subsequent phases can plug in agents and real adapter logic without revisiting foundations.

**Architecture:** pnpm-workspace TypeScript monorepo. Seven packages: `adapter-types` (the `TargetAdapter` interface), `core` (target-agnostic engine: types + trace + LLM wrapper), `rubrics` (YAML loader + sample profile), `cli` (the `iris` binary), `adapter-web` (stub only — no real Playwright integration in Phase 1), `report-template` (placeholder), and `report-template` will fill out in Phase 3. All code TypeScript strict; tests via vitest; lint+format via biome.

**Tech Stack:** Node 20+, pnpm workspaces, TypeScript 5.x strict, vitest, biome, zod (schema validation), yaml (rubric parsing), @anthropic-ai/sdk, commander (CLI), ulid (trace ids), tsup (build).

**Spec reference:** `docs/superpowers/specs/2026-05-09-iris-design.md`. Phase 1 implements §13 (project layout/deps), §8 (trace schema, basic envelope only — payloads added per adapter in later phases), §11.4 (rubric YAML shape — loader only, contents stubbed in Phase 3), §5.1 (CLI surface — flag parsing + `--help`; verbs stubbed), and the LLM cassette mechanism from §14.2.

**Out of scope for Phase 1:** spec interpreter, Explorer agent, Judge agent, real Playwright adapter, report builder, ffmpeg clip slicing, known-bug fixtures, all five rubric profiles. These come in Phases 2–4.

---

## File structure (Phase 1)

```
prod-critic/                                  ← repo root (working folder name)
├── package.json                              ← root, workspaces only
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── .gitignore
├── .npmrc                                    ← pnpm config (strict-peer-deps, etc.)
├── README.md
│
├── packages/
│   ├── adapter-types/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsup.config.ts
│   │   └── src/
│   │       ├── index.ts                      ← TargetAdapter interface + sub-types
│   │       └── index.test.ts                 ← compile-only tests + zod round-trips
│   │
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsup.config.ts
│   │   └── src/
│   │       ├── types.ts                      ← Mode, RunConfig, top-level types
│   │       ├── types.test.ts
│   │       ├── trace/
│   │       │   ├── schema.ts                 ← zod TraceEvent envelope
│   │       │   ├── schema.test.ts
│   │       │   ├── writer.ts                 ← TraceWriter (append-only JSONL)
│   │       │   ├── writer.test.ts
│   │       │   ├── reader.ts                 ← TraceReader (stream JSONL)
│   │       │   ├── reader.test.ts
│   │       │   ├── digest.ts                 ← dom_digest util
│   │       │   ├── digest.test.ts
│   │       │   └── index.ts                  ← package exports
│   │       └── llm/
│   │           ├── client.ts                 ← Anthropic wrapper (cost+latency)
│   │           ├── client.test.ts
│   │           ├── cassette.ts               ← record/replay mechanism
│   │           ├── cassette.test.ts
│   │           └── index.ts
│   │
│   ├── rubrics/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsup.config.ts
│   │   ├── src/
│   │   │   ├── schema.ts                     ← zod RubricProfile schema
│   │   │   ├── loader.ts                     ← YAML → validated profile
│   │   │   ├── loader.test.ts
│   │   │   └── index.ts
│   │   └── profiles/
│   │       └── web/
│   │           └── usability.yaml            ← single sample profile
│   │
│   ├── cli/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsup.config.ts
│   │   └── src/
│   │       ├── bin.ts                        ← shebang entry
│   │       ├── program.ts                    ← commander wiring
│   │       ├── program.test.ts
│   │       ├── flags.ts                      ← shared flag types + mode inference
│   │       ├── flags.test.ts
│   │       ├── commands/
│   │       │   ├── eval.ts                   ← stub: prints resolved config + exits
│   │       │   ├── judge.ts                  ← stub
│   │       │   └── report.ts                 ← stub
│   │       └── render/
│   │           ├── summary.ts                ← --print-summary stdout helper
│   │           └── summary.test.ts
│   │
│   └── adapter-web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsup.config.ts
│       └── src/
│           ├── index.ts                      ← WebTargetAdapter STUB (throws "not implemented")
│           └── index.test.ts                 ← interface conformance: type-checks compile
│
├── docs/
│   ├── superpowers/specs/2026-05-09-iris-design.md   ← already exists
│   ├── superpowers/plans/2026-05-09-iris-phase-1-foundations.md   ← this file
│   ├── architecture.md                       ← stub
│   └── adding-an-adapter.md                  ← written in this phase
│
└── (no fixtures/ yet — Phase 4)
```

**Per-file responsibilities:**

- `adapter-types/src/index.ts` — every type any adapter must implement. Pure types + zod schemas, no runtime logic.
- `core/src/types.ts` — top-level `Mode`, `TargetKind`, `RunConfig`, severity / category enums. No trace types here (those live in `trace/schema.ts`).
- `core/src/trace/schema.ts` — zod schema for the trace event envelope (§8.1 of spec). Payload is `z.unknown()` for now; per-payload schemas land in adapters.
- `core/src/trace/writer.ts` — opens a file, appends one JSON line per event, fsyncs on close.
- `core/src/trace/reader.ts` — async iterator over a trace file; tolerates partial last-line writes.
- `core/src/trace/digest.ts` — `domDigest(html)` returns a stable SHA after stripping ads/timestamps/nonces.
- `core/src/llm/client.ts` — wraps `@anthropic-ai/sdk`; tracks cost (from token usage), latency, retries with exponential backoff on 429/529.
- `core/src/llm/cassette.ts` — wraps `client.ts`; record-or-replay based on `IRIS_RERECORD_CASSETTES` env var.
- `rubrics/src/schema.ts` — zod schema matching the rubric YAML shape from §11.4.
- `rubrics/src/loader.ts` — load a YAML file path → validated `RubricProfile`.
- `cli/src/program.ts` — commander program with three subcommands.
- `cli/src/flags.ts` — flag types, `inferMode(inputs)`, `resolveOutDir()` helpers.
- `cli/src/commands/eval.ts` — Phase 1: parse args, print resolved config as JSON, exit. No actual eval.
- `cli/src/render/summary.ts` — builds the `--print-summary` JSON line.
- `adapter-web/src/index.ts` — stub `WebTargetAdapter` whose every method throws `Error('not implemented in phase 1')`. Just so types resolve and Phase 2 can fill it in.

---

## Conventions used throughout this plan

- **TDD always:** failing test first, run it to see it fail, minimal implementation, run to see it pass, commit.
- **Commit messages** use Conventional Commits (`feat:`, `chore:`, `test:`, `docs:`, `build:`).
- **Every task ends with a commit** — no "I'll squash later" multi-task commits.
- **All paths are relative to repo root** (`/Users/yuxuan/work/prod-critic/`).
- **All shell commands assume cwd = repo root** unless noted.
- **TypeScript strict mode** is on everywhere. No `any`. Use `unknown` and narrow.
- **Test runner** is `vitest run` for one-shot, `vitest` for watch mode. Use `vitest run` in plan steps for deterministic output.

---

## Task 1: Monorepo scaffolding (pnpm workspaces, root package.json, gitignore)

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.npmrc`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
coverage/
.iris-cache/
iris-runs/
.superpowers/
```

- [ ] **Step 2: Create `.npmrc`**

```
strict-peer-dependencies=false
auto-install-peers=true
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 4: Create root `package.json`**

```json
{
  "name": "iris-monorepo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "pnpm -r run typecheck"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "typescript": "^5.6.3",
    "tsup": "^8.3.5",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 5: Install root deps**

Run: `pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 6: Verify pnpm sees the workspace**

Run: `pnpm -r ls --depth -1 2>&1 | head -5`
Expected: lists root project (no packages yet).

- [ ] **Step 7: Commit**

```bash
git add .gitignore .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "chore: scaffold pnpm monorepo"
```

---

## Task 2: TypeScript + biome + vitest config (root)

**Files:**
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `vitest.config.ts` (root)

- [ ] **Step 1: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 2: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": ["dist", "node_modules", "coverage"] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "warn" },
      "suspicious": { "noExplicitAny": "error" }
    }
  }
}
```

- [ ] **Step 3: Create root `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

- [ ] **Step 4: Verify biome runs**

Run: `pnpm lint`
Expected: "Checked 0 files in" (nothing to lint yet) — exit 0.

- [ ] **Step 5: Verify TypeScript installs and runs**

Run: `pnpm exec tsc --version`
Expected: prints version like "Version 5.6.3".

- [ ] **Step 6: Commit**

```bash
git add tsconfig.base.json biome.json vitest.config.ts
git commit -m "chore: add TypeScript, biome, vitest root config"
```

---

## Task 3: `adapter-types` package — `TargetAdapter` interface

**Files:**
- Create: `packages/adapter-types/package.json`
- Create: `packages/adapter-types/tsconfig.json`
- Create: `packages/adapter-types/tsup.config.ts`
- Create: `packages/adapter-types/src/index.ts`
- Create: `packages/adapter-types/src/index.test.ts`

- [ ] **Step 1: Create `packages/adapter-types/package.json`**

```json
{
  "name": "@iris/adapter-types",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/adapter-types/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/adapter-types/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
```

- [ ] **Step 4: Write the failing test**

Create `packages/adapter-types/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type AdapterArtifacts,
  type AdapterConfig,
  type EvidenceRef,
  type Observation,
  type ProbeResult,
  type ProbeSpec,
  type TargetAdapter,
  type TargetKind,
  type ToolResult,
  type ToolSpec,
  ToolResultSchema,
  ProbeResultSchema,
} from './index.js';

describe('adapter-types', () => {
  it('TargetKind has all four kinds', () => {
    const kinds: TargetKind[] = ['web', 'cli', 'api', 'desktop'];
    expect(kinds).toHaveLength(4);
  });

  it('ToolResultSchema validates a successful tool result', () => {
    const r: ToolResult = { ok: true, observation_ref: 'T000001', evidence_refs: [] };
    expect(ToolResultSchema.parse(r)).toEqual(r);
  });

  it('ToolResultSchema validates a failed tool result', () => {
    const r: ToolResult = { ok: false, error: 'selector not found' };
    expect(ToolResultSchema.parse(r)).toEqual(r);
  });

  it('ProbeResultSchema validates an axe-shaped probe result', () => {
    const r: ProbeResult = { ok: true, probe: 'axe', summary: { violations: 3 }, data: {} };
    expect(ProbeResultSchema.parse(r)).toEqual(r);
  });

  it('a fake adapter satisfies TargetAdapter', () => {
    const adapter: TargetAdapter = {
      kind: 'web',
      async start(_config: AdapterConfig) {},
      async stop(): Promise<AdapterArtifacts> {
        return { evidence_dir: '/tmp/x', artifact_files: {} };
      },
      listTools(): ToolSpec[] {
        return [];
      },
      async callTool(_name, _args): Promise<ToolResult> {
        return { ok: true, evidence_refs: [] };
      },
      async observe(): Promise<Observation> {
        return { observation_ref: 'T1', summary: 'empty' };
      },
      listProbes(): ProbeSpec[] {
        return [];
      },
      async runProbe(_name, _args): Promise<ProbeResult> {
        return { ok: true, probe: 'noop', summary: {}, data: {} };
      },
      async sliceEvidence(_refs: EvidenceRef[]) {
        return [];
      },
    };
    expect(adapter.kind).toBe('web');
  });
});
```

- [ ] **Step 5: Install package deps + try to run test (should fail — no source yet)**

Run: `pnpm install`
Run: `pnpm --filter @iris/adapter-types test`
Expected: FAIL — "Cannot find module './index.js'" or similar.

- [ ] **Step 6: Write `packages/adapter-types/src/index.ts`**

```ts
import { z } from 'zod';

export type TargetKind = 'web' | 'cli' | 'api' | 'desktop';

export type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'suggestion';
export type Category = 'bug' | 'a11y' | 'ux' | 'perf' | 'copy' | 'suggestion';

export interface AdapterConfig {
  kind: TargetKind;
  target: string;
  out_dir: string;
  options?: Record<string, unknown>;
}

export interface AdapterArtifacts {
  evidence_dir: string;
  artifact_files: Record<string, string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProbeSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const ToolResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    observation_ref: z.string().optional(),
    evidence_refs: z.array(z.string()).default([]),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ProbeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    probe: z.string(),
    summary: z.record(z.unknown()),
    data: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    probe: z.string(),
    error: z.string(),
  }),
]);
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export interface Observation {
  observation_ref: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface EvidenceRef {
  finding_id: string;
  event_ids: string[];
}

export interface EvidenceFile {
  finding_id: string;
  path: string;
  kind: 'video' | 'screenshot' | 'cast' | 'har' | 'log';
}

export interface TargetAdapter {
  readonly kind: TargetKind;

  start(config: AdapterConfig): Promise<void>;
  stop(): Promise<AdapterArtifacts>;

  listTools(): ToolSpec[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;

  observe(): Promise<Observation>;

  listProbes(): ProbeSpec[];
  runProbe(name: string, args: Record<string, unknown>): Promise<ProbeResult>;

  sliceEvidence(refs: EvidenceRef[]): Promise<EvidenceFile[]>;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @iris/adapter-types test`
Expected: PASS — 5 tests passing.

- [ ] **Step 8: Verify build works**

Run: `pnpm --filter @iris/adapter-types build`
Expected: `dist/index.js` and `dist/index.d.ts` produced.

- [ ] **Step 9: Commit**

```bash
git add packages/adapter-types pnpm-lock.yaml
git commit -m "feat(adapter-types): TargetAdapter interface + ToolResult/ProbeResult schemas"
```

---

## Task 4: `core` package skeleton + top-level types

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/tsup.config.ts`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/types.test.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@iris/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.1",
    "@iris/adapter-types": "workspace:*",
    "ulid": "^2.3.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/core/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
```

- [ ] **Step 4: Write the failing test**

Create `packages/core/src/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ModeSchema, RunConfigSchema, type Mode, type RunConfig } from './types.js';

describe('core types', () => {
  it('ModeSchema accepts the three valid modes', () => {
    const modes: Mode[] = ['free', 'grounded', 'targeted'];
    for (const m of modes) {
      expect(ModeSchema.parse(m)).toBe(m);
    }
  });

  it('ModeSchema rejects unknown modes', () => {
    expect(() => ModeSchema.parse('explore')).toThrow();
  });

  it('RunConfigSchema validates a complete eval config', () => {
    const cfg: RunConfig = {
      verb: 'eval',
      target: { kind: 'web', value: 'https://example.com' },
      mode: 'free',
      out_dir: './iris-runs/test',
      max_steps: 60,
      max_cost_usd: 5,
      timeout_s: 600,
      explorer_model: 'claude-sonnet-4-6',
      judge_model: 'claude-opus-4-7',
      engine: 'hybrid',
      no_html: false,
      no_clips: false,
      print_summary: false,
      verbose: false,
      json_logs: false,
    };
    expect(RunConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it('RunConfigSchema rejects negative budgets', () => {
    expect(() =>
      RunConfigSchema.parse({
        verb: 'eval',
        target: { kind: 'web', value: 'https://example.com' },
        mode: 'free',
        out_dir: '/tmp/x',
        max_steps: -1,
        max_cost_usd: 5,
        timeout_s: 600,
        explorer_model: 'claude-sonnet-4-6',
        judge_model: 'claude-opus-4-7',
        engine: 'hybrid',
        no_html: false,
        no_clips: false,
        print_summary: false,
        verbose: false,
        json_logs: false,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 5: Run test (expected fail)**

Run: `pnpm install && pnpm --filter @iris/core test`
Expected: FAIL — module not found.

- [ ] **Step 6: Write `packages/core/src/types.ts`**

```ts
import { z } from 'zod';

export const ModeSchema = z.enum(['free', 'grounded', 'targeted']);
export type Mode = z.infer<typeof ModeSchema>;

export const TargetKindSchema = z.enum(['web', 'cli', 'api', 'desktop']);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export const SeveritySchema = z.enum(['blocker', 'major', 'minor', 'nit', 'suggestion']);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum(['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion']);
export type Category = z.infer<typeof CategorySchema>;

export const EngineSchema = z.enum(['dom', 'vision', 'hybrid']);
export type Engine = z.infer<typeof EngineSchema>;

export const TargetSchema = z.object({
  kind: TargetKindSchema,
  value: z.string().min(1),
});
export type Target = z.infer<typeof TargetSchema>;

export const RunConfigSchema = z.object({
  verb: z.enum(['eval', 'judge', 'report']),
  target: TargetSchema,
  mode: ModeSchema,
  spec_path: z.string().optional(),
  tasks: z.array(z.string()).optional(),
  rubrics: z.array(z.string()).optional(),
  focus: z.array(z.string()).optional(),
  out_dir: z.string().min(1),
  max_steps: z.number().int().nonnegative(),
  max_cost_usd: z.number().nonnegative(),
  timeout_s: z.number().int().positive(),
  explore_budget: z.number().min(0).max(1).optional(),
  explorer_model: z.string().min(1),
  judge_model: z.string().min(1),
  engine: EngineSchema,
  auth_path: z.string().optional(),
  viewport: z.string().optional(),
  user_agent: z.string().optional(),
  threshold: z.number().optional(),
  no_html: z.boolean(),
  no_clips: z.boolean(),
  print_summary: z.boolean(),
  verbose: z.boolean(),
  json_logs: z.boolean(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;
```

- [ ] **Step 7: Create `packages/core/src/index.ts`**

```ts
export * from './types.js';
```

- [ ] **Step 8: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — 4 tests passing.

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): top-level types (Mode, RunConfig, Target, Severity)"
```

---

## Task 5: `core/trace` — TraceEvent envelope schema

**Files:**
- Create: `packages/core/src/trace/schema.ts`
- Create: `packages/core/src/trace/schema.test.ts`
- Create: `packages/core/src/trace/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/trace/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TraceEventSchema, type TraceEvent } from './schema.js';

describe('TraceEvent envelope', () => {
  it('validates a minimal action event', () => {
    const e: TraceEvent = {
      v: 1,
      id: 'T000001',
      ts: 1747432424.812,
      step: 1,
      target_kind: 'web',
      kind: 'action',
      actor: 'explorer',
      payload: { tool: 'click', args: { selector: 'button' } },
    };
    expect(TraceEventSchema.parse(e)).toEqual(e);
  });

  it('rejects unknown actor', () => {
    expect(() =>
      TraceEventSchema.parse({
        v: 1,
        id: 'T000001',
        ts: 1.0,
        step: 0,
        target_kind: 'web',
        kind: 'action',
        actor: 'mystery',
        payload: {},
      }),
    ).toThrow();
  });

  it('rejects v != 1', () => {
    expect(() =>
      TraceEventSchema.parse({
        v: 2,
        id: 'T000001',
        ts: 1.0,
        step: 0,
        target_kind: 'web',
        kind: 'action',
        actor: 'system',
        payload: {},
      }),
    ).toThrow();
  });

  it('accepts all defined kinds', () => {
    const kinds = [
      'run_start',
      'spec_interpreted',
      'step_plan',
      'action',
      'action_result',
      'observation',
      'probe_call',
      'probe_result',
      'evidence',
      'tentative_finding',
      'hypothesis',
      'surface_seen',
      'surface_unexplored',
      'step_done',
      'give_up',
      'done',
      'budget_warn',
      'budget_abort',
      'run_end',
    ] as const;
    for (const kind of kinds) {
      const e = {
        v: 1 as const,
        id: 'T000001',
        ts: 1.0,
        step: 0,
        target_kind: 'web' as const,
        kind,
        actor: 'system' as const,
        payload: {},
      };
      expect(TraceEventSchema.parse(e).kind).toBe(kind);
    }
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/core test`
Expected: FAIL — schema not found.

- [ ] **Step 3: Write `packages/core/src/trace/schema.ts`**

```ts
import { z } from 'zod';
import { TargetKindSchema } from '../types.js';

export const TraceEventKindSchema = z.enum([
  'run_start',
  'spec_interpreted',
  'step_plan',
  'action',
  'action_result',
  'observation',
  'probe_call',
  'probe_result',
  'evidence',
  'tentative_finding',
  'hypothesis',
  'surface_seen',
  'surface_unexplored',
  'step_done',
  'give_up',
  'done',
  'budget_warn',
  'budget_abort',
  'run_end',
]);
export type TraceEventKind = z.infer<typeof TraceEventKindSchema>;

export const ActorSchema = z.enum(['explorer', 'adapter', 'probe', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

export const TraceEventSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.number(),
  step: z.number().int().nonnegative(),
  target_kind: TargetKindSchema,
  kind: TraceEventKindSchema,
  actor: ActorSchema,
  payload: z.record(z.unknown()),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;
```

- [ ] **Step 4: Write `packages/core/src/trace/index.ts`**

```ts
export * from './schema.js';
```

- [ ] **Step 5: Update `packages/core/src/index.ts`**

```ts
export * from './types.js';
export * as trace from './trace/index.js';
```

- [ ] **Step 6: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — all tests passing including 4 new ones.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core/trace): TraceEvent envelope schema (v1)"
```

---

## Task 6: `core/trace` — TraceWriter (append-only JSONL)

**Files:**
- Create: `packages/core/src/trace/writer.ts`
- Create: `packages/core/src/trace/writer.test.ts`
- Modify: `packages/core/src/trace/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/trace/writer.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from './writer.js';
import type { TraceEvent } from './schema.js';

describe('TraceWriter', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-trace-'));
    path = join(dir, 'trace.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON line per event and closes cleanly', async () => {
    const w = new TraceWriter(path);
    await w.append(makeEvent('T1', 0, 'run_start', { config: { x: 1 } }));
    await w.append(makeEvent('T2', 1, 'observation', { url: 'https://x' }));
    await w.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const e1 = JSON.parse(lines[0]!) as TraceEvent;
    const e2 = JSON.parse(lines[1]!) as TraceEvent;
    expect(e1.id).toBe('T1');
    expect(e2.id).toBe('T2');
    expect(e2.payload).toEqual({ url: 'https://x' });
  });

  it('rejects events that fail schema validation', async () => {
    const w = new TraceWriter(path);
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
      w.append({ v: 99, id: '', ts: 0, step: 0, target_kind: 'web', kind: 'action', actor: 'explorer', payload: {} } as any),
    ).rejects.toThrow();
    await w.close();
  });

  it('events written are recoverable in order', async () => {
    const w = new TraceWriter(path);
    for (let i = 0; i < 10; i++) {
      await w.append(makeEvent(`T${i}`, i, 'action', { i }));
    }
    await w.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(JSON.parse(lines[i]!).id).toBe(`T${i}`);
    }
  });
});

function makeEvent(id: string, step: number, kind: TraceEvent['kind'], payload: object): TraceEvent {
  return {
    v: 1,
    id,
    ts: Date.now() / 1000,
    step,
    target_kind: 'web',
    kind,
    actor: 'system',
    payload: payload as Record<string, unknown>,
  };
}
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/core test`
Expected: FAIL — `TraceWriter` not found.

- [ ] **Step 3: Write `packages/core/src/trace/writer.ts`**

```ts
import { open, type FileHandle } from 'node:fs/promises';
import { TraceEventSchema, type TraceEvent } from './schema.js';

export class TraceWriter {
  private handle: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;

  constructor(private readonly path: string) {}

  private async getHandle(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    if (!this.opening) {
      this.opening = open(this.path, 'a');
    }
    this.handle = await this.opening;
    return this.handle;
  }

  async append(event: TraceEvent): Promise<void> {
    const validated = TraceEventSchema.parse(event);
    const line = `${JSON.stringify(validated)}\n`;
    const fh = await this.getHandle();
    await fh.write(line);
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = null;
      this.opening = null;
    }
  }
}
```

- [ ] **Step 4: Update `packages/core/src/trace/index.ts`**

```ts
export * from './schema.js';
export * from './writer.js';
```

- [ ] **Step 5: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — all tests including 3 new writer tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core/trace): TraceWriter — append-only JSONL with schema validation"
```

---

## Task 7: `core/trace` — TraceReader (stream JSONL)

**Files:**
- Create: `packages/core/src/trace/reader.ts`
- Create: `packages/core/src/trace/reader.test.ts`
- Modify: `packages/core/src/trace/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/trace/reader.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTrace, readTraceArray } from './reader.js';
import type { TraceEvent } from './schema.js';

describe('TraceReader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-reader-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads back a written trace', async () => {
    const path = join(dir, 'trace.jsonl');
    const events: TraceEvent[] = [
      mk('T1', 0, 'run_start'),
      mk('T2', 1, 'observation'),
      mk('T3', 2, 'action'),
    ];
    writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const collected = await readTraceArray(path);
    expect(collected).toEqual(events);
  });

  it('tolerates a missing trailing newline', async () => {
    const path = join(dir, 'trace.jsonl');
    const e = mk('T1', 0, 'run_start');
    writeFileSync(path, JSON.stringify(e));

    const collected = await readTraceArray(path);
    expect(collected).toEqual([e]);
  });

  it('skips a partial last line and reports the count of skipped lines', async () => {
    const path = join(dir, 'trace.jsonl');
    const valid = mk('T1', 0, 'run_start');
    writeFileSync(path, `${JSON.stringify(valid)}\n{"v":1,"id":"T2",`);

    const out: TraceEvent[] = [];
    let skipped = 0;
    for await (const item of readTrace(path)) {
      if (item.kind === 'event') out.push(item.event);
      else skipped++;
    }
    expect(out).toEqual([valid]);
    expect(skipped).toBe(1);
  });
});

function mk(id: string, step: number, kind: TraceEvent['kind']): TraceEvent {
  return {
    v: 1,
    id,
    ts: 1.0,
    step,
    target_kind: 'web',
    kind,
    actor: 'system',
    payload: {},
  };
}
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/core test`
Expected: FAIL — reader not found.

- [ ] **Step 3: Write `packages/core/src/trace/reader.ts`**

```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { TraceEventSchema, type TraceEvent } from './schema.js';

export type TraceItem =
  | { kind: 'event'; event: TraceEvent; line_number: number }
  | { kind: 'malformed'; raw: string; line_number: number; error: string };

export async function* readTrace(path: string): AsyncGenerator<TraceItem> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      const event = TraceEventSchema.parse(parsed);
      yield { kind: 'event', event, line_number: lineNo };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { kind: 'malformed', raw: trimmed, line_number: lineNo, error: message };
    }
  }
}

export async function readTraceArray(path: string): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  for await (const item of readTrace(path)) {
    if (item.kind === 'event') out.push(item.event);
  }
  return out;
}
```

- [ ] **Step 4: Update `packages/core/src/trace/index.ts`**

```ts
export * from './schema.js';
export * from './writer.js';
export * from './reader.js';
```

- [ ] **Step 5: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — including 3 new reader tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core/trace): TraceReader — async iterator tolerant of partial lines"
```

---

## Task 8: `core/trace` — `domDigest` utility

**Files:**
- Create: `packages/core/src/trace/digest.ts`
- Create: `packages/core/src/trace/digest.test.ts`
- Modify: `packages/core/src/trace/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/trace/digest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { domDigest } from './digest.js';

describe('domDigest', () => {
  it('returns a stable sha256-prefixed string', () => {
    const html = '<html><body><h1>Hello</h1></body></html>';
    const d = domDigest(html);
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(domDigest(html)).toBe(d);
  });

  it('ignores whitespace differences', () => {
    const a = '<div><span>x</span></div>';
    const b = '<div>  <span>x</span>  </div>';
    expect(domDigest(a)).toBe(domDigest(b));
  });

  it('strips ISO timestamps so digests match across minutes', () => {
    const a = '<p>last updated 2026-05-09T22:13:44Z</p>';
    const b = '<p>last updated 2026-05-09T22:14:01Z</p>';
    expect(domDigest(a)).toBe(domDigest(b));
  });

  it('strips data-nonce-like attributes', () => {
    const a = '<form data-nonce="abc123"><input/></form>';
    const b = '<form data-nonce="xyz999"><input/></form>';
    expect(domDigest(a)).toBe(domDigest(b));
  });

  it('different content produces different digests', () => {
    expect(domDigest('<p>a</p>')).not.toBe(domDigest('<p>b</p>'));
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/core test`
Expected: FAIL — `domDigest` not found.

- [ ] **Step 3: Write `packages/core/src/trace/digest.ts`**

```ts
import { createHash } from 'node:crypto';

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const NONCE_ATTR = /\b(data-nonce|nonce|csrf-token|data-cy-id)\s*=\s*"[^"]*"/g;
const RUNTIME_IDS = /\bid\s*=\s*"[a-z]+-[0-9a-f]{6,}"/g;

export function domDigest(html: string): string {
  const normalized = html
    .replace(ISO_TS, '__TS__')
    .replace(NONCE_ATTR, '$1=""')
    .replace(RUNTIME_IDS, 'id=""')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `sha256:${hash}`;
}
```

- [ ] **Step 4: Update `packages/core/src/trace/index.ts`**

```ts
export * from './schema.js';
export * from './writer.js';
export * from './reader.js';
export * from './digest.js';
```

- [ ] **Step 5: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — including 5 new digest tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core/trace): domDigest — stable SHA across volatile DOM noise"
```

---

## Task 9: `core/llm` — Anthropic client wrapper

**Files:**
- Create: `packages/core/src/llm/client.ts`
- Create: `packages/core/src/llm/client.test.ts`
- Create: `packages/core/src/llm/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { LlmClient, type LlmCallInput, type LlmRawResponse } from './client.js';

describe('LlmClient', () => {
  it('delegates to the injected transport and accumulates usage', async () => {
    const fakeTransport = vi.fn(
      async (input: LlmCallInput): Promise<LlmRawResponse> => ({
        id: `msg_${input.model}`,
        model: input.model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const client = new LlmClient({ transport: fakeTransport });

    const r = await client.call({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(r.text).toBe('hello');
    expect(r.usage.input_tokens).toBe(100);
    expect(r.usage.output_tokens).toBe(50);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(client.totals().calls).toBe(1);
    expect(client.totals().cost_usd).toBeGreaterThan(0);
    expect(fakeTransport).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff on rate-limit errors', async () => {
    let calls = 0;
    const flaky = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => {
      calls++;
      if (calls < 3) {
        const e = new Error('rate limited') as Error & { status?: number };
        e.status = 429;
        throw e;
      }
      return {
        id: 'ok',
        model: input.model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'finally' }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
    });
    const client = new LlmClient({ transport: flaky, retry_initial_ms: 1, max_retries: 5 });
    const r = await client.call({
      model: 'claude-sonnet-4-6',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(r.text).toBe('finally');
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 400 errors', async () => {
    const bad = vi.fn(async (): Promise<LlmRawResponse> => {
      const e = new Error('bad request') as Error & { status?: number };
      e.status = 400;
      throw e;
    });
    const client = new LlmClient({ transport: bad, max_retries: 5 });
    await expect(
      client.call({
        model: 'claude-sonnet-4-6',
        system: '',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/core test`
Expected: FAIL — `LlmClient` not found.

- [ ] **Step 3: Write `packages/core/src/llm/client.ts`**

```ts
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cache_write: number; cache_read: number }> = {
  'claude-opus-4-7':    { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-6':  { input: 3,  output: 15, cache_write: 3.75,  cache_read: 0.3 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
};

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface LlmCallInput {
  model: string;
  system: string | Array<Record<string, unknown>>;
  messages: LlmMessage[];
  tools?: Array<Record<string, unknown>>;
  max_tokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface LlmRawResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: Array<Record<string, unknown>>;
  usage: LlmUsage;
}

export interface LlmCallResult {
  raw: LlmRawResponse;
  text: string;
  usage: LlmUsage;
  cost_usd: number;
  latency_ms: number;
}

export type LlmTransport = (input: LlmCallInput) => Promise<LlmRawResponse>;

export interface LlmClientOptions {
  transport: LlmTransport;
  max_retries?: number;
  retry_initial_ms?: number;
}

export class LlmClient {
  private readonly transport: LlmTransport;
  private readonly max_retries: number;
  private readonly retry_initial_ms: number;
  private _calls = 0;
  private _cost = 0;
  private _input_tokens = 0;
  private _output_tokens = 0;

  constructor(opts: LlmClientOptions) {
    this.transport = opts.transport;
    this.max_retries = opts.max_retries ?? 4;
    this.retry_initial_ms = opts.retry_initial_ms ?? 500;
  }

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const start = Date.now();
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt <= this.max_retries) {
      try {
        const raw = await this.transport(input);
        const cost = computeCost(raw.model, raw.usage);
        this._calls++;
        this._cost += cost;
        this._input_tokens += raw.usage.input_tokens;
        this._output_tokens += raw.usage.output_tokens;
        const text = raw.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        return {
          raw,
          text,
          usage: raw.usage,
          cost_usd: cost,
          latency_ms: Date.now() - start,
        };
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        const retriable = status === 429 || status === 529 || status === 500 || status === 503;
        if (!retriable || attempt >= this.max_retries) throw err;
        const delay = this.retry_initial_ms * 2 ** attempt;
        await sleep(delay);
        attempt++;
      }
    }
    throw lastErr ?? new Error('LlmClient: exhausted retries');
  }

  totals(): { calls: number; cost_usd: number; input_tokens: number; output_tokens: number } {
    return {
      calls: this._calls,
      cost_usd: this._cost,
      input_tokens: this._input_tokens,
      output_tokens: this._output_tokens,
    };
  }
}

function computeCost(model: string, usage: LlmUsage): number {
  const p = PRICE_PER_MTOK[model] ?? { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cache_write +
      usage.cache_read_input_tokens * p.cache_read) /
    1_000_000
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Create `packages/core/src/llm/index.ts`**

```ts
export * from './client.js';
```

- [ ] **Step 5: Update `packages/core/src/index.ts`**

```ts
export * from './types.js';
export * as trace from './trace/index.js';
export * as llm from './llm/index.js';
```

- [ ] **Step 6: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — 3 new LlmClient tests passing.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core/llm): LlmClient — Anthropic wrapper with cost tracking + retry"
```

---

## Task 10: `core/llm` — cassette record/replay mechanism

**Files:**
- Create: `packages/core/src/llm/cassette.ts`
- Create: `packages/core/src/llm/cassette.test.ts`
- Modify: `packages/core/src/llm/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/cassette.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CassetteTransport } from './cassette.js';
import type { LlmCallInput, LlmRawResponse } from './client.js';

describe('CassetteTransport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-cassette-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('record mode calls real transport and writes cassette file', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'recorded'));
    const t = new CassetteTransport({ cassette_dir: dir, mode: 'record', real_transport: real });

    const r = await t.call({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(real).toHaveBeenCalledTimes(1);
    expect(r.content[0]).toEqual({ type: 'text', text: 'recorded' });
  });

  it('replay mode returns cassette without calling real transport', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'first'));

    // First, record one cassette
    const recorder = new CassetteTransport({ cassette_dir: dir, mode: 'record', real_transport: real });
    const input: LlmCallInput = {
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    };
    await recorder.call(input);

    // Now replay; real transport must NOT be called again
    const realB = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'WRONG'));
    const player = new CassetteTransport({ cassette_dir: dir, mode: 'replay', real_transport: realB });
    const r = await player.call(input);

    expect(realB).not.toHaveBeenCalled();
    expect(r.content[0]).toEqual({ type: 'text', text: 'first' });
  });

  it('replay mode throws helpful error when cassette is missing', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'x'));
    const player = new CassetteTransport({ cassette_dir: dir, mode: 'replay', real_transport: real });
    await expect(
      player.call({
        model: 'claude-sonnet-4-6',
        system: 'unrecorded',
        messages: [{ role: 'user', content: 'unrecorded' }],
      }),
    ).rejects.toThrow(/cassette not found/i);
    expect(real).not.toHaveBeenCalled();
  });

  it('hash is stable across volatile fields like extra whitespace in system', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'A'));
    const recorder = new CassetteTransport({ cassette_dir: dir, mode: 'record', real_transport: real });
    await recorder.call({
      model: 'claude-sonnet-4-6',
      system: 'hello   world',
      messages: [{ role: 'user', content: 'x' }],
    });

    const player = new CassetteTransport({ cassette_dir: dir, mode: 'replay', real_transport: real });
    // Same call but different incidental whitespace in system; should still hit cassette
    const r = await player.call({
      model: 'claude-sonnet-4-6',
      system: 'hello world',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(r.content[0]).toEqual({ type: 'text', text: 'A' });
  });
});

function fakeRsp(model: string, text: string): LlmRawResponse {
  return {
    id: `msg_${text}`,
    model,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/core test`
Expected: FAIL — `CassetteTransport` not found.

- [ ] **Step 3: Write `packages/core/src/llm/cassette.ts`**

```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmCallInput, LlmRawResponse, LlmTransport } from './client.js';

export type CassetteMode = 'record' | 'replay';

export interface CassetteOptions {
  cassette_dir: string;
  mode: CassetteMode;
  real_transport: LlmTransport;
}

export class CassetteTransport {
  constructor(private readonly opts: CassetteOptions) {
    if (!existsSync(opts.cassette_dir)) {
      mkdirSync(opts.cassette_dir, { recursive: true });
    }
  }

  call: LlmTransport = async (input: LlmCallInput): Promise<LlmRawResponse> => {
    const hash = hashInput(input);
    const path = join(this.opts.cassette_dir, `${hash}.json`);

    if (this.opts.mode === 'replay') {
      if (!existsSync(path)) {
        throw new Error(
          `cassette not found: ${path}\n` +
            `If this is a new LLM call, re-record cassettes with IRIS_RERECORD_CASSETTES=1`,
        );
      }
      return JSON.parse(readFileSync(path, 'utf8')) as LlmRawResponse;
    }

    // record
    const response = await this.opts.real_transport(input);
    writeFileSync(path, `${JSON.stringify(response, null, 2)}\n`);
    return response;
  };
}

function hashInput(input: LlmCallInput): string {
  const normalized = {
    model: input.model,
    system: normalizeText(input.system),
    messages: input.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? normalizeText(m.content) : m.content,
    })),
    tools: input.tools ?? [],
  };
  const json = JSON.stringify(normalized);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function normalizeText(s: string | Array<Record<string, unknown>>): string | Array<Record<string, unknown>> {
  if (typeof s !== 'string') return s;
  return s.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Update `packages/core/src/llm/index.ts`**

```ts
export * from './client.js';
export * from './cassette.js';
```

- [ ] **Step 5: Run test (expected pass)**

Run: `pnpm --filter @iris/core test`
Expected: PASS — 4 new cassette tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core/llm): CassetteTransport — record/replay for deterministic tests"
```

---

## Task 11: `rubrics` package — schema + YAML loader

**Files:**
- Create: `packages/rubrics/package.json`
- Create: `packages/rubrics/tsconfig.json`
- Create: `packages/rubrics/tsup.config.ts`
- Create: `packages/rubrics/src/schema.ts`
- Create: `packages/rubrics/src/loader.ts`
- Create: `packages/rubrics/src/loader.test.ts`
- Create: `packages/rubrics/src/index.ts`
- Create: `packages/rubrics/profiles/web/usability.yaml`

- [ ] **Step 1: Create `packages/rubrics/package.json`**

```json
{
  "name": "@iris/rubrics",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist", "profiles"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@iris/core": "workspace:*",
    "yaml": "^2.6.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/rubrics/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/rubrics/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
```

- [ ] **Step 4: Create the sample profile `packages/rubrics/profiles/web/usability.yaml`**

```yaml
name: usability
applies_to_targets: [web, desktop]
applies_to_modes: [free, grounded, targeted]
weight_in_overall: 1.0

dimensions:
  - id: clarity
    weight: 1.0
    description: |
      Can a new user tell what the product does and what to do next on each
      screen? Are labels, headers, and CTAs unambiguous?
    scoring_anchors:
      0: "Confusing — unclear what the product is or what to do next."
      3: "Mostly clear, with several rough spots."
      5: "Immediately clear; copy and structure carry the user."
    evidence_required: at_least_one_observation_id
    common_signals:
      positive:
        - "one obvious primary CTA per screen"
        - "labels match user vocabulary"
      negative:
        - "jargon without explanation"
        - "two competing CTAs"
        - "ambiguous icon-only buttons"
```

- [ ] **Step 5: Write the failing test**

Create `packages/rubrics/src/loader.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRubricFile, loadBundledRubric } from './loader.js';

describe('rubric loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-rubric-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the bundled web/usability profile', async () => {
    const r = await loadBundledRubric('web', 'usability');
    expect(r.name).toBe('usability');
    expect(r.applies_to_targets).toContain('web');
    expect(r.dimensions.length).toBeGreaterThan(0);
    const clarity = r.dimensions.find((d) => d.id === 'clarity');
    expect(clarity).toBeDefined();
    expect(clarity?.weight).toBe(1.0);
  });

  it('rejects YAML missing required fields', async () => {
    const path = join(dir, 'broken.yaml');
    writeFileSync(path, 'name: x\n'); // missing dimensions, applies_to_*, weight
    await expect(loadRubricFile(path)).rejects.toThrow();
  });

  it('rejects YAML with bad applies_to_targets value', async () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `name: x
applies_to_targets: [moon]
applies_to_modes: [free]
weight_in_overall: 1
dimensions:
  - id: d
    weight: 1
    description: test
`,
    );
    await expect(loadRubricFile(path)).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run test (expected fail)**

Run: `pnpm install && pnpm --filter @iris/rubrics test`
Expected: FAIL — module not found.

- [ ] **Step 7: Write `packages/rubrics/src/schema.ts`**

```ts
import { z } from 'zod';

export const RubricDimensionSchema = z.object({
  id: z.string().min(1),
  weight: z.number().nonnegative(),
  description: z.string().min(1),
  scoring_anchors: z.record(z.string()).optional(),
  evidence_required: z.string().optional(),
  common_signals: z
    .object({
      positive: z.array(z.string()).optional(),
      negative: z.array(z.string()).optional(),
    })
    .optional(),
});
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const RubricProfileSchema = z.object({
  name: z.string().min(1),
  applies_to_targets: z.array(z.enum(['web', 'cli', 'api', 'desktop'])).min(1),
  applies_to_modes: z.array(z.enum(['free', 'grounded', 'targeted'])).min(1),
  weight_in_overall: z.number().nonnegative(),
  dimensions: z.array(RubricDimensionSchema).min(1),
});
export type RubricProfile = z.infer<typeof RubricProfileSchema>;
```

- [ ] **Step 8: Write `packages/rubrics/src/loader.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RubricProfileSchema, type RubricProfile } from './schema.js';

const PROFILES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'profiles');

export async function loadRubricFile(path: string): Promise<RubricProfile> {
  const text = await readFile(path, 'utf8');
  const data = parseYaml(text);
  return RubricProfileSchema.parse(data);
}

export async function loadBundledRubric(
  target: 'web' | 'cli' | 'api' | 'desktop' | 'shared',
  name: string,
): Promise<RubricProfile> {
  const path = join(PROFILES_ROOT, target, `${name}.yaml`);
  return loadRubricFile(path);
}
```

- [ ] **Step 9: Write `packages/rubrics/src/index.ts`**

```ts
export * from './schema.js';
export * from './loader.js';
```

- [ ] **Step 10: Run test (expected pass)**

Run: `pnpm --filter @iris/rubrics test`
Expected: PASS — 3 tests passing.

- [ ] **Step 11: Commit**

```bash
git add packages/rubrics pnpm-lock.yaml
git commit -m "feat(rubrics): YAML loader + schema + sample web/usability profile"
```

---

## Task 12: `cli` package — bin entry, commander wiring, `--help`

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/tsup.config.ts`
- Create: `packages/cli/src/bin.ts`
- Create: `packages/cli/src/program.ts`
- Create: `packages/cli/src/program.test.ts`
- Create: `packages/cli/src/commands/eval.ts`
- Create: `packages/cli/src/commands/judge.ts`
- Create: `packages/cli/src/commands/report.ts`

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@iris/cli",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/program.js",
  "types": "./dist/program.d.ts",
  "bin": {
    "iris": "./dist/bin.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@iris/core": "workspace:*",
    "@iris/rubrics": "workspace:*",
    "commander": "^12.1.0",
    "picocolors": "^1.1.1"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/cli/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts', 'src/program.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
});
```

- [ ] **Step 4: Write the failing test**

Create `packages/cli/src/program.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildProgram } from './program.js';

describe('iris CLI program', () => {
  it('exposes three subcommands: eval, judge, report', () => {
    const p = buildProgram();
    const names = p.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['eval', 'judge', 'report']));
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
  });
});
```

- [ ] **Step 5: Run test (expected fail)**

Run: `pnpm install && pnpm --filter @iris/cli test`
Expected: FAIL — module not found.

- [ ] **Step 6: Write `packages/cli/src/commands/eval.ts`**

```ts
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
    .option('--max-cost-usd <n>', 'abort when LLM cost exceeds this', (s) => Number.parseFloat(s), 5)
    .option('--timeout <s>', 'total wall-clock seconds', (s) => Number.parseInt(s, 10), 600)
    .option('--explore-budget <0..1>', 'grounded mode: fraction for free exploration', (s) => Number.parseFloat(s), 0.3)
    .option('--explorer-model <id>', 'model for Explorer agent', 'claude-sonnet-4-6')
    .option('--judge-model <id>', 'model for Judge agent', 'claude-opus-4-7')
    .option('--out <dir>', 'run output directory')
    .option('--no-html', 'skip HTML report')
    .option('--no-clips', 'skip per-finding video clips')
    .option('--threshold <n>', 'exit non-zero if overall score below this', (s) => Number.parseFloat(s))
    .option('--print-summary', 'print one-line JSON summary to stdout')
    .option('--dry-run', 'run spec interpreter only, print plan, exit')
    .option('--verbose', 'stream trace events to stderr as they happen')
    .option('--json-logs', 'structured logs to stderr (skill consumers)')
    .action(async (target: string, opts: Record<string, unknown>) => {
      // Phase 1 stub: print resolved args + exit
      const resolved = { target, ...opts };
      process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
      process.stdout.write('\n[iris] eval not implemented in phase 1 — see plans/2026-05-09-iris-phase-1-foundations.md\n');
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
```

- [ ] **Step 7: Write `packages/cli/src/commands/judge.ts`**

```ts
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
```

- [ ] **Step 8: Write `packages/cli/src/commands/report.ts`**

```ts
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
```

- [ ] **Step 9: Write `packages/cli/src/program.ts`**

```ts
import { Command } from 'commander';
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
  return program;
}
```

- [ ] **Step 10: Write `packages/cli/src/bin.ts`**

```ts
#!/usr/bin/env node
import { buildProgram } from './program.js';

const program = buildProgram();

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`iris: ${message}\n`);
  process.exit(64);
});
```

- [ ] **Step 11: Run test (expected pass)**

Run: `pnpm --filter @iris/cli test`
Expected: PASS — 3 program tests passing.

- [ ] **Step 12: Build and try the bin manually**

Run: `pnpm --filter @iris/cli build`
Run: `node packages/cli/dist/bin.js --help`
Expected: prints "Iris — autonomous evaluator…" with three subcommands listed.

- [ ] **Step 13: Verify `eval --help` shows flags**

Run: `node packages/cli/dist/bin.js eval --help`
Expected: prints flags including `--mode`, `--spec`, `--rubrics`, `--engine`.

- [ ] **Step 14: Commit**

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): bin entry + commander program with eval/judge/report stubs"
```

---

## Task 13: `cli/flags` — mode inference helper

**Files:**
- Create: `packages/cli/src/flags.ts`
- Create: `packages/cli/src/flags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/flags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inferMode, type EvalInputs } from './flags.js';

describe('inferMode', () => {
  it('returns targeted when --task is given', () => {
    const inp: EvalInputs = { tasks: ['verify checkout'] };
    expect(inferMode(inp)).toBe('targeted');
  });

  it('returns targeted when --tasks file is given', () => {
    expect(inferMode({ tasks_path: '/x.txt' })).toBe('targeted');
  });

  it('returns grounded when only --spec is given', () => {
    expect(inferMode({ spec_path: '/spec.md' })).toBe('grounded');
  });

  it('returns free when nothing is given', () => {
    expect(inferMode({})).toBe('free');
  });

  it('explicit override wins over inference', () => {
    expect(inferMode({ spec_path: '/spec.md', explicit_mode: 'free' })).toBe('free');
    expect(inferMode({ tasks: ['x'], explicit_mode: 'grounded' })).toBe('grounded');
  });

  it('throws when explicit mode is invalid', () => {
    expect(() => inferMode({ explicit_mode: 'explore' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/cli test`
Expected: FAIL — `inferMode` not found.

- [ ] **Step 3: Write `packages/cli/src/flags.ts`**

```ts
import { ModeSchema, type Mode } from '@iris/core';

export interface EvalInputs {
  spec_path?: string;
  tasks?: string[];
  tasks_path?: string;
  explicit_mode?: string;
}

export function inferMode(inputs: EvalInputs): Mode {
  if (inputs.explicit_mode !== undefined) {
    return ModeSchema.parse(inputs.explicit_mode);
  }
  if ((inputs.tasks && inputs.tasks.length > 0) || inputs.tasks_path) return 'targeted';
  if (inputs.spec_path) return 'grounded';
  return 'free';
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `pnpm --filter @iris/cli test`
Expected: PASS — 6 flags tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/flags.ts packages/cli/src/flags.test.ts
git commit -m "feat(cli/flags): inferMode helper with explicit-override semantics"
```

---

## Task 14: `cli/render/summary` — `--print-summary` line builder

**Files:**
- Create: `packages/cli/src/render/summary.ts`
- Create: `packages/cli/src/render/summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/render/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSummaryLine, type SummaryInput } from './summary.js';

describe('buildSummaryLine', () => {
  it('produces a single-line valid JSON terminated by newline', () => {
    const inp: SummaryInput = {
      score: 7.4,
      threshold_passed: true,
      findings: { blocker: 1, major: 4, minor: 12, nit: 3, suggestion: 15 },
      run_dir: './iris-runs/x',
      duration_s: 412,
      cost_usd: 1.84,
      caveats: 3,
    };
    const line = buildSummaryLine(inp);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n').filter((s) => s.length > 0)).toHaveLength(1);

    const parsed = JSON.parse(line.trim()) as SummaryInput & { v: number };
    expect(parsed.v).toBe(1);
    expect(parsed.score).toBe(7.4);
    expect(parsed.threshold_passed).toBe(true);
    expect(parsed.findings.blocker).toBe(1);
  });

  it('rounds score and cost to 2 decimals', () => {
    const line = buildSummaryLine({
      score: 7.4444,
      threshold_passed: false,
      findings: { blocker: 0, major: 0, minor: 0, nit: 0, suggestion: 0 },
      run_dir: '/x',
      duration_s: 10,
      cost_usd: 1.84321,
      caveats: 0,
    });
    const parsed = JSON.parse(line.trim()) as { score: number; cost_usd: number };
    expect(parsed.score).toBe(7.44);
    expect(parsed.cost_usd).toBe(1.84);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/cli test`
Expected: FAIL — summary not found.

- [ ] **Step 3: Write `packages/cli/src/render/summary.ts`**

```ts
export interface SummaryInput {
  score: number;
  threshold_passed: boolean;
  findings: {
    blocker: number;
    major: number;
    minor: number;
    nit: number;
    suggestion: number;
  };
  run_dir: string;
  duration_s: number;
  cost_usd: number;
  caveats: number;
}

export function buildSummaryLine(input: SummaryInput): string {
  const out = {
    v: 1,
    score: round2(input.score),
    threshold_passed: input.threshold_passed,
    findings: input.findings,
    run_dir: input.run_dir,
    duration_s: input.duration_s,
    cost_usd: round2(input.cost_usd),
    caveats: input.caveats,
  };
  return `${JSON.stringify(out)}\n`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `pnpm --filter @iris/cli test`
Expected: PASS — 2 summary tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/render
git commit -m "feat(cli/render): --print-summary one-line JSON builder"
```

---

## Task 15: `adapter-web` package — stub adapter (Phase 2 fills it in)

**Files:**
- Create: `packages/adapter-web/package.json`
- Create: `packages/adapter-web/tsconfig.json`
- Create: `packages/adapter-web/tsup.config.ts`
- Create: `packages/adapter-web/src/index.ts`
- Create: `packages/adapter-web/src/index.test.ts`

- [ ] **Step 1: Create `packages/adapter-web/package.json`**

```json
{
  "name": "@iris/adapter-web",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@iris/adapter-types": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `packages/adapter-web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/adapter-web/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
});
```

- [ ] **Step 4: Write the failing test**

Create `packages/adapter-web/src/index.test.ts`:

```ts
import type { TargetAdapter } from '@iris/adapter-types';
import { describe, expect, it } from 'vitest';
import { WebTargetAdapter } from './index.js';

describe('WebTargetAdapter (Phase 1 stub)', () => {
  it('satisfies the TargetAdapter interface and reports kind=web', () => {
    const adapter: TargetAdapter = new WebTargetAdapter();
    expect(adapter.kind).toBe('web');
  });

  it('every method throws "not implemented in phase 1"', async () => {
    const a = new WebTargetAdapter();
    await expect(a.start({ kind: 'web', target: 'https://x', out_dir: '/tmp' })).rejects.toThrow(/phase 1/);
    await expect(a.stop()).rejects.toThrow(/phase 1/);
    expect(() => a.listTools()).toThrow(/phase 1/);
    await expect(a.callTool('click', {})).rejects.toThrow(/phase 1/);
    await expect(a.observe()).rejects.toThrow(/phase 1/);
    expect(() => a.listProbes()).toThrow(/phase 1/);
    await expect(a.runProbe('axe', {})).rejects.toThrow(/phase 1/);
    await expect(a.sliceEvidence([])).rejects.toThrow(/phase 1/);
  });
});
```

- [ ] **Step 5: Run test (expected fail)**

Run: `pnpm install && pnpm --filter @iris/adapter-web test`
Expected: FAIL — `WebTargetAdapter` not found.

- [ ] **Step 6: Write `packages/adapter-web/src/index.ts`**

```ts
import type {
  AdapterArtifacts,
  AdapterConfig,
  EvidenceFile,
  EvidenceRef,
  Observation,
  ProbeResult,
  ProbeSpec,
  TargetAdapter,
  TargetKind,
  ToolResult,
  ToolSpec,
} from '@iris/adapter-types';

const NOT_IMPL = 'WebTargetAdapter: not implemented in phase 1 — see plans/2026-05-09-iris-phase-1-foundations.md';

export class WebTargetAdapter implements TargetAdapter {
  readonly kind: TargetKind = 'web';

  async start(_config: AdapterConfig): Promise<void> {
    throw new Error(NOT_IMPL);
  }

  async stop(): Promise<AdapterArtifacts> {
    throw new Error(NOT_IMPL);
  }

  listTools(): ToolSpec[] {
    throw new Error(NOT_IMPL);
  }

  async callTool(_name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    throw new Error(NOT_IMPL);
  }

  async observe(): Promise<Observation> {
    throw new Error(NOT_IMPL);
  }

  listProbes(): ProbeSpec[] {
    throw new Error(NOT_IMPL);
  }

  async runProbe(_name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    throw new Error(NOT_IMPL);
  }

  async sliceEvidence(_refs: EvidenceRef[]): Promise<EvidenceFile[]> {
    throw new Error(NOT_IMPL);
  }
}
```

- [ ] **Step 7: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 2 tests passing.

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-web pnpm-lock.yaml
git commit -m "feat(adapter-web): stub WebTargetAdapter (Phase 2 implementation pending)"
```

---

## Task 16: Repo-wide build + lint + test green

**Files:** none (verification task only)

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: each package builds without errors; `dist/` produced in every package.

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: all suites pass; total tests around 30+.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: no errors. Fix any biome warnings introduced.

- [ ] **Step 4: Run typecheck across packages**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Manually verify the bin works after a full clean install**

Run:
```bash
rm -rf node_modules packages/*/node_modules packages/*/dist
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js eval --help
node packages/cli/dist/bin.js eval https://example.com --spec /tmp/nope.md --dry-run
```
Expected: third command prints resolved JSON config including `target: "https://example.com"` and the "not implemented in phase 1" message. Exit code 0.

- [ ] **Step 6: Commit nothing (verification-only). If any fixes were needed, commit them with:**

```bash
git commit -m "chore: foundations green — build + test + lint + typecheck"
```

---

## Task 17: README + adding-an-adapter doc + architecture stub

**Files:**
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/adding-an-adapter.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# Iris

Autonomous evaluator for built software products. Drives the product like a real user, judges what it observes against a stable rubric, and emits a machine-readable report with video evidence.

**Status:** Phase 1 foundations only. Real evaluation arrives in Phase 3.

## Install (development)

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

## Packages

| Package | Purpose |
|---|---|
| `@iris/adapter-types` | The `TargetAdapter` interface every adapter implements. |
| `@iris/core` | Target-agnostic engine: types, trace, LLM wrapper, cassettes. |
| `@iris/rubrics` | Rubric YAML loader + bundled profiles. |
| `@iris/cli` | The `iris` binary. |
| `@iris/adapter-web` | Web (Playwright) adapter. **Stub in Phase 1.** |

## Documents

- [Design spec](docs/superpowers/specs/2026-05-09-iris-design.md)
- [Phase 1 plan](docs/superpowers/plans/2026-05-09-iris-phase-1-foundations.md)
- [Architecture](docs/architecture.md)
- [Adding an adapter](docs/adding-an-adapter.md)

## Scripts

- `pnpm build` — build every package via tsup.
- `pnpm test` — run vitest across every package.
- `pnpm lint` — biome lint.
- `pnpm format` — biome format.
- `pnpm typecheck` — TypeScript no-emit across packages.
````

- [ ] **Step 2: Write `docs/architecture.md`**

```markdown
# Architecture

See [the design spec](superpowers/specs/2026-05-09-iris-design.md) for the canonical architecture document. This file is a quick map for new contributors.

## Top-level flow (eval)

```
CLI → Orchestrator → Spec Interpreter → TargetAdapter.start
                  → Explorer loop (observe/plan/act/record) → trace.jsonl
                  → TargetAdapter.stop
                  → Judge (reads trace) → findings + scores
                  → Report Builder → report.json + html + md + clips
```

## The seam: `TargetAdapter`

`packages/adapter-types/src/index.ts` defines the interface every adapter implements. v1 ships only `WebTargetAdapter` (`packages/adapter-web/`). To add a new target (CLI, API, desktop), see [adding-an-adapter.md](adding-an-adapter.md).

## Why two phases (Explorer + Judge)?

The trace is the durable artifact. The Judge can be re-run against any stored trace without paying for browser automation — this is the iteration loop for tuning rubric prompts.

## Phase status

- Phase 1 (foundations): ✅ in progress per `plans/2026-05-09-iris-phase-1-foundations.md`
- Phase 2 (real web adapter): planned
- Phase 3 (Explorer + Judge end-to-end): planned
- Phase 4 (polish + bench): planned
```

- [ ] **Step 3: Write `docs/adding-an-adapter.md`**

```markdown
# Adding a TargetAdapter

To add support for a new target kind (CLI, API, desktop, etc.), implement the `TargetAdapter` interface from `@iris/adapter-types`.

## Steps

1. Create a new package under `packages/adapter-<kind>/`.
2. Add `@iris/adapter-types` as a workspace dependency.
3. Implement the `TargetAdapter` interface. Every method must be callable; throw clear errors for unsupported tools.
4. Define your tool list (`listTools()`) — these become Anthropic tool definitions seen by the Explorer.
5. Define your probe list (`listProbes()`) — deterministic non-LLM checks the Explorer can request.
6. Implement `observe()` — return a target-specific snapshot. Web returns DOM + screenshot ref; CLI returns stdout/stderr/cursor; etc.
7. Implement `sliceEvidence()` — given finding evidence refs, slice your run-recording into per-finding artifacts.
8. Add rubric profiles under `packages/rubrics/profiles/<kind>/` that apply to your target.
9. (Phase 4+) opt into the conformance suite from `@iris/adapter-types/conformance`.

## Trace events

All adapters write to the same `trace.jsonl`. The envelope is target-agnostic; the `payload` is target-specific. Use `target_kind: '<your-kind>'` so the Judge can interpret payloads.

## Rubric profiles

Each profile YAML declares `applies_to_targets`. Profiles with `applies_to_targets: [web]` won't be loaded for a CLI run.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture.md docs/adding-an-adapter.md
git commit -m "docs: README + architecture + adding-an-adapter"
```

---

## Self-review checklist

Run through this before declaring Phase 1 done. Fix anything inline.

**1. Spec coverage check (against `docs/superpowers/specs/2026-05-09-iris-design.md`):**

- §13.1 monorepo layout → Tasks 1–2, 3, 4, 11, 12, 15 ✅
- §13.2 runtime deps installed (anthropic, zod, yaml, commander, ulid) → Tasks 3, 4, 9, 11, 12 ✅
- §13.3 build/test tooling (tsup, vitest, biome) → Tasks 2, every package ✅
- §13.4 distribution (`bin: { iris: ... }`) → Task 12 ✅
- §13.5 Node 20+ ESM → Task 1 (`engines.node`), all `tsconfig.json` ✅
- §8.1 trace envelope schema → Task 5 ✅
- §8.2 trace event kinds enum → Task 5 ✅
- §11.4 rubric YAML shape → Task 11 ✅
- §14.2 cassette mechanism → Task 10 ✅
- §5.1 CLI surface (verbs + flags + `--print-summary`) → Tasks 12, 13, 14 ✅
- §6.2 mode inference → Task 13 ✅
- §7 `TargetAdapter` interface → Task 3 ✅
- §10.5 Explorer tool/probe specs (`ToolSpec`, `ProbeSpec`) → Task 3 ✅
- LLM wrapper with cost tracking, prompt caching support, retries → Task 9 ✅

Out of scope for Phase 1 (will appear in later plans):
- Spec interpreter — Phase 3
- Explorer / Judge agents — Phase 3
- Real Playwright adapter — Phase 2
- All 5 rubric profiles (only `usability.yaml` shipped) — Phase 4
- Report HTML/MD/JSON builders — Phase 3
- ffmpeg clip slicing — Phase 4
- Known-bug-bench fixtures — Phase 4
- Adapter conformance suite — Phase 4

**2. Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details" in any task. Every step has either a complete code block or a literal command. ✅

**3. Type/name consistency:**

- `TargetAdapter` interface (Task 3) — methods used identically in `WebTargetAdapter` stub (Task 15) and the conformance test in Task 3. ✅
- `TraceEvent` schema (Task 5) — used unchanged by `TraceWriter` (Task 6) and `TraceReader` (Task 7). ✅
- `Mode` enum (Task 4) — referenced consistently in `inferMode` (Task 13). ✅
- `LlmTransport` (Task 9) — used as `real_transport` shape in cassette (Task 10). ✅
- `RubricProfile` (Task 11) — schema matches the YAML shape in the bundled file. ✅

---

## Phase 1 done — ready for Phase 2

When all 17 tasks are committed:

- `pnpm build && pnpm test && pnpm lint && pnpm typecheck` all green.
- `node packages/cli/dist/bin.js --help` works and lists `eval`, `judge`, `report`.
- The trace, LLM wrapper, cassette mechanism, and rubric loader are all unit-tested and importable.
- The web adapter compiles but throws "not implemented in phase 1" for every method.

Phase 2 will implement the real `WebTargetAdapter` (Playwright + axe + tools + recording) and the adapter conformance test suite.
