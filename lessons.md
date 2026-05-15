# Lessons

- 2026-05-14: For Iris Codex provider work, do not use `codex exec` as a one-shot fallback. The provider path being evaluated is Codex App Server (`codex app-server`) with long-lived JSON-RPC threads and dynamic tool calls.
- 2026-05-14: When comparing Iris providers against historical unseen-app audits, match the benchmark mode. Do not compare a `--task` targeted smoke with `--no-discover` against a no-spec discovery run that produced a 12-goal audit.
## 2026-05-14 — Do not equate post-validator downgrade counts with provider capability without checking raw statuses

When comparing providers, inspect all three layers before saying one provider is weaker:

- raw Explorer `goal_status` events
- raw Judge output before deterministic validators
- final report after evidence/goal validators

The Wikipedia Codex App Server run initially looked like `3/12` verified, but raw Explorer and raw Judge had `8/12` verified. The low final count was mostly a validator windowing artifact from out-of-order batched `goal_status` events, plus one too-terse Judge note. Always debug that split before making provider-quality claims.

## 2026-05-14 — Treat goal_status evidence ids as pointers during goal validation

For Codex App Server runs, the Judge may cite `goal_status` event ids because the prompt says to use latest goal statuses. Do not downgrade that as uncited evidence until checking whether the cited status belongs to the same goal/session and points to outcome observations through `evidence_event_ids`.

## 2026-05-14 — Discovery goals should be action/state-change shaped

When Discovery proposes passive baseline goals like "confirm the homepage remains readable", treat that as a Discovery bug before blaming the provider. No-spec goals should normally require a user action or a specific visible state change. If a page has below-fold/menu/banner surfaces, use a bounded disposable survey to expose those surfaces and propose concrete goals around them.

## 2026-05-14 — Normalize Judge score scale at report boundary

Even with a 0-10 schema contract, LLM Judges may emit a 0-100 shaped score such as `91`. Preserve raw Judge artifacts, but normalize report-facing scores to the 0-10 contract so CLI summaries and benchmark comparisons do not mislead.

## 2026-05-14 — Discovery v2 goals should be value-ranked, not link-count driven

If Discovery v2 sees below-fold/menu/banner surfaces, inventory them all but do not turn every visible destination into a product goal. Default no-spec Discovery should fan out core product actions and materially different state changes, then group or sample peripheral outbound/footer/legal/app-store/social/sister-project links. A higher goal count is only useful when the goals reflect user-value coverage, not raw link enumeration.

## 2026-05-14 — Do not let terminal meta tools hide unfinished goal work

For Iris Explorer runners, `done` is only valid when assigned goals are actually terminal or budget is exhausted. If pending goals or retryable partial goals remain and there is step/time budget, reject `done` with a concrete pending-goal list.

## 2026-05-14 — Partial and blocked need evidence too

Treat evidence-less `partial` or `blocked` goal statuses as invalid. A goal that was not attempted should stay pending; a true blocker must cite the observation or probe that shows the blocker/incomplete outcome.

## 2026-05-14 — Judge note terseness should not defeat trace-backed verification

If the Judge writes terse notes but the Explorer's `goal_status` has a substantive rationale and valid cited outcome evidence, use the Explorer rationale as audit-note backfill rather than downgrading an otherwise valid verified goal.

## 2026-05-14 — Score matrices must expose missing requested profiles

When a report consumer asks for frontend-related scores, inspect both `scores.overall.weighted_from` and `scores.profiles`. A report that only includes `quality` while the default web rubric requested `usability`, `accessibility`, `frontend_correctness`, `coverage`, and `ux_baseline` is incomplete, even if the overall score looks valid. Render dimension matrices in Markdown and surface omitted requested profiles as `missing` or `n/a` with a caveat instead of silently dropping them.

## 2026-05-14 — Provider fixes should live in shared core when the contract is provider-neutral

If a fix concerns Judge output shape, report schema, rubric coverage, or validation semantics, do not leave it in only the Codex App Server or Agent SDK orchestrator. Put the invariant in `@iris/core` and have both providers call it, then add a focused core test plus at least one provider-path smoke test.

## 2026-05-14 — Raw recordings are not report evidence

Do not present a raw browser `.webm` as the primary proof for an Iris report. Raw recordings are unstitched debug artifacts and can be misleading when they show an incidental page such as a donation flow. First-class report evidence must be claim-scoped: goal/finding ID, screenshot or clip, source event, and a clear missing-evidence state when a claim only has probe/text evidence.

## 2026-05-14 — A high score with missing rubric profiles is a report-quality failure

If `scores.overall.weighted_from` requests profiles that are absent from `scores.profiles`, the report verdict must surface that incompleteness before the numeric score. Show the missing profile count in the hero and label the score as non-authoritative until the rubric coverage is complete.

