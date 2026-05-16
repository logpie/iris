# Iris scenario proof validation root fix

## Problem

The 2026-05-16 tldraw `gpt-5.5`/high run created material board content but reported only 4/8 verified goals. The failing reasons show the validator requiring authoring labels like `Milestones:`, `Caption:`, and `Invite context:` as literal UI text.

## Decision

Use `required_outputs` as the primary scenario proof checklist. Treat `test_data` as actor input/context and only fall back to it for older discovery artifacts that do not have `required_outputs`.

This keeps validation generic across product types: Discovery already separates "what to use" from "what proof must show"; Judge validation should honor that separation instead of inferring proof from raw prompt prose.

## Steps

1. Improve scenario visible-data extraction.
   - Add generic role-prefix extraction for content fields such as decision, outcome, caption, annotation, board label, and invite context.
   - Ignore optional upload filename metadata as non-literal proof.
   - Verify: scenario-data tests cover the tldraw-style metadata lines without requiring the prefixes.

2. Update goal claim validation to prefer `required_outputs`.
   - If required outputs contain literal visible tokens, validate those.
   - If required outputs are broad non-text proof descriptions, keep scenario text validation neutral and let action/outcome checks decide.
   - Fall back to `test_data` only when no required-output tokens exist.
   - Verify: goal-claim tests show metadata-heavy `test_data` does not downgrade when required outputs are visible.

3. Revalidate the existing tldraw run.
   - Build the updated packages before using the CLI dist command.
   - Run report revalidation against `iris-runs/tldraw-gpt55-high-20260516-075917`.
   - Verify: G1/G4/G5 become verified; G2 remains partial only if the visible title was actually missing.

## Review note

The configured `/codex-gate` MCP tool is not available in this session, so the mandatory gate cannot be invoked here. I will compensate with focused unit tests plus revalidation of the real trace that exposed the bug.

## Follow-up: optional scenario completion gate

After the validator source-of-truth fix, the remaining risk is Explorer claiming a scenario verified before cited evidence contains the deterministic visible outputs. Add an opt-in `--scenario-gate` argument instead of enabling it globally.

Implementation:

- Build per-goal gate checks from Discovery `product_use_contract.user_jobs[].required_outputs`.
- Gate only literal visible-text outputs; leave broad visual/state proof to screenshots, vision evidence, and the final validator.
- Apply the same gate API to Codex App Server and Agent SDK runners so provider behavior stays compatible.
- Keep the gate off by default; `--scenario-gate` adds a checklist to Explorer context and rejects premature `goal_status(status="verified")` tool calls.

Verify:

- Dry-run `iris eval ... --scenario-gate` must show `"scenario_gate": true`.
- Focused tests cover gate construction, missing-output rejection, visual-only filtering, and prompt rendering.
- Fresh tldraw e2e with `--scenario-gate`, `gpt-5.5`, and high reasoning must still produce real screenshots/clips and material named board scenarios.

## Follow-up: repeated goal-status validation window

The gated tldraw run created and cited real board content, but the first report showed 6/8 goals verified. Inspection showed a validator windowing bug: app-server Explorer can mark a goal partial, continue working, then emit final verified statuses in a batch. `sliceGoalWindows` overwrote the earlier per-goal action window with the later batch window, losing the draw/paste/drag evidence.

Fix:

- Merge per-goal windows across repeated `goal_status` events instead of replacing them.
- Preserve session isolation for parallel traces.

Verify:

- Unit test covers partial-then-verified status windows retaining earlier action evidence.
- Revalidate the completed tldraw trace: goal-claim validation should keep 8/8 verified and report zero deterministic downgrades.
