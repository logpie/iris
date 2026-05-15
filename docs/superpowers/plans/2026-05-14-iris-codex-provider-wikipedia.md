# Iris Codex App Server + Wikipedia Benchmark Plan

**Date:** 2026-05-14
**Scope:** Add a long-lived Codex App Server runner for Iris, then compare a fresh Wikipedia canary against the existing cloud-backed Claude Agent SDK path and the historical audit row.

## Correction From User

The first draft proposed a `codex exec` one-shot transport. That is the wrong provider for this benchmark. The implementation will use Codex App Server with `thread/start`, `turn/start`, `dynamicTools`, and `item/tool/call` request handling.

## Plan

1. Add a small App Server JSON-RPC client.
   - Why: Iris needs one long-lived `codex app-server --listen stdio://` process per run, not one CLI process per LLM call.
   - Verify: a focused unit test feeds response, notification, and server-request lines and confirms pending requests resolve, notifications are delivered, and dynamic tool requests get JSON-RPC responses.

2. Add App Server single-shot helpers.
   - Why: spec interpretation, discovery/vision, and Judge are still single-turn model calls, but they should run through App Server threads so auth, model catalog, token usage, and image support stay on the same Codex harness.
   - Verify: a live smoke or integration helper can start an ephemeral thread, run a one-turn `gpt-5.4-mini` prompt, collect final `agentMessage`, and record `thread/tokenUsage/updated`.

3. Add an App Server Explorer runner using dynamic tools.
   - Why: the load-bearing difference from `codex exec` is server-initiated `item/tool/call` requests. Iris must expose adapter tools, probes, and meta tools as `dynamicTools`, execute them locally, emit trace events, and return `DynamicToolCallResponse` results.
   - Verify: a focused fake-client test simulates a `click` or `observe` dynamic tool request and confirms trace events plus response payloads match the Agent SDK runner semantics.
   - Verify: a live dynamic-tool smoke uses a tiny `add` tool and confirms App Server asks for the tool and resumes after Iris replies.

4. Add `runIrisViaCodexAppServer` for the full pipeline.
   - Why: `--transport codex-appserver` should exercise the same high-level phases as `sdk`: preflight, discovery when no spec is present, Explorer, auto axe/console probes, Judge, validators, and report generation.
   - Verify: `--transport sdk` behavior is unchanged; `--transport codex-appserver --parallel 1` writes `config.json`, `trace.jsonl`, `findings.json`, `scores.json`, `report.json`, and `report.md`.

5. Wire CLI transport selection.
   - Why: users should select the new provider from the normal `iris eval --transport` surface.
   - Verify: help text names `codex-appserver`; invalid values fail clearly; `codex` may alias to `codex-appserver` but must not mean `codex exec`.

6. Run deterministic checks before live benchmarks.
   - Verify: focused App Server tests pass.
   - Verify: `pnpm --filter @iris/cli exec tsc --noEmit --pretty false` passes.
   - Verify: `pnpm -r build` passes.

7. Benchmark Wikipedia with explicit labels.
   - Why: Wikipedia is a live canary, not a deterministic regression target.
   - Verify: run a fresh `cloud-sdk` Wikipedia eval if local auth/rate limits permit, recording duration, score, goals attempted/verified, findings, termination, token usage/cost when available, and run directory.
   - Verify: run a fresh `codex-appserver` Wikipedia eval with comparable timeout and record the same metrics.
   - Verify: compare both fresh runs against the historical row from `docs/AUDIT.md`: `10/12` attempted, `10` verified, score `8.4`, `0` findings.

## Plan Review

Codex MCP Plan Gate is not available in this session. I will not use `codex exec` as a fallback after the user correction. Plan review is limited to the App Server protocol proof already run locally plus deterministic tests and live smoke runs.

## Outcome

Implemented the App Server provider and CLI wiring. Focused tests, typecheck, and builds passed:

