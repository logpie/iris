# Plan: Generic Product-Use Contracts

Written at: 2026-05-14T23:55:17-07:00

## Objective

Make Iris evaluate real product use by carrying a generic product-use contract from Discovery through Explorer, Judge, validation, and report output.

## Steps

1. Add ProductUseContract schema to Discovery.
   - Why: Discovery is where Iris decides what "real use" means for the product.
   - Verify: Discovery unit tests prove contract fields survive normalization and report JSON extraction.

2. Update Discovery prompt and Explorer context.
   - Why: Explorer needs archetype-level user jobs, required actions, expected artifacts, and weak proof warnings before acting.
   - Verify: prompt/context tests assert canvas/editor examples require artifact creation rather than activation-only proof.

3. Update Judge prompt.
   - Why: Judge should score task/artifact coverage separately from surface coverage and avoid high scores for sampled controls.
   - Verify: prompt tests assert the real-use/value-loop guidance is present.

4. Extend goal-claim validation with generic weak-proof detection.
   - Why: LLM judgement alone will drift. Verified goals should be downgraded when notes/evidence only show toolbar/menu/focus/activation.
   - Verify: validator unit tests cover activation-only downgrade and durable artifact pass.

5. Render real-use depth in the report.
   - Why: The reader should immediately see whether Iris exercised the primary value loop and what proof was accepted or rejected.
   - Verify: HTML tests assert the summary renders and old reports remain compatible.

6. Rebuild and re-render the current tldraw report.
   - Why: The current report is the regression artifact the user is auditing.
   - Verify: served report contains product-use contract metadata and real-use depth summary.

## Plan Gate

- Worktree/branch: `/Users/yuxuan/work/prod-critic`, `main`.
- Owned files: `packages/core/src/discovery/*`, `packages/core/src/judge/*`, `packages/core/src/report/*`, `packages/adapter-web/src/contract.ts`, focused tests, and report re-render artifacts.
- Risk: overfitting the rules to canvas products. Mitigation: schema uses generic product kinds and generic required-action/artifact/weak-evidence arrays.
- Risk: old reports break. Mitigation: all report fields are optional and rendering is conditional.
- Verification: focused tests, package typechecks, full build, report re-render and served-page check.

## Implementation Result

- Added a generic `product_use_contract` to Discovery output and normalized Explorer context.
- Updated Discovery, Explorer, and Judge prompts so real-use depth is defined by product kind, primary value loop, required actions, expected artifacts/state, accepted evidence, and weak evidence.
- Added deterministic goal validation against the product-use contract. The validator now rejects weak proof only when the claim lacks outcome language, and it recognizes keyboard shortcuts/style-control clicks as valid required actions.
- Rendered the real-use contract in HTML and Markdown reports next to the Discovery coverage map.
- Added `iris report --revalidate` so stored `judge.raw.txt` can be replayed through the current evidence/goal validators before re-rendering old run reports.

## Verification Log

- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts src/explorer/prompts.test.ts src/judge/prompts.test.ts src/judge/goal-claim-validator.test.ts src/report/report-json.test.ts src/report/report-html.test.ts src/report/report-md.test.ts --reporter=dot`
- `pnpm --filter @iris/core run typecheck`
- `pnpm --filter @iris/adapter-web run typecheck`
- `pnpm --filter @iris/cli run typecheck`
- `pnpm -r run build`
- `pnpm -r run test -- --reporter=dot`
- `pnpm --filter @iris/cli run test -- --reporter=dot`
- Fresh real-product run: `node packages/cli/dist/bin.js eval https://www.tldraw.com --transport codex-appserver --explorer-model gpt-5.4 --judge-model gpt-5.4 --out iris-runs/tldraw-product-use-contract-20260515-001105 --parallel 1 --timeout 900 --steps-per-goal 14 --free-exploration-steps 12 --max-steps 220 --print-summary --verbose`
- Revalidated served report: `node packages/cli/dist/bin.js report iris-runs/tldraw-product-use-contract-20260515-001105 --revalidate`
- Served-page checks: HTTP 200 for `report.html`, claim clip, and screenshot assets; Playwright snapshot verified `6/7 verified`, `Real-use contract`, and visible per-goal clips.

## Follow-up: Evidence Presentation Quality

Written at: 2026-05-15T01:14:00-07:00

The tldraw report still makes the reader work too hard:

- Claim clips are raw browser recordings, so canvas gestures often look static and low-signal.
- A failed journey can appear once as a goal and again as a finding, with nearly identical clips, which reads as contradictory even when the JSON is internally consistent.
- Action-tool friction can become a UX finding without visible product impact.
- The primary canvas-editor goal can pass after one basic object, which is technically real use but weaker than a real user drawing a meaningful board artifact.

Remediation plan:

1. Generate trace-based storyboard clips from observation and screenshot frames for every goal/finding claim, and use raw page video only as fallback.
   - Verify: a unit test proves claim storyboards are created from trace screenshots and used before adapter raw-video slicing.

2. Link findings to overlapping goal rows and suppress duplicate finding media when the goal row already shows the same evidence context.
   - Verify: HTML tests assert a partial goal displays the linked finding and the finding row points back to that goal instead of embedding a duplicate clip.

3. Discard low-signal action-result-only UX findings about click/focus/retry friction unless there is visible user-facing failure evidence.
   - Verify: validator tests cover tool-friction discard while preserving real, visible failure findings.

4. Strengthen generic discovery/explorer guidance for artifact-editor products: the primary value loop should produce a small meaningful artifact through multiple normal actions when the product exposes those tools.
   - Verify: prompt tests assert this guidance is present and remains product-kind generic.
