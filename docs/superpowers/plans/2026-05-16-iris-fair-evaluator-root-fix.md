# Iris Fair Evaluator Root Fix Plan

Timestamp: 2026-05-16 15:55 PDT

## Objective

Make Iris evaluate general software products fairly by auditing selected scenarios against a learned capability denominator, exposing important skipped scope, and producing scenario-specific evidence reels instead of fixed/static clips.

This is not a prompt polish pass and not a named-site patch. The implementation should be small enough to reason about and broad enough to apply to content/search, artifact/editor, CRUD/workflow, dashboard/filtering, and commerce/transaction-boundary products.

## Design Principles

1. Separate sampled task success from product-scope coverage.
   - A run can be `4/4 verified` and still have limited product coverage.

2. Keep scope semantics small.
   - Public/evaluator-facing states are only:
     - `must_test`
     - `should_test_or_explain`
     - `not_normally_tested`
   - Reasons are plain text, not a growing enum matrix.

3. Treat product-native important capabilities as first-class.
   - Iris must test them or explain why not.
   - The explanation must affect confidence/scope.

4. Evidence should prove the scenario arc.
   - Primary clips should show before/action/result/proof when possible.
   - Raw full recordings are debug artifacts.

## Implementation Steps

### 1. Add A Selection Expectation Gate

Add a normalization pass after capabilities are derived and before seed goals are finalized.

Implementation shape:

- Add a small `selection_expectation` field to `DiscoveryCapability`:
  - `must_test`
  - `should_test_or_explain`
  - `not_normally_tested`
- Add `skip_reason` as optional/plain text for untested important capabilities.
- Derive expectation from generic signals:
  - current capability importance,
  - whether it is tied to the learned value loop or user job,
  - whether related surfaces/journeys are product-native material actions,
  - whether it is only setup/peripheral/external/unsafe.
- If a `must_test` capability has an unselected material journey, select that journey.
- If a `should_test_or_explain` capability is not selected, preserve it as skipped with a reason and make it report/scoring-visible.

Why:

- This closes the hole where a model can label important product-native scope as `setup` and the run still looks complete.
- Plain skip reasons preserve flexibility without building a large brittle deferral taxonomy.

Verify:

- Unit: a content/search fixture with a product-native history/provenance journey mislabeled as setup is selected or explicitly skipped as important scope.
- Unit: promo/legal/footer surfaces do not become selected merely because they are visible.
- Unit: a canvas/editor fixture still prioritizes material artifact scenarios before setup/help/promo.

### 2. Make Coverage And Confidence Use Skipped Important Scope

Update capability coverage derivation and score authority so the top-level summary cannot hide important skipped capabilities.

Implementation shape:

- Extend `CapabilityCoverageSummary` with counts/lists for:
  - important capabilities covered,
  - important capabilities skipped,
  - must-test skipped,
  - plain-language scope limits.
- Lower confidence/authority when:
  - any `must_test` capability is skipped,
  - multiple `should_test_or_explain` capabilities are skipped,
  - selected scenarios pass but denominator coverage is weak.
- Keep product score separate from evidence confidence; do not automatically punish product quality for Iris scope gaps.

Why:

- This makes "all selected scenarios passed" true but not misleading.

Verify:

- Unit: all goals verified plus one skipped `must_test` capability does not produce high confidence.
- Unit: all goals verified plus a clearly peripheral skipped capability remains high confidence.
- Report JSON test: scope limits are serialized with labels and reasons.

### 3. Redesign The Report Summary Around Reader Questions

Update report HTML/Markdown/JSON so the first viewport answers:

- What did Iris test?
- How many selected scenarios passed?
- How many important product capabilities were covered?
- What important scope was skipped and why?
- How confident is Iris in the evidence?

Implementation shape:

- Replace scenario-count dominance with a compact summary strip:
  - `Scenarios verified`
  - `Important capabilities covered`
  - `Important capabilities skipped`
  - `Confidence`
  - `Scope`