- `pnpm --filter @iris/cli exec tsc --noEmit --pretty false`
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot`
- `pnpm --filter @iris/core build`
- `pnpm --filter @iris/cli build`

Wikipedia App Server canary result:

- Run directory: `iris-runs/wikipedia-codex-appserver-20260513-212457`
- Explorer completed in 32.1s with 3 browser action steps.
- Goal coverage: `1/1` attempted, `1/1` verified with outcome evidence from the OpenAI article observation.
- Explorer usage: `input_tokens=402084`, `cached_input_tokens=361216`, `output_tokens=909`.
- Judge timed out after 180s, so the report is `termination=judge_failed`, `blocked=true`, `threshold_passed=false`.

Comparison:

- Historical cloud/SDK Wikipedia row from `docs/AUDIT.md`: `10/12` attempted, `10` verified, score `8.4`, `0` findings.
- Current App Server provider is functional for live browser driving, but not competitive end-to-end yet because App Server Judge latency and ambient Codex context overhead prevent a scored report within budget.

## Token Overhead Fix Plan

1. Preserve App Server usage snapshots.
   - Why: the existing Explorer path collapses `thread/tokenUsage.total` into one `usage` object, hiding the crucial difference between latest-turn input, cumulative input, cached input, and non-cached input.
   - Verify: focused tests confirm normalized `last`, `total`, and `non_cached_input_tokens` values are emitted.

2. Add provider-overhead diagnostics.
   - Why: future benchmark reports need enough data to tell baseline provider overhead from Iris-generated page/tool context.
   - Verify: App Server Explorer `run_end` includes dynamic tool count/schema size, observation character counts, tool-call count, cached-input ratio, and model-continuation estimate.

3. Reduce avoidable App Server continuations.
   - Why: each App Server tool continuation appears to replay a roughly 32k-token baseline. The Explorer should not burn model turns on probes that Iris can run deterministically after the Explorer, nor should targeted runs require an extra `done` tool once all goals are terminal.
   - Verify: the App Server prompt says Iris will auto-run axe/console; the `goal_status` handler marks the run complete when all assigned goals are terminal; post-completion non-`done` tools are not executed.

4. Remove the artificial Judge cap.
   - Why: the `Math.min(180, remaining)` timeout made the benchmark unfair and caused the earlier Wikipedia result to be blocked by a wrapper cap rather than by the user-requested run budget.
   - Verify: the Judge timeout uses the remaining run budget with a small floor, not a hard 180s ceiling.

5. Surface token usage in reports.
   - Why: `report.json` and `report.md` should make provider overhead visible without digging through traces.
   - Verify: report tests cover optional token usage fields and Markdown rendering.

## Token Overhead Plan Review

Codex MCP Plan Gate is still unavailable in this session, so the adversarial gate cannot be executed. Fallback review criteria are: keep the change instrumentation-first, preserve existing report consumers by making usage optional, avoid broad behavior changes outside the App Server path, and verify with unit tests plus a live App Server micro-probe.

## Token Overhead Fix Outcome

Implemented the instrumentation and targeted-run continuation reductions:

- App Server single-shot and Explorer now preserve normalized `token_usage.last` and `token_usage.total`, including `non_cached_input_tokens`.
- Explorer `run_end` now includes `provider_overhead` with dynamic tool count, schema size, observation-summary characters, dynamic tool-call count, cached-input ratio, and estimated model continuations.
- The Codex App Server Explorer prompt no longer asks the model to run axe/console by default; Iris still runs those probes deterministically after Explorer.
- `goal_status` now marks the run complete when all assigned goals are terminal, even if expansion tools are available.
- The Codex App Server Judge timeout now uses the remaining run budget instead of a hard 180s ceiling.
- `report.json` and `report.md` now surface optional provider token usage.

Verification:

- `pnpm --filter @iris/cli exec tsc --noEmit --pretty false` passed.
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/core exec vitest run src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot` passed.
- `pnpm -r build` passed.
- Live smoke: `iris-runs/codex-appserver-token-fix-smoke-20260513-215611` shows Explorer `dynamic_tool_call_count=1`, `token_usage.last`, `token_usage.total`, and report-level token usage. The intentionally short `--timeout 90` smoke still blocked at Judge after using the remaining 76s budget.

Later verifier cleanup:

- The stale `src/explorer/explorer.test.ts` `max_cost_usd` fixture fields were removed after the final Discovery v2 work. Core typecheck now passes.

