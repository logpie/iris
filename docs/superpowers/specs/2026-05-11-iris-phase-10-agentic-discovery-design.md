# Iris Phase 10: Agentic Discovery — auto-spec + dynamic goal expansion

**Date:** 2026-05-11
**Status:** Draft for user review

## Why

Phase 9 made interactions real and outcome citations honest, but it depends on someone hand-writing a spec. For Iris to be "drop on any URL, get a real evaluation," it has to either be *told* what the product does or *figure it out itself*. A new human user does the latter constantly: they land on a page, form a hypothesis about what it is, try the obvious things, discover new surfaces, and try those too. Their mental "spec" grows during the visit.

This phase makes Iris work that way:

- **Discovery pass** before Explorer runs — one LLM call against an initial screenshot + DOM produces seed goals. Same way a person decides "this looks like a TODO list, I should try adding something."
- **Dynamic goal expansion** during exploration — when the Explorer finds a surface that wasn't covered by seed goals (Settings page, Library panel, share dialog), it appends new goals. The Judge evaluates against the *final* goal set.
- **Universal UX rubric** that produces signal even when goals are sparse — discoverability, console cleanliness, keyboard, mobile, error states, destructive-action confirmation. Doesn't depend on the spec.

Combined with the "told" path that already exists (`--spec`), Iris becomes mode-symmetric:

| User input | Iris behavior |
|---|---|
| URL only | Discovery pass → seed goals → explore + expand → evaluate |
| URL + spec | Use spec as seed goals → explore + expand → evaluate |
| URL + tasks | Targeted execution (existing) |

The expansion mechanism works the same in both cases — `--spec` doesn't disable it.

## Architecture

### 1. Discovery pass

New orchestrator phase between preflight and Explorer. Adapter-aware so CLI/API contracts plug in later.

```
preflight → discovery → Explorer → Judge → validators → report
```

**Web discovery (this phase):**

1. Navigate to URL (already done by adapter `start()`).
2. Capture observation (DOM outline + body text — already produced).
3. Take one screenshot.
4. Send screenshot + observation summary + URL to a single LLM call with a discovery prompt:

   > You are a curious new user. Given this screenshot and page text, describe what this product is (1-2 sentences) and propose 6-12 testable goals a normal user would try on their first visit. Order them by user-likelihood: most common actions first.

5. Parse goals (same shape as the existing `InterpretedSpec`). Treat as the seed spec.
6. Emit a `discovery` trace event with the product description + seed goals.

If discovery fails (LLM returns garbage, parse error), fall back to free mode — same behavior as today when there's no spec.

**Future CLI discovery (stub):** capture `--help` output + first-screen output; LLM proposes goals like "list files", "process a sample input", "show version". Not implemented this phase.

**Future API discovery (stub):** read OpenAPI/Swagger; LLM proposes "list resources", "create a resource and verify with GET", "delete a resource and verify". Not implemented this phase.

### 2. Dynamic goal expansion

New Explorer meta-tool `propose_goal`. The Explorer calls it when it discovers something seed goals don't cover.

```
propose_goal({
  description: "Change the theme to dark mode and verify it persists across reload",
  rationale: "Discovered a Settings page with theme options not in seed goals",
  priority: "should" | "could"
})
```

Constraints:
- New goals always get priority `should` or `could`, never `must` — seed goals own the `must` tier.
- Max 6 expansion goals per run (configurable). Prevents runaway expansion.
- Expansion goals carry IDs `G7+` (start after seed-goal IDs).
- The Explorer's per-goal budget applies to expansion goals too — so adding 3 goals at step 20 with `steps_per_goal=8` means up to 24 more turns budgeted, capped by `max_steps`.

Emitted as a `goal_proposed` trace event with full justification so the Judge can audit.

### 3. Universal UX rubric profile

New rubric: `ux_baseline`. Doesn't depend on goals. Dimensions:

| Dimension | What's scored | Probe inputs |
|---|---|---|
| `primary_action_discoverable` | Is the primary CTA visible in the first observation, and did the Explorer find it within 5 turns? | trace events |
| `console_clean` | Console errors during the run | `console_errors_since` probe |
| `network_clean` | Failed network requests | `network_failures_since` probe |
| `a11y_baseline` | Axe violations on first-load + after each navigation | `axe` probe |
| `error_states_clear` | Did empty/invalid form submits produce clear errors? Did 404 / not-found surfaces have useful copy? | trace events + Judge inspection |
| `destructive_confirmed` | Did destructive actions (delete, sign-out, reset) prompt for confirmation? | trace events |
| `keyboard_accessible` | Did at least one full flow work with Tab/Enter/Esc only? | trace events |
| `mobile_responsive` | Visit one surface at 375px width; does the primary action remain accessible? | screenshot diff |

