# Iris Phase 6 — Trust the Signal

**Date:** 2026-05-11
**Status:** Spec. Driven entirely by Phase 5 dogfood discoveries.
**Prior context:** `docs/superpowers/specs/2026-05-10-iris-phase-5-design.md`, Phase 5 dogfood summary in memory.

---

## Goal

Phase 5 made Iris produce honest signal. Phase 6 makes that signal trustworthy enough to act on. Three pieces, scoped tight:

- **F1** — Validator distinguishes Explorer-error from app-bug.
- **F2** — Judge ensembling for blocker/major findings (flake control).
- **F3** — Per-finding video clips, embedded in the report.

## Non-goals (explicit cuts)

- **Hierarchical multi-Explorer** (IDE-scale fan-out): structural change, defer to Phase 7. Phase 6's quality bumps make the eventual fan-out more useful.
- **Fix-suggestion synthesis** (TestSprite's wedge): the Judge already emits `suggested_fix` (Phase 3); improving its quality is a prompt tuning exercise that benefits from Phase 6's validation gates. Defer.
- **Cross-app score calibration**: needs a corpus first; not a 1-week task.
- **Stagehand-style action caching**: cost optimization, not signal quality.

## Why these three, in this order

Phase 5 dogfood produced three concrete weaknesses, each addressed by one piece:

1. **Vercel run** flagged "skip-to-content link not clickable via direct selector" as a `minor/a11y` finding backed by a failed action_result. Likely Explorer used wrong selector. The validator marked it `verified` because the failed-action_result counted as backing. The validator is correct-by-rule but wrong-in-spirit. **→ F1**.

2. **Same target, two consecutive runs**: TodoMVC score 7.8 then 7.2 (-0.6 delta). Two clean runs should not differ by 0.6 points. The Judge is non-deterministic on edge cases. **→ F2**.

3. **The full-run video is 3.3MB** of mostly idle frames; no good way to point a stakeholder at "the bug." Per-finding evidence currently shows a single screenshot. Watching the actual interaction would be the most useful single artifact for a human reviewer. **→ F3**.

---

## F1 — Explorer-error disambiguation in the validator

### Problem

Real-world runs have 8-12 failed `action_result` events per run. Some are real bugs (clicking a broken button); most are the Explorer using a bad selector that doesn't match the rendered DOM. The current `evidence-validator.ts` treats every failed action_result as backing evidence for any finding that cites it. This over-credits findings whose only "evidence" is the Explorer's selector miss.

### Design

**Two new validator rules**, applied during `validateFindings`:

1. **Self-success cancels failure**. If a finding cites `action_result {tool: T, ok: false}` events and the SAME `tool` was used successfully (`ok: true`) elsewhere in the trace within the same surface (same observation_ref or within ±5 events), the failure is **not backing**. The Explorer tried-failed-retried-succeeded, which isn't a bug.

2. **Action-failure patterns must match**. A failed `click` doesn't prove "the click target is broken." It proves "the selector didn't match." For a finding to use a failed `click` as backing, the failure error message must match common app-bug patterns (e.g., `timeout`, `not visible`, `not enabled`, `intercepted`). Selector-miss patterns (e.g., `no element found`, `selector resolved to 0 elements`) do NOT count as backing.

If a finding's only "backing" was a selector-miss action_result, treat it as having no backing → severity downgrade per Phase 5 rules + `likely_explorer_error: true` tag.

### Implementation surface

- `evidence-validator.ts`: extend `hasBackingEvidence` to inspect action_result error messages.
- Add `likely_explorer_error?: boolean` to finding schema.
- Report HTML: render `[likely-explorer-error]` tag inline if set.
- New unit tests covering both rules.

### Trade-offs

- **The error-pattern heuristic is regex-based.** Playwright's error messages are stable across versions but new error variants might slip through. The conservative move (treat ambiguous errors as backing) keeps false-negative-bug rate low.
- **"Same tool succeeded elsewhere" requires walking the trace window.** Adds work to the validator but it's still O(events) per finding — cheap.

### Verify

- Re-run Vercel target post-F1. The "skip-to-content not clickable via direct selector" finding either gets discarded, downgraded to suggestion + tagged, OR is replaced by a different finding citing a different failure.
- Re-run bench. All 12 fixtures should still pass (their findings are real app bugs, backed by genuine evidence patterns).

---

## F2 — Judge ensembling for blocker/major findings

### Problem

Two consecutive clean runs of TodoMVC produced scores 7.8 then 7.2 — 0.6 point variance. For Otto closing a build loop on Iris's verdict, this variance is the difference between "ship" and "block." Even with temperature=0, the Judge prompt has enough ambiguity for the model to make different calls on borderline findings.

### Design

**Two-pass Judge for high-severity findings only**. The full Judge runs once as today. After it returns, a SECOND Judge call with the same input runs in parallel, with no knowledge of the first output. The orchestrator intersects:

- **Blocker / Major findings**: keep ONLY findings whose `finding_hash` appears in both runs. (Hash is stable enough — see Phase 5 G4 — that "same finding" survives across Judge runs.)
- **Minor / Nit / Suggestion findings**: take the union from the first Judge run. Low-severity findings don't drive ship decisions; doubling Judge calls just to dedupe nits is bad ROI.

A finding that appears only in one pass goes into `discarded_findings` with `reason: "ensemble_disagreement"`. This gives users a way to see what the Judge was uncertain about.

### Cost / latency

- Second Judge call costs ~$0.15-0.20 per run (same as the first; same prompt).
- Runs in parallel (`Promise.all`) so latency is single-Judge.
- Net cost increase per run: ~30% (Judge is ~40% of total run cost).
- Trade for: ≥50% reduction in critical-finding variance.

Made opt-in via `--judge-ensemble` (default off so existing benches don't double-cost). Off by default in the SDK orchestrator. Enabled in the bench script to validate behavior.

### Implementation surface

- New `judgeWithEnsemble` helper in orchestrator that calls `judge.run` twice via `Promise.all`, intersects critical findings, emits ensemble metadata.
- `--judge-ensemble` CLI flag.
- Report `evidence_validation` extended with `ensemble: { agreed, disagreed }` field when ensemble was used.
- Both Orchestrator and agent-sdk-orchestrator paths.

### Trade-offs

- **Doubles Judge cost.** Mitigation: opt-in flag.
- **Could mask a real blocker that Judge only catches in one pass.** Mitigation: the discarded finding is logged with `ensemble_disagreement` so users can review. Plus: a blocker that the Judge can't reliably re-detect is, by definition, a borderline call — it should be reviewed by a human anyway.
- **Cannot do meaningful ensembling on a run with 0 findings** — most TodoMVC runs are like this. Need to test on bench fixtures (which DO produce findings).

### Verify

- Run the bench with `--judge-ensemble` on. All 12 fixtures should still pass; ensemble metadata should appear in report.json.
- Run TodoMVC twice consecutively with ensemble on; score variance should be ≤0.3 (vs 0.6 today on non-ensembled runs).

---

## F3 — Per-finding video clips in the report

### Problem

Phase 4 already implements `sliceEvidenceClips` (ffmpeg-based) which extracts a clip per finding given the cited event timestamps. It's not exercised in the default Phase 5 pipeline — the report shows a single full-run video. For a human reviewer, "show me this specific bug" is more useful than "watch 3 minutes of cursor blinks."

### Design

**Wire the existing slicer into the pipeline.** After Judge + validator, before report rendering:

1. For each finding's `evidence` event IDs, compute a clip window: `[earliest_event_ts - 2s, latest_event_ts + 3s]` clamped to recording duration.
2. Call `adapter.sliceEvidence(refs)` to produce one .webm clip per finding.
3. Surface clip paths in `report.artifacts.clips[finding_id] = path`.
4. In the HTML report, render an embedded `<video>` next to each finding (collapsed by default for small findings; auto-open for blocker/major).

The full recording stays — it's the audit artifact. The clips are the watchable evidence.

### Cost / latency

- ffmpeg slicing is local CPU; ~0.5-2s per clip. 5 findings = ~5-10s extra wall time.
- Disk: clips average ~200KB each. 10 findings = 2MB total.
- Trade for: 10-30s of useful video per finding vs scrubbing through a 3MB full recording.

Already gated by the existing `--no-clips` flag, which stays as the opt-out.

### Implementation surface

- Orchestrator (both paths): after validator, call `adapter.sliceEvidence` with the per-finding event ID list. Stash returned paths.
- `report-json.ts`: extend `ReportArtifacts.clips` to be populated, currently optional.
- `report-html.ts`: extend `renderFinding` to embed a `<video controls>` element when `report.artifacts.clips[finding.id]` exists.

### Trade-offs

- **Findings with thin evidence (only one cited event) get a 5s clip** — short but still useful.
- **ffmpeg is a system dependency.** Already required by Phase 4. No new install.

### Verify

- Re-run a bench fixture that produces ≥2 findings (e.g., 01 or 08). Each finding should have a clip artifact.
- Open the report HTML; each finding section should embed a playable video.

---

## Out of scope, explicitly deferred

- Hierarchical multi-Explorer for IDE-scale targets
- LLM-based fix-suggestion synthesis
- Score calibration across apps
- Action-caching for replay determinism

## Self-review

- Each piece is independently shippable.
- F1 changes the validator deterministically; risk is low.
- F2 doubles Judge cost when enabled but is opt-in.
- F3 uses an existing Phase 4 function; risk is wiring, not logic.
- Verification per piece is system-level, not just unit tests.
