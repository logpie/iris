# Iris Phase 9: Outcome Contract — Goal-Claim Validation + Interaction Completeness

**Date:** 2026-05-11
**Status:** Draft for user review

## Why

The Excalidraw audit on 2026-05-10 surfaced a class of failure that earlier phases didn't fix:

- The Explorer claimed `goal_status: verified` for "draw a rectangle." The Judge propagated the claim. The pass-bar report said `goals_verified: 5/6`.
- Manual inspection of the screenshots (`vision-0012`, `step-0010`, `step-0012`, `step-0015`) shows the canvas is **empty**. No rectangle was ever drawn.
- The Explorer issued a single `vision_click(x:300, y:300, reason:"Start of rectangle drag")` — one click, not a click-drag. Excalidraw's rectangle tool requires `mouse.down → move → mouse.up`. Iris's action toolkit has no drag primitive, so the Explorer faked it with a single click and convinced itself it had succeeded when the properties side-panel appeared (a side-effect of the rectangle *tool* being active, not of a rectangle *existing*).

Two failure modes generalize across web/CLI/API:

1. **Interaction-surface gap.** The agent cannot do what a real user does (web: no drag/key-chord/paste/upload; CLI: no stdin/signals/TUI; API: no auth flow/pagination/retry). Goals that need missing primitives get faked silently.
2. **Side-effect-as-outcome confusion.** The agent treats "something happened" (panel opened, prompt rendered, 200 returned) as proof the goal completed, without checking the *user-visible outcome* (shape on canvas, file written with expected contents, resource readable via follow-up GET).

Phase 5's evidence-validator only inspects **findings**. `goal_status` events bypass it. Phase 8's access_blocks distinguishes external blocks (bot detection, paywalls) from product defects. Neither layer questions a `verified` claim.

This phase fixes both modes generically, so the same architecture extends to CLI and API adapters later without re-work.

## Non-goals

- No new CLI adapter in this phase. CLI/API surfaces appear in the abstraction (declared `OutcomeContract` interface) but no implementation lands.
- No new score model. The validator downgrades goal status; the Judge already weights `verified vs partial vs blocked` when computing scores.
- No app-specific heuristics. Anything that looks like "if URL contains excalidraw.com then..." is rejected.

## Architecture (modality-agnostic)

Three components, each modality-pluggable:

### 1. `InteractionKit` — declared per adapter

Each adapter exposes the set of user-action primitives it can perform. Today's web adapter has `click, type, press, hover, scroll, vision_click, screenshot, vision_describe`. Real users also do `drag, double-click, right-click, key-chord, paste, upload, hover-and-wait`. The kit makes the surface explicit:

```ts
interface InteractionKit {
  kind: TargetKind;
  primitives: Array<{
    name: string;
    user_action: string;        // "drag", "key-chord", "paste"
    coverage_note?: string;     // e.g. "vision-coord and selector forms both supported"
  }>;
}
```

The kit is published into the trace at run start (new event kind `interaction_kit`) so the Judge sees what was possible and the goal-claim validator can flag "goal requires X primitive that's not in kit."

### 2. `OutcomeContract` — declared per adapter

Defines what counts as user-visible-outcome evidence for *this* modality:

```ts
interface OutcomeContract {
  kind: TargetKind;
  // Given a goal description + the trace events scoped to that goal,
  // return the artifacts that constitute user-visible outcome evidence.
  // Returns empty array when no outcome-shaped artifact exists in the
  // window — that's the signal for "verified claim is unbacked."
  collectOutcomeEvidence(input: {
    goal: { id: string; description: string };
    goal_events: TraceEvent[];
  }): OutcomeArtifact[];
}

interface OutcomeArtifact {
  kind: 'screenshot' | 'stdout' | 'stderr' | 'exit_code' | 'fs_diff' | 'http_response' | 'follow_up_read';
  ref: string;                 // path or event_id
  note?: string;               // why this counts ("post-action screenshot after step 12")
}
```

**Web contract (this phase):**
- Outcome = the most recent screenshot taken **after** the last successful interaction in the goal window.
- Side-effects ignored: `vision_describe` of an empty region; "panel appeared"-style descriptions without a cited visual element; screenshots taken *before* the final interaction.
- The contract does not itself judge "is the shape there?" — that's the Judge's job. The contract just locates the evidence the Judge must cite.

