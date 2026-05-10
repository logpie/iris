# Iris

Autonomous evaluator for built software products. Drives the product like a real user, judges what it observes against a stable rubric, and emits a machine-readable report with video evidence.

**Status:** Phases 1–3 complete. `iris eval https://app.example.com --spec spec.md` produces a real report.json with findings + rubric scores. Phase 4 adds personas, ffmpeg clips, and known-bug bench.

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
| `@iris/adapter-web` | Web (Playwright) adapter. Drives Chromium, runs axe, captures video + trace. |

## Documents

- [Design spec](docs/superpowers/specs/2026-05-09-iris-design.md)
- [Phase 1 plan](docs/superpowers/plans/2026-05-09-iris-phase-1-foundations.md)
- [Phase 2 plan](docs/superpowers/plans/2026-05-09-iris-phase-2-web-adapter.md)
- [Phase 3 plan](docs/superpowers/plans/2026-05-09-iris-phase-3-agents.md)
- [Phase 4 plan](docs/superpowers/plans/2026-05-09-iris-phase-4-polish.md)
- [Architecture](docs/architecture.md)
- [Adding an adapter](docs/adding-an-adapter.md)

## Scripts

- `pnpm build` — build every package via tsup.
- `pnpm test` — run vitest across every package.
- `pnpm lint` — biome lint.
- `pnpm format` — biome format.
- `pnpm typecheck` — TypeScript no-emit across packages.