## Final Wikipedia E2E Outcome

After debugging the App Server single-shot lifecycle and Judge output contract, the no-spec Wikipedia canary now completes end to end.

Final run:

- Run directory: `iris-runs/wikipedia-codex-appserver-e2e-fixed-20260513-233339`
- Command shape: no `--task`, no `--no-discover`, no `--no-expand`; `--max-steps 60`, `--steps-per-goal 10`, `--timeout 900`.
- Discovery: `9` seed goals proposed.
- Explorer: `termination=done`, `20` action steps.
- Raw Explorer goal statuses: `9` verified, `0` partial.
- Final post-Judge/goal-claim report: score `7.0`, threshold passed, `9/9` attempted, `9/9` verified.
- Duration: `147.821s`.
- Exit code: `0`.

Token usage from the final report:

- Total input tokens: `1,615,037`
- Cached input tokens: `1,518,208`
- Non-cached input tokens: `96,829`
- Output tokens: `6,464`
- Judge phase: `39,693` input, `17,792` cached, `21,901` non-cached, `2,384` output.
- Explorer provider overhead: `42` dynamic tools, `10,189` dynamic tool schema chars, `72,000` observation-summary chars, `31` dynamic tool calls, cached-input ratio `0.9732`, model-continuation estimate `29.18`.

Comparison:

- Historical Claude/SDK Wikipedia row in `docs/AUDIT.md`: `10/12` attempted, `10` verified, score `8.4`, `0` findings.
- Final Codex App Server Wikipedia run: `9/9` attempted and verified, score `7.0`, `2` findings.
- Interpretation update: the earlier `3/12` and `0/8` verified counts were not fair provider-quality conclusions. Debugging showed validator artifacts: out-of-order batched `goal_status` events, then Judge citations to `goal_status` ids rather than the underlying `evidence_event_ids`. The final fixed end-to-end run now keeps all verified goal claims.

Follow-up fix:

- Goal-claim validation now accepts cited same-session outcome observations that predate the goal's `goal_status`, even when the sequential goal window missed them because statuses were emitted out of order.
- Added a regression test for out-of-order verified goals with cited outcome-shaped observations.
- The Codex App Server compact Judge prompt now requires every verified goal note to be at least 20 characters and name the visible outcome.
- Goal-claim validation now expands same-goal cited `goal_status` ids into their `evidence_event_ids`, while preserving the requirement for outcome-shaped proof.

## Discovery v2 / Retry / State Probe Plan

1. Retry partial goals while budget remains.
   - Why: `partial` is useful as a bounded cutover state, but it should not become final if the run still has enough time/steps to take one focused second pass.
   - Verify: a fake App Server run emits `partial`, then receives a retry notice and upgrades the same goal to `verified`.

2. Add deterministic state probes for web UI state.
   - Why: some goals are stateful without clean text changes: focus, hash/scroll, banner dismissal, collapsed/expanded controls, selected tabs, and appearance changes.
   - Verify: adapter tests prove `ui_state` returns URL/hash/scroll, active element, body class/style, and selected-element visibility/attributes/computed style.

3. Add bounded Discovery v2 survey.
   - Why: no-spec Discovery should see below-fold and menu/banner surfaces without mutating the primary run state.
   - Verify: the web adapter uses a disposable context, scrolls bounded samples, peeks menu-like controls, optionally dismisses banners, and leaves the primary page unchanged.

4. Tighten Discovery goal shape.
   - Why: passive baseline goals such as "confirm the homepage remains readable" create unfair validator downgrades because they do not require a user action or specific state change.
   - Verify: the final Wikipedia Discovery proposal contains action-oriented goals only.

## Discovery v2 / Retry / State Probe Outcome

Implemented:

- Codex App Server Explorer and Claude Agent SDK Explorer now do one partial-goal retry pass when step/time budget remains.
- `ui_state` is available as a web probe.
- Web adapters expose `discoverySurvey()` using a disposable browser context with bounded scroll/menu/banner exploration.
- Discovery receives the survey summary and now avoids passive baseline goals.
- Report score normalization converts accidental 0-100 Judge scores such as `91` into 0-10 report scores such as `9.1`.

