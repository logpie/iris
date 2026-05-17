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

# Iris Artifact-Centered Product Contract — Research Addendum

**Date:** 2026-05-15
**Status:** Implementation-scoped. User requested a generic fix after the tldraw run showed shallow canvas use being treated as product proof.

## What exists today

- Discovery v2 asks for one `product_use_contract`, surfaces, journeys, a coverage plan, and goals.
- The contract is singular by design and currently stores `primary_value_loop`, `core_artifacts`, and `user_jobs`.
- Coverage selection already prefers selected/core journeys and contract-backed journeys.
- Explorer context already receives the product-use contract and weak-evidence language.
- The deterministic goal-claim validator downgrades verified claims when a goal misses contract `required_actions`, cites only weak evidence, or fails to cite outcome-shaped evidence.

## Gap

The contract is too flat. A product like tldraw can be modeled as one umbrella contract, but "create visible canvas content" is not enough to prove real product use. If Discovery emits only one shallow user job, the validator has little to enforce beyond one or two tool actions.

The generic failure pattern is surface/task compression:

- artifact editors collapse to "draw one thing"
- document editors collapse to "type something"
- dashboards collapse to "open filter"
- content products collapse to "load/search page"

The right invariant is not product-specific feature enumeration. It is artifact/state materiality: core goals must create, change, consume, or export a durable user-visible result with enough capability depth for the product kind.

## Constraints

- Keep backward compatibility with existing reports and tests using `primary_value_loop`, `core_artifacts`, and `user_jobs`.
- Do not make tldraw-specific rules. Product-kind archetypes are acceptable because they are already part of the generic contract.
- Keep discovered surfaces as inventory. They should not directly become goals unless they satisfy a product-use obligation.
- Preserve provider compatibility; the contract is shared between Claude and Codex paths through core discovery and report JSON.

## Implementation direction

- Add a structured `value_loops` layer under the singular product contract.
- Add `proof_obligations` to user jobs so each material journey has explicit acceptance criteria.
- Normalize missing contract detail by synthesizing user jobs from material journeys and enriching shallow jobs with generic product-kind materiality floors.
- Render the report as value loop -> acceptance jobs -> linked goals, not as one paragraph blob.
- Make the goal-claim validator reject verified core artifact-editor claims that cite proof text without satisfying their synthesized materiality requirements.

## Expected behavior after the fix

- A tldraw-like Discovery output with only a single "draw a shape" job should be normalized into a richer artifact value loop and acceptance job obligations.
- Promo/banner/setup journeys should remain deferred.
- A verified canvas/editor goal without drag/create plus text/style/move-like materiality should downgrade to partial.
- Existing content/search contracts should remain valid and not be forced into editor-specific requirements.

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

---

# Iris Codex Provider + Wikipedia Benchmark — Research

**Date:** 2026-05-14
**Status:** Current-state research before adding a Codex transport and comparing runs.

## Request

Run Iris on Wikipedia again and compare the current cloud-backed path against a newly wired Codex provider. If a fresh cloud run is too expensive or blocked, use previous experimental logs as a benchmark.

## What exists today

- `iris eval` exposes `--transport <kind>` with documented values `sdk | api | cli`.
- `sdk` runs the main current path through `@anthropic-ai/claude-agent-sdk` in `packages/cli/src/agent-sdk-runner.ts` and `packages/cli/src/agent-sdk-orchestrator.ts`.
- `api` uses raw Anthropic Messages through `packages/cli/src/llm-factory.ts`.
- `cli` uses local `claude -p` through `packages/cli/src/claude-cli-transport.ts`.
- The `sdk` path is the most feature-complete current path: discovery pass, Agent SDK MCP tool registration, optional parallel Explorer sessions, SDK vision, and a single Judge call.
- The `api` and `cli` paths use the older core `Orchestrator` and `Explorer` loop through `LlmClient`. They do not run the Phase 10 discovery pass when no spec is supplied.

## Prior Wikipedia evidence

- There are no saved Wikipedia run directories in the checkout.
- `docs/AUDIT.md` records the previous unseen-app audit row: Wikipedia attempted `10/12` goals, verified `10`, had `0` findings, score `8.4`, and was judged "likely real".
- `docs/dynamic-website-testing.md` warns that Wikipedia should be treated as an exploratory canary rather than a pass/fail regression target because live page state changes.

## Codex App Server behavior verified locally

- `codex app-server generate-ts --experimental` exposes the v2 protocol types, including `thread/start`, `turn/start`, `thread/tokenUsage/updated`, `rawResponseItem/completed`, `dynamicTools`, and `item/tool/call`.
- `codex app-server --listen stdio://` speaks newline-delimited JSON-RPC over stdio when spawned with pipes.
- `initialize` returned the app-server user agent and `$CODEX_HOME`.
- `account/read` returned a ChatGPT account and `model/list` returned current Codex models including `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.
- A live dynamic-tool probe worked:
  - `thread/start` included `dynamicTools: [{ name: "add", ... }]`.
  - `turn/start` asked the agent to call `add`.
  - App Server emitted `item/tool/call` with `{ a: 2, b: 3 }`.
  - Responding with JSON-RPC `{ id: 0, result: { contentItems: [{ type: "inputText", text: "5" }], success: true } }` resumed the turn.
  - The final `agentMessage` was `5`.
- `thread/tokenUsage/updated` provides total and per-turn input, cached input, output, and reasoning token counts plus `modelContextWindow`.
- App Server can accept image inputs via `UserInput` variants: `{ type: "localImage", path }` and `{ type: "image", url }`.

## Provider design

Add a Codex App Server runner analogous to the Claude Agent SDK runner, not a `codex exec` one-shot bridge.

Core pieces:

- `CodexAppServerClient`: spawn one `codex app-server --listen stdio://` process per Iris run; implement newline JSON-RPC request/response handling, notifications, and server-initiated requests.
- `runCodexAppServerSingleShot`: create an ephemeral thread, run one turn, collect final `agentMessage`, token usage, and duration. Used for spec interpretation, discovery/vision, and Judge.
- `runCodexAppServerExplorer`: create one ephemeral thread with Iris `dynamicTools` for adapter tools, probes, and meta tools. Handle every `item/tool/call` by invoking the Iris adapter, emitting trace events, and returning `DynamicToolCallResponse` content to App Server.
- `runIrisViaCodexAppServer`: orchestrate preflight, discovery, Explorer, automatic probes, Judge, validators, and report writing using the App Server helpers.
- CLI: add `--transport codex-appserver` and optionally `codex` as an alias.

Important constraint:

- The live app-server proof loaded user/project instructions and global MCP startup by default. The first implementation should set raw events off and keep the Iris prompts explicit. If there is no stable config switch to suppress ambient instructions, record the token overhead in benchmark output rather than hiding it.

## Recommendation

Implement the App Server runner directly and label benchmarks honestly as:

- `cloud-sdk`: current Claude Agent SDK path, feature-complete and likely fastest.
- `codex-appserver`: new long-lived Codex App Server path with dynamic Iris tools.
- `historical-wikipedia`: prior audit row from `docs/AUDIT.md`.

Do not implement a `codex exec` one-shot provider for this comparison; it would benchmark CLI process overhead and prompt-envelope fragility, not the Codex harness the product should actually evaluate.

## 2026-05-14 implementation and benchmark result

Implemented `--transport codex-appserver` using a long-lived `codex app-server --listen stdio://` JSON-RPC process. The provider starts App Server threads, exposes Iris adapter tools/probes/meta tools as `dynamicTools`, handles server-initiated `item/tool/call` requests, and returns `DynamicToolCallResponse` results. The Explorer runner seeds each App Server turn with a real browser observation event so Codex cannot verify from prior knowledge alone.

Verification performed:

- `pnpm --filter @iris/cli exec tsc --noEmit --pretty false`
- `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot`
- `pnpm --filter @iris/core exec vitest run src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot`
- `pnpm --filter @iris/core build`
- `pnpm --filter @iris/cli build`

Wikipedia App Server canary:

- Command shape: `node packages/cli/dist/bin.js eval https://en.wikipedia.org/wiki/Main_Page --transport codex-appserver --task "Confirm the Wikipedia main page loads, search for OpenAI, and verify the OpenAI article page loads." --rubrics quality --max-steps 8 --steps-per-goal 4 --timeout 240 --no-html --no-clips --out iris-runs/wikipedia-codex-appserver-20260513-212457 --print-summary`
- Run directory: `iris-runs/wikipedia-codex-appserver-20260513-212457`
- Explorer result: `done` in 32.1s, 3 browser action steps, 1/1 goal verified with outcome evidence from the OpenAI article observation.
- App Server token usage for Explorer was high: `input_tokens=402084`, `cached_input_tokens=361216`, `output_tokens=909`.
- Judge result: App Server Judge timed out after 180s. The generated report is marked `termination=judge_failed`, `blocked=true`, `threshold_passed=false`, with the trace and verified goal preserved.

Comparison point:

- Historical cloud/SDK Wikipedia audit in `docs/AUDIT.md`: `10/12` goals attempted, `10` verified, score `8.4`, `0` findings, "likely real".
- Current App Server result is not yet competitive as an end-to-end Iris provider because Explorer can drive the browser, but Judge latency/ambient Codex context overhead prevents a scored report within the benchmark budget.

## 2026-05-14 token overhead investigation

The `402084` App Server input tokens in the Wikipedia Explorer run are not explained by Wikipedia page text alone. The trace payload is much smaller:

