# Iris Report Reader Redesign Plan

Timestamp: 2026-05-16T00:18:00-07:00

## Objective

Make the HTML report substantially easier to read from a product user's point of view. Keep the existing JSON schema stable, but stop exposing the singular `main_outcome` as if it were the only user behavior Iris understood.

Owned files:

- `packages/core/src/report/report-html.ts`
- `packages/core/src/report/report-html.test.ts`
- `packages/core/src/report/testing-plan.ts`
- `packages/core/src/report/testing-plan.test.ts`
- `research.md`
- `docs/superpowers/plans/2026-05-16-iris-report-reader-redesign.md`

## Plan Gate

1. Concrete objective and owned files: listed above.
2. Worktree/branch: `/Users/yuxuan/work/prod-critic`, branch `main`; the worktree is already dirty from ongoing Iris changes, so edits must stay scoped.
3. Riskiest assumptions:
   - Reader-facing simplification can be done without a JSON schema migration.
   - Existing tests are narrow enough to update without masking report regressions.
   - The latest tldraw run is sufficient to visually validate the report redesign.
4. Existing patterns:
   - Reuse `TestingPlan` as the canonical product map.
   - Reuse report re-render command instead of rerunning the product for every UI tweak.
   - Keep raw evidence in the audit appendix; keep claim clips attached to task cards.
5. System verification:
   - `pnpm exec vitest run packages/core/src/report/report-html.test.ts packages/core/src/report/testing-plan.test.ts --pool=forks`
   - `pnpm --filter @iris/core typecheck`
   - `pnpm --filter @iris/core build`
   - `pnpm --filter @iris/cli build`
   - Re-render latest tldraw run with `node packages/cli/dist/bin.js report <run-dir>`.
   - Serve report and inspect screenshot in browser; verify `report.html` and task clips return 200.
6. Docs/report updates:
   - Research note appended in `research.md`.
   - This plan records the rationale and verification trail.

## Implementation Steps

1. Rename and reorganize the testing-plan HTML.
   - Why: "Main user outcome" is a leaky singular contract field; readers need the visible multi-journey plan.
   - Verify: HTML no longer contains `Main user outcome`; it contains `Overall mission`, `User journeys checked`, and `Tested scenarios`.

2. Redesign task/evidence cards.
   - Why: each card should read as "Task, status, evidence, observed result", not "group header plus duplicated goal card".
   - Verify: single-task evidence groups render the task id/status/title once in the group header, and media remains first-class.

3. Simplify hero/run metadata.
   - Why: model/effort/transport matter, but tokens/cost/step internals should not dominate.
   - Verify: hero still shows core verdict metrics and run setup, without cost/tokens.

4. Keep debugging material folded.
   - Why: raw recordings and trace details are useful for debugging but should not compete with scenario evidence.
   - Verify: audit appendix remains collapsed and raw recordings stay under it.

## Review Trail

- Plan gate self-review: approved. The change is report-reader presentation over stable report JSON; verification must include rendered HTML inspection, not just tests.
- Implementation gate self-review: approved after checking the rendered tldraw report in browser. The first visual pass found scenario evidence sorted alphabetically; fixed `scenario:<order>` ranking and added a regression test.
- Verification completed:
  - `pnpm exec vitest run packages/core/src/report/report-html.test.ts packages/core/src/report/testing-plan.test.ts packages/core/src/report/report-md.test.ts packages/core/src/report/report-json.test.ts --pool=forks`
  - `pnpm --filter @iris/core typecheck`
  - `pnpm --filter @iris/core build`
  - `pnpm --filter @iris/cli build`
  - `node packages/cli/dist/bin.js report iris-runs/tldraw-e2e-20260516-000516-deep`
  - Browser screenshots of the live report confirmed the simplified top plan and scenario evidence order.
