# Iris Task Run Artifacts Plan

**Date:** 2026-05-15
**Scope:** Add replay-ready task-run artifacts derived from trace events and goal results.

## Problem

Iris currently verifies goals but does not persist a durable execution record per goal. The report has goals, trace events, screenshots, and clips, but there is no compact artifact that says: this task used these actions, these results, these observations, and these evidence ids. Without that, replay/self-heal would either re-read the whole trace or ask the model to rediscover paths every time.

## Decision

Add a provider-neutral task-run builder in core and include its output in `report.json`.

This is intentionally not full replay yet:

- It does not skip Explorer.
- It does not execute cached actions.
- It does not call a model to self-heal.

It creates the durable substrate replay needs.

## Steps

1. Add `TaskRun` types and a `buildTaskRuns()` helper.
   - Verify: unit tests build task runs from synthetic trace events with action/result/observation/goal_status.

2. Include compact perception links from observation trace events.
   - Verify: observation trace payloads include `perception_state` only when the adapter supplies it, and tests can extract element hashes.

3. Attach task runs to `report.json`.
   - Verify: report-json tests assert `task_runs` includes goal id, status, replayable action, evidence ids, and perception refs.

## Gate

Codex MCP Plan Gate is not available in this session. Fallback review criteria:

- No behavior change to Explorer execution.
- No provider-specific logic.
- No bulky full DOM/body payloads in task runs.
- Mark trace-derived replay readiness conservatively.

## Verification

- `pnpm --filter @iris/core exec vitest run src/task-runs/task-runs.test.ts src/report/report-json.test.ts --reporter=dot`
- `pnpm --filter @iris/core run build`

## Outcome

Implemented:

- `packages/core/src/task-runs/task-runs.ts` derives one task-run record per judged goal from trace windows, `goal_status`, action/action_result pairs, evidence ids, and observation events.
- `report.json` now includes `task_runs` when trace events and spec goals are available.
- Observation trace payloads now include compact `perception_state` when adapters provide it, so task runs can preserve element hashes and screenshot/url context without embedding full DOM/body text.
- Core, Agent SDK, and Codex App Server runner observation events use the same shared payload helper.

Verification completed:

- `pnpm --filter @iris/core exec vitest run src/task-runs/task-runs.test.ts src/report/report-json.test.ts --reporter=dot`
- `pnpm --filter @iris/core run build`
- `pnpm --filter @iris/cli exec tsc --noEmit --pretty false`