- `iris-runs/wikipedia-codex-appserver-20260513-212457/trace.jsonl` has about `14953` observation-summary characters and about `29575` JSON payload characters across all events.
- The final Explorer usage was `input_tokens=402084`, `cached_input_tokens=361216`, `output_tokens=909`, so non-cached input was roughly `40868`.

Live micro-probes isolated the baseline:

- Codex App Server, no dynamic tools, one trivial `OK` turn: `inputTokens=32623`, `cachedInputTokens=17280`, `outputTokens=18`.
- Codex App Server, one tiny dynamic tool registered but unused: `inputTokens=32633`.
- Codex App Server, all current web tools/probes registered but unused: `inputTokens=33772`; the 32-tool JSON schema envelope is only about `7399` characters.
- Codex App Server, all current web tools/probes plus a 4000-character Wikipedia observation: `inputTokens=34719`.
- Codex App Server, one noop tool called three times before final answer: `total.inputTokens=130860`, `total.cachedInputTokens=99840`; `last.inputTokens=32768`.

Claude Agent SDK comparison probes with the existing isolation flags (`settingSources: []`, `strictMcpConfig: true`):

- Claude Agent SDK, no tools, one trivial `OK` turn: `input_tokens=1726`, `output_tokens=6`, cost about `$0.0092`.
- Claude Agent SDK, 32 dummy MCP tools registered but unused: `input_tokens=6`, `cache_creation_input_tokens=6173`, `output_tokens=6`, cost about `$0.0388`.
- Claude Agent SDK, one noop MCP tool called three times: `input_tokens=2956`, `output_tokens=175`, cost about `$0.0196`.

Working conclusion:

- App Server has a roughly `32k` input-token baseline per model continuation before Iris page content is considered.
- `thread/tokenUsage.total.inputTokens` is cumulative over the internal tool loop. Each tool result continuation replays the App Server baseline and accumulated thread state, with most repeated tokens showing up as cached input.
- The Wikipedia run had 9 tool-like Explorer events, 4 observations, and 2 probe results. Its `402k` raw input is consistent with repeated App Server continuations, not a single 402k prompt.
- For cost/performance comparison, Iris should report total input, cached input, non-cached input, output, and the latest-turn usage separately. Raw `input_tokens` alone overstates newly generated prompt content but still reflects cache-read and latency overhead.

Likely next fixes:

- Preserve App Server `tokenUsage.last` and `tokenUsage.total` separately in trace/report instead of collapsing to `usage.total`.
- Add provider-overhead diagnostics to benchmark output: baseline turn input, dynamic-tool schema size, observation chars, tool-call count, cached-input ratio.
- Reduce unnecessary model continuations in the Codex path by making post-Explorer probes programmatic where possible and by letting the Explorer stop as soon as all assigned goals are terminal.
- Investigate whether App Server has a supported way to suppress or slim the hidden harness context analogous to Claude SDK's `settingSources: []`.

## 2026-05-14 token overhead fix

Implemented the first three fixes:

- `runCodexAppServerSingleShot` and `runCodexAppServerExplorer` now preserve normalized `token_usage.last` and `token_usage.total`, including `non_cached_input_tokens`.
- Explorer `run_end` now emits `provider_overhead` diagnostics: dynamic tool count, dynamic tool schema size, observation-summary chars, dynamic tool-call count, cached-input ratio, and estimated model continuation count.
- The Codex App Server Explorer prompt no longer instructs the model to run axe and console probes by default. Iris still runs those deterministically after Explorer if the model did not.
- The Explorer marks a run done as soon as all assigned goals are terminal, instead of requiring `maxExpansionGoals=0`.
- The Judge timeout no longer has the artificial 180s cap; it uses the remaining run budget with a 45s floor.
- `report.json` and `report.md` now surface optional provider token usage under `run.usage`.

Verification:

- Focused CLI test passed: `pnpm --filter @iris/cli exec vitest run src/codex-app-server-client.test.ts --reporter=dot`.
- Focused report tests passed: `pnpm --filter @iris/core exec vitest run src/report/report-json.test.ts src/report/report-md.test.ts --reporter=dot`.
- CLI typecheck passed: `pnpm --filter @iris/cli exec tsc --noEmit --pretty false`.
- Workspace build passed: `pnpm -r build`.
- Live smoke run `iris-runs/codex-appserver-token-fix-smoke-20260513-215611` confirmed the new trace/report fields. Its Explorer did one dynamic tool call (`goal_status`) and emitted `token_usage.last`, `token_usage.total`, and `provider_overhead`. The smoke used a short `--timeout 90`; Judge consumed the remaining 76s budget and timed out, confirming the hard 180s cap is gone but Judge latency remains unresolved.

Remaining:

- The stale `src/explorer/explorer.test.ts` `max_cost_usd` fixture fields were later removed; core typecheck now passes.
- The hidden App Server baseline remains about 32k input tokens per model continuation; the next investigation is whether App Server exposes a supported equivalent of Claude SDK's `settingSources: []` / `strictMcpConfig: true` isolation.

## 2026-05-14 Wikipedia retest after token fix

Command shape:

- `node packages/cli/dist/bin.js eval https://en.wikipedia.org/wiki/Main_Page --transport codex-appserver --task "Confirm the Wikipedia main page loads, search for OpenAI, and verify the OpenAI article page loads." --rubrics quality --max-steps 8 --steps-per-goal 4 --timeout 900 --no-discover --no-expand --no-html --no-clips --out iris-runs/wikipedia-codex-appserver-retest-20260513-221939 --print-summary`

Result:

- Run directory: `iris-runs/wikipedia-codex-appserver-retest-20260513-221939`
- Explorer completed: `termination=done`, `duration_s=25.762`, `steps=4`.
- Goal coverage: `1/1` attempted, `1/1` verified.
- Explorer token usage: `input_tokens=318102`, `cached_input_tokens=278528`, `non_cached_input_tokens=39574`, `output_tokens=659`.
- Explorer overhead diagnostics: `dynamic_tool_count=41`, `dynamic_tool_schema_chars=9907`, `observation_summary_chars=16000`, `dynamic_tool_call_count=6`, `cached_input_ratio=0.8756`, `model_continuation_estimate=7.8`.
- Judge failed after consuming the real remaining budget: `codex app-server single-shot timed out after 869s`.

Conclusion:

- Codex App Server can drive Wikipedia and produce evidence-backed goal verification.
- The token fix improved observability and reduced default probe turns, but raw cumulative Explorer input remains high because each continuation replays the App Server baseline.
- The blocking issue is now clearly App Server Judge latency/context overhead, not the Explorer browser-driving path and not the previous artificial 180s wrapper timeout.

Follow-up debug on goal count:

- The retest was not apples-to-apples with the historical Claude/SDK Wikipedia audit.
- The command used `--task` and `--no-discover`, so CLI mode inference made it `targeted`, created exactly one `initial_tasks` goal, and skipped discovery.
- Even removing `--no-discover` while keeping `--task` would still skip discovery because `initial_tasks` creates `interpreted` before the discovery gate.
- To compare against the historical `10/12` Wikipedia audit, rerun without `--task`, `--tasks`, `--no-discover`, or `--no-expand`.

## 2026-05-14 Discovery v2 and final Wikipedia retest

New implementation findings:

- The existing web observation is broader than a pure first-viewport OCR: it includes visible text plus a DOM outline and can include body text below the fold. It still does not safely exercise hidden menu, banner, or post-interaction state surfaces.
- A bounded disposable survey is useful for Discovery because it can scroll, peek menu-like controls, and dismiss banners without changing the primary Explorer browser state.
- `partial` needs a second-chance policy. If all goals are terminal but some are partial and step/time budget remains, the runner should reset only partial goals and ask for stronger evidence instead of ending.
- Some Wikipedia goals need deterministic state evidence. `ui_state` now captures active element, scroll/hash, body class/style, visibility, ARIA attributes, checked state, and computed styles for selected selectors.
- Passive baseline goals are a Discovery quality issue. Goals should normally require a user action or a specific state change, unless the page itself offers an explicit view/layout control.

Final live result:

- Run directory: `iris-runs/wikipedia-codex-appserver-discoveryv2-final-20260514-000130`
- Discovery proposed `9` action-oriented goals.
- Explorer ended `done` after `29` action steps.
- Final report: score `9.1`, threshold passed, `9/9` attempted/verified, `0` findings, `0` goal-claim downgrades.
- Raw Judge artifacts emitted `overall.score: 91`; report generation now normalizes 0-100 shaped scores to 0-10 while preserving raw artifacts.
- Provider usage remained high but mostly cached: total input `1,895,795`, cached input `1,765,504`, non-cached input `130,291`, output `8,992`.

Comparison update:

- Historical Claude/SDK Wikipedia row: `10/12` attempted, `10` verified, score `8.4`, `0` findings.
- Final Codex App Server Discovery v2 row: `9/9` attempted and verified, score `9.1`, `0` findings.
- Working conclusion: Codex App Server works end to end for Wikipedia. Remaining concern is App Server token/latency overhead, not inability to verify goals.

## 2026-05-14 Discovery value-ranking correction

The later report critique showed the first Discovery v2 correction overfit goal count. A no-spec run should not convert every visible footer/outbound/app-store/legal destination into a product goal. Goals should represent product-use outcomes and important secondary surfaces; rubrics then score cross-cutting quality over the resulting evidence.

