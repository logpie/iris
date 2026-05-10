# Iris — Phase 4: Polish, Personas, Bench

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Production-readiness — turn the Phase 3 working pipeline into something you'd actually trust as Otto's feedback signal. Adds persona pool, ffmpeg clip slicing, known-bug bench, rubric tuning, lighthouse probe, vision_describe LLM call.

**Architecture:** No new packages. Additions inside `@iris/core/explorer/personas/`, `@iris/adapter-web/recording/ffmpeg-slice.ts`, `packages/adapter-web/src/probes/lighthouse.ts`, `fixtures/known-bugs/` at repo root, and tuned rubric YAMLs.

**Tech Stack:** Adds: `lighthouse` (npm), `ffmpeg` (system binary, optional). Adds Anthropic vision (image content blocks) usage for `vision_describe`.

**Spec reference:** §10.5 (lighthouse, vision_describe), §11.4 (rubric tuning), §12.4 (ffmpeg clip slicing), §14.3 (known-bug bench).

---

## File structure (Phase 4 additions)

```
packages/core/src/explorer/personas/
├── index.ts                  ← export PERSONAS map
├── default.ts                ← already implicit in P3
├── power-user.ts             ← efficient user, knows shortcuts
├── novice.ts                 ← reads everything, makes typical mistakes
├── adversarial.ts            ← fuzzes inputs, tries weird combos
├── keyboard-only.ts          ← Tab/Enter only, no mouse
└── personas.test.ts

packages/adapter-web/src/
├── recording/
│   ├── ffmpeg-slice.ts       ← real .webm clip slicing per-finding
│   └── ffmpeg-slice.test.ts  ← skips if ffmpeg missing
├── probes/
│   ├── lighthouse.ts         ← real lighthouse probe
│   └── lighthouse.test.ts
└── tools/
    └── vision.ts             ← vision_describe MODIFIED to call LLM with screenshot

fixtures/known-bugs/
├── 01-empty-form-submit/
│   ├── public/index.html
│   ├── meta.json
├── 02-focus-trap-modal/
├── 03-broken-export/
├── 04-console-noise/
├── 05-bad-empty-state/
├── 06-keyboard-inaccessible/
├── 07-clean-baseline/
└── 08-many-small-issues/

scripts/
├── bench.ts                  ← Phase 4 known-bug-bench runner
└── README.md

packages/rubrics/profiles/    ← TUNED weights + dimensions based on bench
└── ... (existing files updated)
```

---

## Tasks

### Task 1: Persona pool (4 new + slot refactor)

**Files:**
- Create `packages/core/src/explorer/personas/{default,power-user,novice,adversarial,keyboard-only,index}.ts` + `personas.test.ts`
- Modify `packages/core/src/explorer/prompts.ts` — `personaSuffix` now takes a persona id from PERSONAS map

Each persona is a `~150-300-word string` that's appended as a system message slot. Keys: `default`, `power_user`, `novice`, `adversarial`, `keyboard_only`.

CLI: add `--persona <name>` flag to `eval`. Default: `default`. Repeatable for multi-persona runs (Phase 4.1+ — for now, single persona per run).

Tests: each persona prompt mentions distinguishing behavior; `PERSONAS[name]` lookup works.

Commit: `feat(core/explorer): persona pool (power_user/novice/adversarial/keyboard_only)`

---

### Task 2: ffmpeg-driven per-finding clip slicing

**Files:**
- Create `packages/adapter-web/src/recording/ffmpeg-slice.ts` + `ffmpeg-slice.test.ts`
- Modify `packages/adapter-web/src/index.ts` — `sliceEvidence` calls ffmpeg when available, falls back to screenshot otherwise

`sliceEvidenceClips(refs, video_path, screenshot_index): EvidenceFile[]`:
- For each finding, look up trace event timestamps for cited evidence ids.
- Compute clip window `[earliest_ts - 1.5s, latest_ts + 2.5s]`, clamp to video bounds, max 30s.
- Spawn `ffmpeg -i video.webm -ss START -t DURATION -c copy clip-FXXX.webm`.
- Generate poster frame `ffmpeg -i video.webm -ss MID -frames:v 1 clip-FXXX.poster.png`.
- Return EvidenceFiles per finding.
- If `ffmpeg` not on PATH, log warning, fall back to screenshot.

Adjacent findings within 5s share a clip.

Tests: 
- Unit test the windowing math (no ffmpeg needed).
- Integration test: skip if `which ffmpeg` returns non-zero. Otherwise spawn ffmpeg against a small test video.

Commit: `feat(adapter-web/recording): ffmpeg-driven per-finding clip slicing`

