# 2026-05-16 Iris Material Scenario Plan

## Problem

Iris is improving at rejecting toolbar/menu-only proof, but its plan generation is still capability-centered. A mature editor like tldraw gets goals such as "add text" and "use a non-default shape" instead of a real scenario such as creating a small launch-plan board with named steps, labels, relationships, and styling.

## Design

Make concrete user scenarios the primary internal/public unit while keeping existing JSON compatibility.

- Keep `product_use_contract`, `value_loops`, `user_jobs`, `journeys`, and `goals`.
- Extend `user_jobs` with optional scenario fields:
  - `scenario_brief`
  - `test_data`
  - `required_outputs`
  - `quality_bar`
- Discovery prompt learns the product first and produces user scenarios with concrete data.
- Discovery normalizers enrich shallow/model-generic jobs with product-kind scenario scaffolds.
- Goals inherit scenario wording so Explorer sees concrete tasks.
- Explorer/Judge/validator/report consume the scenario fields.

## Tradeoffs

- Rejected: hardcode tldraw examples such as "elephant". That would improve one site and fail the product-generalization requirement.
- Rejected: replace the whole discovery schema in this pass. The report/Judge/CLI pipeline already depends on the compatibility shape; extending `user_jobs` is safer and still moves the conceptual center.
- Accepted: product-kind scaffolds. Broad classes like canvas editors, document editors, CRUD tools, dashboards, search/content sites, commerce, and communication tools need different task data. This is generic evaluation design, not site patching.

## Steps

1. Extend schemas and report model for scenario fields.
   - Verify: focused report/discovery tests pass and generated `TestingPlan.scenarios` exposes scenario brief, outputs, and quality bar.

2. Update Discovery prompt and normalizers so shallow jobs become concrete material user scenarios.
   - Verify: tldraw-like unit tests fail on generic "visible content" and pass only when a named artifact brief and required outputs exist.

3. Update Explorer/Judge context and validator enforcement.
   - Verify: a verified claim with generic shape/text proof but missing scenario-required labels is downgraded.

4. Re-render and run focused tests/typecheck/build.
   - Verify: `pnpm exec vitest ...`, `pnpm --filter @iris/core typecheck`, `pnpm --filter @iris/core build`, and `pnpm --filter @iris/cli build` pass.

5. Run a fresh real tldraw e2e with clips enabled.
   - Verify: report goals are concrete user scenarios, claim clips load over the served Tailscale URL, and evidence shows named scenario content rather than generic filler.

## Review Notes

- Codex-gate MCP is not available in this session; compensate with focused tests, a fresh real-product run, and manual report/video audit.