Prompt policy after correction:

- Inventory all visible surfaces from viewport, survey, menus, and banners.
- Classify surfaces as core, important secondary, or peripheral.
- Fan out core product actions and materially different state changes.
- Group, sample, move to hints, or omit low-signal peripheral destinations such as outbound app-store links, footer legal pages, social links, and sister-project grids.
- Do not treat a higher raw goal count as proof of better Discovery.

Regression coverage:

- Discovery prompt-boundary tests now assert value-ranking language instead of small-set fan-out language.
- A grouped legal/app-download response remains grouped after normalization rather than being deterministically exploded into five goals.

The earlier fan-out live probes used `--max-steps 0`; their Judge outputs are not meaningful because Explorer intentionally performed no actions.

## 2026-05-14 Final Wikipedia capability status

Current state:

- Codex App Server can run Wikipedia end to end through Discovery, Explorer, Judge, evidence validation, and report generation.
- Discovery v2 now combines bounded survey visibility with deterministic small-set fan-out. The final verification run produced `19` seed goals, covering search, language editions, banner actions, app-store links, sister projects, and legal links.
- Runner end conditions are stricter:
  - `done` is rejected while assigned goals remain pending or retryable partials remain and budget remains.
  - `partial` and `blocked` require evidence ids; unattempted goals cannot be bulk-closed as terminal.
  - terse Judge notes can be backfilled from substantive Explorer `goal_status.rationale` when the cited evidence is valid.

Best final artifact:

- Run: `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148`
- Revalidated report: `iris-runs/wikipedia-codex-appserver-full16-evidencegate-20260514-0148/report.revalidated.json`
- Regenerated coverage from the saved trace: `19/19` verified, score `8.0`, threshold passed. The `19` goal count is retained only because this report reuses the old trace; it is now treated as inflated by peripheral link fan-out.
- Remaining finding after product-impact calibration: a machine-only axe `select-name` issue on the final visited page's `#languages-dropdown`, capped to `minor` with `severity_calibrated: true`.
- Provider usage: total input `2,492,208`, cached `2,343,808`, non-cached `148,400`, output `8,803`.

Comparison:

- Historical Claude/SDK Wikipedia row in `docs/AUDIT.md`: `10/12` attempted, `10` verified, score `8.4`, `0` findings.
- Current Codex App Server row after product-impact calibration: `19/19` verified after revalidation, score `8.0`, `1` minor axe finding. The next full rerun should use value-ranked Discovery and should not be compared goal-count-for-goal-count against this inflated trace.
- Interpretation: Codex is no longer failing the Wikipedia task. The remaining difference is benchmark shape and strictness: current Discovery became too broad by treating peripheral destinations as first-class goals, while App Server still has high cumulative input-token overhead from repeated continuations.

---

# Wikipedia Codex Score Matrix — Research

**Date:** 2026-05-14
**Status:** Implemented after diagnosis.

## What exists today

- `report.json` already stores rubric scores at `scores.profiles.<profile>.dimensions.<dimension>`.
- `report.html` already renders a collapsed rubric breakdown from those dimensions.
- `report.md` only showed profile totals, so correctness and frontend-specific dimensions were not visible in the primary text report.
- The final Wikipedia revalidated report listed default web profiles in `scores.overall.weighted_from`, but only returned the `quality` profile in `scores.profiles`.

## Relevant code paths

- Markdown report rendering: `packages/core/src/report/report-md.ts`.
- HTML report rendering: `packages/core/src/report/report-html.ts`.
- Report JSON score normalization: `packages/core/src/report/report-json.ts`.
- Codex App Server Judge prompt: `packages/cli/src/codex-app-server-orchestrator.ts`.
- Default web rubrics: `packages/cli/src/load-rubrics.ts`.

## Constraints

- Do not fabricate a numeric score for a missing profile. Missing or omitted profiles should be visible as missing or `n/a`.
- Preserve existing report consumers by leaving `report.json` score shape compatible.
- Keep the App Server compact Judge prompt concise enough to complete, but not so terse that it drops profiles.

## Conclusion

The missing frontend matrix was not a data-model limitation. It was a renderer gap plus a Judge prompt-compliance gap. The fix is to render dimensions in Markdown and HTML, require every requested profile/dimension in the compact Codex App Server Judge prompt, and use one shared core helper to defensively surface any omitted requested profile or dimension with `n/a` scores and a caveat.

## Compatibility update

- Shared helper: `packages/core/src/judge/score-coverage.ts`.
- Claude/Agent SDK path: `packages/cli/src/agent-sdk-orchestrator.ts` calls the shared helper after raw Judge or ensemble output.
- Codex App Server path: `packages/cli/src/codex-app-server-orchestrator.ts` calls the same helper after raw Judge/fallback output.
- Core orchestrator path: `packages/core/src/orchestrator/orchestrator.ts` calls the helper as well; `Judge.run()` also applies it for direct core usage.

## HTML update

- The report now starts with an executive overview: verdict, score, goal coverage, finding count, runtime, termination, token usage, and cost.
- Findings and the score matrix are shown before the longer goal transcript.
- The score matrix includes profile totals and dimension rows, including missing requested profiles from old reports.
- The long goal list, video, and trace are collapsed so key information is not buried.

## Visual evidence update

- Raw browser `.webm` files are debug recordings, not claim-scoped proof. They can start or end on an incidental page and misrepresent the run when shown as the primary artifact.
- HTML reports now promote claim-scoped screenshots before the score matrix. Each visual card is linked to the goal or finding ID it supports and to the underlying event.
- Goal evidence can point at `goal_status` events; the renderer resolves those through `evidence_event_ids` so the visible screenshot comes from the actual observation/probe frame.
- Findings that only have probe evidence are explicitly marked as needing better visual evidence.
- Incomplete rubric coverage is now a report-quality state. A partially scored report can still show the raw numeric score, but the hero verdict says `Incomplete score report` and labels the score as non-authoritative.

## Report flow update

- The report should be organized for a human reader, not by internal artifact type.
- Findings now own their evidence context. A probe-only axe finding renders a nearby browser frame plus the machine evidence details: rule id, impact, selector, element HTML, and rule link.
- Goal evidence now appears as integrated rows with status, goal text, result context, screenshot, and a plain source link. The reader should not need to match a goal list to a separate screenshot gallery.
- A horizontal `Run walkthrough` storyboard provides the scan path for the journey. It is more useful than raw videos for static-heavy runs.
- Raw videos are labelled `Debug recordings`, not proof. They sit behind the walkthrough and scroll inside a bounded pane.
- Evidence chips are human-readable labels such as `probe: axe` and `visual: step 9`; opaque event ids remain available through links and trace details.

## Claim clip update

- Claim-level video generation is now provider-neutral through `collectClaimEvidenceArtifacts()` in `@iris/core/report`.
- Core, Claude/Agent SDK, and Codex App Server orchestrators all call the same helper, so `--no-clips` and evidence artifact shape stay compatible across providers.
- The helper handles goals and findings, follows `goal_status.evidence_event_ids`, and maps observation trace events to their `OBS-*` screenshot refs.
- The web adapter now produces per-claim proof clips from the screenshot timeline around each claim. Raw Playwright page recordings remain available as debug recordings, but they are no longer the report's primary video evidence.
- The revalidated Wikipedia report has been regenerated with deduped evidence cards and claim clips; the served report is `http://100.104.175.44:8765/report.revalidated.html`.

## Goal evidence consolidation update

- The report no longer has a separate tested-goals transcript after the evidence section.
- Tested goals and evidence are now one grouped section: `Tested goals & evidence`.
- The grouped proof section is organized by user-facing surface instead of artifact type. For Wikipedia this yields Search & articles, Language editions, Donation flow, Mobile apps, Wikimedia projects, and Policies & licensing.
- Finding proof stays inline in the Findings section to avoid duplicating finding cards inside goal evidence.
- Claim clips are collapsed behind `play clip` controls in each proof row, reducing visual noise while keeping video proof attached to the claim.

## Appendix and full-rubric update

- The report no longer renders `Run walkthrough`, raw debug recordings, or full trace rows as separate top-level sections. They are folded into one collapsed `Audit trail` appendix.
- The appendix renders only source events cited by report claims; the complete `trace.jsonl` remains linked for debugging.
- Raw videos remain available under `Raw debug recordings`, but they are no longer part of the primary reading flow.
- Finding layout now uses a consistent title/body/media grid, and raw axe-rule title shapes such as `select-name` are translated into reader-facing accessibility copy.
- The saved Wikipedia trace was replayed through Codex App Server Judge with all six requested web rubrics. The regenerated report now has `6/6` rubric profiles and `25` score rows instead of `1/6`.
- Judge schema parsing now defaults missing rubric-dimension `evidence` arrays to `[]`, which lets complete nullable/n/a dimension scores survive even when the model omits the empty array.

## Product-impact calibration for a11y findings

- The user's critique was right: a machine-only axe `select-name` violation on a Wikipedia language dropdown is not automatically a major product finding in a general product-quality run.
- Accessibility is still a scored rubric, but raw automated-probe impact is not the same thing as product severity.
- Judge prompts now say axe-only issues usually affect accessibility dimensions rather than top-level major/blocker findings unless a core flow is blocked, the run is explicitly accessibility/compliance-focused, or trace evidence shows broad user impact.
- The evidence validator now caps machine-only axe-backed accessibility findings from major/blocker to minor and tags them as `severity_calibrated`.
- Discovery goals and rubric profiles are intentionally not a parent-child tree: goals are scenario evidence generators; rubrics are cross-cutting scoring dimensions. The report should make that relation clear and avoid implying that every rubric needs a matching goal or that every visible link is a goal.