**CLI contract (stub, for future):**
- Outcome = combined `stdout + stderr + exit_code + fs_diff` over the goal window. No implementation yet; interface declared.

**API contract (stub, for future):**
- Outcome = `http_response` of the action call **plus** a `follow_up_read` event confirming the write is persistent (POST → GET roundtrip). Stubbed.

### 3. `GoalClaimValidator` — runs post-Judge, pre-report

Mirrors the evidence-validator. For every goal where the Judge emitted `status: verified`:

1. Window the trace events between the goal's first attempt and its `goal_status` event.
2. Ask the adapter's `OutcomeContract.collectOutcomeEvidence` to return outcome artifacts.
3. Check the Judge's `evidence` array for the goal cites at least one of those artifacts.
4. Check the Judge's `notes` / rationale does **not** rely solely on side-effect language. We maintain a small list of side-effect phrases the Judge prompt teaches it to avoid: "panel appeared," "tool selected," "highlighted," "focus moved," "prompt rendered," "request fired," "200 returned." If the rationale matches one of these patterns and cites no outcome artifact, downgrade.
5. On failure → downgrade `verified → partial`, append a caveat `"goal-claim validator: no outcome-shaped evidence cited (only side-effects)"`, increment `goal_claim_validation.downgraded`.

The validator emits an `evidence_validation`-style summary (`goal_claim_validation: { verified_kept, downgraded, ... }`) so the report shows the work, like the existing evidence-validator does.

### Flow

```
Explorer (with InteractionKit primitives)
     │
     ▼
trace.jsonl  ← interaction_kit event at start; outcome artifacts recorded per usual
     │
     ▼
Judge  ← prompt updated: outcome-vs-side-effect rule; cite outcome artifact for `verified`
     │
     ▼
evidence-validator  ← unchanged (validates findings)
     │
     ▼
goal-claim-validator  ← NEW: validates `verified` goal claims against OutcomeContract
     │
     ▼
report.json + report.html  ← surfaces downgrades + caveat
```

## Web slice: what actually ships

The architecture above is universal. This phase ships **only the web fill-in**, with CLI/API as declared-but-stubbed contracts.

### Web interaction primitives to add

| Primitive | Selector form | Vision-coord form | Why |
|---|---|---|---|
| `drag` | `drag({selector, dx, dy})` | `vision_drag({from, to, hold_ms?})` | Canvas drawing, sliders, resizing, drag-and-drop, range pickers |
| `key_chord` | `key_chord({keys: ["Meta","z"]})` | n/a | Undo, select-all, copy/paste shortcuts |
| `paste` | `paste({selector, text})` | `vision_paste({x, y, text})` | Forms, editors — different code path than `type` (no per-key events) |
| `right_click` | `right_click({selector})` | `vision_right_click({x, y})` | Context menus |
| `double_click` | `double_click({selector})` | `vision_double_click({x, y})` | Text-edit-in-place, file-list open |
| `upload` | `upload({selector, file_path})` | n/a | File pickers — produces a synthetic file fixture if path omitted |
| `hover_wait` | `hover_wait({selector, wait_ms})` | `vision_hover_wait({x, y, wait_ms})` | Tooltips, hover-revealed UI |

All run through the existing `actionWithRetry` wrapper for selector-miss handling. `upload` requires special handling — uses Playwright `setInputFiles`.

### Judge prompt: outcome-vs-side-effect rule

Add to `JUDGE_SYSTEM`:

> **Outcome-vs-side-effect rule.** A goal is `verified` only if the user-visible *outcome* of the goal is present in the cited evidence. Side-effects of interaction are NOT outcomes:
> - Tool being selected, button being focused, hover state appearing → side-effect, not outcome
> - Properties panel rendering when a tool is chosen → side-effect of tool selection
> - HTTP 200 returning from an API call → side-effect, not confirmation the resource exists
> - A prompt/dialog appearing → side-effect of triggering it, not confirmation the action it offers was taken
>
> For each `verified` goal you must cite at least one piece of outcome-shaped evidence (a screenshot showing the user-visible artifact for web; stdout/file-diff for CLI; follow-up GET for API). If the only evidence is a side-effect, mark the goal `partial` and note "outcome not confirmed."

### Goal-claim validator: implementation cost

Pure TypeScript, no LLM call. ~150 lines + tests. Lives at `packages/core/src/judge/goal-claim-validator.ts`. Plugs into `Orchestrator.run()` post-Judge, pre-report-write.

## Surface changes