The rubric is added to the default profile set when no `--rubrics` is specified. The first six dimensions need no new code (probes exist or are derivable from trace events). `keyboard_accessible` requires an explicit keyboard-flow attempt — the Explorer prompt already says "Use keyboard nav for one full flow"; we just need the Judge to grade it. `mobile_responsive` requires a viewport resize + revisit pass — small addition to the adapter.

### 4. Mode behavior

| `--spec` provided? | Discovery runs? | Initial goals come from | Expansion enabled? |
|---|---|---|---|
| No | Yes | Discovery pass | Yes (up to 6) |
| Yes | No | Spec interpreter | Yes (up to 6) |
| Yes + `--no-expand` | No | Spec interpreter | No |
| `--tasks` provided | No | Tasks (targeted) | No |

`--no-discover` exists as an escape hatch for debugging or for fully-determined runs.

## Surface changes

### New files

- `packages/core/src/discovery/discovery.ts` — discovery pass (LLM call + parsing)
- `packages/core/src/discovery/prompts.ts` — discovery prompt
- `packages/core/src/discovery/index.ts`
- `packages/rubrics/src/profiles/ux-baseline.ts` — universal UX rubric
- Tests for both

### Modified files

- `packages/core/src/orchestrator/orchestrator.ts` — add discovery phase; wire `propose_goal` into Explorer
- `packages/cli/src/agent-sdk-orchestrator.ts` — same for SDK transport
- `packages/core/src/explorer/explorer.ts` — register `propose_goal` meta-tool
- `packages/core/src/explorer/prompts.ts` — meta-tool guidance for `propose_goal`
- `packages/core/src/trace/schema.ts` — add `discovery`, `goal_proposed` event kinds
- `packages/cli/src/commands/eval.ts` — `--no-discover`, `--no-expand` flags; default-on discovery when no spec
- `packages/rubrics/src/index.ts` — export ux_baseline
- `packages/core/src/judge/prompts.ts` — Judge sees expansion goals + ux_baseline dimensions

## Behavioral contracts

- **No regression for `--spec` runs.** Spec-provided runs are unaffected by discovery (skipped) and unaffected by expansion if the user passes `--no-expand`.
- **Expansion is bounded.** Max 6 goals, never higher tier than `should`, budget cap respected.
- **Discovery failure ≠ run failure.** If the discovery LLM call returns nothing parseable, the run continues in free mode with the ux_baseline rubric. Logged as a caveat, not an error.

## Pass bar (replaces Phase 9 pass bar)

Five public web apps, **no human-written spec for any of them**. Run with `--mode free` (implicit discovery). I manually audit each report by eye and confirm:

| App | What I check |
|---|---|
| excalidraw.com | Discovery proposes "draw a shape" type goals; primitives are real; outcomes confirmed by screenshot |
| todomvc.com/react/ | Discovery proposes add/complete/clear; outcomes real |
| A calculator (e.g. desmos.com) | Discovery proposes "compute an expression"; numeric outcome visible |
| A public Wikipedia article edit-preview flow | Discovery proposes "preview an edit"; outcome confirmed |
| A markdown editor like dillinger.io | Discovery proposes "type and see rendered preview"; outcome confirmed |

Bar:
- Every report has at least 60% of seed goals attempted (`verified` or `partial` or `blocked`, not all `untested`).
- Every `verified` claim survives my manual screenshot audit (no fakes).
- `ux_baseline` dimensions all score (non-null), showing the rubric produces signal independent of spec.

## What I'm NOT doing

- No persistence of discovery output across runs. Each run rediscovers.
- No multi-page deep crawl during discovery. One screenshot, one page, one LLM call. The Explorer does the deep crawl during exploration as it already does.
- No "goal removal" — Explorer can add goals but not delete seed goals. Skipped/untested status is the mechanism for "we couldn't do this one."
- No discovery for `--tasks` (targeted) mode. Targeted = user knows exactly what to test.
- CLI and API adapter discovery is stub-only this phase.

## Self-review

- Placeholder scan: every section has concrete types, file paths, behavioral contracts.
- Internal consistency: discovery seeds goals → Explorer expands → Judge evaluates with universal rubric supplementing — single path.
- Scope: focused. One phase, one architectural shape. CLI/API stubbed.
- Ambiguity: discovery prompt is concrete; expansion cap is named (6); rubric dimensions are named with probe sources; pass bar is named per-app.