## 2026-05-14 Discovery v2 surface-graph research

The current Discovery implementation is still a bottleneck despite the latest Wikipedia fixes. The web adapter's `discoverySurvey()` captures a bounded text summary from a disposable context, tries one hard-coded primary search journey, peeks a few menu-like controls, optionally dismisses banners, and scrolls a small number of times. Core Discovery then sends that summary plus one screenshot to a single model call that returns a flat `goals` list.

This is enough to avoid pure first-viewport blindness, but it is not yet how a real user learns a product. A real user builds a mental map: pages, nav, forms, menus, state changes, prerequisites, hidden panels, and high-value journeys. Iris currently asks the model to infer that map from lossy prose and then jumps straight to goals. That creates three recurring failure modes:

1. Discovery over-compresses product surfaces and emits too few goals.
2. Discovery over-expands peripheral destinations and emits too many low-value goals.
3. Reports cannot explain why a goal was chosen, what product surface it covers, or what was discovered but deferred.

The root fix should be provider-neutral and shared by Claude/Agent SDK and Codex/App Server. The adapter should produce a structured surface graph, core Discovery should synthesize journeys from that graph, and the report should preserve the chain from discovered surface to selected goal to evidence. Existing dynamic `propose_goal` remains useful, but it should become a feedback mechanism against the surface graph rather than the primary way Iris discovers missing product areas.

Key constraints:

- Keep Discovery bounded. This is not an unbounded crawl.
- Use disposable browser contexts for exploration that may click, scroll, or navigate.
- Avoid external-link deep visits by default; classify them as destinations unless they are core to the product.
- Store the full structured survey artifact on disk, but feed the model a compact ranked digest to control token cost.
- Preserve the existing flat `goals` output for downstream compatibility while adding richer v2 fields.

---

# Iris AI Test Automation Prior Art Spike

**Date:** 2026-05-15
**Status:** Research and local spike. No implementation changes in this section.

## Request

Study Midscene and adjacent AI test automation tools, then compare their useful ideas with Iris' current architecture and the ideal product direction. Use spikes where useful.

## Sources checked

- Midscene: `https://github.com/web-infra-dev/midscene`, local clone `/tmp/iris-prior-art/midscene`, commit `9df3512874ac0e47fc12895f05b427f69ac99fd7`.
- Stagehand: `https://github.com/browserbase/stagehand`, local clone `/tmp/iris-prior-art/stagehand`, commit `7ed26a87b4a43daf16ae232f346061f2fb521316`.
- browser-use: `https://github.com/browser-use/browser-use`, local clone `/tmp/iris-prior-art/browser-use`, commit `933e28c599ddd74c15a48568f159da95547e40dd`.
- TestZeus Hercules: `https://github.com/test-zeus-ai/testzeus-hercules`, local clone `/tmp/iris-prior-art/testzeus-hercules`, commit `e8bf322a1cd894b1b7b18b4d3c44a4767788363a`.

## Current Iris baseline

The relevant Iris pieces are already moving in the right direction, but they are still halfway between a browser agent and a product evaluator:

- `packages/adapter-web/src/index.ts` has `observe()` and `discoverySurvey()`. `observe()` gives visible text, a DOM outline, rich input content, screenshots, and page metadata. `discoverySurvey()` can use a disposable browser context to sample scroll positions, menu peeks, banner dismissal, a primary search path, and a few links.
- `packages/core/src/discovery/prompts.ts` asks for v2 fields: surface graph, journeys, coverage plan, and value-ranked goals.
- `packages/core/src/discovery/discovery.ts` can parse and normalize v2 fields, but only adds heuristic supplemental goals when both surfaces and journeys are missing.
- `packages/core/src/explorer/prompts.ts` and `packages/core/src/explorer/explorer.ts` run a text-first Explorer loop. Each turn carries an observation summary and tool context; screenshots are captured as evidence but are not the primary per-step perception channel.
- `packages/core/src/trace/digest.ts` currently normalizes DOM strings for trace comparison, but Iris does not yet have a unified element identity model with stable hashes, layout bounds, action history, and replay self-healing.

The latest Wikipedia spike shows the gap. The report run looked good at the top level, but the discovery artifact is still v1-shaped:

```json
{
  "run": "iris-runs/wikipedia-codex-appserver-keycoverage2-20260514-153030",
  "events": 145,
  "observations": 30,
  "actions": 33,
  "discovery_goals": 10,
  "discovery_surface_graph": {
    "surfaces": 0,
    "journeys": 0,
    "coverage_plan": false,
    "selected_journeys": 0,
    "deferred_surfaces": 0
  }
}
```

All checked Wikipedia `discovery.json` files had goals but no `surfaces`, `journeys`, or `coverage_plan`. That means the report can render Discovery v2 concepts, but the actual Wikipedia runs still did not preserve the surface-to-journey-to-goal chain.

The same run also illustrates the token profile:

```json
{
  "observations": 30,
  "obs_summary_chars": {
    "total": 119007,
    "p50": 4000,
    "p90": 4000,
    "max": 4000
  },
  "usage": {
    "total_input_tokens": 2841110,
    "cached_input_tokens": 2738688,
    "non_cached_input_tokens": 102422,
    "output_tokens": 8410
  }
}
```

The expensive part is not just page content. Iris repeats large prompt and observation envelopes across many App Server continuations. Most of that is cached, but it is still a latency and cache-read-cost problem. The ideal architecture should reduce repeated prose state and move toward compact, stable, replayable state.

## Midscene lessons

Midscene is not just "LLM with Playwright." The useful ideas are architectural:

- Vision-first action localization. Midscene deliberately uses screenshots for locating UI actions and keeps DOM optional for extraction and page understanding. Iris currently leans on text and DOM outline first, which is cheaper and explainable, but weaker for layout-sensitive bugs, visual affordances, offscreen overlays, and "what would a user actually see" claims.
- Task abstraction. Midscene has `TaskExecutor`, execution sessions, action space, planning output, completion state, memory, and report dumps. Iris has goals and Explorer turns, but not yet a durable task/scenario object that can be replayed independently of the original model conversation.
- Cache as a product feature. Midscene caches planning workflows and locate results with read-only, read-write, and write-only modes, and validates cache shape before use. Iris should have an equivalent cache for successful goal plans and locator/visual targets.
- Report as debugger. Midscene's report stack is closer to a replay/debugger: timeline, screenshots, model call details, action dumps, and visualizer UX. Iris reports have improved, but the report is still too much "verdict document" and not enough "evidence player."
- History compression. Midscene explicitly compresses conversation history after many steps. Iris should not rely only on provider prompt caching; it needs domain-aware state summaries and deltas.

Adoption for Iris: do not import Midscene as the core engine. Lift the design: task IR, vision action resolver, cache/replay, model-call evidence, and report timeline.

## Stagehand lessons

Stagehand's strongest fit for Iris is deterministic repeatability:

- It exposes `observe`, `act`, and `extract` as stable APIs. This separation is useful for Iris too: Discovery observes candidate actions, Explorer acts, Judge/extractors read structured outcome state.
- It treats action caching and self-healing as first-class. The self-heal integration test intentionally corrupts a cached selector (`xpath=/yeee`) and verifies a later run repairs the cached action.
- Its deep locator layer resolves selectors across iframe hops and lazily re-resolves before actions. Iris' current web adapter should be hardened in that direction for iframes, shadow roots, and stale handles.

Adoption for Iris: add "replay known scenario, then self-heal only on drift" as the default retest path. This is directly relevant to benchmark stability and reducing provider overhead.

## browser-use lessons

browser-use has the clearest state-model idea:

- It builds an enhanced DOM state from DOM, accessibility, browser snapshot, bounds, shadow roots, and content documents.
- It stores interacted element identity with XPath, element hash, stable hash, and element attributes.
- It separates cached and new token accounting in the token service.

Iris should steal the state model, not necessarily the agent loop. The missing Iris primitive is a provider-neutral `PerceptionState`:

- page URL, title, viewport, scroll, active element, dialogs, frames;
- visible AX tree and compact DOM tree;
- element bounds and stable element hashes;
- candidate controls with role/name/value/state;
- recent interactions attached to stable element ids;
- screenshot refs and optional cropped visual patches.

This would shrink prompts, improve evidence links, enable replay/self-heal, and make reports less dependent on opaque event ids.

## TestZeus Hercules lessons

Hercules is weaker as a product evaluator but useful as a CI/test-report reference:

- It takes semi-structured Gherkin scenarios and splits them into per-scenario executions.
- It writes JUnit XML with proof links for videos, screenshots, logs, and cost metrics.
- It uses accessibility tree distillation and proof folders as first-class outputs.

Adoption for Iris: keep natural Discovery, but compile selected journeys into a semi-structured scenario/task file. Emit CI-native outputs alongside HTML: one test case per goal/journey, with proof links and score metadata.

## What Iris should become

Ideal Iris should not be a generic browser-driving bot. It should be a product-quality evaluator with a testable product map:

1. Discovery builds a bounded surface graph.
   - Adapter produces deterministic structured surfaces from scroll/menu/banner/form exploration.
   - Model synthesizes value-ranked journeys from those surfaces.
   - Goals are derived from selected journeys.
   - Deferred surfaces are explicit and visible in the report.

