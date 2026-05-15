# Iris Discovery v2 Surface Graph Implementation Plan

**Date:** 2026-05-14
**Status:** Draft implementation plan
**Scope:** Replace the current shallow Discovery summary with a provider-neutral surface graph, journey planner, and reportable coverage chain. This applies to both Claude/Agent SDK and Codex/App Server paths.

## Problem

The current Discovery pipeline is too lossy:

- `packages/adapter-web/src/index.ts` captures a text-heavy bounded survey from one disposable browser context.
- `packages/core/src/discovery/discovery.ts` sends that survey to one model call and accepts a flat `goals` list.
- `packages/core/src/discovery/prompts.ts` contains growing prompt rules and domain heuristics to compensate for missing structure.
- The CLI orchestrators pass only `survey_summary` into Discovery, so both providers inherit the same blind spots.

The latest Wikipedia work made Discovery less first-viewport-blind, but it did not create a real product model. Iris still lacks a durable representation of pages, controls, menus, forms, content areas, prerequisites, and discovered-but-deferred surfaces. That is why goal count keeps oscillating between "too few" and "too broad."

## Design Principle

Discovery should not directly mean "ask for goals." Discovery should mean:

1. Observe and enumerate product surfaces.
2. Rank surfaces by user value and audit risk.
3. Synthesize user journeys from those surfaces.
4. Emit seed goals from the highest-value journeys.
5. Preserve what was discovered, selected, deferred, and later verified.

Goals remain scenario evidence generators. Rubrics remain cross-cutting scoring dimensions. The new surface graph explains where the goals came from.

## Non-Goals

- No unbounded crawl.
- No arbitrary account creation, payment, destructive actions, or external-site deep testing.
- No provider-specific Discovery behavior.
- No score-model rewrite in this phase.
- No replacement of dynamic `propose_goal`; it becomes a structured feedback path, not the main discovery mechanism.

## Proposed Data Model

Add structured v2 fields while preserving the existing v1-compatible `goals` array.

```ts
export interface DiscoverySurface {
  id: string;
  label: string;
  kind:
    | 'page'
    | 'nav'
    | 'form'
    | 'search'
    | 'menu'
    | 'modal'
    | 'banner'
    | 'content'
    | 'table'
    | 'media'
    | 'account'
    | 'settings'
    | 'footer'
    | 'external'
    | 'unknown';
  url: string;
  source: 'initial' | 'scroll' | 'menu_peek' | 'primary_journey' | 'sample_nav';
  value: 'core' | 'important_secondary' | 'peripheral';
  confidence: number;
  evidence: Array<{ ref: string; note: string }>;
  controls?: Array<{ role?: string; tag?: string; name?: string; href?: string }>;
  prerequisites?: string[];
}

export interface DiscoveryJourney {
  id: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  surface_ids: string[];
  user_intent: string;
  suggested_goal: string;
  sample_input?: string;
  expected_evidence: string[];
  risk: 'high' | 'medium' | 'low';
}

export interface DiscoveryCoveragePlan {
  selected_journey_ids: string[];
  deferred_surface_ids: string[];
  rationale: string;
  recommended_steps_per_goal?: number;
  coverage_risk: 'low' | 'medium' | 'high';
}
```

## Implementation Steps

1. Define shared v2 types and schemas.
   - Change `packages/adapter-types/src/index.ts` so `DiscoverySurvey` can carry structured `surfaces`, `captures`, and `links` in `payload` without breaking existing adapters.
   - Change `packages/core/src/discovery/discovery.ts` to parse a v2 Discovery output with `surfaces`, `journeys`, `coverage_plan`, and the existing `goals`.
   - Verify: unit tests accept old v1 Discovery JSON and new v2 JSON; invalid v2 fields fail cleanly without aborting the run.

2. Replace prose-only web survey with a structured surface survey.
   - Refactor `packages/adapter-web/src/index.ts` so `discoverySurvey()` returns a compact summary plus structured payload.
   - Capture stable surface records from initial viewport, bounded scrolls, menu peeks, banner states, and the primary journey.
   - Extract visible controls with accessible names, roles, hrefs, form types, selected state, aria-expanded, and viewport/source metadata.
   - Keep the disposable context and bounded limits.
   - Verify: adapter tests use a fixture with below-fold nav, menu controls, a dismissable banner, search, and footer links; the primary page remains unchanged after the survey.

3. Add limited same-origin sample navigation.
   - In the disposable survey only, follow a small ranked set of same-origin links that look like core product paths: docs/content detail, dashboard section, pricing, account entry, editor/workspace, search result, or product detail.
   - Do not deep-follow external links; classify them as external destinations.
   - Limit to a small cap, likely 3 sample navigations, with timeout and restore-to-origin between samples.
   - Verify: fixture proves sample navigation discovers a second-page form/content surface without visiting external legal/app-store links.

