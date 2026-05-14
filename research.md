# Iris Phase 5 — Research

**Date:** 2026-05-10
**Status:** Pre-plan. Awaiting user review and persona pick before drafting plan.

---

## The honest diagnosis: why Iris is currently a toy

Iris produces a polished report from a thin actual investigation. The pipeline runs, the artifacts are well-typed, the rubric math is reproducible — but if I were a real user, the output would not change a decision I was about to make. Specifically:

1. **The Explorer doesn't actually test the app.** On TodoMVC v2 it typed one todo, ran out of turns, and reported. 6 of 7 spec goals never got touched. The Judge correctly flagged them as unverified, but no human would call that "an evaluation."
2. **No regression baseline.** Run Iris on the same app today and tomorrow → two unrelated reports. A real consumer (especially Otto) needs "what got worse since the last build" — that's the load-bearing signal, not a snapshot.
3. **Scores are not comparable across apps or runs.** TodoMVC scoring 5.0 and a SaaS dashboard scoring 4.0 doesn't mean the SaaS is "worse" — it means the rubric averages across what got tested, and what got tested is a function of the Explorer's luck within a fixed turn budget. The number looks authoritative; it isn't.
4. **No detection of "app is fundamentally broken."** If the page returns 500, or never finishes loading, or the React tree crashes after one click, Iris will dutifully call `axe` on the broken page and report "0 a11y violations." A real user notices this in 3 seconds; Iris doesn't notice at all.
5. **Findings can be fabricated.** The Judge reads a text digest of the trace and emits findings. Nothing in the pipeline *enforces* that every finding has a screenshot, console error, DOM snapshot, or network failure backing it. With a flaky Judge prompt, "the modal traps focus" is a sentence the LLM can write whether or not a modal was ever observed.
6. **Flake.** Two back-to-back runs at temperature=0 produced ~10-15% score variance during bench tuning. A user cannot ship based on that.
7. **Descriptive, not prescriptive.** "Found 3 issues" — okay, which one do I fix first, where is it in the code, what should I do? Otto especially needs this: it can build, but only if Iris hands it actionable patches or precise diffs.
8. **Video is unwatchable.** ~90s of cursor blinks per actual action. Will get worse as apps get more complex. Already covered.
9. **No delta-aware testing.** Run on the same app twice, re-test the same flows from scratch. Wasteful in cost and time, and produces no new signal.
10. **Cannot handle real apps' state.** Login, multi-step flows, persisted state across pages, email verification, dialog handling, file upload — the adapter has tools for all of these, but the Explorer has no strategy for *using* them coherently across multiple steps. A signup flow is currently beyond Iris.

The polished memo report makes this worse, not better — it gives the run an authoritative voice it hasn't earned.

---

## Who are the real users, and what do they actually want?

I see four plausible primary personas. They want different things and the right Phase 5 depends on which one we're building for.

### A. Otto (the builder agent loop) — programmatic consumer

**Need:** A *delta signal* on every build. "Build N+1 fixed these 2 things, broke these 3, left the rest unchanged. Confidence: high."

**Cares about:**
- Stable `report.json` schema
- Per-finding evidence chain so Otto can localize the fix
- Regression detection across builds (this is the load-bearing thing)
- Low false-positive rate — false bugs cause Otto to thrash
- Cost per evaluation — Otto evaluates hundreds of builds

**Does NOT care about:** Pretty reports. Video. Memo prose.

### B. A founder/PM running Iris as a pre-ship gate

**Need:** "Should I ship this, yes or no?" with evidence I can show my team.

**Cares about:**
- Pass/fail verdict with a clear threshold
- The 3-5 most important findings, ordered by impact
- Visual evidence (screenshots, video clips per finding) for stakeholder review
- Speed — they're not going to wait 30 minutes
- Don't cry wolf — if Iris blocks ship on a nit they'll stop using it

### C. A QA engineer replacing/augmenting manual smoke tests

**Need:** Reproducible, deterministic regression tests that catch things their Playwright suite misses.

**Cares about:**
- Deterministic runs (same input → same output)
- Coverage report: what did Iris actually exercise?
- Easy to extend with custom rubrics for their app
- Integration with CI: PR-level diffs
- Cost is OK if it replaces manual QA hours

### D. Someone evaluating a competitor / vendor product

**Need:** Black-box quality assessment they can defend to their team.

**Cares about:** Scoring rubric they can argue for, evidence that isn't cherry-picked, comparison across multiple competitor products.

This is probably the lowest-priority persona for v1; mentioned for completeness.

---

## My read on which persona dominates Phase 5