- Keep raw surface/journey ids in details/debug sections.
- Use warning color for skipped important scope; do not use green for partial/skipped states.

Why:

- A skeptical user should not need to read a wall of text to discover that the denominator is incomplete.

Verify:

- HTML snapshot/unit test asserts the top summary contains both selected-scenario pass count and important skipped capability count.
- HTML test asserts skipped scope appears before detailed evidence cards.
- Manual visual audit after e2e confirms the first screen is scannable and not jargon-heavy.

### 4. Replace Fixed Storyboards With Context-Aware Evidence Reels

Update `evidence-clips.ts` so primary evidence is not a uniform six-frame slideshow.

Implementation shape:

- Build a scenario evidence window from trace anchors:
  - include the closest useful before frame,
  - include action-adjacent frames,
  - include result/proof frames,
  - dedupe static adjacent screenshots,
  - bound maximum frames/duration.
- Use variable frame counts and role-sensitive durations.
- Keep adapter raw slicing as a fallback when trace screenshots cannot produce a useful reel.
- Preserve full raw recordings as debug artifacts, not primary report proof.

Why:

- Evidence needs to show the user journey, not just a final screenshot with a play button.

Verify:

- Unit: short evidence with one anchor produces a short before/result reel, not a six-frame padded clip.
- Unit: multi-step evidence produces a longer reel with variable frame count.
- Unit: generated clip durations are not uniformly fixed by a hardcoded six-frame storyboard.
- E2E audit: report videos show meaningful scenario-specific changes.

### 5. Add General Canary Tests

Add tests that encode evaluator principles by product archetype, not by named product.

Canaries:

- Content/search:
  - search/read, article/content navigation, internal or alternate content path, and trust/provenance/reference/history are selected or explicitly scoped.
- Artifact/editor:
  - create, revise/manipulate, style/structure, import/export/share represented as capabilities; selected scenarios include material artifact changes.
- CRUD/workflow:
  - create/update/list/detail or blocked setup is explicit; opening a modal is not enough.
- Dashboard/filtering:
  - filter/sort/drill actions require before/after state proof.
- Commerce/transaction boundary:
  - product select/cart/checkout boundary is tested; payment/auth/external boundary is explicitly scoped.

Why:

- These canaries protect the generic evaluator loop without hardcoding Wikipedia or tldraw.

Verify:

- `pnpm --filter @iris/core test -- discovery`
- `pnpm --filter @iris/core test -- report`
- `pnpm --filter @iris/core test -- evidence-clips`

### 6. Run Full Verification And Fresh E2E

After implementation and unit tests:

- Run full typecheck/build/test.
- Run fresh e2e from scratch on at least two product types:
  - content/search product,
  - artifact/editor product.
- Serve only the current report URLs.
- Manually audit the reports as a skeptical user:
  - scope summary honest,
  - important skips visible,
  - scenarios are material,
  - evidence clips prove scenario arcs,
  - score confidence is not overstated.
- Self-correct and rerun if any gap remains.

Verify:

- `pnpm -r run typecheck`
- `pnpm -r run build`
- `pnpm -r run test -- --pool=forks`
- Fresh e2e run dirs contain report HTML/JSON, raw debug recordings, and primary evidence reels.
- Manual audit notes are appended to `research.md` before marking the goal complete.

## Plan Gate

The project instructions require `/codex-gate`, but no Codex MCP/codex-gate tool is exposed in this session after tool discovery. This plan therefore records the missing gate explicitly and substitutes:

- written research and plan artifacts,
- executable canary tests,
- full typecheck/build/test,
- fresh e2e reports,
- skeptical manual audit before completion.

If a Codex gate tool becomes available later in the session, run it before final commit/close.

## Final Verification Log

Timestamp: 2026-05-16 17:31 PDT.

