# Iris Phase 7 — Less Noise

**Date:** 2026-05-11
**Status:** Spec. Driven by Phase 6 dogfood findings + open limitations.

---

## Goal

Phase 5 made the signal honest. Phase 6 made it trustworthy. Phase 7 reduces upstream noise so honest+trustworthy reports are also *actionable* and *less polluted*.

Three pieces:
- **F7-1** — Adapter retries selector misses with alternate strategies before returning failure.
- **F7-2** — Validate Phase 6 F2 (Judge ensemble) on bench. Make default-on if variance drops.
- **F7-3** — Actionable fix-suggestions: Judge emits structured `suggested_fix` with code-level specifics.

## Non-goals (explicit cuts)

- **Auth / session-state handling**: needs real test accounts to dogfood; not in scope for a single phase. Hand-wave: `--storage-state path/to/state.json` plumbing later.
- **Hierarchical multi-Explorer**: structural change, defer to Phase 8. Doesn't blend with the noise-reduction theme of this phase.
- **GitHub Action / CI integration**: pure infra. Useful but not what's blocking trust/actionability.
- **Stagehand-style action caching**: cost optimization. Cool but a distraction.

## Why these three

### F7-1 — Selector retry

Real-world Phase 5 dogfood:
- Vercel: 8 failed action_results per run.
- HN: 12 failed action_results.
- TodoMVC: 2.

A large fraction of those failures are the Explorer guessing a CSS selector that doesn't quite match. Phase 6 F1 caught these post-hoc and downgraded findings that cited them. F7-1 attacks the same problem upstream: when a `click`/`hover`/`wait_for` fails with "resolved to 0 elements" or "no element found", the adapter tries alternate selector strategies (role-based, text-based, accessible name) before reporting failure. Reduces noise at the source.

### F7-2 — Validate F2

Phase 6 F2 shipped but wasn't exercised on a target with critical findings (TodoMVC ran clean). Without measurement of variance reduction, we can't make ensemble default-on. F7-2 is a validation gate: run bench with `--judge-ensemble`, compare to non-ensemble bench, measure variance.

### F7-3 — Actionable fix-suggestions

The Judge already emits `suggested_fix: {type, summary}`. The summary is one sentence. For Otto closing a build loop, "Add aria-label to button" isn't enough — it needs to know *which* button. For human reviewers, "improve a11y" reads as filler.

Restructure: `suggested_fix: {type, summary, code_pointer?, patch_hint?}`. `code_pointer` is `{selector, attribute, current_value, suggested_value}` when applicable. `patch_hint` is a one-line natural-language description of the change a developer would make. Judge prompt updated to populate these when evidence supports it.

---

## F7-1 — Selector retry in the adapter

### Problem

Real example from Phase 5 Vercel trace:
```
locator.click: Error: strict mode violation: locator('h1') resolved to 2 elements
locator.click: Error: locator('a[href*="signup"]') resolved to 2 elements
locator.waitFor: locator('button[id*="trigger"]') resolved to 3 elements
```

The Explorer chose a selector. Playwright's strict mode rejected the ambiguous match. The Explorer either retried with a different selector (Explorer turns wasted) or gave up. Either way the trace is polluted with failures the user doesn't care about.

### Design

When an action tool (`click`/`hover`/`type`/`wait_for`) fails with a selector-related error, the adapter automatically retries with 1-2 alternate strategies before returning failure. The Explorer sees ONE retry-failure or ONE success.

**Retry strategies** (tried in order):

1. **First-match fallback for strict-mode-violation**: if the selector resolved to multiple elements, automatically retry with `.first()`. Playwright's "strict mode" was added to catch ambiguity; for an Explorer-driven test, "click the first matching element" is usually the right behavior.
2. **Role-based retry**: if the selector pattern is `text=...` or includes a button/link descriptor, retry with `getByRole(...)`. Heuristic: extract the visible text, try `page.getByRole('button', {name: ...})` then `page.getByRole('link', {name: ...})`.
3. **No more retries**: if both fail, return the ORIGINAL error to the Explorer (so the Judge sees the actual failure, not a hidden one).

Retry budget: max 2 alternate attempts per call. Each retry has a 2s timeout (shorter than the default).