**Otto (A) is the explicit primary consumer per project memory.** The founder/PM (B) is what makes Iris a standalone product. (C) and (D) are downstream.

If we optimize for Otto, the priorities are different from optimizing for the founder. For Otto, the *report* barely matters — `report.json` schema and the delta signal matter. For the founder, the report is the product.

**My recommendation:** Build for Otto first because (a) project memory says so, (b) it forces us to fix the core epistemics (do we actually test the app?), (c) once Otto can rely on the signal, the founder-facing report falls out naturally as a rendering of the same data.

You may want to overrule this — see "Open questions" below.

---

## Gap inventory, ranked by ship-blocker severity

Each is tagged with which persona it primarily serves.

### Tier 0 — Iris isn't an evaluator without these

**G1. The Explorer actually exercises the app** (A, B, C)
Today: picks 1-2 flows, runs out of budget, reports.
Should: cover every spec goal at least once, plus free exploration.
Approach: per-goal budgets + hierarchical exploration (one sub-run per goal subset), as discussed previously. Score should only average over *tested* goals.

**G2. Detect "the app is broken" before scoring it** (A, B, C)
Today: scores a broken page as if it works.
Should: have a fast preflight (page loads → no JS crash on first interaction → key elements present) before running the full rubric. If preflight fails, terminate early with a "blocked" verdict, not a 4.0/10.
Approach: a small "smoke" sub-Explorer that runs first, ~5 turns max, with hard-coded checks. Separate from the rubric scoring loop.

**G3. Evidence-enforced findings** (A, B, C)
Today: Judge can write a finding with no evidence and it still appears.
Should: every finding must cite ≥1 trace event ID, and at least one of {screenshot, console_error, network_failure, axe_violation, dom_snapshot} must back it programmatically. Findings without backing get dropped or moved to "low-confidence."
Approach: post-processing step between Judge output and report generation that validates each finding's evidence chain against the trace. Drop or downgrade unverifiable ones. Cheap, deterministic, high-impact for trust.

### Tier 1 — required for Otto to use it as a feedback signal

**G4. Regression / delta reports across runs** (A, C)
Today: each run is a snapshot.
Should: `iris diff <prev-run> <curr-run>` → "fixed: X, new: Y, persistent: Z." Otto's build loop closes on this, not on raw scores.
Approach: stable finding identity (content-hash on title+location+evidence pattern), then set-difference between two `report.json`s. Score deltas per rubric dimension.

**G5. Flake control** (A, B, C)
Today: 10-15% variance run-to-run.
Should: ≤3% variance OR explicit confidence bands.
Approach: two interventions stacked — (a) seed/replay determinism in the Explorer (cassettes already exist for tests; extend to runs), and (b) Judge ensembling on critical findings (run Judge twice, agree on a finding before emitting).

**G6. Actionable fix suggestions, not just descriptions** (A, B)
Today: "modal traps focus."
Should: "modal traps focus. Likely cause: `dialog` role missing `aria-modal=true` and tabindex trap. Suggested patch: …"
Approach: extend the Judge prompt to emit a `suggested_fix` field per finding, gated by confidence. For Otto, this becomes a tool call that returns a patch. (Higher cost; opt-in flag `--suggest-fixes`.)

### Tier 2 — required to scale to real apps

**G7. Multi-step coherent flows** (B, C)
Today: Explorer turn = one tool call. Stateful flows like signup require ~10 coherent turns and the Explorer loses thread.
Should: explicit "task" abstraction the Explorer plans against, persisting context across turns within one task.
Approach: introduce a per-task scratchpad in the Explorer loop — short text the model maintains describing its current intent and progress. Already half-built via the plan stack; needs to be wired into the SDK transport too.

**G8. Hierarchical exploration for complex apps** (B, C)
Today: one Explorer covers the whole app.
Should: orchestrator fans out sub-runs (one per surface or goal cluster), merges traces, single report.
Approach: previously discussed. Adapter and trace format already support this; needs orchestrator + reporter work.

**G9. Delta-aware re-testing** (A, C)
Today: every run re-tests everything.
Should: skip goals that have been verified within the last N runs unless the underlying surface changed.
Approach: hash the relevant DOM region per goal, compare against a per-target cache. Skip with "carried forward from run X" annotation in the report.

### Tier 3 — quality-of-life, important but not blocking

**G10. Video edit pass** (B)
Trim dead air using existing action markers. Already discussed.

**G11. Calibration across apps** (B)
Today: 5.0 doesn't mean the same thing across apps.
Should: per-rubric anchor examples baked into the prompt, or normalize against a reference distribution.

