# Iris agentic discovery capability denominator

## Problem

Iris has improved from surface-click checks to material user scenarios, but the report still lacks a real denominator for product breadth. A mature product can pass the tested scenarios while Iris only sampled part of the product. The system needs to learn and expose product capabilities separately from UI surfaces and scenario goals.

This is a root design change, not a tldraw-specific patch: scenarios are what Iris executes; capabilities are what Iris believes the product can materially do.

## Current architecture

- Discovery emits `product_use_contract`, `surfaces`, `journeys`, `coverage_plan`, and `goals`.
- Discovery normalization already contains artifact-editor capability heuristics for journey synthesis, but those are not persisted as a product denominator.
- The report derives a reader-facing `TestingPlan` from Discovery and Judge goals.
- Evaluation confidence currently depends on goal completion, rubric completeness, and Judge confidence, not product capability coverage.

## Constraints

- Keep existing JSON fields compatible. Add optional fields rather than renaming existing structures.
- Do not make a tldraw-only ruleset. Use product-kind priors plus discovered surfaces/jobs/journeys.
- Keep user-facing report language simple: "product areas" and "covered/not covered", not internal contract jargon.
- `/codex-gate` is not available in this session, so the mandatory gate cannot be invoked. The review trail for this plan is this note plus focused tests and an implementation self-review.

## Plan

1. Add a capability-denominator schema to Discovery.
   - Add `DiscoveryCapability` with id, label, product kind, importance, status, confidence, source, evidence, linked scenarios/journeys/surfaces, reason, and coverage gap.
   - Add optional/default `capabilities` to `DiscoveryOutput`.
   - Verify: a Discovery response with no `capabilities` still parses and normalizes.

2. Synthesize capabilities generically during Discovery normalization.
   - Merge model-provided capabilities, product-kind priors, value-loop/user-job hints, journeys, and discovered surfaces.
   - Use priors for canvas/document/search/content/CRUD/dashboard/commerce/developer products, then mark coverage from selected seed goals and user jobs.
   - Verify: canvas and search/content fixtures produce non-empty, product-relevant capability lists with core and secondary importance.

3. Feed capability gaps into Explorer context.
   - Add a compact "product capability coverage" block to `formatDiscoveryExplorerContext`.
   - Verify: context includes covered and missing material capabilities without exceeding the existing context budget.

4. Add capability coverage to report JSON and score authority.
   - Extract capabilities from discovery trace events.
   - Derive capability coverage counts, core coverage ratio, gaps, and level.
   - Cap score authority when core capability coverage is low, even if all tested scenarios passed.
   - Verify: all-goals-verified plus low core capability coverage becomes provisional/insufficient with an explicit reason.

5. Redesign the report flow around scenario results plus product coverage.
   - Add a compact capability coverage card near the top of the scenario audit.
   - Keep raw discovery/surface inventory collapsed.
   - Verify: generated HTML contains reader-facing capability coverage and no duplicate internal denominator language.

6. Add tests and re-render tldraw.
   - Add discovery tests for canvas and search/content.
   - Add report JSON/evaluation tests for capability authority.
   - Update HTML tests for the visible capability section.
   - Re-render the current tldraw report and inspect the report JSON/HTML for coverage summary.
   - Verify: focused tests, typecheck/build for touched packages, and report regeneration pass.

## Completion audit — 2026-05-16

Objective: make and execute the ideal-state Iris discovery/evaluation plan, verify with actual end-to-end runs, and stop only when the implementation is complete and working as intended.

Prompt-to-artifact checklist:

| Requirement | Evidence so far | Status |
|---|---|---|
| Discovery learns product breadth, not just surfaces/goals | `DiscoveryCapability` schema and generic product-kind capability synthesis in `packages/core/src/discovery/discovery.ts` | Implemented |
| Prompt asks for the capability denominator generically | `DISCOVERY_SYSTEM` includes capability-denominator instructions and JSON field | Implemented |
| Explorer sees capability gaps | `formatDiscoveryExplorerContext` prints product capability coverage | Implemented |
| Report separates scenario pass rate from product breadth | `report.json` includes `evaluation.capability_coverage`; `report.html` renders Product coverage and Product abilities | Implemented |
| Product score authority is capped when breadth is weak | Report/evaluation tests cover all-goals-verified but low core capability coverage -> insufficient | Implemented |
| Unsupported findings are not accepted as product evidence | `evidence-validator.ts` now rejects timing/latency claims without timing evidence | Implemented |
| Generic cross-product coverage | Unit tests cover canvas editor and search/content products | Implemented |
| Actual report UI is inspectable and less jargon-heavy | Re-rendered existing tldraw run and visually inspected screenshot | Verified on re-rendered run |
| Fresh real-product E2E after final code | Not yet run after the final code changes | Missing |

Next action from audit: run a fresh tldraw E2E with Codex App Server (`gpt-5.5`, `high`, scenario gate, clips enabled), inspect the generated report/video evidence, and patch any root issue found by that run. If that passes, run at least one content/search product E2E or explain any external blocker with logs.