### New files

- `packages/core/src/adapter/interaction-kit.ts` — `InteractionKit` types + helpers
- `packages/core/src/adapter/outcome-contract.ts` — `OutcomeContract` types + helpers
- `packages/core/src/judge/goal-claim-validator.ts` — validator + tests
- `packages/adapter-web/src/contract.ts` — web `OutcomeContract` + `InteractionKit` impl
- `packages/adapter-web/src/tools/drag.ts` — drag primitive (selector + vision)
- `packages/adapter-web/src/tools/key-chord.ts`
- `packages/adapter-web/src/tools/paste.ts`
- `packages/adapter-web/src/tools/click-variants.ts` — right-click, double-click, hover-wait
- `packages/adapter-web/src/tools/upload.ts`

### Modified files

- `packages/adapter-types/src/index.ts` — `TargetAdapter` gains optional `interactionKit()` and `outcomeContract()` accessors (optional so non-web adapters can land later without breaking)
- `packages/adapter-web/src/index.ts` — wire new tools into `listTools()` / `callTool()`; expose kit + contract
- `packages/adapter-web/src/tools/index.ts` — register new tools, include in tool-spec
- `packages/core/src/orchestrator/orchestrator.ts` — emit `interaction_kit` event at run start; call `GoalClaimValidator` after Judge
- `packages/cli/src/agent-sdk-orchestrator.ts` — same wiring for SDK transport
- `packages/core/src/judge/prompts.ts` — add outcome-vs-side-effect rule to system prompt; update output schema doc to require `evidence` cite for `verified`
- `packages/core/src/judge/judge.ts` — extend `JudgeOutputSchema.spec_compliance` with optional `goal_claim_validation: {verified_kept, downgraded, downgrade_reasons: string[]}`
- `packages/core/src/report/report-html.ts` — render goal-claim-validation summary; render caveat next to downgraded goals
- `packages/core/src/trace/events.ts` — new event kind `interaction_kit`

### Backward compatibility

- `interactionKit()` and `outcomeContract()` are optional on `TargetAdapter`. Adapters without them get a default no-op contract that accepts all `verified` claims (current behavior — no regression for hypothetical out-of-tree adapters).
- The validator emits zero downgrades when contract is absent.
- Existing traces without `interaction_kit` events still parse.

## Pass bar (replaces iter2 set)

Three real public web apps, no auth, no bot detection. Iris must score them with **no fake `verified` claims** as audited manually:

| App | What it tests |
|---|---|
| **excalidraw.com** | Canvas drag (rectangle, arrow), text placement, undo via Cmd+Z |
| **A public terminal emulator** (e.g. `tty.js`-style demo if reachable) | Key chords, paste, hover-wait |
| **A multi-step form site** (e.g. a Typeform demo) | Form fill across screens, validation errors, submit |

Bar: every `verified` goal must have outcome-shaped evidence cited. Manual audit of screenshots required to confirm pass. `goal_claim_validation.downgraded` must equal the number of goals where outcome was not actually achieved — both directions: no fakes pass, no real successes get falsely downgraded.

## What I'm not doing

- No drag-and-drop *between* elements (e.g., reordering lists). Adding later if pass-bar demands it.
- No accessibility-tree-aware interaction (e.g., navigating via screen reader). Out of scope.
- No retry-with-different-primitive (e.g., "click failed, try drag"). The Explorer chooses the primitive; the validator only judges outcome.

## Open questions resolved

| Q | Resolution |
|---|---|
| Downgrade target | `verified → partial` (Explorer attempted, outcome unverifiable — softer than `untested`) |
| iter2 pass-bar log | Annotate with `[FALSE PASS — audit 2026-05-11 found empty canvas]`, do not delete |
| One spec or split | One combined spec — abstraction and web fill-in are coupled |
| Stub future adapters | Yes — declare interfaces, no impl. Half-day cost prevents re-architecture |

## Self-review (against CLAUDE.md spec self-review)

- Placeholder scan: none — every section has concrete types, file paths, primitive lists.
- Internal consistency: `OutcomeContract.collectOutcomeEvidence` returns artifacts; validator checks Judge cited at least one — consistent with the "Flow" diagram.
- Scope: focused. One phase, one architectural shape, web fill-in. CLI/API are interface-only.
- Ambiguity: "side-effect phrases" list is concrete and bounded; "outcome-shaped" is defined per contract; "real public webapp" pass bar is named.
