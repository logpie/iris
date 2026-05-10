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

- Phase 1 (foundations): ✅ merged 2026-05-09 per `plans/2026-05-09-iris-phase-1-foundations.md`
- Phase 2 (real web adapter): ✅ merged 2026-05-09 per `plans/2026-05-09-iris-phase-2-web-adapter.md`
- Phase 3 (Explorer + Judge end-to-end): planned
- Phase 4 (polish + bench): planned