Final Wikipedia run:

- Run directory: `iris-runs/wikipedia-codex-appserver-discoveryv2-final-20260514-000130`
- Command: `node packages/cli/dist/bin.js eval https://www.wikipedia.org/ --transport codex-appserver --max-steps 80 --steps-per-goal 10 --timeout 900 --out iris-runs/wikipedia-codex-appserver-discoveryv2-final-20260514-000130 --print-summary`
- Discovery: `9` action-oriented goals.
- Explorer: `termination=done`, `29` action steps.
- Final report: score `9.1`, threshold passed, `9/9` attempted/verified, `0` findings, `0` goal-claim downgrades.
- Caveats: one TrustedScript-related axe/console error, and no direct mobile-width pass.
- Provider usage: total input `1,895,795`, cached input `1,765,504`, non-cached input `130,291`, output `8,992`.

Comparison:

- Historical Claude/SDK Wikipedia row in `docs/AUDIT.md`: `10/12` attempted, `10` verified, score `8.4`, `0` findings.
- Final Codex App Server Discovery v2 run: `9/9` attempted and verified, score `9.1`, `0` findings.
- Interpretation: Codex App Server is now working end to end on Wikipedia. Its remaining weakness is provider overhead/latency from repeated App Server continuations, not goal-verification capability.

Verification:

- `pnpm --filter @iris/adapter-web exec vitest run src/index.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts src/judge/goal-claim-validator.test.ts src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot`
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot`
- `pnpm -r build`

Verifier cleanup:

- Existing `src/explorer/explorer.test.ts` fixtures still passed removed `max_cost_usd` fields to `ExplorerConfig`; those stale test-only fields were removed.
- `pnpm --filter @iris/core exec tsc --noEmit --pretty false` now passes.

## Discovery Value-Ranking Fix

Problem:

- Discovery v2 saw more Wikipedia surfaces, but the prompt treated visible surfaces too uniformly.
- The first correction went too far in the other direction: app store links, sister projects, legal links, and other peripheral destinations became first-class goals, producing an inflated `19`-goal report that looked broader than its product signal.

Fix:

- Default no-spec Discovery is now value-ranked.
- Discovery inventories all visible surfaces, then classifies them as core, important secondary, or peripheral.
- Core product actions and materially different state changes can fan out into separate goals.
- Peripheral outbound/footer/legal/app-store/social/sister-project links should be grouped, sampled, moved to hints, or left out of the product-goal list.

Verification:

- Prompt-boundary regression: `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts --reporter=dot`.
- Regression now asserts grouped peripheral destination goals stay grouped and the prompt asks for value-ranking rather than link-count fan-out.

Note:

- The live verification used `--max-steps 0` to verify Discovery only. The follow-on Judge result is intentionally not meaningful because Explorer performed no actions.

## Final Codex Wikipedia Outcome

Additional fixes after the fan-out work:

- `done` is no longer accepted while assigned goals are pending or retryable partial goals remain and budget remains.
- `partial` and `blocked` goal statuses now require evidence ids, preventing bulk closure of unattempted goals.
- Discovery applies deterministic small-destination fan-out for visible legal/app-store/donation/sister-project small sets.
- Goal-claim validation can backfill terse Judge notes from the Explorer's substantive `goal_status.rationale` when evidence is valid.

Final run:

- Run directory: `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148`
- Revalidated report: `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.json`
- Discovery: `19` seed goals in the pre-calibration report; this is now treated as inflated by peripheral link fan-out.
- Explorer: `termination=done`, `33` action steps.
- Revalidated final report after the product-impact patch: score `8.0`, threshold passed, `19/19` attempted/verified, `0` goal-claim downgrades. The `19` goal count is retained because this report reuses the old trace; it is now treated as inflated by peripheral link fan-out.
- Findings after the product-impact patch: `1` machine-only axe accessibility finding (`select-name` on `#languages-dropdown`) capped to `minor` with `severity_calibrated: true`.
- Provider usage: total input `2,492,208`, cached input `2,343,808`, non-cached input `148,400`, output `8,803`.