2. Goals compile to scenario tasks.
   - A task has user intent, prerequisites, candidate actions, expected evidence, allowed detours, and terminal success/failure criteria.
   - Tasks can be exported as JSON or Gherkin-like text.
   - Explorer executes tasks; Judge scores claims and product quality, but does not invent the product map after the fact.

3. Execution uses hybrid perception.
   - Text/AX/DOM state remains the cheap default for discovery, extraction, and evidence summaries.
   - Vision is used for action localization, layout claims, visual regressions, screenshots, occlusion, scrollability, modal state, and "real user saw this" proof.
   - The model should receive compact state plus targeted crops, not a full repeated DOM dump every turn.

4. Replay and self-heal reduce cost.
   - Successful tasks produce a replayable action chain keyed by URL, task id, surface ids, and stable element hashes.
   - Retests replay deterministically first.
   - If an action fails or state hash drifts, Iris asks the model to self-heal the locator or replan that local segment.
   - Reports distinguish replayed proof, self-healed proof, and fully exploratory proof.

5. Evidence becomes the primary product.
   - Every goal row should own its screenshots, clips, actions, extracted state, and verdict.
   - The report should have a timeline/scrubber with goal and finding anchors.
   - Raw debug recordings are appendix material. Claim-scoped clips and screenshots are proof.
   - Opaque event ids should be links, not the main reader interface.

6. Outputs support humans and CI.
   - HTML for product review.
   - JSON for programmatic consumers.
   - JUnit for CI and benchmark dashboards.
   - Optional scenario/task artifacts for reruns.

## Recommended implementation sequence

First priority: make Discovery v2 real and guarded.

- Add a canary test using the existing Wikipedia-like survey fixture or a local fixture with search, menus, banner/donation, article/content, language, footer, and external links.
- Assert that no-spec discovery returns non-empty `surfaces`, non-empty `journeys`, and a non-empty `coverage_plan.selected_journey_ids`.
- Fail if a run silently collapses to flat v1 goals when survey surfaces are available.
- Store `discovery-survey.json` separately from `discovery.json`; report both selected and deferred surfaces.

Second priority: introduce `PerceptionState`.

- Centralize current `observe()` text, outline, ui_state, rich content, screenshot refs, and selected computed styles into one typed state object.
- Add stable element ids/hashes and bounds.
- Keep a compact prompt serializer plus a full artifact serializer.
- Replace repeated 4000-character observation prose where possible with state ids, deltas, and targeted excerpts.

Third priority: add task replay and self-heal.

- Persist successful goal executions as task runs with action steps and element identities.
- On rerun, try deterministic replay before exploratory LLM control.
- If replay fails, call the model with the failed step, current `PerceptionState`, prior target, and local objective.
- Log whether the proof came from replay, self-heal, or full exploration.

Fourth priority: add visual action/assertion path.

- Add an optional visual locator/assertion primitive that works from screenshot plus cropped candidates.
- Use it when selector action fails, when a claim is visual/layout-related, or when report proof needs "what user saw" confirmation.
- Do not make every turn pure vision by default; use it where it adds evidence or robustness.

Fifth priority: upgrade report and CI outputs.

- Add a timeline/evidence-player view anchored by goal and finding, not artifact type.
- Add per-goal JUnit XML with proof links and score properties.
- Show Discovery graph coverage: selected journeys, deferred surfaces, and reasons.

## Bottom line

Midscene validates the direction the user has been pushing: videos, screenshots, tasks, and replay should be first-class, not afterthoughts. Stagehand shows that cached actions need self-healing. browser-use shows Iris needs a richer stable perception state. Hercules shows that scenario-shaped outputs and CI proof links matter.

The root Iris fix is not a prompt tweak. It is to make the product map, task graph, perception state, replay cache, and evidence player real shared primitives. The immediate bug exposed by the spike is concrete: current Wikipedia runs still produce flat goals without Discovery v2 `surfaces`, `journeys`, or `coverage_plan`, so the next implementation should start there.

## 2026-05-16 Report reader redesign research

What exists today:

- `packages/core/src/report/testing-plan.ts` converts Discovery output into a canonical `TestingPlan` with one `main_outcome`, multiple `journeys`, multiple `scenarios`, and deferred areas.
- `packages/core/src/report/report-html.ts` renders the HTML. The top hero, coverage panel, tested-goal evidence cards, score matrix, and audit appendix are all in one file.
- `report-json.ts` includes `testing_plan` in `report.json`; re-rendering an existing run through `packages/cli/src/commands/report.ts` is enough to validate report presentation without rerunning the product.

Current UX problem:

- The report exposes internal-ish terms and redundant concepts: "Main user outcome", "Product areas tested", "Tasks tested", "Coverage", "Scope", "Observed", "source event", and status pills repeated at both group and card level.
- `main_outcome` is singular because the underlying `ProductUseContract.primary_value_loop` is singular. For tldraw this is an umbrella value loop, while the actual tested user journeys are the `TestingPlan.journeys` below it. Labeling the umbrella as "Main user outcome" makes it look like Iris only found one user behavior.
- The evidence cards are close to the right source of truth, but the visual hierarchy is backwards for a reader: the task id/status/title should be the card headline, the media should be first-class, and internal coverage/source links should be secondary.

Constraints:

- Keep the JSON schema stable for existing report consumers; change the reader-facing HTML labels and layout first.
- Keep model/reasoning/transport visible because previous feedback asked for it, but move low-signal run mechanics out of the hero.
- Keep raw traces and raw recordings available, but behind the audit appendix.

Implementation direction:

- Rename the singular umbrella to "Overall mission" / "What Iris tried to prove", and make "User journeys checked" the visible multi-outcome section.
- Render a compact journey/task overview before evidence: journey cards with task counts and pass status; task checklist with id, status, title, and expected outcome.
- Redesign evidence cards so each task row has one title line: task id, status pill, title. Put proof media beside a concise "What Iris saw" block. Collapse coverage/debug metadata.
- Collapse the score matrix details behind a clearer "Scoring" section with profile chips first.
- Verify with the latest tldraw run re-render, browser screenshot, report tests, typecheck, and build.

## 2026-05-16 Material scenario generation research

Trigger:

- The latest tldraw run is much better than the first shallow reports, but it still proves generic capabilities rather than realistic product use. The selected goals are "create object", "add two elements", "use non-default shape", "add text", "export", and "share". Those are capability checks, not concrete user scenarios.
- The user's "why not draw an elephant?" question was a probe for generalization, not a request to hardcode elephants. The root requirement is: Iris should first learn what the product is for, then create material, inspectable, non-toy scenario briefs that a real user might attempt.

What exists today:

- `packages/core/src/discovery/prompts.ts` already asks for "scenario-native" plans and says surfaces are not goals. It also asks artifact editors for multiple operations.
- `packages/core/src/discovery/discovery.ts` has a compatibility schema with `product_use_contract`, `value_loops`, and `user_jobs`, plus normalization that expands rich canvas surfaces into capability journeys.
- `packages/core/src/report/testing-plan.ts` turns `user_jobs` into public `UserScenario` rows.
- `packages/core/src/judge/goal-claim-validator.ts` enforces broad materiality categories such as create/text/style/media, but it does not yet enforce scenario-specific visible content or semantic artifact quality.

Gap:

- Discovery still emits and normalizes around capability families: create, style, history, shape variant, text, media, export, share. This catches toolbar-only proof, but it does not make the task concrete enough. A toy "Board notes" text can satisfy a "text" capability.
- The compatibility fields lack an explicit scenario brief, required output elements, and quality bar. `expected_artifact` is a broad outcome string, not a checklist of visible scenario content.
- Explorer context shows contract details, but it does not front-load a concise "do this concrete scenario" brief per goal.
- The Judge/validator can reject missing broad categories, but not missing scenario content like title, labels, relationships, or user-meaningful structure.

Design direction:

- Keep `product_use_contract`/`user_jobs` for compatibility, but make each `user_job` a concrete user scenario by adding optional fields:
  - `scenario_brief`: one-sentence realistic task.
  - `test_data`: concrete strings/data the Explorer should use.
  - `required_outputs`: visible content/state/components that must appear.
  - `quality_bar`: non-toy criteria a reviewer can inspect.
- Update Discovery prompt and normalizers so product learning produces scenario briefs first, then journeys/goals are execution handles derived from those scenarios.
- Add generic product-kind scenario scaffolds for broad categories, not site-specific patches. For canvas/document/media/editor products, generate realistic artifact briefs with named content and relationships. For search/content, CRUD, dashboards, commerce, and communication tools, generate realistic task data and visible result requirements.
- Make Explorer context and run prompt surface the scenario brief and required outputs before lower-level actions.
- Make Judge/validator reject verified claims when scenario-specific required outputs are missing from cited trace evidence, while still allowing visual-only requirements that cannot be text-matched to be judged by screenshot/vision evidence.

Verification targets:

- Unit: discovery preserves and enriches scenario brief fields; tldraw-like canvas discovery produces concrete named scenario content, not just "visible content".
- Unit: report testing plan exposes scenario brief, required outputs, and quality bar.
- Unit: goal-claim validator downgrades a verified canvas claim that contains generic shape/text proof but omits scenario-required labels.
- Integration: fresh tldraw e2e should produce goals whose titles/expected results read like real user scenarios, and clips/screenshots should show named scenario content, not generic "Board notes".

