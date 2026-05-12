# Iris audit — Phase 12, by-eye review of 5 unseen apps

Reviewed: excalidraw, todomvc, wikipedia, desmos, dillinger. All runs used latest Phase 11 code with no human-written spec.

## Headline numbers

| App | Goals attempted/total | Verified | Findings | Score | Verdict |
|---|---|---|---|---|---|
| excalidraw | 6/12 | 2 | 0 | 7.6 | mostly honest, some real-but-undeservedly-partial |
| todomvc | 4/12 | 1 | 1 fake | 7.4 | mostly honest, 1 agent-perspective fake finding |
| wikipedia | 10/12 | 10 | 0 | 8.4 | likely real, didn't audit every screenshot |
| desmos | 5/12 | 5 | 0 (1 discarded) | 8.0 | verifications real at time of test |
| dillinger | 3/12 | 1 | 2 major + 1 minor | 5.2 | 2 of 3 findings are fakes |

## Class-A divergences (Iris fabricated a failure)

### A1 — TodoMVC F-001 "Toggle checkbox click via ARIA selector times out"
- **Reality:** TodoMVC's toggle checkbox works fine. The agent's `role=checkbox[name="Toggle Todo: …"]` selector hit Playwright's strict-mode-violation (multiple checkboxes match). Agent-perspective failure dressed as a product complaint.
- **Why my filter missed it:** My regex matches `\bselector\s+(failed|timed\s+out|...)` but the title says "selector **times out**" (present tense). Same class.
- **Fix:** Extend regex to catch tense variations + `"X via Y selector"` framing.

### A2 — Dillinger F-001 "15 console errors logged during normal app usage"
- **Reality:** All 15 errors are `Failed to load resource: net::ERR_CONNECTION_CLOSED` — network-resource failures (likely third-party ads/trackers being blocked or unreachable from headless Playwright). NOT `console.error()` calls from Dillinger's own code. The product works fine.
- **Why this slipped through:** Console probe lumps all error-level console messages, including `net::ERR_CONNECTION_CLOSED` resource failures that Chrome auto-logs. These are noise, not bugs.
- **Fix:** Console probe must categorize: `app_error` (console.error / pageerror with stack) vs `resource_error` (net::ERR_…, failed-to-load patterns). Only `app_error` should count toward `console_clean` rubric or feed bug findings. Surface `resource_error` separately if non-zero, with caveat.

### A3 — Dillinger F-004 "Export-as flow gives no visible confirmation"
- **Reality:** Dillinger DOES show two toasts ("Preparing HTML…", "Exported as HTML") in the bottom-right when Export-as-HTML is clicked. Visible in screenshot. (Same finding has appeared in P10, P11, P12 — recurring gap.)
- **Root cause:** Explorer's vision_describe queries after Export click ask about "browser chrome / download bar" instead of sweeping the page for toast notifications. The Judge then quotes the negative vision_describe outputs as confident proof of absence.
- **Fix path:** (a) Explorer prompt should require a full-page vision_describe after action-completion checks, not a region-scoped query for hypothesized chrome. (b) Adapter should expose a `notifications` probe that captures DOM patterns like `[role=alert]`, `[role=status]`, `aria-live`, `.toast`, `.notification`. (c) Judge prompt: "no toast visible" findings require a quoted vision_describe explicitly scoped to the bottom-right or full-page region; absent that scope, mark as untested.

## Class-B divergences (Iris claimed verified on broken/untested)

### B1 — Desmos G1 looked fake at first glance but isn't
- Step-39 screenshot shows no parabola, but step-13 vision_describe explicitly named "Expression slot 1 contains y=x², which renders as a re…". The parabola WAS rendered at the moment of verification, even though it was later deleted to make room for G2.
- **Not a bug, but a report-communication issue:** the per-goal report shows evidence event IDs that, if clickable to screenshots, would let a reader see the moment of verification. If the report doesn't make that easy, readers will eye-audit the LATEST screenshot and think Iris lied.
- **Fix:** Ensure the per-goal evidence chip in the HTML report links to a screenshot taken at or right after the verifying interaction, not just an arbitrary event id.

### B2 — TodoMVC G9 "Item count footer updates" marked partial with "outcome artifact uncited"
- The footer count change IS observed in trace (vision_describe quotes "2 items left"), but the Judge's evidence cites action events instead of the observation. Validator correctly downgraded.
- **Not a Class-B bug.** The validator working as intended. Same pattern as P10 Wikipedia G2.

## Class-C divergences (coverage gap — should have attempted)

### C1 — Single-goal grind on Dillinger (8/12 untested due to budget exhaustion on G1)
- Phase-11-identified bug. The SDK transport's `runAgentSdkExplorer` has a `goalLedger` but no auto-cutover after 1.5× per-goal budget. The Explorer can burn the whole budget on one goal.
- **Fix:** Port `GoalTracker.checkCutover()` logic into `runAgentSdkExplorer`. Track turns-on-current-goal; force-emit `goal_status({status:'partial', auto_cutover:true})` and inject a system reminder when threshold hit.

### C2 — Excalidraw 6/12 attempted (G5/G6/G7 partial, G8-G12 untested)
- Budget actually expanded (60 steps, ~10 per goal). The agent attempted 6 goals — not bad. The "partial" verdicts on G2/G4/G5/G6 reflect vision_describe outputs that didn't quote the user-visible artifact, even though the artifacts were there. This is the same outcome-naming gap from P9.
- **Fix:** Already mitigated by Phase 10 vision_describe region targeting. Could be better — Explorer should sample multiple regions when checking for an artifact.

## Class-D divergences (score/communication)

### D1 — Dillinger threshold_passed=true with score 5.2 and 2 major findings, but coverage 3/12
- The threshold check is too lenient. A product with 75% goals untested AND 2 major findings claiming actual problems should not "pass threshold."
- **Fix:** Threshold should incorporate coverage. Score ≥ threshold AND coverage ≥ 50% AND no unresolved major-severity fake-risk findings.

### D2 — All apps got "threshold_passed: true" despite mixed verdicts
- The default threshold is too low or the pass logic is too loose.
- **Fix:** Pair with D1.

## Prioritized fixes

1. **Console probe categorization (A2)** — split app_error vs resource_error. Stops the "15 console errors" class of fake finding. **Highest leverage, simplest fix.**
2. **Toast/notification detection (A3)** — adapter probe + Explorer prompt change. Closes the recurring Export-confirmation gap and any similar transient-UI case.
3. **Agent-perspective filter extension (A1)** — broaden regex to catch tense variants and "X via Y selector" framing.
4. **SDK per-goal auto-cutover (C1)** — port from GoalTracker. Stops single-goal grinds.
5. **Threshold + coverage gate (D1/D2)** — score and threshold must reflect coverage.

I'll do these in order with self-verification at each step.