## 2026-05-14 — Reports should follow reader questions, not artifact buckets

For Iris reports, organize the HTML around the reader's path: what failed, what proof supports it, which goals were exercised, and how to scan the journey. Do not make users match findings to screenshots, goals to event ids, and raw videos to trace rows by hand. Keep opaque IDs behind source links unless the user opens the trace.

## 2026-05-14 — Static-heavy videos need a storyboard scan path

Raw browser recordings often contain waits, redirects, and static pages. Provide a screenshot walkthrough/storyboard before raw videos, and make video panes scrollable and clearly labelled as debug recordings unless they are claim-scoped clips.

## 2026-05-14 — Claim videos must be claim-scoped, not selected raw page recordings

For Iris reports, do not satisfy "video evidence" by choosing a Playwright page recording from `evidence/videos`. Page recordings are debug artifacts and may be static or unrelated to the claim. First-class video proof should be generated per goal/finding from the evidence timeline, embedded next to that claim, and backed by a source event. Keep raw recordings collapsed as debug material.

## 2026-05-14 — Do not split tested goals from their proof

For Iris reports, the reader should not have to reconcile a tested-goals transcript with a separate evidence gallery. Group tested goals and their proof together by user-facing product surface, keep findings evidence inside the finding, and collapse secondary details/clips so the page remains scannable.

## 2026-05-14 — Skills must match the active agent runtime

When a skill is imported from another agent environment, remove unavailable tool references and peer-agent wording before relying on it. A Codex-local skill should describe actions Codex can actually take in this runtime; otherwise final answers will include misleading "tool unavailable" caveats.

## 2026-05-14 — Fold debug artifacts into an audit appendix

For Iris reports, a screenshot storyboard, raw page recordings, and full trace dump are secondary verification/debug aids once claim-scoped goal and finding evidence exists. Keep them behind one audit-trail appendix and show only cited source events inline; do not render long trace rows or raw recordings as competing top-level report sections.

## 2026-05-14 — Do not expose raw axe rule ids as finding titles

When a finding title is generated from an axe rule id such as `select-name`, translate it into a user-readable title using the axe violation help/target. Keep the raw rule id in machine-evidence details, not as the headline a report reader has to interpret.

## 2026-05-14 — Rubric dimension evidence arrays should default empty

Judges may score a dimension as `null` or n/a and omit its `evidence` array even when the prompt asks for `evidence: []`. Treat missing dimension evidence as an empty array during schema parsing; do not fail the whole Judge result after it returned otherwise complete rubric coverage.

## 2026-05-14 — Real-user audit should separate product pain from evaluator artifacts

When a user asks for a third-party product-quality audit, manually re-run representative user flows and compare them against the report before accepting findings. Do not promote low-priority a11y/style nits or evaluator/tool failures as product bugs. If report evidence contradicts a finding, label it as an Iris/report discrepancy even if the numeric score is high.

## 2026-05-14 — Machine-only probes belong in rubrics unless they show user impact

For real-user Iris audits, console-only and axe-only probe outputs should not become top-level product findings unless they connect to visible user harm, blocked flows, crashes, or explicit accessibility scope. Keep them in score dimensions or discarded diagnostics so reports do not read like bikeshedding.

## 2026-05-14 — Verify served report asset URLs, not just artifact files

When regenerating Iris HTML reports, check every rendered `<img src>` and `<video src>` over the same HTTP server users will open. Artifacts may exist on disk while the report still points at repo-root-relative paths like `iris-runs/<run>/evidence/...`, which 404 when `report.html` is served from the run directory. Normalize run-contained artifact paths to `evidence/...` and test with HTTP HEAD/Playwright before sharing the URL.

## 2026-05-14 — Keep only one shared report server alive

When sharing an Iris report over Tailscale, stop stale report servers before giving the user a URL. Multiple live ports serving old run directories make it easy to audit the wrong artifact and misdiagnose fixed regressions. After starting the latest server, run `lsof -nP -iTCP:<ports> -sTCP:LISTEN` and confirm only the intended report port remains.

## 2026-05-14 — Sliced claim clips must be visible, full-width evidence

Do not hide Iris claim clips behind tiny collapsed controls inside flex action rows. A `<details>` summary can measure only the chip width, making the opened video look broken or unscrollable even when the slice exists. Claim clips should be open by default, full-width under the goal/finding row, and wrapped in an explicit scrollable body. Regression checks should verify rendered geometry/open state, not only that video URLs return 200.

## 2026-05-14 — Do not reflexively tell the user they are right

When the user reports a discrepancy, respond with the observed evidence and the fix path, not validation phrasing like "you are right" or "you are right again." The user may be diagnosing from partial or stale artifacts, and reflexive agreement is both ungrounded and patronizing. Say "I reproduced it," "I found a regression," or "this URL is stale" only after checking.
