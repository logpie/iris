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

## 2026-05-14 — Discovery surface counts need an explicit coverage mapping

When Discovery reports more surfaces than journeys or goals, the report must explain the grouping directly: surfaces are inventory, journeys are workflows, and goals are selected test claims. Show `surfaces -> journeys -> goals`, distinguish direct journey surfaces from page-context surfaces, and list deferred surfaces separately. An empty deferred list is misleading if unmapped page containers are not called out as context.

## 2026-05-14 — Repair near-miss trace references before rendering reports

Judge evidence can contain one-character ULID typos. Do not render those as mysterious source ids or unresolved evidence until a deterministic typo resolver has tried to map them to unique trace events. Apply the same resolver to findings, goals, and rubric score evidence so HTML, Markdown, JSON, and validators agree.

## 2026-05-14 — Report UI should not hardcode product-specific analysis

If a report row seems to imply too much, fix the analysis contract first rather than adding one-off HTML warnings for login, checkout, donation, or other domains. The Judge/LLM should preserve the exact claim boundary in goal notes, and the report should generically render goal scope, observed result, journey, and surfaces. UI can improve scanability, but product interpretation belongs in analysis.

## 2026-05-14 — Show Discovery relationships as a map, not separate chip piles

For Discovery v2, a surface inventory plus selected-journey chips is still hard to scan. Prefer a compact coverage map with columns for Journey, Goal checked, and Surfaces covered. Keep full surface inventory collapsible and deferred surfaces separate.

## 2026-05-14 — Failed evaluator probes are not product evidence

When Iris tooling injects probes such as axe and the site blocks them with CSP, classify the resulting console errors as instrumentation noise. The report should mark the affected probe-backed rubric as n/a with a caveat, not as a product console bug and not as a clean axe pass. Re-render commands must apply the same derived caveats as fresh report generation.

## 2026-05-14 — Report metadata belongs in the report, not the chat answer

When asked for key Iris run metadata such as provider, model, reasoning effort, and token usage, surface it in `report.html`/`report.md` where users audit the run. Chat summaries are useful only after the report itself contains the information.

## 2026-05-14 — Product-depth fixes must be generic contracts, not site patches

When Iris under-tests a rich product like a canvas editor, do not patch prompts with a named-site workaround. Discovery should infer the product kind, define the primary value loop, list required user actions, and mark weak evidence that cannot verify the job. Explorer, Judge, validators, and reports should all consume that same product-use contract so the behavior applies across editors, CRUD tools, dashboards, search/content sites, and other app classes.

## 2026-05-15 — Evidence cannot serve contradictory report roles

Do not attach the same Iris video as both verified-goal proof and finding proof. If a finding explains a tested goal, link the finding to that goal row and show the media once in the goal evidence. Claim evidence should be unique, visible, and claim-scoped; raw/debug recordings stay in the audit appendix and should never compete with goal/finding proof.

## 2026-05-15 — Artifact products require artifact-depth evidence

For canvas editors, document editors, builders, design tools, and similar creation products, "opened a menu" or "clicked a tool" is weak evidence unless the user-visible artifact changes. Discovery and Explorer should ask for a minimally meaningful artifact composed of multiple operations when feasible, and reports should make the resulting artifact clip central rather than showing static toolbar/menu footage.

## 2026-05-15 — Never serve validation runs as report-quality evidence

If an Iris run was launched with evidence-saving shortcuts such as `--no-clips`, do not share it as a user-facing report URL. Validation runs can prove code paths, but report-quality runs must have claim-scoped videos/screenshots verified over the same served URL the user will open.

## 2026-05-15 — Skipped goals must mean not applicable

Iris seed goals should not be marked `skipped` because the agent stopped early or claims budget ran out while steps remain. Treat "not attempted", "not exercised", "not tested", and "budget ran out" skipped rationales as invalid runner input; the agent must attempt the goal or mark it partial/blocked with evidence after a real attempt.

## 2026-05-15 — Product score and evaluator confidence are different

When Iris partially proves flows on a mature product, do not let the headline score read like a product-quality downgrade. Separate the Judge's observed product score from Iris's evidence confidence. Partial, untested, probe-blocked, or rubric-missing conditions should make the score provisional or insufficient, with explicit reasons, unless the evidence actually shows product failure.