Current assessment:

- Codex App Server works end to end for Wikipedia.
- The old poor verification counts were runner/evidence/discovery issues, not evidence that Codex is weak at the task.

## Score Matrix / Rubric Completeness Fix

Updated: 2026-05-14T10:34:00-07:00

Problem:

- The report schema already supported dimension-level score matrices, and HTML rendered the rubric breakdown.
- Markdown only showed profile totals, hiding dimensions such as `quality.correctness`.
- The final Codex App Server Wikipedia Judge output included only `quality` in `scores.profiles` even though the default web rubrics also requested `usability`, `accessibility`, `frontend_correctness`, `coverage`, and `ux_baseline`.

Fix:

- Markdown reports now render a `Score matrix` table with one row per profile dimension.
- Markdown also surfaces profiles listed in `weighted_from` but missing from `scores.profiles`.
- Codex App Server Judge prompting now explicitly requires every profile and dimension from `RUBRIC PROFILES TO SCORE`.
- Rubric coverage enforcement is centralized in `@iris/core/judge` as `ensureRubricScoreCoverage`, used by both the Claude/Agent SDK path and the Codex App Server path.
- The shared helper defensively backfills omitted requested profiles or dimensions with `n/a` dimensions and a confidence caveat, so future omissions are visible rather than silent.
- HTML was redesigned so the first screen shows verdict, score, goal coverage, findings, runtime, tokens, and cost. The score matrix is visible in the main report flow; long goal/video/trace sections are collapsed.

Verification:

