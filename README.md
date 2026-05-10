# Iris

Autonomous evaluator for built software products. Drives the product like a real user, judges what it observes against a stable rubric, and emits a machine-readable report with video evidence.

**Status:** v1 feature-complete (Phases 1–4 done). `iris eval https://app.example.com --spec spec.md --persona power_user` drives a real Chromium with Playwright, runs axe + console + network probes, lets a Claude Sonnet Explorer act through tool-use, then a Claude Opus Judge produces findings + rubric scores. Outputs JSON / Markdown / HTML reports plus per-finding video clips (via ffmpeg). Ready for Otto integration; rubric tuning against the known-bug bench is the next iteration loop.

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
