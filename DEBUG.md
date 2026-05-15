# Wikipedia Codex Retest Goal Count Debug

Started: 2026-05-14

## Symptom

The Codex App Server Wikipedia retest reported only one goal, while the historical Claude/SDK Wikipedia audit reported `10/12` attempted goals and `10` verified.

## Observations

- Current retest run directory: `iris-runs/wikipedia-codex-appserver-retest-20260513-221939`.
- Current retest `config.json` has `mode: "targeted"`.
- Current retest `config.json` has `discover: false`.
- Current retest `config.json` has `expand_goals: false`.
- Current retest `config.json` has exactly one `initial_tasks` entry: `Confirm the Wikipedia main page loads, search for OpenAI, and verify the OpenAI article page loads.`
- Current retest trace has zero `discovery` events.
- Current retest report has one spec compliance goal, `G1`, and it is `verified`.
- Earlier Codex App Server Wikipedia run `iris-runs/wikipedia-codex-appserver-20260513-212457` also has `mode: "targeted"`, zero `discovery` events, and one goal.
- `docs/AUDIT.md` says the historical audit runs used latest Phase 11 code with no human-written spec.
- `docs/AUDIT.md` records the historical Wikipedia row as `10/12` attempted, `10` verified, score `8.4`, and `0` findings.
- `packages/cli/src/flags.ts` infers `targeted` mode whenever `--task` or `--tasks` is provided.
- Both Agent SDK and Codex App Server orchestrators only run discovery when `config.discover !== false && !interpreted`.
- Both orchestrators create `interpreted` goals from `initial_tasks` before the discovery check.

## Hypotheses

### H1: The retest command intentionally forced one goal by using `--task` and `--no-discover` (ROOT HYPOTHESIS)

- Supports: current config has `mode: "targeted"`, `discover: false`, one `initial_tasks` entry, and zero discovery trace events.
- Supports: CLI mode inference maps any `--task` to `targeted`.
- Supports: orchestrators create `interpreted` from `initial_tasks` before discovery, so even without `--no-discover`, a `--task` run has goals already and skips discovery.
- Conflicts: none so far.
- Test: run a minimal local mode/discovery decision check using the CLI inference and orchestrator conditions, without making live LLM calls.

### H2: Codex App Server discovery is broken and would not generate 12 goals even in free mode

- Supports: no successful Codex App Server discovery run has been observed yet.
- Conflicts: the one-goal retests never attempted discovery, so they cannot prove discovery is broken.
- Test: run or simulate the discovery decision in free mode; if decision says discovery would run, H2 remains unproven and requires a separate live discovery test.

### H3: The report lost discovered goals after Explorer/Judge, making a 12-goal run look like a one-goal run

- Supports: reports are built after Judge and fallback paths can synthesize goal rows.
- Conflicts: trace has zero `discovery` events and config has one initial task, so there were no discovered goals to lose in this retest.
- Test: inspect trace/config/report consistency. If all three show no discovery and one seed task, reject H3 for the current retest.

### H4: `--no-expand` caused the one-goal result

- Supports: current config has `expand_goals: false`.
- Conflicts: expansion adds opportunistic goals during Explorer; it is not the Phase 10 discovery pass that produced the historical 12 seed goals.
- Test: compare orchestrator discovery condition with expansion setting. If discovery is gated by `!interpreted` and `discover`, not `expand_goals`, reject H4 as the primary cause.

## Experiments

### E1: Reconstruct discovery gate for current and historical-style inputs

Command:

```bash
node - <<'NODE'
const fs = require('fs');
const current = JSON.parse(fs.readFileSync('iris-runs/wikipedia-codex-appserver-retest-20260513-221939/config.json','utf8'));
function inferMode({ tasks = [], tasksPath = false, specPath = false, explicitMode }) {
  if (explicitMode) return explicitMode;
  if (tasks.length > 0 || tasksPath) return 'targeted';
  if (specPath) return 'grounded';
  return 'free';
}
function hasInterpreted(config) {
  return Boolean((config.initial_tasks && config.initial_tasks.length > 0) || config.spec_text || config.spec_path);
}
function wantDiscovery(config) {
  return config.discover !== false && !hasInterpreted(config);
}
const cases = {
  current_retest_config: current,
  same_but_discover_enabled: { ...current, discover: true },
  historical_style_no_task_no_spec: {
    discover: true,
    expand_goals: true,
    initial_tasks: [],
    mode: inferMode({}),
  },
  task_without_no_discover: {
    discover: true,
    initial_tasks: [{ description: 'one task' }],
    mode: inferMode({ tasks: ['one task'] }),
  },
};
for (const [name, config] of Object.entries(cases)) {
  console.log(JSON.stringify({
    name,
    mode: config.mode,
    initial_task_count: config.initial_tasks?.length ?? 0,
    discover: config.discover,
    has_interpreted_before_discovery: hasInterpreted(config),
    want_discovery: wantDiscovery(config),
  }));
}
NODE
```

Result:

```json
{"name":"current_retest_config","mode":"targeted","initial_task_count":1,"discover":false,"has_interpreted_before_discovery":true,"want_discovery":false}
{"name":"same_but_discover_enabled","mode":"targeted","initial_task_count":1,"discover":true,"has_interpreted_before_discovery":true,"want_discovery":false}
{"name":"historical_style_no_task_no_spec","mode":"free","initial_task_count":0,"discover":true,"has_interpreted_before_discovery":false,"want_discovery":true}
{"name":"task_without_no_discover","mode":"targeted","initial_task_count":1,"discover":true,"has_interpreted_before_discovery":true,"want_discovery":false}
```

Interpretation:

- Confirms H1. The current retest could not enter discovery.
- Confirms that simply removing `--no-discover` while keeping `--task` would still not be apples-to-apples; `initial_tasks` creates `interpreted` before the discovery gate.
- Rejects H4 as the primary cause. `--no-expand` affects opportunistic Explorer goal additions, not the seed discovery pass.

### E2: Trace/report consistency check

Current and prior Codex App Server Wikipedia runs both have:

- `mode: targeted`
- `discoveryEvents: 0`
- exactly one report goal

Interpretation:

- Rejects H3 for the current retest. The report did not lose discovered goals; no discovery happened.