4. Rewrite Discovery prompt around surfaces and journeys.
   - Update `packages/core/src/discovery/prompts.ts` to ask for surface classification, journey synthesis, and value-ranked selected goals.
   - Remove brittle Wikipedia-specific supplemental heuristics once structured surface coverage makes them unnecessary.
   - Keep peripheral grouping rules: footer legal links and app-store links should usually be grouped, sampled, or deferred.
   - Verify: prompt tests assert the model contract includes surface graph, journey plan, deferred surfaces, and no target goal count.

5. Add deterministic post-processing and ranking.
   - Normalize IDs for surfaces, journeys, and goals.
   - Deduplicate by surface identity and user outcome, not by destination keyword only.
   - Enforce that every emitted goal references at least one selected journey or surface.
   - Preserve deferred surfaces in `discovery.json` and trace events.
   - Verify: tests cover under-compression, over-expansion, grouped peripheral destinations, and missing journey references.

6. Wire both provider orchestrators through the same v2 path.
   - Update `packages/cli/src/agent-sdk-orchestrator.ts` and `packages/cli/src/codex-app-server-orchestrator.ts` to pass structured survey payloads into `runDiscovery`.
   - Write `discovery-survey.json` beside `discovery.json` for debuggability.
   - Emit a `discovery` trace event containing selected goals, surfaces, journeys, deferred surfaces, and the compact prompt digest.
   - Verify: fake/smoke tests show both transports write the same artifact shape for the same adapter survey.

7. Feed Discovery context into Explorer.
   - Include selected journeys and deferred surfaces in the grounded Explorer prompt.
   - Teach `propose_goal` to include an optional `surface_id` or `journey_id` when it finds a new or under-covered surface.
   - Keep expansion capped and budgeted.
   - Verify: Explorer tests prove proposed goals can be tied back to surfaces and still respect the expansion cap.

8. Update report output.
   - Update `packages/core/src/report/report-json.ts` to expose Discovery surfaces, selected journeys, deferred surfaces, and coverage risk.
   - Update `packages/core/src/report/report-html.ts` so the reader sees: discovered surface -> selected goal -> evidence -> verdict.
   - Avoid adding another long isolated section. Fold Discovery rationale into the tested-goals/evidence presentation.
   - Verify: report tests check that every displayed goal can show its originating surface/journey and that deferred surfaces are summarized without overwhelming the page.

9. Add regression fixtures and canaries.
   - Add a web fixture under `packages/adapter-web/test-fixtures/sites/survey/` or extend the existing one to cover hidden surfaces, menus, search, banner, footer, and second-page content.
   - Add tests for Discovery prompt/schema behavior in `packages/core/src/discovery/discovery.test.ts`.
   - Keep a live Wikipedia canary as a final manual check, but do not encode live Wikipedia as a deterministic unit test.
   - Verify: fixture tests pass deterministically; live Wikipedia report shows article/content usage, account/language/banner surfaces when discovered, and grouped/deferred peripheral destinations.

## Verification Matrix

- `pnpm --filter @iris/adapter-web exec vitest run src/index.test.ts src/contract.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts src/report/report-json.test.ts src/report/report-html.test.ts --reporter=dot`
- `pnpm --filter @iris/core run typecheck`
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot`
- `pnpm -r run build`
- Live Codex App Server canary against Wikipedia with `--transport codex-appserver`.
- Live Claude/Agent SDK canary against the same target if provider auth and budget permit.

## Success Criteria

- Discovery artifacts explain why each seed goal exists.
- Goals are neither first-viewport compressed nor peripheral-link inflated.
- Reports show a clear chain from surface to goal to evidence.
- Discovered-but-deferred surfaces are visible in the report and JSON.
- Both Codex App Server and Claude/Agent SDK consume the same Discovery output.
- Existing report video/screenshot evidence remains present and scrollable.
- Live Wikipedia no-spec run still completes end to end, with content/article use represented as a first-class journey.

## Risks and Controls

- **Risk: survey mutates target state.** Control: all survey interactions happen in disposable contexts, and tests assert primary context state is unchanged.
- **Risk: too many surfaces increase token cost.** Control: full survey goes to disk, model receives a ranked compact digest with caps.
- **Risk: same-origin sample navigation becomes a crawl.** Control: cap sample pages, forbid recursive sample navigation, and skip external links.
- **Risk: the model emits goals not tied to discovered surfaces.** Control: post-processing rejects or demotes goals without surface/journey references.
- **Risk: report becomes verbose again.** Control: Discovery context is folded into grouped goal/evidence rows, with deferred surfaces summarized.

## Rollout

1. Land v2 behind existing Discovery defaults while keeping v1 JSON compatibility.
2. Run deterministic fixtures and builds.
3. Run one Codex App Server Wikipedia canary.
4. Run one Claude/Agent SDK canary when feasible.
5. Compare reports manually as a real user: do the selected goals represent the product, does the evidence prove real use, and are deferred surfaces understandable?

## Review Status

This is a plan artifact only. No implementation has started from this plan. The Codex MCP plan gate is not available in this session, so the implementation gate will need either a manual review pass or the available local review workflow before coding starts.
