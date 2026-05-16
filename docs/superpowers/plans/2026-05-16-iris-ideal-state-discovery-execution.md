# 2026-05-16 Iris Ideal-State Discovery Execution Plan

Objective: make Iris close the loop from product learning to scenario selection to real e2e proof. The report should not merely explain that a run missed capabilities; the run should plan from the learned capability denominator before Explorer starts.

Plan gate status: `/codex-gate` is required by local process, but no codex-gate MCP/tool is available in this Codex session. I am recording that limitation here and compensating with focused tests, full test sweeps, and real product e2e runs.

## 1. Close Discovery capability gaps before Explorer

Implement a generic Discovery normalization stage that derives the capability denominator, finds uncovered core/important abilities, synthesizes material journeys for the gaps, then recomputes product-use jobs, coverage plan, seed goals, and capabilities.

Why: selected scenarios must be a sample from the learned product denominator, not an unrelated list plus a report-time caveat.

Verify:
- Unit test: a tldraw-like Discovery response with only one broad creation journey expands into distinct selected goals for text/notes, connectors, styling/revision, shape-library usage, and visible secondary artifact capabilities when surfaces exist.
- Unit test: a Wikipedia/content-like Discovery response expands content navigation/tool gaps without creating canvas-editor goals.
- `formatDiscoveryExplorerContext` lists no core capability gaps after closed-loop planning for a rich editor with visible controls.

## 2. Persist the denominator in traces

Write `capabilities` into discovery trace events for both SDK and Codex App Server orchestrators.

Why: report generation should read the actual learned denominator from the run trace. Re-synthesis is a backwards-compat fallback, not the primary path.

Verify:
- Unit/e2e test or fixture assertion: `trace.jsonl` discovery payload contains `capabilities`.
- Re-rendered report uses the same capability counts as `discovery.json`.

## 3. Make Explorer expansion capability-aware

Strengthen the Explorer context/tool instructions so proposed goals are for uncovered product abilities, not merely newly seen UI surfaces. If all core capabilities are already selected, expansion should be secondary and bounded.

Why: runtime exploration should improve the plan when the product reveals more, without bringing back banner/legal/promo bikeshedding.

Verify:
- Prompt/unit assertion includes capability-gap language in the `propose_goal` tool description or Explorer context.
- Existing goal-status/scenario-gate tests still pass.

## 4. Validate with full tests

Run focused discovery/report/validator tests, CLI typecheck, core typecheck, and the full core suite.

Verify:
- `pnpm --filter @iris/core typecheck`
- `pnpm --filter @iris/cli typecheck`
- `pnpm --filter @iris/core exec vitest run --pool=forks`

## 5. Validate with actual e2e product runs

Run fresh end-to-end evaluations with real products:
- tldraw: artifact editor, should produce a non-trivial artifact scenario set and claim-scoped evidence.
- Wikipedia: content/search product, should cover search/read/navigation/content tools without donation/banner bikeshedding.

Use Codex App Server with high reasoning when available, scenario gate enabled, clips enabled, and no stale server/report URLs. Inspect `report.json`, `discovery.json`, `trace.jsonl`, and report screenshots/videos.

Verify:
- Discovery has capabilities in both `discovery.json` and trace.
- Core capability coverage is high or any remaining gap is explicitly legitimate.
- Goals/scenarios are material user outcomes, not tool/button/menu checks.
- Videos/screenshots show actual product use, not static landing-page/menu footage.
- Report flow makes product coverage, scenario audit, findings, and evidence easy to scan.