## Root Cause

The one-goal Wikipedia retest was caused by the benchmark command, not by Explorer discovering too little: `--task` made the run `targeted` with exactly one initial goal, and `--no-discover` disabled the discovery pass that historical Claude/SDK audits used to produce 12 goals.

## Conclusions

- H1 confirmed.
- H3 rejected for the current retest.
- H4 rejected as primary cause.
- H2 remains a separate open question: Codex App Server discovery itself still needs an apples-to-apples free-mode run.

## Fix

No production code fix is needed for the one-goal symptom. The benchmark procedure is wrong for provider comparison.

Correct next retest shape:

```bash
node packages/cli/dist/bin.js eval https://en.wikipedia.org/wiki/Main_Page \
  --transport codex-appserver \
  --rubrics quality \
  --max-steps 60 \
  --steps-per-goal 10 \
  --timeout 900 \
  --no-html \
  --no-clips \
  --out iris-runs/wikipedia-codex-appserver-free-<timestamp> \
  --print-summary
```

Important: do not pass `--task`, `--tasks`, `--no-discover`, or `--no-expand` when comparing against the historical no-spec Wikipedia audit.

## 2026-05-14 Report Discrepancy Debug

### Observations

- Fresh run directory: `iris-runs/wikipedia-codex-appserver-rerun-audit-20260514-141848`.
- The CLI run produced useful Explorer/Judge output but the report had `run.termination: judge_failed` because Judge parsing failed on `discarded_findings` entries that omitted `tentative_event_id`.
- The report says `4 / 7` goals verified after deterministic validation.
- Raw Judge and Explorer both marked G3 verified, but Judge cited `01KRM5RG87DRXMHMXGVVWXKAVGF`, a one-character-invalid copy of actual trace event `01KRM5RG87DRXMHMXGXVVKAVGF`; the validator correctly refused the invalid id, but the user-facing result under-counted a real verified language path.
- G7 stayed partial because the Explorer did not observe store navigation. Manual browser audit showed the Google Play link opens in a new tab. Current `WebLifecycle` keeps returning the original page, so new-tab destinations are invisible to later observations/probes.
- The report finding `Donation banner close is not sticky` is contradicted by the cited post-close observation. Trace events around `01KRM5S0Y172VED60H465XS79A` show a successful close action followed by a homepage observation without the fundraising banner text; the remaining donation text is footer content.
- `ui_state` currently passes selectors to `document.querySelector`, so Playwright selectors such as `button:has-text('Close')` fail the whole probe even though the Explorer/action layer can use them.

### Hypotheses

#### H1: `judge_failed` is stale schema brittleness plus an old run artifact

- Supports: the raw Judge JSON is otherwise usable, and the only parse error was missing `tentative_event_id` in discarded findings.
- Conflicts: none; this was already reproduced and fixed in `JudgeOutputSchema`.
- Test: rebuild and rerun from scratch; report termination should no longer be `judge_failed`.

#### H2: G3 under-count is an evidence-id typo, not a failed product path

- Supports: raw Explorer goal_status points to the correct Japanese outcome event; raw Judge copied a near-identical invalid id.
- Conflicts: accepting typo ids can be dangerous if fuzzy matching is broad.
- Test: add a validator test that only accepts a unique one-edit trace id typo before the relevant goal_status.

#### H3: G7 under-count is active-page tracking, not app-store reachability

- Supports: manual browser audit saw a new Google Play tab; `WebLifecycle` never switches active page on `context.page`.
- Conflicts: the Explorer also tried a wrong Apple selector once, so active-page tracking alone may not fix every future path.
- Test: add a lifecycle regression test where a target=_blank click makes `getPage()` return the new page.

#### H4: false banner finding is caused by observation-length-only backing

- Supports: `eventBackingVerdict` treats any observation longer than 20 chars as backing for any finding; the cited observation actually disproves the persistent-banner claim.
- Conflicts: deterministic semantic contradiction is hard in the general case.
- Test: add a narrow regression test for persistent dismissal findings where a successful close action is followed by a cited observation with no persistent-surface markers.

#### H5: `ui_state` selector failures are a selector-dialect mismatch

- Supports: Explorer used Playwright selectors; `ui_state` uses CSS `querySelector`.
- Conflicts: none; the code path is direct.
- Test: add an adapter test where `ui_state` accepts `button:has-text("Close")`.

### Experiments

- E1: Added a Judge schema regression for discarded findings without `tentative_event_id`; focused Judge tests passed.
- E2: Added goal-claim validation coverage for a unique stable-prefix trace-id typo; focused goal validation tests passed.
- E3: Added evidence validation coverage for a false persistent-dismissal finding contradicted by a post-close observation; focused evidence validation tests passed.
- E4: Added `ui_state` coverage for Playwright selector syntax; adapter tests passed.
- E5: Added lifecycle coverage for newly opened pages becoming active; adapter tests passed.
- E6: Ran a rebuilt clean Wikipedia run at `iris-runs/wikipedia-codex-appserver-fixed-rerun-20260514-144038`; result was `termination=done`, `7/7` verified, and the app-download Google Play destination was captured.
- E7: The fixed run still surfaced machine-only console/axe probe findings as product findings. Added validation to discard machine-only probe findings with no visible user impact, then reran cleanly at `iris-runs/wikipedia-codex-appserver-final-rerun-20260514-144536`.

### Root Cause

The original report mixed real product evidence with evaluator/tooling artifacts: schema strictness turned a usable Judge result into `judge_failed`, goal validation could not tolerate a uniquely identifiable copied event-id typo, the web adapter did not switch to new tabs, `ui_state` used a narrower selector dialect than Explorer actions, and evidence validation treated machine-only or contradictory observations as product findings.

### Fix

- Normalize discarded Judge findings that omit `tentative_event_id`.
- Resolve unique stable-prefix trace-id typos during goal-claim validation.
- Discard persistent-dismissal findings contradicted by cited post-close observations.
- Discard machine-only axe/console probe findings that have no visible user impact.
- Make `ui_state` use Playwright locators so it supports the same selector dialect as action tools.
- Track newly opened browser pages as the active page.

Final verification run:

