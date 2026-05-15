# Iris Discovery v2 Guardrails Implementation Plan

**Date:** 2026-05-15
**Scope:** Prevent Discovery v2 runs from silently collapsing to flat v1 goal lists when the adapter already produced structured survey surfaces.

## Problem

The Discovery schema, prompts, report renderer, and adapter survey can already represent v2 concepts: surfaces, journeys, and coverage plans. The latest Wikipedia artifacts still showed `goals` without `surfaces`, `journeys`, or `coverage_plan`. That makes the report look v2-aware while the run artifact cannot explain why goals were selected or which discovered surfaces were deferred.

## Decision

Add a deterministic fallback inside core Discovery normalization:

- If the model returns v2 graph fields, preserve and normalize them as today.
- If the model returns only flat goals but the structured survey payload has surfaces, normalize those survey surfaces into Discovery surfaces.
- Synthesize a small journey for each flat goal, attaching it to likely survey surfaces by surface kind/value/name.
- Create a coverage plan from the synthesized journeys and defer peripheral survey surfaces that were not selected.
- Keep legacy v1 behavior unchanged when no structured survey surfaces exist.

This keeps the implementation provider-neutral and avoids importing a separate automation engine.

## Steps

1. Parse survey payload surfaces into Discovery surfaces.
   - Verify: unit test passes a structured survey payload with search, article/content, account, and footer surfaces while the model returns flat goals; output has non-empty `surfaces`.

2. Synthesize journeys for flat model goals when survey surfaces exist.
   - Verify: synthesized journeys reference existing surface ids, selected journey ids are non-empty, and each goal gets a `journey_id` or `surface_ids`.

3. Preserve v1 compatibility.
   - Verify: existing v1 no-survey tests still return `v: 1` and supplement legacy goals as before.

4. Add regression coverage for the Wikipedia-shaped collapse.
   - Verify: a model response with only goals and a Wikipedia-like survey payload cannot produce empty `surfaces`, empty `journeys`, or missing `coverage_plan`.

## Gate

Codex MCP Plan Gate is not available in this session. Fallback review criteria:

- No provider-specific branching.
- No broad report redesign.
- No unbounded goal fan-out.
- Deterministic fallback must be visibly weaker than real model v2 output but better than an unexplained flat artifact.

## Verification

- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts --reporter=dot`
- `pnpm --filter @iris/core run build`

## Outcome

Implemented the fallback in `packages/core/src/discovery/discovery.ts`:

- Structured survey surfaces are parsed into Discovery surfaces when the model returns only flat goals.
- Flat goals synthesize same-count journeys with likely surface references.
- Coverage plans are created from synthesized journeys and defer peripheral unselected survey surfaces.
- Legacy no-survey Discovery remains v1-shaped.

Verification completed:

- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts --reporter=dot`
- `pnpm --filter @iris/core run build`
- Artifact smoke using `iris-runs/discovery-v2-survey-codex-e2e-finalpost-20260514-170653/discovery-survey.json` with a deliberately flat model response produced `v=2`, `21` surfaces, `3` journeys, `3` selected journeys, and non-empty goal refs.