**Trace transparency**: every retry attempt emits a `retry_attempt` event in the trace so the Judge and validator can see what happened. The final `action_result` carries `retried: true` and `retry_count: N` in its payload. This means an action that succeeded only after retry is still flagged for review (it suggests the Explorer's first selector was wrong).

### Implementation surface

- New helper `actionWithRetry(page, tool, args, retries)` in adapter-web/src/tools/.
- `click`/`hover`/`type`/`wait_for` call sites updated to use the helper.
- New trace event kind `retry_attempt` (small payload: tool, original_selector, retry_strategy, retry_ok).
- `action_result` payload schema extended with `retried?: boolean, retry_count?: number`.
- Evidence-validator: a successful-after-retry `action_result` is NOT backing evidence (the failure was Explorer error, the success was the retry).

### Trade-offs

- **Hides Explorer mistakes from the surface trace.** Mitigation: `retry_attempt` events keep the audit trail.
- **Adds latency on selector-miss paths.** Each retry is ≤2s; 2 retries = ≤4s extra per failing action. Real-world cost: a Vercel run with 8 failures × 2 retries × 2s = up to 32s extra. Acceptable.
- **First-match fallback may click the wrong element.** Conservative mitigation: don't retry destructive actions (`type` with text, `press` of dangerous keys). The default for ambiguous click-targets matches Playwright's pre-strict-mode behavior; users found this acceptable for years.

### Verify

Re-run Vercel. Compare failed action_results pre/post F7-1. Expectation: at least 50% of the previous selector-miss failures now succeed (with retry markers), reducing noise. F1's `likely_explorer_error` downgrades correspondingly drop.

---

## F7-2 — Validate F2 ensemble on bench

### Problem

Phase 6 F2 shipped a Judge ensemble feature but only ran it on TodoMVC, which produces 0 critical findings — no ensemble dedupe possible. The unit tests pass but the real question (does ensemble reduce variance?) is unanswered.

### Design

Run the existing bench twice:
1. Once with default settings (current 12/12 baseline at $4.62).
2. Once with `--judge-ensemble` flag added.

Measure for each of the 8 known-bug fixtures:
- Score (mean and stddev across the two passes).
- Finding count.
- Validator stats (verified/downgraded/discarded).
- Ensemble metadata (agreed_critical / disagreed_critical).

Compare. Decide:
- If ensemble reduces variance on critical findings, make it default-on (or document `--judge-ensemble` as recommended).
- If it doesn't, keep it opt-in or remove it.

### Implementation surface

- One-time bench run with extra flag.
- Document results in `docs/bench.md` and project memory.
- Update `scripts/bench.ts` to pass `--judge-ensemble` when `IRIS_BENCH_ENSEMBLE=1` env var is set, so the result is reproducible.

### Trade-offs

- **Extra cost**: roughly another $4-5 for the second bench pass.
- **Time**: ~15 min wall-clock with the existing bench.

### Verify

Two bench runs complete with metrics captured. Result documented honestly: "ensemble reduces variance from X to Y on critical findings" OR "no measurable improvement; ensemble stays opt-in."

---

## F7-3 — Actionable fix-suggestions

### Problem

Phase 3 introduced `suggested_fix: {type, summary}`. The summary is a one-liner like "Add a11y label" or "Use aria-modal". Useful as a hint, not actionable for an automated builder agent or a human developer trying to triage.

### Design

Restructure `suggested_fix` to:

```ts
suggested_fix?: {
  type: string;                    // 'a11y', 'copy', 'logic', 'process' — same as today
  summary: string;                 // one-line description (same as today)
  // Phase 7 additions, optional — Judge populates when evidence supports them:
  code_pointer?: {
    selector: string;              // CSS or role-name selector for the offending element
    attribute?: string;            // which attribute to change (e.g. 'aria-label')
    current_value?: string;        // what it is today (per the trace evidence)
    suggested_value?: string;      // what to change it to
  };
  patch_hint?: string;             // one-line developer-facing description ("Set role='dialog' and aria-modal='true' on .modal-root")
}
```

The Judge prompt is updated to populate `code_pointer` when:
- The cited trace evidence includes a selector (from `action`/`action_result` payloads).
- The bug category is `a11y`, `bug`, or `ux` (not `process` or `suggestion`).

For findings without trace selectors, only `summary` and `patch_hint` are populated.

### Implementation surface

- `JudgeFindingSchema`: extend `suggested_fix` shape.
- Judge prompt: add a section explaining when/how to populate the new fields.
- Report HTML: render `code_pointer` as a small code block under each finding; render `patch_hint` inline next to the existing Fix label.
- `for_builder` next-actions in `report.json`: include `patch_hint` and `code_pointer` so Otto can act on them.

### Trade-offs

- **Larger Judge prompt** → small cost increase (~5%).
- **Risk of fabricated selectors**: Judge might invent selectors not present in trace. Validator update: if `code_pointer.selector` doesn't appear in any `action` event in the trace, drop the code_pointer (keep summary/patch_hint). This is a deterministic check.
- **Some findings have no clean code-pointer**: process findings, perf findings, generic UX critique. Schema makes the fields optional; Judge skips when not applicable.

### Verify

Run on Vercel + bench fixture 08 (many-small-issues, known to have typos). Expectations:
- At least 50% of bug/a11y findings should have a `code_pointer`.
- Validator should drop any fabricated selectors (test with a fake Judge output citing a non-trace selector).
- Report HTML renders the new structure correctly.

---

## Out of scope

- Auth/session
- Hierarchical exploration
- GitHub Action
- Action caching
- LLM-based validator/fix-suggestion (we keep validation deterministic)

## Self-review

- F7-1 is the riskiest piece — it changes adapter behavior. Trace transparency (retry_attempt events) is the safety net.
- F7-2 is just measurement; no code-path risk.
- F7-3 is schema-extension; downstream consumers tolerate optional fields.
- Each piece is independently shippable. Order: F7-1 first (changes traces), then F7-2 (depends on stable traces), then F7-3 (depends on validated Judge behavior).