- Implemented the small public scope model: `must_test`, `should_test_or_explain`, `not_normally_tested`.
- Added product-agnostic capability selection expectations, skip reasons, score/confidence effects, and report visibility for important skipped capabilities.
- Updated report UX to make scenario pass rate distinct from important capability coverage and skipped scope.
- Replaced fixed six-frame evidence clips with bounded context-aware reels from scenario trace windows.
- Fixed a validation-discovered evidence reel hang in long scenario frame thinning and added a regression test.
- Added general archetype canaries for content/search, artifact/editor, CRUD/workflow, and commerce/transaction-boundary behavior.
- Fresh e2e:
  - `iris-runs/wikipedia-rootfix-final-20260516-171606`: 5/5 scenarios verified; 8/9 important capabilities covered; 1 important skipped; provisional score.
  - `iris-runs/tldraw-rootfix-final-20260516-170325`: 9/9 scenarios verified; 9/10 important capabilities covered; 1 important skipped; provisional score.
- Manual visual audit passed for the final reports:
  - report header shows `free mode`,
  - no visible `Task G...`, `grounded mode`, or `tested goal` wording,
  - skipped important scope is above the fold and score-relevant,
  - tldraw evidence shows actual artifact creation/edit/export/share paths,
  - clips have variable durations and scenario-specific arcs.
- Verification:
  - `pnpm -r run typecheck`
  - `pnpm -r run build`
  - workspace test run: 73 files passed, 551 tests passed, 1 skipped.

## Continuation: Five-Product Generality Verification

Timestamp: 2026-05-16 17:56 PDT.

The two-product validation is not enough to call Iris a solid general evaluator. The strengthened goal requires at least five distinct real products and skeptical manual report audits.

Verification set:

- Content/search: Wikipedia final run already produced and must remain auditable.
- Artifact/editor: tldraw final run already produced and must remain auditable.
- CRUD/workflow: run TodoMVC from scratch.
- Dashboard/filtering/data grid: run AG Grid example from scratch.
- Commerce/cart/transaction boundary: run Demoblaze from scratch.

Count a product only if:

- selected scenarios map to the learned important-capability denominator,
- important skipped product-native capabilities are visible and confidence/scope-relevant,
- scenario evidence is real product use rather than setup/promo/menu inspection,
- evidence reels are scenario-specific and not uniform fixed/static clips,
- the top report summary separates selected-scenario pass rate from important product-scope coverage.

Verify:

- Fresh `iris eval` run dirs for at least three additional products.
- Manual audit notes appended to `research.md` for all five counted products.
- Any generic gap found in the new product set is fixed, covered by tests where feasible, and rerun.
- `pnpm -r run typecheck`, `pnpm -r run build`, and relevant test suites pass after any code changes.

## Continuation Verification Log

Timestamp: 2026-05-17 04:33 PDT.

Implemented during continuation:

- Discovery now treats contradictory capability metadata as a gap: if the model says a selected capability still needs a deeper/future audit, Iris does not count adjacent selected journeys as proof unless a strongly matching scenario is selected.
- Discovery now closes uncovered must-test capability gaps even when nearby selected journeys share IDs or surfaces.
- CLI summaries now separate `scenario_evidence` from `finding_evidence`; unsupported finding drafts no longer look like missing goal evidence.
- Goal-claim validation can upgrade a partial to verified only when cited outcome evidence satisfies the same product-use/outcome checks used for verified claims.

Fresh or audited product evidence:

- Counted:
  - Wikipedia: `iris-runs/wikipedia-rootfix-final-20260516-171606`.
  - tldraw: `iris-runs/tldraw-rootfix-final-20260516-170325`.
  - TodoMVC: `iris-runs/todomvc-rootfix-5prod-fixed-20260516-174511`.
  - Mortgage Calculator: `iris-runs/mortgagecalc-rootfix-5prod-final-20260517-012840`.
  - Hacker News: `iris-runs/hackernews-rootfix-5prod-final-20260517-041900`.
