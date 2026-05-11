# Iris Phase 5 — Honest Signal Design

**Date:** 2026-05-10
**Status:** Spec, pre-plan. Decisions locked per user direction; awaiting spec review before plan.
**Prior context:** `research.md` (project root) — diagnosis and gap inventory that drove this scope.

---

## Goal

Take Iris from "polished report over a thin investigation" to "trustworthy signal a real user can act on." Four changes, picked because each one fixes a way Iris currently lies to its consumer.

## Non-goals (explicit cuts)

- Flake reduction beyond what falls out naturally — defer.
- Fix-suggestion synthesis (`suggested_patch` per finding) — defer to Phase 6.
- Hierarchical multi-explorer fan-out for large apps — defer to Phase 6.
- Video-edit pass / dead-air trimming — defer; cosmetic given the bigger lies in the report.
- Cross-app score calibration — defer; needs a corpus first.

If we land these four well, the next phase has a real foundation to build on. If we land eight of them shakily, we have a slightly bigger toy.

## Persona

A real user who wants to use the product. Two embodiments share the same primitives:

- **Programmatic consumer** (Otto, CI, scripts): reads `report.json` and `diff.json`. Doesn't see HTML. Needs stable schemas, evidence backing, and delta signal.
- **Human shipping a product**: reads `report.html`. Needs a verdict, the 3-5 most important findings with visual evidence, and "is this worse than last time."

Both fail today for the same root reason — Iris reports things it didn't actually verify. Fix the epistemics and both personas get served.

---

## Architecture changes

Four pieces, ordered by dependency. Each piece is independently shippable: G1 alone improves the run, G2 alone catches broken apps, etc. We ship them in order but a halt after any one of them still leaves Iris better off.

```
[adapter.start] → [preflight (G2)] → [Explorer w/ per-goal budgets (G1)]
                       │                          │
                       ▼ blocked                  ▼
                  early exit             [Judge] → [evidence validator (G3)] → [report]
                                                                                  │
                                                       [iris diff prev curr (G4)] ▼
                                                                              diff.json/html/md
```

---

## G1 — Per-goal budgets & honest scoring

### Problem

One global `--max-steps` (default 60) caps the whole run. The Explorer can spend all 60 turns on goal 1, leaving goals 2-N untested. The Judge then averages over all goals — penalizing the score for goals that were never reached. Users see "5.0/10" and read "this app is mediocre" when the truth is "we didn't get to test most of it."

### Design

**Budget allocation:**
- New flag `--steps-per-goal <n>` (default `10`). Cap per attempted spec goal.
- New flag `--free-exploration-steps <n>` (default `8`). Tail budget for unguided exploration.
- Effective `max_steps = (goals_count × steps_per_goal) + free_exploration_steps`, hard-capped by `--max-steps` if user passes one explicitly. (Keeps the single-cap escape hatch.)
- If the user passes `--max-steps` and not `--steps-per-goal`, fall back to old behavior (no per-goal cap) — backwards-compatible escape hatch.

**Explorer loop changes:**
- Explorer state gets a `current_goal_id` and `turns_spent_on_current_goal`.
- The system prompt instructs the Explorer: "You have ~`steps_per_goal` turns for this goal. When you're done, or when you've spent your budget, call `mcp__iris__goal_status` with one of: `verified`, `partial`, `blocked`, `skipped`, then move to the next."
- New MCP/native tool `goal_status({ id, status, rationale })` — emits a `goal_status` trace event and transitions Explorer state to the next goal.
- Hard cutover: if the Explorer exceeds `steps_per_goal × 1.5` turns on one goal without calling `goal_status`, the loop auto-emits a `goal_status: partial` with rationale `"budget exceeded without explicit completion"` and force-moves to the next goal. (Prevents the model from ignoring the budget.)
- Free-exploration phase runs after all goals are attempted (or after `goal_status: skipped` on the last one). Goal state during this phase is `__free__`.

**Scoring math:**
- Per-rubric-dimension scoring is unchanged.
- Spec-compliance score: average **only over attempted goals** (`verified` + `partial` + `blocked`). `skipped` and untouched goals don't count toward or against the average.
- Report headline: include `goals_attempted / goals_total` and `goals_verified / goals_attempted` as separate numbers. Score line no longer pretends to summarize the unattempted goals.
- TL;DR sentence is rewritten: "Iris tested N of M goals and verified K. The remaining M-N were not exercised — see Caveats." Lower coverage explicitly weakens the verdict instead of silently dragging the score down.

### What this is not

This is not hierarchical exploration. One Explorer still runs the whole show, just with a turn budget per goal. Hierarchical fan-out is Phase 6.

### Trade-offs