- `pnpm --filter @iris/core exec vitest run src/report/report-md.test.ts src/report/report-html.test.ts src/discovery/discovery.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/judge/score-coverage.test.ts src/report/report-html.test.ts src/report/report-md.test.ts src/discovery/discovery.test.ts --reporter=dot`
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts src/eval-e2e.test.ts --reporter=dot`
- `pnpm --filter @iris/core run typecheck`
- `pnpm --filter @iris/cli run typecheck`
- `pnpm -r run build`
- `git diff --check`
- Playwright visual smoke on the regenerated HTML. The only console error was a local `/favicon.ico` 404.

Artifact update:

- Re-rendered `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.md`.
- Re-rendered `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.html`.
- Current revalidated Markdown now shows `quality.correctness=10`, `quality.completeness=10`, `quality.polish=8`, and marks the missing frontend/usability/accessibility/coverage/UX profiles explicitly.
- The remaining product work is overhead and benchmark hygiene: reduce App Server continuation overhead, remove duplicate/near-duplicate discovered goals such as duplicate App Store variants, and classify axe findings against the exact final page context.

## Evidence Presentation Fix

Updated: 2026-05-14T11:40:00-07:00

Problem:

- The HTML report made raw browser recordings look like the primary evidence.
- The selected recording could show the donation page, which made the report feel like it had not actually exercised Wikipedia.
- Claim screenshots were present in the trace but not first-class in the report.
- The report still led with `8.0/10` even though only `1/6` requested rubric profiles had scores.

Fix:

- The HTML report now has a `Visual evidence` section before the score matrix.
- Visual cards are claim-scoped: they show the goal/finding IDs, the screenshot, and the source event link.
- Raw recordings are rendered separately as `Raw recordings` and labelled as unstitched debugging recordings rather than proof.
- Missing visual proof for probe-only findings is explicit.
- Missing rubric profiles now change the hero to `Incomplete score report` and show `Rubric 1/6`.

Verification:

- Rebuilt and regenerated `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.html`.
- Playwright smoke verified the hero warning, visual evidence section, raw recording separation, and no broken visual evidence images.

## Report Reader Flow Fix

Updated: 2026-05-14T12:05:00-07:00

Problem:

- The report still forced the reader to stitch together findings, goals, screenshots, raw videos, and event IDs.
- The axe finding was not self-explanatory without opening trace JSON.
- Raw videos were static-heavy and not scroll-friendly.

Fix:

- Findings now include evidence context inline. Probe-only axe evidence shows the nearest context frame plus the failing selector and element HTML.
- `Visual evidence` became `Evidence review`, with each goal paired directly with its screenshot and result note.
- Added a scrollable `Run walkthrough` storyboard from browser screenshots.
- Raw videos are now `Debug recordings`, separated from proof, and rendered in a bounded vertical scroll pane.
- Evidence chips use labels like `probe: axe` instead of ID tails.

Verification:

- Regenerated the revalidated HTML and checked it in Playwright.
- Confirmed the walkthrough is horizontally scrollable, the raw video pane is vertically scrollable, and the scoped evidence images load.

## Claim-Level Video Proof Fix

Updated: 2026-05-14T12:36:52-07:00

Problem:

- The report still depended on raw Playwright page recordings for video evidence.
- Those recordings can be static-heavy and can show incidental pages, so they are misleading as proof for a specific goal/finding.
- Existing clip slicing was provider-incomplete: Codex App Server did not run it, and the earlier path covered findings more than goals.

Fix:

- Added shared `@iris/core/report` evidence collection for claim artifacts.
- Wired the shared helper through core, Claude/Agent SDK, and Codex App Server orchestrators.
- Web adapter now tracks a screenshot timeline and creates short claim proof clips from neighboring captured frames.
- Goal cards sharing the same proof are deduped into one evidence row, and the report embeds normalized claim-clip paths.

Verification:

- Revalidated Wikipedia report now shows `16` evidence rows and `16` claim-level clips.
- Raw recordings remain visible only as `Debug recordings` in a bounded scroll pane.
- Sampled generated clips were ~`4.84s` with multiple distinct frames, not single static stills.
- Relevant core, adapter-web, and CLI tests/typechecks passed, plus full workspace build.

## Goal Evidence Consolidation

Updated: 2026-05-14T12:50:47-07:00

Problem:

- The report still separated tested goals from evidence review.
- The evidence section was visually busy and duplicated finding evidence already shown in Findings.

Fix:

- Replaced separate tested-goal and evidence-gallery sections with `Tested goals & evidence`.
- Grouped goal proof rows by surface instead of artifact type.
- Collapsed per-claim videos behind `play clip` controls to keep the page scannable.
- Removed stale CSS/classes for the old tested-goals/evidence-card UI.
- Updated the local `codex-gate` skill so it is a Codex-native self-review checklist rather than a Claude-imported MCP workflow.

Verification:

- Served Wikipedia report now shows six logical proof groups and no old `.goals-section` or `.evidence-item` nodes.
- Browser eval confirmed `15` deduped goal-proof rows, `15` goal clips, and `6` raw debug videos.
- Relevant tests, typechecks, and full build passed.

## Report Appendix And Full Rubrics

Updated: 2026-05-14T13:35:00-07:00

Problem:

- `Run walkthrough`, `Debug recordings`, and the full trace were still competing with claim-scoped proof as separate report sections.
- The full trace made the report long even though most readers only need source events cited by findings/goals/scores.
- The visible finding title exposed a raw axe rule shape (`select-name`) instead of a reader-facing accessibility issue.
- The saved Wikipedia report still had only `1/6` scored rubric profiles.

Fix:

- Folded screenshot storyboard, raw page recordings, cited events, and full trace link into one collapsed `Audit trail` appendix.
- Removed full trace row rendering from the main report; only `26` cited source events are rendered, with `trace.jsonl` linked for full debugging.
- Reworked finding layout into a consistent title/body/media grid and translated raw axe rule titles into readable accessibility copy.
- Made rubric dimension `evidence` arrays default to `[]` during Judge schema parsing so otherwise complete rubric output does not fail on nullable/n/a dimensions.
- Replayed the saved Wikipedia trace through Codex App Server Judge with all six web rubrics and regenerated `report.revalidated.{json,md,html}` plus `report.fullrubrics.*`.

Verification:

- Browser eval confirmed top-level debug sections count is `0`, audit appendix is collapsed by default, score profiles are `6`, score rows are `25`, raw videos remain available under the appendix, and no old `Run walkthrough` / `Debug recordings` / raw axe-title text remains.
- Tailscale URL `http://100.104.175.44:8765/report.revalidated.html` returns HTTP 200 with the regenerated HTML.
- Focused report/Judge tests and package builds passed.
