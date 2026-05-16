# Iris Artifact-Centered Contract Plan

**Date:** 2026-05-15
**Branch:** `main`
**Objective:** Make Iris derive and verify goals from product-use proof obligations instead of shallow surface interactions, while keeping one product-level contract.

## Owned files

- `packages/core/src/discovery/prompts.ts`
- `packages/core/src/discovery/discovery.ts`
- `packages/core/src/discovery/discovery.test.ts`
- `packages/core/src/judge/goal-claim-validator.ts`
- `packages/core/src/judge/goal-claim-validator.test.ts`
- `packages/core/src/report/report-html.ts`
- `packages/core/src/report/report-md.ts`
- Report/discovery tests as needed
- This plan and `research.md`

## Plan Gate

1. Objective and scope are shared core code, not provider-specific code. The same path feeds Claude and Codex App Server.
2. Current worktree confirmed: `/Users/yuxuan/work/prod-critic`, branch `main`.
3. Riskiest assumption: generic materiality floors can be useful without turning into product-specific if/else logic. Keep them keyed to existing broad `product_kinds` and journey intent, not to tldraw labels.
4. Existing patterns: reuse `ProductUseContractSchema`, `normalizeProductUseContract`, `formatDiscoveryExplorerContext`, and `evaluateProductUseContract`.
5. Verification:
   - `pnpm --filter @iris/core test -- discovery.test.ts goal-claim-validator.test.ts report-html.test.ts report-md.test.ts`
   - `pnpm --filter @iris/core typecheck`
   - Inspect normalized contract output in tests for the tldraw-like case.
6. Docs/report updates: render value loops and acceptance checks clearly so users can see contract -> job -> goal linkage.

## Steps

1. Extend schema and prompt.
   - Add `value_loops` and `proof_obligations`.
   - Keep legacy fields required for backward compatibility.
   - Verify: discovery prompt test confirms new fields and artifact-centered wording.

2. Normalize generic materiality.
   - Synthesize one default value loop from legacy contract fields when missing.
   - Synthesize missing jobs for selected material journeys.
   - Enrich shallow artifact-editor jobs with required create/edit/style/text obligations.
   - Verify: tldraw-like shallow discovery output gets richer obligations and still defers setup/promo surfaces.

3. Enforce in validator.
   - Treat `proof_obligations` as additional weak-proof rejection and required-action context.
   - Downgrade verified editor claims when materiality requirements are missing from the action window.
   - Verify: tests cover shallow canvas proof downgraded and richer proof kept.

4. Improve report presentation.
   - Show value loop summary and acceptance jobs linked to goal status.
   - Avoid presenting one contract blob as if it were one goal.
   - Verify: report HTML/MD tests cover the new fields.

5. Final checks.
   - Run targeted tests and typecheck.
   - Inspect diff for provider-specific code or duplicated logic.

## Verification Notes

Completed 2026-05-15:

- Added `value_loops`, `proof_obligations`, materiality enrichment, and contract-aware goal validation in shared core code.
- Added provider robustness for Codex App Server outputs:
  - Discovery accepts `toolbar` surfaces.
  - Discovery parse tries balanced JSON candidates instead of a greedy object.
  - Codex App Server and Agent SDK paths preserve `discovery.raw.txt` / `judge.raw.txt` for parse failures.
  - Judge normalizes compact string `access_blocks` into structured blocks.
- Added score calibration after deterministic goal-claim downgrades so rubric scores cannot keep saying “all goals completed” after validation made a goal partial.
- Live tldraw checks:
  - `iris-runs/tldraw-artifact-contract-smoke8-20260515-135352`: Discovery selected create, style, text/note, and share goals; no discovery fallback artifact.
  - `iris-runs/tldraw-artifact-contract-e2e4-20260515-135534`: Explorer created a rectangle, styled it, reached share/sign-in, and changed language through the page menu. Judge reported 3/4 verified after validation, with the simple create-only goal downgraded to partial by the materiality floor.
- Commands:
  - `pnpm exec biome check` on touched files passed.
  - `pnpm build && pnpm typecheck` passed.
  - `pnpm test` passed across all workspace packages.

Remaining product/evaluation gap:

- The materiality floor is intentionally strict for artifact editors. A single rectangle creation is partial unless the goal or value loop only asks for a smoke check; real-use verification should include composition/editing such as style, text, connector, movement, resize, or media.