- Run: `iris-runs/wikipedia-codex-appserver-final-rerun-20260514-144536`
- Termination: `done`
- Coverage: `6/6` verified
- Findings: `0`
- Discarded diagnostics: `1` machine-only probe finding with no visible user impact
- Caveat: keyboard/focus checks were not directly exercised

## E2E Symptom

After fixing token observability and rerunning targeted Wikipedia with a full `--timeout 900`, Explorer succeeded but Judge failed:

- Run: `iris-runs/wikipedia-codex-appserver-retest-20260513-221939`
- Explorer: `termination=done`, `duration_s=25.762`, `steps=4`, `1/1` goal verified.
- Judge: `codex app-server single-shot timed out after 869s`.
- Trace has 20 events and about `34153` raw trace characters.
- `buildTraceDigest(events)` for that run is only about `3305` characters.
- `buildJudgeUserPrompt(...)` for that run is only about `3672` characters, before the static `JUDGE_SYSTEM`.

## E2E Hypotheses

### H5: Codex App Server discovery is the next blocker

- Supports: no successful free-mode Codex App Server discovery run has been observed.
- Conflicts: the known 900s failure happened after Explorer, in Judge, not discovery.
- Test: run a discovery-only/free-mode short probe or observe a free run until `discovery.json` is written.

### H6: The Judge timeout is caused by the static `JUDGE_SYSTEM` prompt or output contract, not by trace size (ROOT HYPOTHESIS)

- Supports: targeted retest Judge user prompt is only about `3672` chars, yet timed out for `869s`.
- Supports: simple App Server probes complete quickly, so App Server itself is not universally stalled.
- Conflicts: not yet tested with isolated Judge system prompt.
- Test: run three single-shot App Server probes with short timeouts: simple system/simple prompt, Judge system/simple JSON prompt, Judge system/actual targeted Judge prompt.

### H7: The Judge timeout is caused by lack of `outputSchema`

- Supports: `runCodexAppServerSingleShot` accepts `outputSchema`, but the Codex Judge path does not pass one.
- Supports: App Server may behave better with structured output constraints than with a long prose output contract.
- Conflicts: Agent SDK Judge works without explicit `outputSchema`.
- Test: rerun a minimal Judge-style prompt with and without `outputSchema`.

### H8: The App Server single-shot listener misses completion notifications after Explorer

- Supports: Judge times out through `runCodexAppServerSingleShot` after a prior Explorer thread, so a lifecycle/listener issue is possible.
- Conflicts: live micro-probes with the same client model completed; no server process was left running.
- Test: run actual Judge prompt in a fresh App Server process. If it still times out, reject listener-after-Explorer as primary cause.

## E3: Fresh App Server single-shot completion probe

Probe command:

```bash
node - <<'NODE'
# Fresh App Server process; run baseline-simple and Judge prompt matrix.
NODE
```

Result for the first baseline case:

```json
{
  "name": "baseline-simple",
  "ok": false,
  "duration_s": 60.205,
  "error": "timeout after 60s",
  "text_chars": 2,
  "text_head": "ok",
  "notifications": {
    "turn/completed": 1,
    "item/agentMessage/delta": 1,
    "item/completed": 3,
    "thread/tokenUsage/updated": 1
  }
}
```

Interpretation:

- The model completed and returned `ok`.
- App Server emitted `turn/completed`.
- The single-shot waiter still timed out, so the blocker is not model reasoning or Judge prompt size.
- Root cause is the single-shot notification filter: it rejects notifications after `turnId` is known when `params.turnId` is absent. At least one real `turn/completed` notification is thread-scoped rather than turn-scoped.

Conclusion:

- H8 confirmed as the immediate e2e blocker.
- H6/H7 are no longer primary timeout hypotheses; they can still be revisited if Judge JSON parsing fails after the completion listener fix.

## Score Matrix / Frontend Rubric Debug

Updated: 2026-05-14T10:34:00-07:00

### Symptom

The final Wikipedia artifact had many frontend-relevant signals, but the Markdown report did not show a rubric dimension matrix such as `quality.correctness`, `frontend_correctness`, `accessibility`, or `usability`.

### Observation

- `report.json` already carries dimension scores under `scores.profiles.*.dimensions`.
- `report.html` already renders a collapsed rubric breakdown from those dimensions.
- `report.md` only rendered profile totals, so dimensions such as `correctness` were hidden in the primary text artifact.
- The final revalidated Wikipedia report has `scores.overall.weighted_from` listing `quality`, `usability`, `accessibility`, `frontend_correctness`, `coverage`, and `ux_baseline`, but `scores.profiles` only contains `quality`.
- The compact Codex App Server Judge system prompt used a single-profile example with `quality/correctness/completeness/polish` and only weakly asked the Judge to replace those ids with actual rubric profiles.

### Root Cause

There were two separate issues:

1. Markdown report rendering was too shallow. The data model could hold a score matrix, but the most commonly read report only showed profile totals.
2. The Codex App Server Judge prompt over-optimized for brevity and made the single `quality` example too sticky. That let frontend-related profiles be silently omitted.

### Fix

- `report.md` now renders a `Score matrix` table with profile, dimension, score, and rationale.
- Missing profiles listed in `weighted_from` are shown as `missing` rows instead of disappearing.
- The Codex App Server Judge prompt now requires every profile and dimension listed under `RUBRIC PROFILES TO SCORE`.
- Rubric coverage backfill now lives in `@iris/core/judge` as `ensureRubricScoreCoverage`, so SDK, App Server, and the core orchestrator share the same score-completeness contract.
- The helper backfills omitted requested profiles and omitted dimensions with `n/a` scores and confidence caveats, without overwriting any score the Judge actually returned.
- HTML now starts with a compact executive overview, surfaces the score matrix as a first-class section, and collapses the long tested-goal list and recording by default.

### Verification