## 2026-05-16 Scenario proof validation root fix research

Trigger:

- A fresh tldraw run with `gpt-5.5` and high reasoning produced material board content, but the report showed only 4/8 goals verified.
- The partial goals were not mostly missing product actions. Trace observations contained the requested labels and states for G1, G4, and G5. G2 was partly legitimate because the visible flow title `Support Triage Flow` was not observed.

What exists today:

- Discovery emits `user_jobs` with both `test_data` and `required_outputs`.
- `test_data` is the concrete content/context Iris should use while acting. It may include role labels such as `Milestones:`, `Caption:`, `Invite context:`, optional file metadata, and setup data that does not need to remain visible.
- `required_outputs` is the intended proof checklist: visible strings, components, or state changes that must appear in evidence.
- `packages/core/src/judge/goal-claim-validator.ts` currently calls `scenarioVisibleDataTokens(job.test_data)` and ignores `required_outputs` in `evaluateScenarioSpecificProof`.

Root cause:

- The validator uses the wrong source of truth for proof. It treats model-authored input labels and optional setup hints as literal visible requirements.
- `scenarioVisibleDataTokens` also lacks generic handling for content-role prefixes such as `Decision:`, `Outcomes:`, `Caption:`, `Annotation:`, and `Invite context:`, and it does not skip optional upload filename metadata like `Media filename if upload is available: ...`.

Fix direction:

- Make scenario proof validation prefer `required_outputs` when present, falling back to `test_data` only for older discovery artifacts.
- Broaden scenario-data extraction generically around content-role prefixes instead of adding tldraw-specific rules.
- Keep broad/non-text required outputs such as export events, file events, or visible state as non-literal text requirements; those are validated by action/outcome evidence, not substring matching.
- Revalidate the existing tldraw 5.5/high trace after the code fix. Expected result: G1, G4, and G5 should move from partial to verified; G2 may remain partial if `Support Triage Flow` was truly not visible.

## 2026-05-16 Optional scenario completion gate research

Trigger:

- The user asked to try a completion gate, but make gating an optional argument.
- The target failure mode is Explorer prematurely marking a scenario verified even though the cited proof does not contain deterministic scenario outputs.

What exists today:

- Discovery has a structured `product_use_contract.user_jobs[].required_outputs` field.
- Both Codex App Server and Agent SDK runners own the `goal_status` dynamic tool, so both can enforce a provider-neutral gate before accepting `verified`.
- Final Judge validation already checks scenario-specific proof, but it runs after Explorer has finished; it cannot force Explorer to keep trying in the same run.

Design:

- Add `--scenario-gate` to `iris eval`.
- Build per-goal gate checks from required outputs, but only for literal visible text. Broad visual requirements such as non-default shape, connector, image/media object, export result, or state changes stay under screenshot/vision/action validation.
- Pass the same gate list into both runner transports.
- Record observation/action-result text by trace event id. When Explorer calls `goal_status(status="verified")`, reject the tool call if cited evidence ids are missing required literal outputs.

Validation findings:

- Fresh tldraw gated run produced 8 proposed goals, 112 Explorer steps, real screenshots, and 9 sliced evidence clips.
- No gate rejections occurred in the final run, which means Explorer cited enough deterministic visible-text evidence for the scenarios it claimed.
- The first report after the run showed 6/8 verified, but this was a separate validator windowing bug: repeated `goal_status` calls overwrote earlier action windows. Merging repeated per-goal windows and revalidating the same trace produced 8/8 verified with zero deterministic downgrades.

## 2026-05-16 Agentic discovery capability-denominator research

Trigger:

- The user pushed on a deeper Discovery gap: Iris can now generate concrete scenarios, but it still does not clearly learn and expose the product denominator.
- For tldraw, a scenario set can verify a launch board, export, media, or sharing path, yet still miss broad canvas-editor capability areas such as freehand drawing, object manipulation, connectors, style depth, collaboration depth, or history/undo. Reporting only scenario counts makes the evaluation look more complete than it is.

What exists today:

- `packages/core/src/discovery/prompts.ts` asks Discovery to infer product kind, value loops, user jobs, scenarios, surfaces, journeys, and seed goals.
- `packages/core/src/discovery/discovery.ts` normalizes those concepts and has artifact-editor capability heuristics that synthesize extra journeys for style/history/shape/text/connector/media/export/share when surfaces expose them.
- `packages/core/src/report/testing-plan.ts` creates the public `TestingPlan` around user journeys and user scenarios.
- `packages/core/src/report/evaluation.ts` separates product score from evidence confidence, but confidence only considers goal completion, rubric completeness, and Judge confidence.
- The report can show surface-to-scenario coverage, but it still treats UI inventory and scenarios as the denominator. That is not the same as product capability coverage.

Root cause:

- Iris conflates three levels: UI surfaces, executable scenarios, and product capabilities. Scenarios are the things tested; capabilities are the learned denominator of what the product appears able to do.
- Without a structured capability denominator, the evaluator cannot honestly say whether a mature product was broadly exercised or only sampled.
- Prompt-only fixes keep adding scenario examples, but there is no schema/report/scoring place to hold "capability discovered but not tested" as first-class evidence.

Design direction:

- Add `capabilities` to Discovery output as a provider-neutral, product-kind-aware denominator.
- Normalize capabilities from three sources: model output, product-kind priors, and discovered surfaces/journeys/user jobs. This keeps the fix generic while still using known product archetypes.
- Track each capability with importance, coverage status, related scenarios/journeys/surfaces, evidence/source, and a coverage gap.
- Let scenarios cover capabilities, but do not make capability coverage equal scenario completion. A scenario can cover multiple capabilities; a capability can remain discovered/deferred even when all tested scenarios pass.
- Feed capability gaps into Explorer context so future goal proposals are biased toward missing material product abilities.
- Render capability coverage prominently in the report and use it to cap score authority. A high scenario pass rate with low core capability coverage should read as a limited/provisional evaluation, not as a full product judgment.

Verification targets:

- Unit: canvas-editor discovery with tldraw-like surfaces produces a synthesized capability denominator including creation, text, style, connectors, object revision/history, shape variants, media/import, export/save, and share/collaboration.
- Unit: non-canvas product kinds such as search/content or CRUD also produce generic capability denominators, proving this is not a tldraw patch.
- Unit: report JSON includes capability coverage and downgrades authority when core capability coverage is low despite all tested goals passing.
- Unit: report HTML shows capability coverage in the high-level report flow, not only in a debug disclosure.
- Integration: re-render the current tldraw report and confirm it explains both tested scenario success and uncovered product capabilities.
## 2026-05-16 Ideal-state Discovery execution research

Current state:
- `packages/core/src/discovery/discovery.ts` now has a first-class `capabilities` denominator and report-time capability synthesis, but the denominator is still mostly downstream accounting. It does not reliably force scenario selection before Explorer runs.
- The web adapter already performs a bounded Discovery v2 survey (`discoverySurvey({ max_scrolls: 2, peek_menus: true, dismiss_banners: true })`) before LLM Discovery in both SDK and Codex App Server orchestrators.
- Discovery normalization already contains artifact-editor journey repair (`ensureArtifactEditorCapabilityJourneys`) and product-kind materiality scaffolds, but this is not a generic closed loop over the learned capability denominator.
- `formatDiscoveryExplorerContext` tells Explorer about capability gaps, and Explorer has `propose_goal`, but expansion is opportunistic and not guaranteed to close core gaps. A run can still start with selected goals that cover too little of the learned product.
- Fresh orchestrators write `discovery.json` with capabilities, but the trace `discovery` event currently omits `capabilities`; report extraction then has to synthesize capability coverage from older fields instead of reading the actual Discovery denominator.

Root gap:
- The ideal state is not just a better report. Iris must learn the product denominator, audit the selected scenarios against that denominator, and repair the plan before Explorer starts. Otherwise a high scenario pass rate can still mean "Iris tested the subset it happened to pick," not "Iris fairly evaluated the product."

Constraints:
- The fix should be generic across product kinds. Product-specific priors are acceptable only as reusable product-kind capability priors; no named-site patches.
- Scenario count should grow because uncovered core abilities require material checks, not because of a fixed target count.
- Low-value surfaces such as banners, legal/footer links, and promos should remain deferred unless they block core use.
- Existing scenario gates, goal claim validation, report evidence slicing, and score-authority logic should continue to consume the same Discovery output shape.

Target design:
- Add a Discovery closed-loop repair stage inside normalization:
  1. Normalize surfaces, journeys, product-use contract, and initial coverage plan.
  2. Derive capability denominator from product kind, surfaces, journeys, and model output.
  3. Identify core/important capabilities not selected by the plan.
  4. Synthesize material journeys for those gaps from the same product-kind materiality scaffold.
  5. Recompute product-use jobs, coverage plan, seed goals, and final capabilities.
- Persist actual `capabilities` in trace `discovery` events for both SDK and Codex App Server paths.
- Verify with unit tests that under-compressed tldraw-like Discovery expands to material scenarios before Explorer, and that content products expand content-navigation gaps without canvas-specific behavior.
- Verify with actual e2e runs, at minimum tldraw and Wikipedia, using report artifacts and screenshots/videos rather than trusting unit tests alone.

## 2026-05-16 Fair product evaluation root-fix research

Timestamp: 2026-05-16 15:48 PDT

Trigger:

- The user created an explicit goal to root-fix Iris as a general software-product evaluator, not a tldraw/Wikipedia patch.
- Prior work improved Discovery v2, scenario grounding, capability denominators, mouse overlays, and report layout, but the ideal-state loop is still incomplete: selected-scenario success can still read as broad product coverage, important product-native scope can be silently deferred, and evidence clips are often fixed-length screenshot storyboards rather than meaningful scenario arcs.

What exists today:

- `packages/core/src/discovery/prompts.ts` asks the model to learn product kind, value loops, user jobs, scenarios, surfaces, journeys, and a coverage plan.
- `packages/core/src/discovery/discovery.ts` normalizes Discovery output and now carries a capability denominator. It still trusts model-selected journeys too much: `normalizeDiscoveryCoveragePlan()` requires only core/contract journeys, filters selection by `goal_class`, and records unselected material surfaces as deferred rather than forcing a fair selection/explanation pass.
- `DiscoveryCapabilityStatusSchema` currently has `selected`, `deferred`, `discovered`, and `not_applicable`. That mixes three different meanings: important but untested, lower-signal but intentionally skipped, and merely observed.
- `finalizeCapabilitySeed()` marks a capability `selected` when any selected journey/scenario matches it, otherwise `deferred` if related journeys/surfaces exist. It does not preserve the higher-level evaluator question: "Would a capable user expect this product-native ability to matter?"
- `packages/core/src/report/evaluation.ts` reports capability coverage but still allows high coverage labels when all core-selected scenarios pass and only a subset of the denominator was tested. Gaps only include uncovered `core`/`important` capabilities, so misclassified product-native scope can disappear.
- `packages/core/src/report/evidence-clips.ts` creates trace storyboards before raw slicing, caps them at six frames, and gives every frame the same duration. This explains uniform clips around eight seconds and weak "slideshow" evidence. Raw browser recordings are available but too long/static to be primary evidence.

Observed root causes:

- Selection is model-output-driven instead of denominator-audited. If Discovery labels a product-native journey as `setup`, `sample`, or low-priority, the normalizer can drop it even when a skeptical evaluator would expect it to be tested or explicitly scoped out.
- Iris lacks a small public semantic model for scope. The system has many internal labels, but the evaluator needs only: must test, should test or explain, and not normally tested. More granular labels are useful only as private hints, not as the report or scoring truth.
- Deferral is not score-relevant enough. "All selected scenarios passed" can dominate even when important capability scope is skipped.
- Evidence generation optimizes for available screenshots instead of useful proof. A fixed six-frame storyboard can hide the actual before/action/result/proof arc, and raw recordings remain debug artifacts rather than user-facing evidence.

Minimal general design:

- Add a product-agnostic selection gate after Discovery normalization and before Explorer:
  - Derive a capability expectation for every non-`not_applicable` capability using general signals: centrality to the learned value loop, product-native material action/output, existing importance, selected scenario coverage, and whether the related surfaces are peripheral/setup/external.
  - Use only three evaluator-facing buckets: `must_test`, `should_test_or_explain`, and `not_normally_tested`.
  - Do not hardcode named products or inflate a large product-kind enum matrix. Existing product kinds may supply generic materiality priors, but the gate decision must be explainable in plain language.
- Repair or flag the selection:
  - `must_test` capabilities require at least one selected material scenario unless they are truly blocked/unsafe/external.
  - `should_test_or_explain` capabilities may be skipped, but the report must show why and confidence/scope must reflect the skip.
  - `not_normally_tested` capabilities stay in debug/detail scope unless they block the primary value loop.
- Replace fuzzy deferral in public artifacts:
  - Report every important capability as tested, skipped with reason, or not relevant.
  - Keep raw surfaces/journeys in debug details; make the public report about product abilities and user scenarios.
- Make score authority depend on denominator coverage:
  - Selected scenario pass rate answers "did the sampled tasks work?"
  - Capability coverage answers "how much important product scope did Iris actually exercise?"
  - Any skipped `must_test` or unexplained important skip should cap confidence and make the scope limit impossible to miss.
- Replace fixed-duration primary clips with context-aware evidence reels:
  - Build clips from scenario-relevant trace anchors and label/frame roles such as before, action, result, and proof when available.
  - Prefer visual/state-change windows around evidence anchors; keep full raw recordings as debug artifacts.
  - Avoid uniform fixed six-frame output. Clip length should follow the scenario evidence arc, with bounded maximums and static-frame deduplication.

Verification plan:

- Unit/canary coverage must include archetypes rather than named-site hacks:
  - content/search product: search, read/navigate, source/history or alternate content path surfaced as tested or explicitly skipped.
  - artifact/editor product: create, revise/manipulate, style/structure, import/export/share represented as capabilities; selected tasks must include material artifact change.
  - CRUD/workflow product: create, update, status/assignment/list filtering, and destructive/unsafe boundaries handled honestly.
  - dashboard/filtering product: inspect summary, filter/sort/drill down, and verify metric/detail changes.
  - commerce/transaction-boundary product: browse/select/configure/cart and stop or explain at payment/external-risk boundary.
- Report tests must assert top-level separation between selected scenarios verified, important capabilities covered, important capabilities skipped, confidence, and scope limits.
- Evidence tests must assert variable, scenario-specific evidence reels and preserve raw recordings as debug artifacts only.
- Real e2e must be rerun from scratch on at least two different product types after implementation. The reports must pass skeptical manual audit before this goal can be marked complete.

Plan-gate constraint:

- The project AGENTS instructions require `/codex-gate`, but no Codex MCP or codex-gate tool is available in this session after tool discovery. The review trail for this goal must therefore be a written self-review plus executable tests/e2e artifacts unless the tool becomes available later.

Final validation notes:

- Timestamp: 2026-05-16 17:31 PDT.
- Fresh final e2e run, content/search archetype: `iris-runs/wikipedia-rootfix-final-20260516-171606`.
  - Target: `https://www.wikipedia.org/`.
  - Transport/model: Codex App Server, `gpt-5.5`, high reasoning for discovery/explorer/judge.
  - Result: 5/5 selected scenarios verified, 8/9 important capabilities covered, 1 important capability skipped and score-relevant.
  - Score authority: provisional, because donation/fundraising prompt handling was discovered as important product-native scope but not selected, and a minor axe image-alt finding was confirmed.
  - Manual audit: top summary clearly separates scenarios verified, important capabilities covered, important capabilities skipped, evidence confidence, findings, runtime, and rubric completeness. Header correctly reports `free mode`. No visible `Task G...`, `grounded mode`, or `tested goal` copy remains in the report HTML.
- Fresh final e2e run, artifact/editor archetype: `iris-runs/tldraw-rootfix-final-20260516-170325`.
  - Target: `https://www.tldraw.com/`.
  - Transport/model: Codex App Server, `gpt-5.5`, high reasoning for discovery/explorer/judge.
  - Result: 9/9 selected scenarios verified, 9/10 important capabilities covered, 1 important capability skipped and score-relevant.
  - Score authority: provisional, because canvas zoom/minimap navigation was discovered as important product-native scope but not selected; axe was not scored because CSP blocked instrumentation.
  - Manual audit: scenarios are material product use rather than menu-click checks: create a Q3 launch board, revise board state, style content, use non-default shapes, add note/media, reach share boundary, and export/save. Evidence clips show scenario arcs and are variable-length, not uniform fixed clips.
- Evidence reel validation:
  - Wikipedia final clip durations: finding 2.08s; scenarios 3.16s to 8.64s.
  - tldraw final clip durations: scenarios 3.16s to 10.48s.
  - Full raw recordings remain available under each run's `evidence/videos/` and primary report proof uses per-scenario reels under `evidence/clips/`.
- During the final tldraw rerun, a real post-Judge hang exposed a bug in frame thinning: the loop could fail to make progress when rounded frame indices repeated. Fixed `thinFrames()` to use a bounded for-loop and added a long-scenario evidence reel regression test.
- Final verification commands completed:
  - `pnpm --filter @iris/core test -- evidence-clips --pool=forks`
  - `pnpm --filter @iris/core test -- report-html --pool=forks`
  - `pnpm -r run typecheck`
  - `pnpm -r run build`
  - Workspace test run: 73 test files passed, 551 tests passed, 1 skipped.

## 2026-05-16 Five-product verification extension

Timestamp: 2026-05-16 17:56 PDT

Trigger:

- The active goal was strengthened after the first root-fix close: Iris must be verified on at least five distinct real software products before we call the evaluator solid.
- The previous root-fix has strong evidence for only two products: Wikipedia as content/search and tldraw as artifact/editor. That is not enough to prove generality.

Verification matrix:

- Already counted only if current artifacts remain inspectable and honest:
  - Content/search: `https://www.wikipedia.org/`, run `iris-runs/wikipedia-rootfix-final-20260516-171606`.
  - Artifact/editor: `https://www.tldraw.com/`, run `iris-runs/tldraw-rootfix-final-20260516-170325`.
- New products to run from scratch:
  - CRUD/workflow: `https://demo.playwright.dev/todomvc/`.
  - Dashboard/filtering/data grid: `https://www.ag-grid.com/example/`.
  - Commerce/cart/transaction boundary: `https://www.demoblaze.com/`.
- Backup if a target is unreachable or blocks automation for environmental reasons:
  - Commerce/auth boundary: `https://www.saucedemo.com/`.
  - Calculator/form workflow: `https://www.calculator.net/mortgage-calculator.html`.

Audit rule:

