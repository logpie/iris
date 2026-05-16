# Iris active discovery planner repair

## Current gap

The capability-denominator pass made Iris able to name product abilities and score coverage, but that is still partly retrospective. If Discovery learns that a product has core abilities that are not represented by model-proposed journeys, Iris can still proceed to Explorer and only expose the missing breadth in the final report.

Ideal-state Discovery should use what it learns before execution: learn the product map, derive the denominator, repair the scenario plan, then run Explorer against material user scenarios.

## Plan

1. Add a generic Discovery normalization step that turns uncovered learned abilities into scenario journeys.
   - Use product-kind capability priors plus observed surfaces.
   - Only synthesize core abilities, and visible important abilities when there is surface evidence.
   - Verify: a dashboard/content/editor payload with missing journeys gains material scenario journeys before goals are generated.

2. Keep generated scenarios material and product-kind generic.
   - Reuse the existing materiality scaffold so generated goals ask for a visible artifact, state change, output, or consumed content.
   - Verify: generated goals are not menu/tool checks.

3. Persist capabilities in discovery trace events for every provider path.
   - Add `capabilities` to SDK and Codex App Server discovery event payloads.
   - Verify: source search confirms both provider paths write the same field.

4. Validate with tests and a fresh run artifact.
   - Run focused Discovery/report tests, core and CLI typechecks, then a fresh e2e or dry run as far as local provider state allows.
   - Verify: report/discovery artifacts show scenarios selected from learned abilities before Explorer execution.

