# TodoMVC E2E Follow-up Plan

**Date:** 2026-05-14
**Status:** Implementation plan after saved-run diagnosis.

## Context

The saved TodoMVC run at `/tmp/iris-todomvc-v2/report.json` passed the score threshold but goal-claim validation downgraded all 11 verified goals. Static fixture review also showed that TodoMVC vanilla is not a clean accessibility baseline: it has real axe and keyboard/touch discoverability issues.

Codex Gate was required by local instructions but could not run because `mcp__codex__codex` is not available in this session.

## Steps

1. **Carry outcome evidence through `goal_status`.**
   - Add `evidence_event_ids` to Explorer `goal_status` contracts.
   - In prompts/tool descriptions, require verified goals to cite post-action observation, screenshot, or vision_describe result ids, not action/action_result/goal_status ids.
   - Include those ids in the Judge trace digest.
   - Verify: focused prompt/digest tests.

2. **Make parallel goal windows session-aware.**
   - Annotate merged parallel trace payloads with `session_id` based on source trace path.
   - Slice goal windows using the goal_status event's `session_id` when available, preserving legacy behavior for old traces without session ids.
   - Verify: validator unit test with interleaved parallel sessions where the old global window would exclude the real outcome observation.

3. **Reconcile TodoMVC meta and matcher behavior.**
   - Remove the blanket no-major expectation.
   - Add expected findings for the confirmed button-name/axe, hover-only delete, and resource-load issues.
   - Preserve false-positive guards for fabricated CRUD/data-loss/filter/persistence defects.
   - Make bench precision checks understand nested `expected_to_NOT_find.match` patterns already used by this meta file.
   - Verify: `meta.json` parses and a static matcher check against the saved report passes.

4. **Validate.**
   - Run `pnpm -r build`.
   - Run `pnpm --filter @iris/cli exec tsc --noEmit --pretty false`.
   - Run focused tests for goal-claim-validator, judge, explorer, and related CLI trace merge/matcher code.
   - Attempt a TodoMVC eval rerun. If local server/network binding is unavailable in the sandbox, report that blocker and the static verification completed.

## Plan Review

`/codex-gate` could not be executed because the Codex MCP tool it requires is unavailable. No adversarial review thread id exists for this plan.