- A product counts only when the report demonstrates all of these:
  - scenario selection is explainable from the learned important-capability denominator,
  - important product-native skipped capabilities are explicit and affect score authority or confidence,
  - selected scenarios are material real use, not menu/promo/setup checks,
  - evidence reels show a meaningful scenario arc instead of uniform/static clips,
  - the top report summary makes "selected scenarios passed" visibly different from "important product scope covered."

Known risk:

- The three new targets are public products/demos, so some flows may legitimately stop at auth/payment/external boundaries. That is acceptable only if Iris explains the boundary and scope impact; silent omission does not count.

## 2026-05-17 Continuation audit

Timestamp: 2026-05-17 04:33 PDT

What changed during continuation:

- Fixed a Discovery consistency bug where a capability could be counted as covered even when its own `coverage_gap` said it belonged in a deeper or future audit. The normalizer now treats that contradiction as uncovered unless a strongly matching selected scenario is added.
- Fixed a selection-gate bug where uncovered must-test capabilities were considered already selected merely because adjacent journey IDs were selected. If no unselected existing journey covers the gap, Iris synthesizes a product-agnostic gap scenario.
- Clarified CLI summary output: scenario evidence is now reported separately from finding-draft evidence. The previous `evidence.verified=0` line was misleading because it referred to finding validation, not goal evidence.
- Added a bounded partial-goal reconciliation path: a partial can be upgraded only when cited outcome evidence satisfies the same product-use contract and outcome-artifact checks used to prevent false verified claims.

Counted product audits so far:

- Wikipedia, content/search: `iris-runs/wikipedia-rootfix-final-20260516-171606`.
  - 5/5 scenarios verified; 8/9 important capabilities covered; 1 important skipped and score-relevant.
  - Manual audit still counts this as a fair report: selected scenarios covered search/open/read/navigation/language/account boundary, and the skipped donation/fundraising scope is explicit.
- tldraw, artifact/editor: `iris-runs/tldraw-rootfix-final-20260516-170325`.
  - 9/9 scenarios verified; 9/10 important capabilities covered; 1 important skipped and score-relevant.
  - Manual audit still counts this as a fair report: evidence shows material board creation/edit/style/export/share rather than menu-only use.
- TodoMVC, CRUD/workflow: `iris-runs/todomvc-rootfix-5prod-fixed-20260516-174511`.
  - 4/4 scenarios verified; 5/5 important capabilities covered; authoritative/high evidence.
  - Manual audit counts this as fair CRUD coverage: create, complete/filter, edit/persist-ish list state, and delete/clear style workflows were exercised.
- Mortgage Calculator, form/calculator workflow: `iris-runs/mortgagecalc-rootfix-5prod-final-20260517-012840`.
  - 4/4 scenarios verified; 5/5 important capabilities covered; authoritative/high evidence.
  - Manual audit counts this as fair utility coverage: input scenarios produced changed monthly-payment outputs, amortization/output content, and related calculator/navigation scope.
- Hacker News, content/community product: `iris-runs/hackernews-rootfix-5prod-final-20260517-041900`.
  - 8/9 scenarios verified; 6/6 core capabilities covered; 11/13 important capabilities covered; 2 important skipped.
  - Manual audit counts this as fair evaluator behavior, not a high product score: story source, comments, alternate feeds, jobs, and login/submission boundary were exercised; authenticated mutation was blocked rather than faked; vote/hide and profile/domain inspection were explicit scope limits.

Negative/productive audits not counted as clean passes:

- DataTables:
  - `iris-runs/datatables-rootfix-5prod-final-20260517-025616` originally looked strong, but exposed a misleading evidence summary and over-counted a manual/reference capability.
  - `iris-runs/datatables-rootfix-5prod-final2-20260517-031645` correctly refused to overclaim after the fix, marking implementation/source-code reading as skipped.
  - `iris-runs/datatables-rootfix-5prod-final3-20260517-033200` still produced only 1/5 verified; this remains an execution/proof weakness for developer-doc/data-grid products.
- SauceDemo:
  - `iris-runs/saucedemo-rootfix-5prod-final10-20260517-034300` improved to 2/4 verified and kept locked-out login in scope.
  - `iris-runs/saucedemo-rootfix-5prod-final11-20260517-040600` improved to 3/5 verified with all core capabilities covered, but standard login and cart remained partial despite trace evidence showing inventory and cart state. This indicates remaining friction in product-use required-action windows and partial-to-verified reconciliation.
- BMI Calculator:
  - `iris-runs/bmicalc-rootfix-5prod-final-20260517-035600` produced 2/6 verified and revealed a classification gap: form/calculator products can be over-read as content/search when result pages contain rich educational text.

Remaining confidence note:

- The five counted products now cover content/search, artifact/editor, CRUD/list workflow, calculator/form workflow, and content/community navigation. That is materially broader than the original two-product state.
- I am not fully satisfied with Iris on transaction-boundary commerce or developer-doc/data-grid products. The evaluator is much more honest about those gaps now, but not consistently capable enough to count those runs as clean passes.

Final automated verification:

- Focused changed-path tests passed:
  - `pnpm --filter @iris/core exec vitest run src/scenario/scenario-data.test.ts src/discovery/discovery.test.ts src/judge/goal-claim-validator.test.ts src/report/report-json.test.ts src/report/report-md.test.ts src/report/report-html.test.ts src/report/evidence-clips.test.ts --pool=forks`
  - `pnpm --filter @iris/cli exec vitest run src/scenario-completion-gate.test.ts src/render/summary.test.ts --pool=forks`
- Workspace verification passed:
  - `pnpm -r run typecheck`
  - `pnpm -r run build`
  - `pnpm -r run test -- --pool=forks`
- Full test sweep result: each workspace package completed with 73 test files passed, 562 tests passed, 1 skipped.

## 2026-05-17 Known gap fix and system audit research

Timestamp: 2026-05-17 15:27 PDT

Trigger:

- The five-product breadth goal was met, but the final notes kept three classes open: transaction-boundary commerce/auth, developer-doc/data-grid proof, and form/calculator classification.
- The user asked to fix those first, then zoom out across system design, prompt design, wiring, data/module/prompt flow, brittleness, duplicates, and bugs with multiple agents.

Current gap evidence:

- Commerce/auth: `iris-runs/saucedemo-rootfix-5prod-final11-20260517-040600` ended `3/5` verified with medium confidence. The earlier note says all core capabilities were covered, but standard login and cart stayed partial despite trace evidence showing inventory/cart state. This points at proof reconciliation and scenario-gate semantics, not only Explorer behavior.
- Developer-doc/data-grid: `iris-runs/datatables-rootfix-5prod-final3-20260517-033200` ended `1/5` verified. The preceding DataTables attempts exposed both sides of the problem: over-counting manual/source-code reading when it is only deeper documentation scope, then under-proving material data-grid interactions.
- Calculator/form: `iris-runs/bmicalc-rootfix-5prod-final-20260517-035600` ended `2/6` verified and exposed a classification gap where rich result/educational text can make a calculator look like content/search even though the primary loop is form inputs -> computed output.

Relevant code paths:

- Discovery normalization and product-kind repair: `packages/core/src/discovery/discovery.ts`.
- Discovery archetype tests and canaries: `packages/core/src/discovery/discovery.test.ts`.
- Scenario required-output extraction: `packages/core/src/scenario/scenario-data.ts`.
- Scenario completion gate: `packages/cli/src/scenario-completion-gate.ts`.
- Goal claim validation and partial-to-verified reconciliation: `packages/core/src/judge/goal-claim-validator.ts`.
- Report score authority and capability coverage: `packages/core/src/report/evaluation.ts`.
- CLI summary honesty: `packages/cli/src/render/summary.ts`.

Constraints:

- Fix generic evaluator behavior, not named-site branches.
- Keep public scope semantics small: must test, should test or explain, not normally tested.
- Do not make partial scenarios look verified unless cited evidence satisfies the same product-use and outcome-artifact checks.
- Do not punish product score for evaluator scope gaps; cap score authority/confidence instead.
- Use written artifacts and verification logs because chat context is not durable.

Implemented generic fixes:

- Scenario proof extraction now preserves structured visible values (`Product: Sauce Labs Backpack`, `Search: London`, `Sort column: Age`) and drops non-visible inputs/absence prose from proof gates.
- Scenario gates and goal-claim validation now read `probe_result` UI-state text/selectors as proof evidence.
- Auth gates no longer verify from typed credentials alone; commerce/auth inventory gates require post-login product/inventory text.
- Discovery now infers `calculator_tool`, `data_grid`, and `developer_documentation` and applies specific scaffolds for computed results, row/count/order/range proof, and concrete code/API/dependency proof.
- Report JSON now refuses `threshold_passed` when score authority is `insufficient`.
- Capability runtime coverage now treats linked partial goals as partial before counting linked verified goals as covered.

Focused verification so far:

- `pnpm --filter @iris/core exec vitest run src/scenario/scenario-data.test.ts src/discovery/discovery.test.ts src/judge/goal-claim-validator.test.ts src/report/report-json.test.ts --pool=forks`
- `pnpm --filter @iris/core build`
- `pnpm --filter @iris/cli exec vitest run src/scenario-completion-gate.test.ts src/render/summary.test.ts --pool=forks`
- `pnpm -r run typecheck`
- `pnpm -r run build`
- `pnpm -r run test -- --pool=forks`
- Full workspace result: each package reported 73 test files passed, 571 tests passed, 1 skipped.
