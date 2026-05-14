# TodoMVC Realistic Demo Fixture Plan

**Date:** 2026-05-13
**Scope:** Vendor a pinned static TodoMVC vanilla JS fixture for Iris realistic-demo regression targets.

## Plan

1. Vendor only static runtime files from TodoMVC `examples/vanillajs/` at `25a9e31eb32db752d959df18e4d214295a2875e8`.
   - Why: current TodoMVC branch heads no longer have `examples/vanillajs/`; their replacement no-build app uses in-memory storage and does not satisfy the requested persistence contract. Commit `25a9e31eb32db752d959df18e4d214295a2875e8` is the latest upstream commit found for the requested `examples/vanillajs/` fixture path and uses localStorage.
   - Verify: every `<link href>` and `<script src>` in `public/index.html` resolves to an existing file under `fixtures/realistic-demos/todomvc-vanilla/public/`.

2. Add Iris metadata for a clean real-product baseline.
   - Why: this fixture is meant to catch Iris false positives on a correct reference app, not seed deliberate bugs.
   - Verify: `meta.json` parses as JSON and follows the clean-baseline fields used by `fixtures/known-bugs/07-clean-baseline/meta.json`.

3. Add `VENDORED.md` with source, commit, copied path, changes, license, update procedure, and bench integration decision.
   - Why: realistic third-party fixtures need pinned provenance so future agents can refresh without guessing.
   - Verify: `VENDORED.md` names the exact commit and states that the default bench does not auto-include `fixtures/realistic-demos/`.

4. Keep bench defaults unchanged.
   - Why: `pnpm bench` currently includes known-bug and broken-app fixtures only; auto-including realistic demos would change nightly cost and runtime.
   - Verify: `scripts/bench.ts` is unchanged and still discovers only `fixtures/known-bugs/` and `fixtures/broken-apps/`.

5. Run local checks.
   - Verify: `pnpm -r build` passes.
   - Verify: `pnpm --filter @iris/cli exec tsc --noEmit --pretty false` passes.
   - Verify: a short static-server smoke test loads `/index.html` and confirms referenced assets return 200.

## Plan Review

Codex MCP plan gate could not run in this session because `mcp__codex__codex` is not available. The implementation keeps the change data-only and fixture-local, with verification focused on static asset integrity and existing build/type checks.

## Verification Results

- `meta.json` parsed successfully with Node.
- Every local stylesheet/script reference in `public/index.html` resolves to an existing file under `public/`.
- All vendored JavaScript files passed `node --check`.
- `public/js/store.js` uses `localStorage`; no `MemoryStorage` remains in the fixture.
- `scripts/bench.ts` has no diff, so default bench discovery is unchanged.
- Starting a local static server was blocked by the sandbox with `listen EPERM: operation not permitted 127.0.0.1`; asset resolution was verified directly from disk instead.
- `pnpm -r build` passed.
- `pnpm --filter @iris/cli exec tsc --noEmit --pretty false` passed.
