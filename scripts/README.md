# scripts/

Operational scripts for the Iris monorepo.

## bench.ts

Runs `iris eval` against each fixture in `fixtures/known-bugs/` and asserts the meta.json expectations.

**Requirements:**
- `ANTHROPIC_API_KEY` in env (real LLM cost)
- `pnpm build` has been run (uses `packages/cli/dist/bin.js`)
- `npx playwright install chromium` (Phase 2 setup)
- `ffmpeg` on PATH (optional, for video clips)

**Cost:** ~$5–15 per full run (8 fixtures × ~$1 each, depending on exploration depth).

**Usage:**

```bash
# Full bench
pnpm bench

# Single fixture
pnpm bench -- --filter empty-form

# Lower cost cap per fixture
pnpm bench -- --max-cost 0.50
```

**What it asserts per fixture:**
- All `must_find` findings appear (recall)
- Score falls within `expected_score_range.overall` (calibration)
- Nothing in `expected_to_NOT_find` appears (precision)

**Exit code:**
- 0 — all fixtures passed
- 1 — at least one fixture failed
- (skipped quietly with code 0 if `ANTHROPIC_API_KEY` is missing)

**When to run:**
- Nightly in CI
- Before any release
- After tuning rubric YAMLs (Task 7)