- **Cost goes up** when `goals_count` is large — by design. A spec with 10 goals will use ~108 turns instead of 60. Users get to override with `--max-steps`.
- **The Explorer may rush** if `steps_per_goal` is too low. Default of 10 was picked empirically (TodoMVC needed ~3 turns per goal in tuning; complex flows need more headroom).
- **`goal_status` adds a tool the Explorer must learn.** Mitigated by the auto-cutover fallback.

---

## G2 — Preflight: detect broken apps before scoring them

### Problem

If the target returns 500, never finishes loading, or throws a JS error that wipes the React tree, the Explorer happily calls `axe` on the broken page and the Judge writes findings about the empty DOM. The score comes back around 4-5/10 with a polished memo. A real user can tell in three seconds; Iris can't tell at all.

### Design

**New pipeline phase** between `adapter.start()` and `Explorer.run()`: `preflight(adapter, target)`. Runs four fast checks; returns `{ ok: boolean, reasons: PreflightFailure[] }`.

**Preflight checks** (all run, all results returned — don't stop at first failure, the user needs to see all of them):

1. **HTTP status**: navigation response was 2xx/3xx (not 4xx/5xx). Uses the existing network probe.
2. **Page finished loading**: `domcontentloaded` + `networkidle` reached within `preflight_timeout_s` (default 15s).
3. **No fatal JS error during load**: console has no `error`-level entries containing keywords like `Uncaught`, `TypeError: Cannot read`, `Minified React error`. (Match list configurable; tuned to avoid false positives from normal warnings.)
4. **Page has real content**: body has ≥30 visible text characters OR ≥5 interactive elements (links/buttons/inputs). Distinguishes a blank crash from a real app, including SPAs.

**On preflight failure:**
- Emit a single `blocked` finding in `report.json` describing all failed checks with evidence (status code, first console error, screenshot of the broken page).
- Skip Explorer and Judge entirely.
- Exit code: `4` (new code, `blocked`). Distinct from `1` (threshold not met), `2` (budget abort), `3` (infrastructure error).
- Report renders a **blocked banner** at the top instead of a score. No "5.0/10" — that would be a lie.
- `--print-summary` JSON includes `"blocked": true, "blocked_reasons": [...]`.

**On preflight pass:**
- Run continues normally. Preflight result still emitted as a trace event for the Judge to read (it should know the page was healthy).

### Trade-offs

- **False positives on slow apps**: a real app that takes 20s to bootstrap looks broken. Mitigated by configurable `--preflight-timeout-s` and the network-idle check (won't fire until the app is actually quiescent).
- **False positives on apps that warn at load**: noisy SaaS dashboards log warnings on every page. Mitigated by matching only specific fatal patterns, not all `error`-level entries.
- **One canary interaction was considered but cut from scope** — adds complexity (which element to click?) and the four passive checks above are 90% of the value.

### Rejected alternative

Letting the Judge detect "the app is broken" from the trace post-hoc. Rejected because it wastes the Explorer/Judge cost on a known-bad target and the false-positive rate would be much higher (Judge would need to infer from indirect signals).

---

## G3 — Evidence-enforced findings

### Problem

The Judge gets a text digest of the trace and emits findings with `evidence: string[]` of event IDs. Nothing validates the cited IDs exist or that the cited events actually back the finding. With a confused prompt or a hallucinating model, "the modal traps focus" appears in the report whether or not a modal was ever observed.

### Design

**New post-Judge stage:** `validateFindings(judgeOutput, trace) → ValidatedFindings`. Runs deterministically (no LLM), between Judge output and report generation.

**For each finding:**

1. **Citation existence check**: every event ID in `finding.evidence` must exist in the trace. If zero of the cited IDs exist, the finding is **discarded** with reason `"all_evidence_ids_invalid"`. Logged in `discarded_findings`.

2. **Backing classification** (for severity ≥ `minor`): at least one of the following must be true within the cited events or in a ±2-turn window around them:
   - A `screenshot` event exists.
   - A `console_error` event exists with non-empty error text.
   - A `network_response` event with status ≥400 exists.
   - An `axe_result` event referencing the violation rule exists (matched by axe `ruleId` if the finding category is `a11y`).
   - A `dom_snapshot` or `observe` event with non-empty content exists.
   - The Judge explicitly emitted a `tentative_finding` trace event with matching content during the Explorer phase (means the Explorer flagged it live, not the Judge inventing it later).

3. **Action on missing backing**:
   - Severity = `blocker` or `major` with no backing → **downgrade one tier** AND mark `unverified_backing: true`. (Don't drop — sometimes the Judge is right and the trace is sparse. Let users see it but flag it.)
   - Severity = `minor` or `nit` with no backing → **downgrade to `suggestion`** AND mark `unverified_backing: true`.
   - Severity = `suggestion` → unaffected. (Suggestions are Tier-2 open-ended observations; evidence not required.)

4. **Discarded findings** go into `discarded_findings.json` with `reason` and the original (unmodified) Judge output. Keeps the audit trail.

**Report integration:**
- New "Data integrity" line near the headline: e.g., `"12 findings → 9 verified, 2 downgraded, 1 discarded."` Lives in the TL;DR section.
- Downgraded findings render with a small `unverified` tag next to the severity prefix. No louder; users who care can see it.
- `report.json` schema adds `findings[].unverified_backing: boolean` and `evidence_validation: { verified, downgraded, discarded }`.

### Trade-offs

- **Finding count drops.** Expected and desirable. We measured ~10-15% Judge fabrication rate on TodoMVC runs; the same model on real apps will be worse. Some users equate count with thoroughness — the report's TL;DR has to handle this framing.
- **Some real findings get downgraded.** A real bug the Judge correctly identified but whose evidence the trace digest fuzzed away will get a `suggestion` label. Acceptable cost — a low-severity true positive is worse than a high-severity false positive.
- **The ±2-turn backing window is heuristic.** A modal focus-trap bug might emit no console error or network failure and only manifest as a screenshot pattern. The screenshot count condition catches most of these. Iterate on the window/rules with real bench data.

### Rejected alternatives

- **LLM-based validation** (a second model checks the first). Rejected: doubles cost, adds another fallible model in the loop. Deterministic rules give a stronger guarantee.
- **Forcing the Judge to emit only findings with backing** (prompt-level). Rejected: prompt instructions are unenforceable; we need a real check. Keep the rule in the prompt too as belt-and-suspenders, but don't rely on it.

---

## G4 — Run-to-run delta

### Problem

Every run is a snapshot. A real user (and Otto especially) cares about "what changed since last time" — that's the load-bearing signal for closing a build loop. Without delta, Iris produces a verdict per build but no story across builds.

### Design

**Stable finding identity.** Each finding gets a `finding_hash` field, computed at report-generation time:

```
finding_hash = sha1(
  normalize(title) + "|" +
  category + "|" +
  severity_bucket(severity) + "|" +
  sorted(evidence_event_hashes)
)
```

Where:
- `normalize(title)` = lowercase, collapse whitespace, strip leading numbers/IDs.
- `severity_bucket()` = collapse `nit`+`suggestion` → `low`, `minor` → `med`, `major`+`blocker` → `high`. Keeps identity stable when the Judge waffles between adjacent severities.
- `evidence_event_hashes` = stable hashes of cited trace events (see below).

**Stable trace event hashes.** Each trace event gets a `content_hash` at write time:

```
event_content_hash = sha1(
  kind + "|" +
  actor + "|" +
  canonical_payload_signature(payload)
)
```

Where `canonical_payload_signature` extracts kind-specific stable fields. For example, an `action` event hashes on `(tool_name, selector_normalized, value_truncated)` — not on absolute coordinates or ULID. A `console_error` hashes on the first 80 chars of the message after stripping line numbers and stack traces. (Per-kind signature functions live in `core/src/trace/identity.ts`.)

**New CLI verb:** `iris diff <prev_run_dir> <curr_run_dir>`

Output: `diff.json`, `diff.html`, `diff.md` in CWD or `--out <dir>`.

Diff structure:

```json
{
  "v": 1,
  "prev": { "run_id": "...", "target": "...", "score": 5.0 },
  "curr": { "run_id": "...", "target": "...", "score": 6.5 },
  "score_delta": {
    "overall": +1.5,
    "by_profile": { "ux": +1.0, "a11y": +2.0 }
  },
  "findings": {
    "fixed":      [ /* in prev, not in curr — by hash */ ],
    "new":        [ /* in curr, not in prev */ ],
    "persistent": [ /* in both */ ]
  },
  "coverage_delta": {
    "newly_tested_goals":   ["G3", "G4"],
    "no_longer_tested":     [],
    "verification_changes": [ { "id": "G1", "prev": "partial", "curr": "verified" } ]
  }
}
```

**Targeting:**
- v1 only supports same-target diffs (target URL matches between prev and curr). Cross-target diff is meaningless. Emit a warning and exit 64 if targets differ.
- "Same target" means URL equality after stripping query/fragment, OR explicit `--allow-target-mismatch`.

**HTML diff report:** A condensed view — fixed (green), new (red), persistent (gray). No full rubric breakdown — diff is about *change*. Link back to the two source reports for detail.

**`--print-summary` for diff:**

```json
{"fixed": 3, "new": 1, "persistent": 5, "score_delta": +1.5, "coverage_delta": +2}
```

That single line is what Otto reads to close its loop.

### Trade-offs

- **Hash collisions / instability.** The trace event hash design is the load-bearing piece. Get it wrong and identical bugs across runs hash differently, producing all-new / all-fixed noise. Mitigation: aggressive unit-test coverage with synthetic traces, plus a `--diff-debug` flag that dumps the hash inputs for inspection.
- **Cross-version compat.** `iris diff` must handle prev runs from before this phase (no `finding_hash`). Compute hashes lazily from prev `report.json` if missing.
- **`canonical_payload_signature` is kind-specific code.** Adds maintenance: every new event kind needs a signature function. Acceptable — the kind list is small (~12 today).

### Rejected alternatives

- **LLM-based diff** ("ask Claude what changed"). Rejected: non-deterministic, expensive, can't be cached. Otto can't trust it.
- **Time-series storage** (run history per target, multi-run trends). Tempting but scope creep. v1 is just `diff(A, B)`; trend storage is a downstream consumer's job.

---

## Cross-cutting concerns

### `report.json` schema v2

Bump `v: 1` → `v: 2` with additions:
- `preflight: { ok, checks: [...] }` block at top level (may be `null` if preflight ran and passed, populated if it failed).
- `findings[].finding_hash: string`
- `findings[].unverified_backing: boolean`
- `evidence_validation: { verified: N, downgraded: N, discarded: N }`
- `spec_compliance.goals[].status: "verified" | "partial" | "blocked" | "skipped" | "untested"` (rename for clarity; old `satisfied`/`not_satisfied` keys map forward).
- `headline.goals_attempted` and `headline.goals_verified` as first-class numbers; `headline.score` unchanged (averages only over attempted goals).

Backwards compat: `iris diff` accepts v1 reports as `prev` (computes hashes on the fly); `iris eval` always emits v2.

### `--print-summary` JSON

Add fields:
```json
{
  "blocked": false,
  "goals_tested": "3/7",
  "goals_verified": "2/3",
  "evidence_verified": "9/12",
  "score": 6.5,
  "exit_code": 0
}
```

### Exit codes

- `0` — pass (threshold met or no threshold)
- `1` — threshold not met
- `2` — budget abort (steps/cost/time)
- `3` — infrastructure error (adapter failed, Judge crashed)
- `4` — blocked (preflight failed) — **new**

### CLI surface additions

```
iris eval <target> [...existing flags]
  --steps-per-goal <n>           default 10
  --free-exploration-steps <n>   default 8
  --preflight-timeout-s <n>      default 15
  --no-preflight                 skip preflight (debugging only)

iris diff <prev_run_dir> <curr_run_dir>
  --out <dir>
  --allow-target-mismatch
  --diff-debug                   dump hash inputs
  --print-summary
```

---

## What success looks like

For each piece, the verification criterion in the plan will be system-level (not unit tests):

- **G1**: Run on TodoMVC with full 7-goal spec at default budgets → all 7 goals attempted, score reflects only what was tested, TL;DR explicitly notes coverage.
- **G2**: Run on a deliberately broken fixture (404, JS crash, blank page) → terminates with `blocked` verdict in <20s, exit code 4, no fake score.
- **G3**: Run on TodoMVC, manually corrupt the Judge output to include a fabricated finding with bogus event IDs → that finding gets discarded; report shows correct integrity stats.
- **G4**: Run Iris twice on the same target with a small intentional bug fix between runs → `iris diff` shows the fixed finding in `fixed[]`, identifies persistent findings, score delta direction is correct.

All four together: re-run the 8 bench fixtures. Pass rate should equal or exceed current (8/8), but with broken-app fixtures correctly blocked (currently fail silently), and the score on partial-coverage runs reflecting coverage honestly.

---

## Open risks

1. **The `goal_status` tool may confuse the Explorer.** Need to test with the SDK transport specifically — MCP tool registration there has been finicky.
2. **The auto-cutover heuristic (1.5× per-goal budget) may strand the Explorer mid-action.** May need an in-grace-period escape that lets one tool call complete.
3. **Evidence backing rules will need bench-driven tuning.** Plan should include a "compare verified vs discarded counts across all 8 fixtures" verification step.
4. **Schema v2 migration**: existing run directories on disk are v1. The plan must handle this without breaking the bench runner that reads `report.json`.

---

## Self-review notes

- Placeholder scan: no TBDs, no "implement later," every section has a concrete design.
- Internal consistency: G1's goal-status enum (`verified|partial|blocked|skipped`) is referenced consistently in G3 (evidence validation runs on findings, not goals — no overlap) and G4 (coverage delta uses the same enum). G2's `blocked` exit code (4) is distinct from G1's `blocked` goal-status (different namespaces — exit code applies to the run, goal-status applies to one spec goal).
- Scope check: four pieces, each independently shippable, ordered by dependency. Each cuts a real lie Iris currently tells.
- Ambiguity check: `severity_bucket()` mapping for finding hash is explicit. Per-kind signature functions are deferred to the plan (one per event kind).
