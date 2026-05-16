# Iris Scenario-Native Implementation Plan

**Date:** 2026-05-15
**Objective:** Make Iris internally expose a canonical scenario-native testing plan while preserving current Discovery JSON compatibility.

## Why

The dry run showed the public model should be:

```text
journey group -> scenario -> evidence -> result/finding
```

Current internals still expose `surfaces`, `journeys`, `goals`, `product_use_contract`, `value_loops`, and `user_jobs` as peer concepts. That makes reports confusing and encourages prompt patches. The first root fix is a compatibility layer that turns old Discovery output into a single `TestingPlan`.

## Scope

Owned files:

- `packages/core/src/report/testing-plan.ts`
- `packages/core/src/report/testing-plan.test.ts`
- `packages/core/src/report/report-json.ts`
- `packages/core/src/report/report-html.ts`
- `packages/core/src/report/report-md.ts`
- `packages/core/src/report/index.ts`
- report tests
- prompt tests if wording changes are needed

Not in this first patch:

- Removing old Discovery fields.
- Rewriting the full Explorer/Judge protocol.
- Changing saved run compatibility.

## Steps

1. Add scenario-native types and derivation.
   - Implement `TestingPlan`, `UserJourney`, `UserScenario`, `DeferredArea`, and `deriveTestingPlanFromDiscovery`.
   - Map current `product_use_contract.user_jobs` to scenarios; map current `journeys` to journey groups; map `coverage_plan.deferred_surface_ids` to deferred areas.
   - Verify: tests cover tldraw-like artifact editor, Wikipedia-like content product, and legacy flat-goal fallback.

2. Add `testing_plan` to report JSON.
   - Preserve existing `discovery` object.
   - Derive `testing_plan` during `buildReportJson`.
   - Verify: JSON tests confirm both old and new shapes exist.

3. Make HTML/Markdown render from `testing_plan`.
   - The main report should render primary journey, scenario checklist, areas covered, success signals, and deferred areas from `testing_plan`.
   - Discovery inventory stays in the appendix.
   - Verify: report tests assert old public labels do not return.

4. Retune prompt wording toward scenario-native language.
   - Update Discovery prompt copy so the model understands scenarios are the execution unit.
   - Keep old output schema for now.
   - Verify: prompt tests pass and grep finds no public-facing `value loop`/`user job` language in report renderers.

5. Rebuild and re-render latest tldraw report.
   - Verify: `biome`, focused tests, core typecheck/build, cli build.
   - Verify served report still loads at the current Tailscale URL.

## Success Criteria

- Report JSON has `testing_plan`.
- Reports consume scenario-native plan instead of directly interpreting `product_use_contract`.
- Main report no longer presents overlapping `user scenarios / user journeys / tested scenarios` terminology.
- Current tldraw report still shows 7 verified scenario cards with evidence.
- Existing old Discovery fields remain available for debug and compatibility.
