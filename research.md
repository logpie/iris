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