- `pnpm --filter @iris/core exec vitest run src/report/report-md.test.ts src/report/report-html.test.ts src/discovery/discovery.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/judge/score-coverage.test.ts src/report/report-html.test.ts src/report/report-md.test.ts src/discovery/discovery.test.ts --reporter=dot`
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts src/eval-e2e.test.ts --reporter=dot`
- `pnpm --filter @iris/core run typecheck`
- `pnpm --filter @iris/cli run typecheck`
- `pnpm -r run build`
- Re-rendered `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.md`.
- Re-rendered `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.html`.
- Playwright visual smoke loaded the HTML over a local server and confirmed the top-level layout exposes verdict, score, goals, findings, tokens, findings, and score matrix. The only console error was the expected local-server `/favicon.ico` 404.

## E4: Full free-mode Wikipedia retest after completion-listener fix

Command:

```bash
node packages/cli/dist/bin.js eval https://en.wikipedia.org/wiki/Main_Page \
  --transport codex-appserver \
  --rubrics quality \
  --max-steps 60 \
  --steps-per-goal 10 \
  --timeout 900 \
  --no-html \
  --no-clips \
  --out iris-runs/wikipedia-codex-appserver-free-20260513-225609 \
  --print-summary
```

Observed:

- Discovery succeeded and proposed `10` seed goals.
- Explorer completed with `termination=done`, `43` steps.
- Trace had `10` seed goals: `7` explicitly verified and `3` partial before post-Judge validation.
- Judge no longer timed out, but failed parsing: `Judge returned no JSON object`.
- The captured text began with a valid-looking JSON object but was incomplete at the 500-char error preview:

```text
{"v":1,"findings":[{"id":"F-001","title":"Accessibility violations on the main page",...
```

Additional observation from generated App Server protocol:

- `turn/completed` params include `{ threadId, turn }`.
- `turn.items` includes final `agentMessage` text.
- The single-shot runner resolved on `turn/completed` but did not read the final text from `turn.items`.

### H9: Single-shot captures a partial delta/item instead of the completed turn item

- Supports: full Judge output preview is incomplete, while App Server's completed turn payload is the authoritative final state.
- Supports: the first timeout fix proved completion notifications can have a different shape than the runner assumed.
- Test: fake server emits partial delta/item but full `turn/completed.turn.items` final text. The runner should return the completed turn item.

Conclusion:

- H9 is the next root hypothesis. Patch the single-shot runner to extract the last `agentMessage.text` from `turn/completed.turn.items` before resolving.

## E5: Full free-mode Wikipedia after completed-turn text capture

Command:

```bash
node packages/cli/dist/bin.js eval https://en.wikipedia.org/wiki/Main_Page \
  --transport codex-appserver \
  --rubrics quality \
  --max-steps 60 \
  --steps-per-goal 10 \
  --timeout 900 \
  --no-html \
  --no-clips \
  --out iris-runs/wikipedia-codex-appserver-free2-20260513-230324 \
  --print-summary
```

Observed:

- Discovery proposed `9` seed goals.
- Explorer completed with `termination=done`, `45` steps.
- Trace had `6` verified, `2` partial, and `2` untested goals before Judge validation.
- Judge still failed with incomplete JSON at about `1966` output tokens:

```text
{"v":1,"findings":[{"id":"F-001","title":"Axe scan reports accessibility violations on the Wikipedia main page",...
```

Conclusion:

- H9 rejected as sufficient. Reading `turn.completed.turn.items` is still correct, but the final Judge text itself is being truncated/incomplete.
- The next root cause is the Codex App Server Judge output budget: the generic `JUDGE_SYSTEM` encourages too much JSON detail for the practical final-message budget.

### H10: Codex App Server needs a compact Judge output contract

Experiment against the stored free2 trace:

- Generic compact prompt without the exact Iris shape completed but emitted the wrong schema (`v:2`, invalid categories).
- Compact prompt with an explicit exact Iris `JudgeOutput` skeleton completed in `16.48s`.
- Output was `4604` chars / `1595` output tokens.
- `JudgeOutputSchema.safeParse(...)` passed.

Conclusion:

- H10 confirmed. Use a Codex-App-Server-specific compact Judge system prompt with the exact required JSON skeleton and short-string limits.

## 2026-05-14 Key Feature Coverage Debug

### Observations

- The `6/6` final rerun was too homepage-shaped for Wikipedia. It tested search, language links, donation, account links, and footer/sister-project links, but did not reliably seed article-level reading/navigation/history/edit goals.
- The web discovery survey only captured the landing page, menu peeks, banner state, and scroll samples. It did not follow the primary search journey into an article page, so article controls were absent from the discovery prompt.
- After adding a primary-search survey path, the first rerun still did not surface article controls in Discovery because the landing-page summary consumed the bounded survey prompt window before `after primary search journey` appeared.
- Reordering the survey sections put the downstream article first. The next run produced goals for article reading, article section navigation, language switching, history/edit affordances, account actions, and footer/sister-project links.
- That run had `6/7` verified. The missing goal (`G5`) cited a `ui_state` probe after clicking an article section link; the trace showed `hash: "#Services"` and scroll `y: 9490`, but the web outcome contract did not treat `ui_state` probe results as citable outcome evidence.

### Hypotheses

#### H1: Discovery lacks a downstream journey, so it cannot seed article-level goals

- Supports: survey code only inspected the starting URL and passive homepage state.
- Conflicts: none.
- Test: add a fixture search form and article page; assert `discoverySurvey()` includes the post-search article and its controls.

#### H2: Downstream journey data exists but prompt truncation hides it

- Supports: first deep run's stored survey summary omitted `after primary search journey` within the prompt excerpt.
- Conflicts: none.
- Test: prioritize primary-journey sections ahead of the landing-page viewport and rerun Discovery.

#### H3: Section-navigation proof exists but is rejected by the outcome contract

- Supports: trace event `01KRM94HP328R3SJPRABXJEY41` is a post-click `ui_state` probe with `hash: "#Services"` and `scroll.y: 9490`; the outcome contract only accepted observations, screenshot actions, and vision descriptions.
- Conflicts: none.
- Test: add a contract regression where a post-click `ui_state` probe with hash/scroll/selector state is accepted as outcome evidence.

### Root Cause

Key Wikipedia features were under-tested because Discovery was bounded to the homepage, then because the bounded survey ordering hid the downstream article from the prompt. After Discovery was fixed, the remaining `6/7` mismatch was an outcome-contract gap: product-state probes were not accepted as goal evidence even when they precisely proved article section navigation.

### Fix

- Discovery survey now performs a bounded primary search journey in a disposable browser context and restores the original page afterward.
- Downstream primary-journey sections are prioritized in the survey summary and payload.
- Discovery prompts now tell the model to treat downstream pages as product scope, including article reading, section nav, references, media, related links, language switching, history/edit affordances, and search refinement when visible.
- Web outcome evidence now accepts post-interaction `ui_state` probes with changed hash, scroll position, or matched selectors as citable product-state evidence.
- Discovery normalization now supplements visible high-value article/account surfaces when provider output compresses them away: account entry, article section navigation, and article meta tools.

### Verification

- Focused tests: `pnpm --filter @iris/adapter-web exec vitest run src/contract.test.ts --reporter=dot`
- Focused tests: `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts --reporter=dot`
- Type/build checks: `pnpm --filter @iris/adapter-web run typecheck`, `pnpm --filter @iris/core run typecheck`, `pnpm -r run build`
- Fresh run after supplement: `iris-runs/wikipedia-codex-appserver-keycoverage2-20260514-153030`
- Fresh run result: `10/10` goals verified, score `9`, no findings, no discarded evidence, no goal-claim downgrades.

## E6: Final full free-mode Wikipedia e2e after compact Judge contract

Command:

```bash
node packages/cli/dist/bin.js eval https://en.wikipedia.org/wiki/Main_Page \
  --transport codex-appserver \
  --rubrics quality \
  --max-steps 60 \
  --steps-per-goal 10 \
  --timeout 900 \
  --no-html \
  --no-clips \
  --out iris-runs/wikipedia-codex-appserver-free3-20260513-231307 \
  --print-summary
```

Result:

```json
{
  "score": 8,
  "threshold_passed": true,
  "run_dir": "iris-runs/wikipedia-codex-appserver-free3-20260513-231307",
  "duration_s": 305.531,
  "coverage": { "attempted": 12, "verified": 3, "total": 12 },
  "exit_code": 0
}
```

Observed:

- Discovery proposed `12` seed goals.
- Explorer completed with `termination=done`, `46` action steps.
- Raw Explorer `goal_status` events: `8` verified and `4` partial across `12` goals.
- Final post-Judge/goal-claim report: `3` verified and `9` partial across `12` attempted goals.
- Judge completed with compact JSON and wrote `judge.raw.txt` (`4585` bytes).
- Final token usage:
  - total input `3,151,322`
  - cached input `3,006,848`
  - non-cached input `144,474`
  - output `8,497`
- Provider overhead from `run_end`:
  - dynamic tools `42`
  - dynamic tool schema `10,189` chars
  - observation summaries `114,520` chars
  - dynamic tool calls `61`
  - cached input ratio `0.9716`
  - model continuation estimate `53.41`

Conclusion:

- Codex App Server now works end-to-end on the Wikipedia no-spec canary.
- The initial `3/12` final verified count is not a fair provider-quality conclusion. Follow-up debugging showed the validator downgraded valid evidence because Explorer completed goals out of order and emitted several `goal_status` events later in a batch.

## E7: Why did final verification show only 3/12?

Observation:

- Raw Explorer statuses in `iris-runs/wikipedia-codex-appserver-free3-20260513-231307`: `8` verified, `4` partial.
- Raw compact Judge statuses also marked `8` verified.
- Post-validator report showed only `3` verified.
- Validator downgrade reasons:
  - `G2: no outcome-shaped evidence in goal window`
  - `G4: verified without substantive notes`
  - `G5: no outcome-shaped evidence in goal window`
  - `G7: no outcome-shaped evidence in goal window`
  - `G8: no outcome-shaped evidence in goal window`

Root cause:

- `sliceGoalWindows` assumes goal_status events arrive in the same order goals were exercised.
- The Codex App Server Explorer exercised goals out of order and batched statuses later:
  - `G2` evidence observation was at step 8, but its `goal_status` came after `G4`, `G6`, and `G5` statuses at step 25.
  - `G7`/`G8` evidence observations were at steps 30/32, but their statuses came after `G9`.
- The sequential window for those goals started after the previous status event, excluding the cited observations.

Fix:

- The goal-claim validator now also validates cited observation/screenshot evidence that predates a goal's `goal_status` in the same session, even if the sequential window excluded it due out-of-order status batching.
- The compact Codex App Server Judge prompt now tells the Judge that every verified goal note must be at least 20 characters and name the visible outcome.

Verification:

- `pnpm --filter @iris/core exec vitest run src/judge/goal-claim-validator.test.ts src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/cli exec tsc --noEmit --pretty false` passed.
- Reapplying the fixed validator to the existing `free3` raw Judge output keeps `7` verified and downgrades only `G4` for terse notes. With the prompt fix, a fresh Judge pass should keep `G4` as well if it emits a substantive note, matching the raw `8/12` verified result.

## E8: Why did the first fresh retest show 0/8?

Observation:

- Fresh retest `iris-runs/wikipedia-codex-appserver-validatorfix-20260513-232950` completed end to end with score `7.8`, but the final summary reported `0/8` verified.
- Raw Judge output marked all `8` goals verified.
- The report downgraded every goal with `outcome artifact uncited` or `outcome not confirmed`.
- Raw Judge cited the `goal_status` event ids, while each `goal_status` payload cited the actual observation ids in `evidence_event_ids`.

Root cause:

- The goal-claim validator accepted direct outcome artifact ids, but did not follow the natural `goal_status -> evidence_event_ids` indirection used by the App Server Explorer/Judge loop.

Fix:

- The validator now expands cited `goal_status` refs for the same goal/session into their `evidence_event_ids`, while still requiring an outcome-shaped artifact.
- The compact App Server Judge prompt now asks the Judge to prefer the observation/action ids inside `goal_status.evidence_event_ids`.

Verification:

- Reapplying the fixed validator to `validatorfix-20260513-232950` keeps `8/8` verified with zero downgrades.
- A full fresh end-to-end run `iris-runs/wikipedia-codex-appserver-e2e-fixed-20260513-233339` completed with score `7.0`, threshold passed, `9/9` attempted/verified, `termination=done`, `exit_code=0`.
- Final fixed run usage: total input `1,615,037`, cached input `1,518,208`, non-cached input `96,829`, output `6,464`.
- Explorer overhead in the final fixed run: dynamic tools `42`, schema chars `10,189`, observation summaries `72,000` chars, dynamic tool calls `31`, cached input ratio `0.9732`, model continuation estimate `29.18`.

## E9: Discovery v2, partial retry, and deterministic UI-state probes

Timestamp: 2026-05-14 00:09:01 -0700

Observation:

- The fixed App Server e2e worked, but the benchmark was still vulnerable to two false negatives:
  - partial goals could remain partial even when global budget was still available;
  - state-change goals such as banner dismissal, focus, appearance, and collapsed UI state relied too heavily on text-only observations.
- A separate session suggested Discovery v2: bounded scroll, peek-menu, and dismiss-banner survey in a disposable browser context.

Hypotheses:

- H11: Partial goals are being treated as final too early. Supporting evidence: earlier runs had partial statuses before total step/time budget was exhausted. Test: fake App Server sends `partial`, then verify runner emits `budget_warn` and accepts a second `verified` status.
- H12: Some state changes need deterministic state probes instead of freeform observation text. Supporting evidence: Wikipedia banner/focus state required page class, active element, ARIA, visibility, and scroll proof. Test: add `ui_state` and assert it returns active element plus selected-element visibility/style state.
- H13: Discovery misses or underweights lower-page and hidden interaction surfaces. Supporting evidence: first-viewport discovery can bias toward search/language while Wikipedia has banner, app, sister-project, and footer/legal surfaces. Test: disposable survey scrolls and peeks menus while leaving the primary browser state unchanged.

Root cause:

- The provider was now capable enough for Wikipedia, but Iris still lacked two pieces of evaluator structure: bounded retry for `partial` goals and deterministic survey/state probes for surfaces that are below the fold or stateful without obvious text changes.

Fix:

- Added one partial-retry pass while step/time budget remains for both Codex App Server and Claude Agent SDK runners.
- Added `ui_state` probe for URL/hash/scroll, active element, body class/style, selected element visibility/rect/ARIA/checked/computed style.
- Added optional `TargetAdapter.discoverySurvey()` and implemented a web disposable-context survey with bounded scroll samples, menu peeking, and banner dismissal.
- Fed the survey summary into no-spec Discovery and added a prompt rule against passive baseline goals that do not require user action or a specific state change.

Verification:

- `pnpm --filter @iris/adapter-web exec vitest run src/index.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts src/judge/goal-claim-validator.test.ts src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot` passed.
- `pnpm -r build` passed.

## E10: Final Discovery v2 Wikipedia retest

Command:

```bash
node packages/cli/dist/bin.js eval https://www.wikipedia.org/ --transport codex-appserver --max-steps 80 --steps-per-goal 10 --timeout 900 --out iris-runs/wikipedia-codex-appserver-discoveryv2-final-20260514-000130 --print-summary
```

Result:

```json
{
  "score": 9.1,
  "threshold_passed": true,
  "coverage": { "attempted": 9, "verified": 9, "total": 9 },
  "goal_claim_validation": { "verified_kept": 9, "downgraded": 0 },
  "findings": 0
}
```

Observed:

- Discovery proposed `9` action-oriented goals, informed by the bounded survey.
- Explorer completed with `termination=done`, `29` action steps.
- Explorer verified all `9` goals and used `ui_state` for deterministic page-state evidence during the run.
- Final report kept all `9/9` goal claims with zero validator downgrades.
- Report caveats: one console error from the TrustedScript-blocked axe injection, and no direct mobile-width pass.
- Provider usage in `report.json`:
  - total input `1,895,795`
  - cached input `1,765,504`
  - non-cached input `130,291`
  - output `8,992`
  - Explorer total input `1,815,352`, cached `1,760,640`, non-cached `54,712`, output `5,476`
  - Explorer overhead: `43` dynamic tools, `10,757` dynamic tool schema chars, `108,000` observation-summary chars, `44` dynamic tool calls, cached-input ratio `0.9699`, continuation estimate `30.23`

Score normalization note:

- Raw `scores.json` and `judge.raw.txt` contained `overall.score: 91`, i.e. a 0-100 shaped score despite the 0-10 contract.
- `report.json` and `report.md` now normalize 0-100 scores to 0-10, clamp to 0..10, and round to two decimals. The regenerated final report shows `9.1`.

Conclusion:

- Codex App Server now works end-to-end for the no-spec Wikipedia benchmark.
- The previous `3/12`, `0/8`, and `8/12` verified results were not evidence that the Codex provider is weak. They were a mix of validator evidence-window artifacts, Judge citation indirection, passive Discovery goals, and missing retry/state-probe structure.
- Compared with the historical Claude/SDK row (`10/12` attempted, `10` verified, score `8.4`, `0` findings), the final Codex App Server run is now competitive on goal verification (`9/9`) and scored higher after normalization (`9.1`), while still carrying higher provider token/latency overhead from repeated App Server continuations.

## E11: Why did Discovery v2 still produce only 9 goals?

Timestamp: 2026-05-14 01:06:51 -0700

Observation:

- The bounded survey exposed more Wikipedia surfaces, but the final e2e run still had only `9` seed goals.
- The Discovery prompt still said repeated peer items should choose a representative item and name the family.
- That rule caused over-grouping:
  - Google Play and Apple App Store collapsed into one app-download goal.
  - Commons/Wikivoyage/Wiktionary collapsed into one sister-project goal.
  - Creative Commons/Terms/Privacy collapsed into one footer/legal goal.

Root cause:

- Discovery v2 improved what the discoverer could see, but the prompt's granularity policy still compressed distinct small-set destinations too aggressively.

Fix:

- Updated the Discovery prompt to make default no-spec discovery breadth-first.
- Small sets of `2-5` distinct destinations must fan out into separate goals.
- High-volume homogeneous peer sets with `6+` similar items should still be represented by `2-3` examples, so the discoverer does not enumerate every language link, sister-project grid item, card, row, or result.
- Added a prompt-boundary regression test that checks the fan-out and numeric guardrail instructions.

Verification:

- `pnpm --filter @iris/core exec vitest run src/discovery/discovery.test.ts --reporter=dot` passed.
- Live bounded Discovery probe after the first fan-out change: `iris-runs/wikipedia-codex-appserver-discovery-fanout-20260514-010000` produced `12` seed goals.
- Live bounded Discovery probe after the numeric guardrail: `iris-runs/wikipedia-codex-appserver-discovery-fanout3-20260514-010520` produced `16` seed goals:
  - search
  - English/Japanese/German/French language editions
  - language selector
  - donation dismiss/donate/already-donated states
  - Google Play and Apple App Store separately
  - two representative sister-project links
  - Creative Commons, Terms, and Privacy separately

Note:

- The live probes used `--max-steps 0` to avoid a full Explorer run. The later Judge phase is not meaningful in that mode; `discovery.json` is the verification artifact.

## E12: Final Wikipedia retests after done/evidence gates

Timestamp: 2026-05-14 01:55:00 -0700

Observation:

- The first 17-goal full retest (`iris-runs/wikipedia-codex-appserver-full16-20260514-0123`) found that Explorer could call `done` while G9 was still partial and G17 was pending. The browser had reached the Creative Commons page, but no G17 `goal_status` was recorded.
- A done-gated retest (`iris-runs/wikipedia-codex-appserver-full17-donegate-20260514-0134`) verified `14/14`, score `9.0`; the `done_rejected` trace event fired and forced two pending expansion goals to be closed before run end.
- A normalized 16-goal retest (`iris-runs/wikipedia-codex-appserver-full16-normalized-20260514-0144`) exposed a second runner issue: after partial retry, Explorer bulk-closed unattempted outbound goals as `partial`/`blocked`, several with no evidence, and the runner accepted them as terminal.

Root cause:

- `done` was treated as an unconditional terminal signal.
- `partial` and `blocked` did not require evidence, so "not reached" could be used to end a goal despite remaining budget.
- Prompt-only Discovery fan-out was nondeterministic; legal/app-store/sister-project small sets could still be grouped in later runs.

Fix:

- Codex App Server and Claude Agent SDK runners now reject `done` while assigned goals are still pending or retryable partial goals remain and budget remains.
- `goal_status: partial` and `goal_status: blocked` now require `evidence_event_ids` showing the incomplete outcome or blocker.
- Discovery now has deterministic small-destination normalization for visible small sets such as Google Play / Apple App Store, Donate now / I already donated, Commons / Wikivoyage / Wiktionary, and Creative Commons / Terms / Privacy.
- Goal-claim validation now accepts a substantive Explorer `goal_status.rationale` as fallback audit notes when the Judge note is terse but evidence is valid.

Final verification:

- `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148`
- Discovery proposed `19` seed goals.
- Explorer ended `done` after `33` steps.
- Raw Judge output marked `19/19` verified.
- Original report showed `18/19` because G16 had terse Judge notes; revalidation with the fixed validator produced `19/19` verified with `0` goal-claim downgrades:
  - `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.json`
  - score `8.0`, threshold passed
  - findings: `1` major a11y finding from axe (`select-name` on `#languages-dropdown`)
  - total input `2,492,208`, cached `2,343,808`, non-cached `148,400`, output `8,803`

Local verification:

- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/core exec vitest run src/judge/goal-claim-validator.test.ts src/discovery/discovery.test.ts --reporter=dot` passed.
- `pnpm --filter @iris/cli run typecheck` passed.
- `pnpm --filter @iris/core run typecheck` passed.
- `pnpm -r run build` passed.
- `git diff --check` passed.

## E13: Report visual evidence was misleading

Timestamp: 2026-05-14 11:40:00 -0700

Observation:

- The revalidated Wikipedia report showed an `8.0/10` score even though only the `quality` rubric profile was present and five requested web profiles were missing.
- The HTML exposed a single raw `.webm` recording as if it were the primary evidence. That recording could show a donation page and make the whole run look like it never exercised Wikipedia.
- Goal screenshots existed on disk, but they were buried in the event trace instead of presented next to the claims they supported.
- The major axe finding had only probe evidence and no visual frame, but the report did not call that out.

Root cause:

- Report rendering treated raw browser recordings as first-class evidence, while claim-scoped visual evidence was only implicit in trace events.
- The hero score did not distinguish complete rubric scoring from a partially scored report.
- Missing visual evidence for findings was not surfaced as a report-quality problem.

Fix:

- HTML reports now render a first-class `Visual evidence` section before the score matrix.
- Goal evidence IDs are resolved through `goal_status.evidence_event_ids`, grouped by screenshot, and labelled with the exact goal/finding IDs they support.
- Findings with probe-only evidence now get an explicit `needs better visual evidence` card.
- Raw `.webm` files are listed only in a separate `Raw recordings` section and labelled as unstitched browser-context recordings, not claim-scoped proof.
- Incomplete rubric coverage changes the hero verdict to `Incomplete score report`, shows `Rubric 1/6`, and warns that the overall score is not authoritative.

Verification:

- Regenerated `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.html`.
- Browser smoke at `http://127.0.0.1:8765/report.revalidated.html` showed `Incomplete score report`, `Rubric 1/6`, `Visual evidence`, and `Raw recordings`.
- Browser eval found `15` visual evidence images, `0` broken visual images, and `6` raw recordings.
- Static link check found `32` screenshot references, `6` video references, and `0` missing evidence files.

## E14: Report flow still felt fragmented after first visual evidence fix

Timestamp: 2026-05-14 12:05:00 -0700

Observation:

- The first fix promoted screenshots, but the reader still had to mentally connect findings, goal text, source IDs, screenshots, raw recordings, and the trace.
- Evidence chips still exposed cryptic event-id tails.
- The finding section still felt isolated because the axe finding had no visual context and did not show the failing selector inline.
- Raw recordings were a grid of static-looking videos and the section did not provide a better scan path.
- On mobile, the raw recording stack was very tall and lacked an internal scroll boundary.

Root cause:

- The report was organized around artifact types rather than reader questions.
- The reader needed a flow of: what failed, what evidence supports it, what goals were actually exercised, and where to inspect the journey.

Fix:

- Renamed the visual section to `Evidence review` and turned it into goal/evidence rows: each goal now has status, goal text, result context, screenshot, and a plain `source event` link.
- Findings now render the strongest available context. For probe-only axe findings, the report shows the nearest context screenshot plus the concrete axe rule, impact, selector, HTML snippet, and rule link.
- Evidence chips now use readable labels such as `probe: axe` and `visual: step 9` instead of event-id tails.
- Added a `Run walkthrough` screenshot storyboard before recordings. It is horizontally scrollable and intended as the main scan path for the journey.
- Changed raw videos to `Debug recordings`, removed misleading seek-to-action controls that only targeted the first raw video, and put the recordings in a bounded vertical scroll area.

Verification:

- Browser eval after regeneration:
  - hero: `Incomplete score report`
  - finding includes `Machine evidence from axe`
  - evidence review has `20` evidence items
  - walkthrough has `32` frames and `overflow-x: auto`
  - raw video pane has `6` videos and `overflow-y: auto`
  - desktop goal evidence renders in two columns
  - scoped evidence images have `0` broken loaded images

## E15: Claim videos were still raw/static instead of proof clips

Timestamp: 2026-05-14 12:36:52 -0700

Observation:

- The improved report still had no claim-level clips on the historical Wikipedia run; it only had six raw Playwright page recordings.
- Those raw recordings are browser-context files. They can show static waits, redirects, or incidental pages, so they are not acceptable primary proof for a goal/finding claim.
- Goal evidence also had duplicates: several cards repeated the same screenshot/event for paired goals.

Root cause:

- Clip slicing only ran in some provider paths, and the Codex App Server orchestrator did not run it before report generation.
- The clip helper only handled findings, not goal claims.
- The web adapter tried to choose one `.webm` from Playwright's per-page recordings, first by filename and then by largest file. That is still a weak proxy for "the right proof for this claim."
- Report HTML used raw artifact paths in the evidence-review section even when the report was served from the run directory.

Fix:

- Added shared `collectClaimEvidenceArtifacts()` in `@iris/core/report`, used by core, Claude/Agent SDK, and Codex App Server orchestrators.
- The helper now slices both findings and goals, resolves `goal_status.evidence_event_ids`, and expands observation trace events to their `OBS-*` screenshot refs.
- The web adapter now records a screenshot timeline and generates per-claim `.webm` proof clips from neighboring evidence screenshots. Raw Playwright recordings remain debug fallback, not primary report evidence.
- The report dedupes goal evidence cards that share the same screenshot and renders the normalized per-claim clip paths in `Evidence review`.
- Regenerated the historical Wikipedia report with post-hoc claim clips for the existing trace.

Verification:

- Regenerated `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.html`.
- Browser eval found `16` deduped evidence items, `16` claim clips, `6` raw debug videos, and a bounded raw-video pane.
- `ffprobe`/frame-hash samples for `claim-G1.webm` and `claim-F-001.webm` showed ~`4.84s` clips with `4` distinct sampled frames each.
- Focused tests passed:
  - `pnpm --filter @iris/core exec vitest run src/judge/score-coverage.test.ts src/report/evidence-clips.test.ts src/report/report-html.test.ts src/report/report-md.test.ts src/report/report-json.test.ts src/discovery/discovery.test.ts --reporter=dot`
  - `pnpm --filter @iris/adapter-web exec vitest run src/recording/recording.test.ts src/recording/ffmpeg-slice.test.ts --reporter=dot`
  - `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts src/eval-e2e.test.ts --reporter=dot`
- Typechecks/build passed:
  - `pnpm --filter @iris/core run typecheck`
  - `pnpm --filter @iris/adapter-web run typecheck`
  - `pnpm --filter @iris/cli run typecheck`
  - `pnpm -r run build`

## E16: Tested goals and evidence were still separated by report structure

Timestamp: 2026-05-14 12:50:47 -0700

Observation:

- Even after claim clips existed, the report still forced the reader to treat goals and evidence as separate concepts.
- `Evidence review` was too busy because it mixed proof artifacts, goal text, clips, and finding evidence in one visual gallery.
- Finding evidence was duplicated: findings already had inline evidence context, but the evidence section repeated a second finding card.

Root cause:

- The report still reflected internal artifact buckets instead of the reader's task: "what did Iris test, grouped by user surface, and what proof backs each result?"
- The old `Tested goals` details section and newer evidence cards overlapped conceptually.

Fix:

- Replaced the separate tested-goals transcript and evidence gallery with one `Tested goals & evidence` section.
- Goal rows are grouped by product surface: Search & articles, Language editions, Donation flow, Mobile apps, Wikimedia projects, and Policies & licensing for the Wikipedia run.
- Each grouped row shows claim IDs, status, result context, screenshot, source event, and a collapsed `play clip` control.
- Finding evidence stays in the finding itself; the goal/proof section no longer duplicates finding cards.
- Removed stale HTML/CSS for the old goals/evidence-card UI.
- Rewrote `/Users/yuxuan/.agents/skills/codex-gate/SKILL.md` as a concise Codex-native self-review checklist with no nonexistent MCP or second-Codex references.

Verification:

- Regenerated `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.html`.
- Browser eval found headings: `Findings (1)`, `Tested goals & evidence`, `Score matrix`, `Run walkthrough`.
- Browser eval found `6` proof groups, `15` deduped goal-proof rows, `15` goal proof clips, `0` `.goals-section`, `0` old `.evidence-item`, `6` raw debug videos.
- Tests/typechecks/build passed:
  - `pnpm --filter @iris/core exec vitest run src/judge/score-coverage.test.ts src/report/evidence-clips.test.ts src/report/report-html.test.ts src/report/report-md.test.ts src/report/report-json.test.ts src/discovery/discovery.test.ts --reporter=dot`
  - `pnpm --filter @iris/adapter-web exec vitest run src/recording/recording.test.ts src/recording/ffmpeg-slice.test.ts --reporter=dot`
  - `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts src/eval-e2e.test.ts --reporter=dot`
  - `pnpm --filter @iris/core run typecheck`
  - `pnpm --filter @iris/adapter-web run typecheck`
  - `pnpm --filter @iris/cli run typecheck`
  - `pnpm -r run build`