**G12. CI integration / PR comments** (C)
GitHub Action that runs Iris on every PR, posts findings as a PR comment. Trivial once G4 exists.

---

## What I'd cut from Phase 5

Don't do all 12. Spreading thin across all gaps produces another beautiful-but-thin iteration. Phase 5 should be **3-4 items max**, picked from the top tiers.

**My recommended Phase 5 scope (assuming Otto is the primary consumer):**
1. **G1** — Per-goal budgets + score only over tested goals. Without this, nothing else helps.
2. **G2** — Preflight broken-app detection. Cheap, dramatically improves false-positive rate.
3. **G3** — Evidence-enforced findings. Forces honesty.
4. **G4** — Run-to-run delta. The actual signal Otto needs.

G5/G6 are tempting but I'd defer — better to land 4 things solidly than 6 half-built. G7-G9 are Phase 6 (scaling). G10-G12 are polish.

---

## Open questions for you

These genuinely shape the plan; I don't want to guess wrong.

1. **Primary persona for Phase 5: Otto, or human ship-gate user?** I lean Otto per project memory but you may want to chase the founder use case for adoption reasons.
2. **Is "the app is fundamentally broken → terminate with a special verdict" something you want, or do you want Iris to always produce a score even on a 500 page?** (Affects whether G2 emits a 0/10 or a `blocked` exit code.)
3. **For evidence-enforcement (G3), are you OK with Iris dropping findings the Judge can't back?** This will *reduce* finding count but increase signal. Some users equate finding count with thoroughness.
4. **Delta/regression (G4): scope?** Run-to-run on the same target? Or branch-to-branch (Otto's build N vs N+1)? The latter needs target-identity reasoning.
5. **Budget framing.** Today: one global `--max-steps`. Proposal: `--steps-per-goal` (default ~10) + a small free-exploration budget. Acceptable, or do you prefer keeping a single global cap users can reason about?
6. **Anything in my "Iris is a toy" diagnosis you disagree with?** If the diagnosis is wrong the plan will be wrong.

Once you answer these — even briefly — I'll write `docs/superpowers/specs/2026-05-10-iris-phase-5-design.md` with the scoped design, then the implementation plan after that.

---

# TodoMVC Realistic Demo Vendoring — Research

**Date:** 2026-05-13
**Status:** Scoped implementation note for vendoring a pinned real-product fixture.

## What exists today

- `fixtures/known-bugs/` contains small synthetic static fixtures. `scripts/bench.ts` discovers these fixtures directly from `fixtures/known-bugs/`.
- `fixtures/broken-apps/` contains preflight failure fixtures. `scripts/bench.ts` also discovers these directly.
- `packages/adapter-web/test-fixtures/` is a separate adapter capability fixture family and is not part of `scripts/bench.ts`.
- `docs/dynamic-website-testing.md` recommends one vendored realistic demo served locally because live public demos drift.

## Upstream TodoMVC state

- Source repo: `https://github.com/tastejs/todomvc`.
- Shell network is unavailable in this environment, so upstream metadata and files are read through the GitHub connector.
- The current `master` ref resolves to commit `ff43b02e59dfa604386bb382034b2cd07c2bcd8a` (`Revise README for 2.0.0`, 2026-05-03 UTC).
- The current `gh-pages` ref resolves to commit `983c8382ed28b6bbf1a3c6a49ba4d96400016103` (`V1.4.1`).
- Current upstream no longer exposes `examples/vanillajs/` at those refs. The plain vanilla JS implementation is now present as `examples/javascript-es5/`, with `data-framework="javascript-es5"` and no app build step.

## Constraints

- The new fixture should live under `fixtures/realistic-demos/todomvc-vanilla/`.
- `public/` must be self-contained for a static server rooted at `public/`.
- Do not include TodoMVC CI, lint, package, or test files.
- Preserve upstream behavior; only path changes should be made if required for static serving.
- Keep `scripts/bench.ts` default discovery unchanged so the existing nightly bench cost does not increase.

## Open questions resolved by implementation choice

- Do not vendor current `master` commit `ff43b02e59dfa604386bb382034b2cd07c2bcd8a` for this fixture. Although it is the current branch head, `examples/vanillajs/` is gone there, and the closest no-build replacement (`examples/javascript-es5/`) uses in-memory storage rather than localStorage. That would conflict with the requested clean TodoMVC contract that includes persistence across reload.
- Use `examples/vanillajs/` at commit `25a9e31eb32db752d959df18e4d214295a2875e8` (`Fix vanillajs cypress test run (#1902)`, 2018-07-02 UTC), which is the latest upstream commit found for the requested vanilla fixture path and preserves the localStorage implementation.
- Preserve the upstream `node_modules/...` asset paths inside `public/` rather than rewriting `index.html`; this keeps the app closest to upstream and avoids unnecessary modifications.

---

# TodoMVC E2E Follow-up — Research

**Date:** 2026-05-14
**Status:** Diagnosis before patching remaining TodoMVC eval issues.

## Saved run reviewed

- Run artifact: `/tmp/iris-todomvc-v2/report.json`.
- Headline: score 7.6, threshold passed, 11/11 goals attempted, 0/11 kept verified after goal-claim validation.
- Findings: 1 major and 2 minor, all passed evidence validation.

## Concern 1 — finding legitimacy

- **Axe button-name: keep, major.** The fixture template renders todo delete controls as `<button class="destroy"></button>` with no text or aria label (`public/js/template.js`). The axe probe directly targets that HTML under the `button-name` rule. This is a real accessibility defect. The same axe result also reports unlabeled checkbox controls, but the current finding title emphasizes the button-name violation.
- **Hover-only delete: keep, minor a11y/ux.** `public/node_modules/todomvc-app-css/index.css` sets `.todo-list li .destroy { display: none; }` and only reveals it via `.todo-list li:hover .destroy { display: block; }`. There is no equivalent `:focus-within` or keyboard-visible rule, so keyboard and touch users cannot discover the delete affordance reliably.
- **Resource load errors: keep as minor bug, with caveat.** The saved console probe records two resource 404s but not the URLs. Static source shows `todomvc-common/base.js` requests `learn.json` from the server root, and this vendored `public/` does not include `learn.json`. A second missing resource is likely browser-driven `/favicon.ico`, but the trace does not preserve enough URL data to prove that part from the saved run.

## Concern 2 — all goals downgraded

The initial hypothesis that Explorer cited only action-result ids is incomplete. In this Agent SDK path, `goal_status` currently has no `evidence_event_ids` input at all, so Explorer cannot preserve the post-action observation id when it closes a goal.

There is also a parallel-trace bug. `/tmp/iris-todomvc-v2/trace.jsonl` merges `session-0` and `session-1` by timestamp. `goal-claim-validator.ts` slices a goal window from the previous global `goal_status` to the current one. With parallel sessions, unrelated goal statuses interleave, so a goal's actual post-action observation can sit outside the validator's global window. Example from the saved merged trace:

- G3's real outcome observation is `01KRHVK0K497MHWMYCBS6T900S` (`Buy groceries and milk` displayed).
- G8's `goal_status` lands after that observation and before G3's `goal_status`.
- The validator starts G3's window after G8, sees no successful interaction, and downgrades G3 as `no outcome-shaped evidence in goal window`.

Root fix needs both sides:

- Make `goal_status` carry `evidence_event_ids`, and instruct Explorer to cite post-action observation/screenshot/vision_describe event ids for verified goals.
- Preserve session identity when merging parallel traces and make goal-window slicing session-aware. Otherwise correct evidence ids from one session can still be excluded by another session's interleaved goal status.
- Include `goal_status` evidence ids in the Judge trace digest so the Judge copies the Explorer's validated outcome citations instead of choosing similar-looking observations from another session.

## Concern 3 — TodoMVC meta

The fixture is functionally useful as a reference TodoMVC implementation, but it is not a clean accessibility baseline. The blanket "no major" expectation is too strict because the vendored legacy app has real major-level a11y findings. The meta should instead require the known issues Iris should find and preserve false-positive guards for fabricated CRUD/data-loss/filter/persistence claims.

## Plan

1. Update Explorer/core and Agent SDK `goal_status` contract wording and payloads to include `evidence_event_ids` for verified goals.
   Verify: prompt tests contain `evidence_event_ids`; Judge digest test shows goal_status evidence ids.
2. Make parallel trace merging add `payload.session_id` and make goal-window slicing session-aware.
   Verify: validator unit test covers interleaved parallel sessions.
3. Reconcile TodoMVC `meta.json` with the confirmed issues and teach the bench matcher to honor nested `expected_to_NOT_find.match` patterns.
   Verify: JSON parses and a static matcher check passes against `/tmp/iris-todomvc-v2/report.json`.
4. Run build, CLI typecheck, focused tests, and attempt the TodoMVC eval rerun.
   Verify: report whether local networking permits the live rerun; if not, report the static validation boundary.

## Plan Review

Codex Gate could not be executed because the required `mcp__codex__codex` tool is not available in this session. Fallback is local artifact-backed review plus focused deterministic tests.