- Not counted as clean passes:
  - DataTables final attempts exposed developer-doc/data-grid proof weakness.
  - SauceDemo final attempts exposed remaining commerce/auth partial-proof weakness.
  - BMI Calculator exposed a calculator/form classification weakness.

Current confidence:

- The five-product bar is met for breadth and honest reporting across multiple product kinds.
- The ideal-state evaluator is still not uniformly strong on commerce transaction boundaries and developer documentation/data-grid products. These are now explicit remaining capability gaps rather than silent overclaims.

Automated verification:

- Focused changed-path tests passed for Discovery, scenario data, goal-claim validation, report JSON/MD/HTML, evidence clips, scenario gate, and CLI summary.
- `pnpm -r run typecheck` passed.
- `pnpm -r run build` passed.
- `pnpm -r run test -- --pool=forks` passed; each workspace package reported 73 test files passed, 562 tests passed, 1 skipped.

## Continuation: Known Gap Fix And System Audit

Timestamp: 2026-05-17 15:27 PDT.

The five-product breadth bar is met, but three known product-class weaknesses remain and should be fixed before committing the continuation:

- Commerce/auth: standard login and cart proof can remain partial even when the trace contains inventory/cart state evidence.
- Developer-doc/data-grid: developer examples can either overclaim manual/source-code reading or underverify material data-grid interactions.
- Calculator/form: calculator pages with rich educational/result text can be overclassified as content/search instead of form/calculation workflows.

Plan:

1. Tighten the generic product-kind and selection contracts around calculator/form workflows, developer/data-grid examples, and commerce/auth boundaries.
   - Verify: focused Discovery tests prove calculators keep computed-result workflows primary, developer/data-grid manual/source scope is explicit, and commerce/auth selection reaches a meaningful authenticated/cart boundary without requiring payment.
2. Tighten scenario completion and claim validation so abstract auth/cart state is not required as literal copy, but verified status still requires concrete post-action UI state or outcome evidence.
   - Verify: focused CLI gate and goal-claim validator tests cover standard login/cart proof, negative auth path proof, and no false upgrade from action-only evidence.
3. Run the code-health audit round requested by the user with parallel read-only hunters for known gaps, prompt/data-flow brittleness, report/scoring contracts, and test signal.
   - Verify: `audits/2026-05-17-1527/round-1/triage.md` lists each hunter candidate with fixed/deferred/duplicate/invalid/needs-more-evidence status.
4. Run focused changed-path tests, typecheck, build, and full workspace tests.
   - Verify: `pnpm --filter @iris/core ...`, `pnpm --filter @iris/cli ...`, `pnpm -r run typecheck`, `pnpm -r run build`, and `pnpm -r run test -- --pool=forks`.
5. Commit and push only after the worktree is clean except intentionally excluded scratch files.
   - Verify: `pwd && git branch --show-current`, `git status --short --branch`, commit, push, and final status check.

Plan gate note:

- `/codex-gate` remains unavailable in this session after tool discovery. The substitute review path is the requested parallel agent audit plus executable verification.

Implementation update:

- Fixed typed proof extraction for commerce/auth and data-grid strings without site-specific branches.
- Added calculator, data-grid, and developer-documentation product-kind inference plus scaffolds.
- Added probe-result evidence extraction in the CLI gate and core goal validator.
- Made insufficient score authority block `threshold_passed`.
- Logged parallel hunter reports and triage under `audits/2026-05-17-1527/round-1/`.

Verification update:

- Focused core tests passed: scenario data, discovery, goal-claim validator, report JSON.
- Core build passed after product-kind type updates.
- Focused CLI tests passed: scenario completion gate and summary.
- Workspace typecheck, build, and full tests passed.
- Full workspace result: each package reported 73 test files passed, 571 tests passed, 1 skipped.