## 2026-05-15 — Provisional labels are guardrails, not capability fixes

When an Iris run is provisional, audit the partial goals and trace logs for missing generic evaluator capabilities before stopping at report wording. If the product can perform the flow manually but Iris only reached a menu, toolbar, file picker, or download surface, add the missing browser/tool/oracle capability and validator support so future runs gather stronger evidence.

## 2026-05-15 — Product-use contracts are hierarchies, not one journey

Do not render `primary_value_loop` as if it were the whole real-use contract. It is the product promise; value-loop contracts and scenario checks are child structures that must be visible and countable in reports. If they are collapsed under generic artifact text or truncated, users will correctly think Iris discovered only one journey.

## 2026-05-15 — Report language should match the user's mental model

Avoid exposing internal Iris terms like product-use contract, value-loop contract, proof obligation, or weak evidence in the main report flow. Render the public report around user scenarios, user journeys, user actions, and expected results; keep deeper evaluator details behind disclosure rows or in JSON.

## 2026-05-15 — Do not stack overlapping scenario terms in one report section

Avoid layouts that show "user scenarios", "user journeys", and "tested scenarios" as sibling concepts. Pick one hierarchy for the page: primary journey at the top, scenario checklist for what actually ran, and optional area details behind a collapsed disclosure. If two labels sound like synonyms, users will read the structure as broken.

## 2026-05-15 — Do not hide non-primary journey groups

If Iris has one primary focus plus multiple journey groups, the report must not make the singular primary label look like the entire plan. Use "Main user outcome" for the top-line focus, show all journey groups visibly before the scenario checklist, and reserve collapsed disclosures for debug/deferred detail rather than the main coverage structure.

## 2026-05-15 — Keep report concepts canonical for readers

Iris reports should expose product areas and tested tasks as the main hierarchy. Raw goal ids, discovery journeys, surfaces, and repeated low-level checks are implementation details: merge duplicate checks under one task, group evidence by that canonical task, and keep raw ids in details/debug sections only.

## 2026-05-16 — Report evidence order and labels must match reader expectations

When a report has scenario ids like G1-G8, evidence cards must render in scenario order, not alphabetic title order. The public report should call the singular product loop an overall mission and make multiple user journeys/scenarios visible; labels like "Main user outcome", "source event", and repeated status pills make the report look internally inconsistent even when the underlying run is sound.

## 2026-05-16 — Validate scenario proof from required outputs, not input metadata

When Discovery emits both `test_data` and `required_outputs`, treat `required_outputs` as the proof checklist. `test_data` may contain prompt-authored labels, optional filenames, or setup context such as `Milestones:`, `Caption:`, or `Invite context:`; those strings should guide the Explorer but must not become literal screen requirements unless they appear in `required_outputs`.

## 2026-05-16 — Product learning must create concrete user scenarios

Do not treat "material artifact" as a generic after-the-fact requirement. Iris should first learn the product's real jobs, then generate concrete scenario briefs with named content/data, required visible outputs, and a quality bar. Capability checks like "add text", "use shape", or "open export" are only implementation steps; they should not be the primary user-facing scenarios unless the product itself is that narrow.

## 2026-05-16 — Validator proof rules must preserve scenario scope

Goal validation should canonicalize public observation refs like `OBS-000028` back to trace event ids before judging action history. Product value-loop capabilities are broad context, not mandatory steps for every child scenario; validators should require each scenario's own actions and use broad loop text only for materiality context. Scenario data extraction must also keep literal labels such as `Start` from phrases like `Rectangle labeled Start`, instead of requiring the whole object-description phrase as visible text.

## 2026-05-16 — Cursor evidence should look like real user input

Claim-scoped videos should show a recognizable pointer, not an abstract dot. If cursor visualization is needed for headless recordings, use a mouse-shaped overlay with a subtle fading movement trail so reviewers can follow intent without mistaking the overlay for product UI.

## 2026-05-16 — Product breadth needs a separate denominator

Do not infer product quality from a scenario pass rate alone. Iris needs a visible product-ability denominator that is distinct from UI surfaces and tested scenarios, and reports must label surface counts as UI coverage rather than product coverage. Unsupported timing or performance findings also need timing evidence, not just a static observation.