---

### Task 3: Lighthouse probe

**Files:**
- Modify `packages/adapter-web/package.json` — add `lighthouse ^12.x`
- Create `packages/adapter-web/src/probes/lighthouse.ts` + `lighthouse.test.ts`
- Modify `packages/adapter-web/src/probes/probe-spec.ts` — add `lighthouse` to WEB_PROBE_SPECS
- Modify `packages/adapter-web/src/index.ts` — wire `lighthouse` in `runProbe` switch

`runLighthouse(page): Promise<ProbeResult>` — runs lighthouse against the current page, returns Performance/Accessibility/Best-Practices/SEO scores + key audits.

Lighthouse is heavy; tag the probe spec as opt-in. Add cache: results valid for 10 minutes per URL.

Tests: integration test against `hello` fixture, assert it returns scores.

Commit: `feat(adapter-web/probes): lighthouse probe (opt-in, heavy)`

---

### Task 4: vision_describe LLM call

**Files:**
- Modify `packages/adapter-web/src/tools/vision.ts` — replace stub
- Update `WebTargetAdapter.callTool` to pass an `LlmClient` to `visionDescribe`

`visionDescribe(page, llmClient, args): Promise<ToolResult>`:
- Take screenshot via Playwright.
- Send to Claude (sonnet) with image content block + prompt: "Describe what's on this screen. Focus on: layout, primary CTA, any visible problems."
- Return `{ok: true, evidence_refs: [screenshot_path], description}` (description goes in `data` or new field).

Cassette-based test using a known fixture screenshot.

Commit: `feat(adapter-web/tools): vision_describe — LLM-powered screen description`

---

### Task 5: Known-bug fixtures (8 sites)

**Files:**
- Create `fixtures/known-bugs/{01..08}/{public/*.html, meta.json}`

Each fixture:
- A small HTML site with a SPECIFIC seeded bug (or, for 07, no bugs).
- `meta.json` declares `expected_findings`, `expected_score_range`, `expected_to_NOT_find`.

Use spec §14.3 as the canonical fixture list. Each fixture is small (< 100 LoC of HTML/JS).

Commit: `test: 8 known-bug fixtures for benchmarking`

---

### Task 6: Bench runner

**Files:**
- Create `scripts/bench.ts` — script that runs `iris eval` against each fixture and asserts meta.json expectations
- Create `scripts/README.md` — how to run bench, what budgets to expect
- Add `bench` script to root `package.json`: `"bench": "tsx scripts/bench.ts"`

`bench.ts`:
- For each fixture in `fixtures/known-bugs/`:
  - Spawn local HTTP server pointing at `public/`
  - Run `iris eval <local-url> --spec <derived-from-meta> --max-cost-usd 1`
  - Read `report.json`
  - Assert `must_find` findings appear (recall)
  - Assert scores fall in expected ranges
  - Assert `expected_to_NOT_find` items don't appear (precision)
  - Track per-fixture cost
- Aggregate: total cost, recall, precision, calibration error.
- Exit non-zero if any fixture fails.

Real LLM calls. Run nightly + on release branches. Manual: `pnpm bench`.

Commit: `feat(bench): known-bug-bench runner with recall/precision assertions`

---

### Task 7: Rubric tuning based on bench feedback

**Files:**
- Modify `packages/rubrics/profiles/web/*.yaml`

Run bench. For each fixture, look at:
- Findings the Judge missed → tighten the relevant dimension's `common_signals.negative` to make it more sensitive
- Findings the Judge over-severitized → adjust scoring anchors
- Score-range failures → adjust `weight_in_overall` or dimension weights

Iterate on rubric YAMLs until bench passes consistently. Document changes in commit messages.

This is empirical. May take multiple commits.

Commit: `chore(rubrics): tune web/* profiles based on bench feedback`

---

### Task 8: Final docs + Phase 4 done

**Files:**
- Update `docs/architecture.md` to mark Phase 4 done
- Update `README.md` to reflect: full v1 ship-ready
- Add `docs/bench.md` documenting the bench process and expected cost/runtime

Commit: `docs: Phase 4 complete — Iris v1 ready for Otto integration`

---

## Self-review checklist

- §10.5 lighthouse → T3 ✅
- §10.5 vision_describe LLM-powered → T4 ✅
- §12.4 ffmpeg clip slicing → T2 ✅
- §14.3 known-bug bench → T5, T6 ✅
- §10 persona pool → T1 ✅
- Rubric tuning → T7 ✅

After Phase 4, all in-scope items from the design spec §1 ("In scope (v1)") are done. Iris v1 is ready for Otto integration and skill-wrapping.
