# Iris bench

Iris's empirical regression net. Runs `iris eval` against each fixture in `fixtures/known-bugs/` and asserts the meta.json expectations — recall (`must_find`), precision (`expected_to_NOT_find`), and calibration (`expected_score_range`).

## Why a bench

Behavioral correctness for an LLM-driven tool is empirical. Unit tests verify deterministic logic; cassette tests verify prompt/parse pipelines. The bench is the only thing that catches **prompt drift that "looks fine" but actually drops a category of finding**.

Run it nightly + on release branches.

## Cost

Roughly $5–15 per full bench run (8 fixtures × ~$1 each, scaling with `--max-cost-usd` per-fixture cap).

## Requirements

- `ANTHROPIC_API_KEY` in env (real Claude calls)
- `pnpm build` has been run (uses `packages/cli/dist/bin.js`)
- `pnpm exec playwright install chromium` (Phase 2 setup)
- `ffmpeg` on PATH (optional — if missing, sliceEvidence falls back to screenshots)

## Usage

```bash
# Full bench
pnpm bench

# Single fixture
pnpm bench -- --filter empty-form

# Lower per-fixture cost cap
pnpm bench -- --max-cost 0.50
```

## What gets asserted

For each fixture's `meta.json`:

| Field | Assertion |
|---|---|
| `expected_findings[].must_find: true` | The matching finding (category + severity range + title keywords) appears in `report.json`. **Recall.** |
| `expected_score_range.overall: [min, max]` | `report.headline.score` falls in the range. **Calibration.** |
| `expected_to_NOT_find` | Nothing matching appears in `report.json.findings`. **Precision.** |

Plus:
- Per-fixture cost is tracked and logged.
- Total cost printed at the end.
- Exit code 1 if any fixture fails.

## What's in fixtures/known-bugs/

| Fixture | Bug | Expected score range |
|---|---|---|
| 01-empty-form-submit | Silent submit, no validation | 3–6 |
| 02-focus-trap-modal | No Esc handler, broken focus | 4–7 |
| 03-broken-export | "CSV" button produces JSON | 4–7 |
| 04-console-noise | 4 console errors per load | 5–8 |
| 05-bad-empty-state | Empty page with no copy | 5–8 |
| 06-keyboard-inaccessible | Critical action on `<div>` | 3–6 |
| 07-clean-baseline | No bugs (positive control) | 7.5–10 |
| 08-many-small-issues | 12+ copy nits, no majors | 6–8.5 |

## Tuning rubrics from bench output

When a fixture fails:
- **Missing findings (recall)**: tighten the relevant rubric dimension's `common_signals.negative` to make it more sensitive, or adjust the JUDGE_SYSTEM prompt to look harder for that category.
- **Score out of band (calibration)**: adjust `weight_in_overall` or dimension weights in the rubric YAML.
- **False positives (precision)**: loosen `common_signals` or improve the judge's dedup/discard prompt.

Re-run `pnpm bench -- --filter <fixture>` after each tweak. Iterate until the bench is consistently green.

## Limits

- The bench uses real Anthropic API calls, so it's stochastic. Set `temperature: 0` in the LLM client (already done) but the same prompt + same trace can still produce slightly different outputs run-to-run. Allow some tolerance in score ranges.
- Bench accuracy depends on rubric quality. The Phase 4 ship is functional but not yet tuned; the first full bench run is expected to surface the mismatches that drive the first round of tuning.
