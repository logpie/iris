# Iris — ideal state

This is the bar Iris must clear to be a "real end-product evaluator."

## The single test

> A careful human reviewer who manually uses the same product for the same amount of time would broadly agree with Iris's report.

"Broadly agree" means:
- The major claims line up (works / broken / not tested).
- No claim is materially false in either direction.
- Caveats and limitations are surfaced where the human would also caveat.

If the human and Iris diverge on the headline conclusion (works / doesn't), Iris fails. Disagreement on detail is fine.

## What "works" should produce

On a known-working popular app, Iris must:

1. **Identify the product correctly** — the discovery `product_description` is recognizable to anyone who has used the app.
2. **Propose user-shaped goals** — the goal list looks like what a normal user would try, not a developer's smoke test.
3. **Attempt enough goals to be meaningful** — at least half of the proposed goals receive real interaction (verified / partial / blocked / valid untested with a reason). "All untested because budget" on a single goal is a coverage failure.
4. **Verify outcomes the user can see** — every `verified` survives screenshot audit. No fakes. No verified-by-side-effect.
5. **Not fabricate failures** — zero findings whose text disagrees with what a screenshot shows. If Iris reports "X is broken" and a screenshot proves X works, Iris fails.
6. **Be explicit about its own gaps** — when an interaction failed because the agent's selector was wrong, or a region wasn't sampled, that gets a caveat in `meta.confidence_caveats`, NOT a "the product is broken" finding.

## What "broken" should produce

On a known-broken app or a broken flow, Iris must:

1. **Surface the real bug** — the broken thing appears as a finding with evidence that a reviewer can re-trace.
2. **Cite reproducible evidence** — every finding's `evidence` array points at trace events whose payload supports the claim (post-interaction observation showing the bad state, console error, failed network call, visible error message).
3. **Score reflects severity** — blockers actually block; minors are minor.

## Specific invariants (testable)

| Invariant | Why it matters |
|---|---|
| For every `verified` goal: at least one cited evidence event contains an outcome artifact the contract returned. | No fakes pass. Already enforced by goal-claim validator. |
| For every "the product X is broken" finding: there exists either (a) a console error, (b) a failed network call, (c) an observation containing visible error text, or (d) a vision_describe quote naming the broken state explicitly. | Prevents fake findings invented from Iris's selector misses or scope mistakes. |
| If the same primitive succeeded later in the trace, an earlier failure does NOT support a finding. | Prevents "first selector didn't work" being escalated to a product complaint. |
| If a goal was attempted but the trace contains no observation showing either success or visible failure, the goal MUST be marked `untested` (with caveat), not `blocked` or used as evidence for a finding. | Distinguishes instrumentation gaps from product defects. |
| At least 50% of discovered goals get attempted (verified / partial / blocked) before the run ends, or there's a structural reason (preflight failure, access block, all-budget-on-one-goal cutover). | Coverage failure mode is reported, not hidden. |
| The score should not exceed 7.0 when the spec-compliance coverage (attempted / total) is below 50%. | A "passes threshold" verdict on a barely-tested product is misleading. |
| The trace digest the Judge sees contains the full RICH CONTENT section of each observation, not a 120-char prefix. | Already fixed in Phase 11. |
| Auto-cutover fires when the agent burns ≥1.5× the per-goal budget on one goal without calling `goal_status`. | Prevents stuck-on-one-goal failures (current SDK transport gap). |

## What's NOT in scope for the ideal

- Iris does not need to find every minor bug a human would find. Recall is desirable but not required.
- Iris does not need to drive complex flows requiring credentials or external state.
- Iris's report doesn't need to be more eloquent than a human reviewer; it needs to be correct.

## How I audit

Manual eye-audit of the report against the screenshots, video clips, and (for me) my mental model of the product. For each goal: did Iris's verdict match what's actually on screen? For each finding: would a human reviewer with the same evidence make the same claim?

If the audit reveals a divergence, classify it:

- **Class A** — Iris fabricated a failure on something that works.
- **Class B** — Iris claimed verified on something that doesn't actually work.
- **Class C** — Iris failed to attempt a goal that should have been attempted (coverage gap).
- **Class D** — Iris's score / summary misleads about what was actually tested.

Each class has a different structural fix.
