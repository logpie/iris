# TodoMVC Vanilla Vendor Notes

Vendored on: 2026-05-13

## Source

- Repository: https://github.com/tastejs/todomvc
- Vendored commit SHA: `25a9e31eb32db752d959df18e4d214295a2875e8`
- Commit: `Fix vanillajs cypress test run (#1902)`
- Source path copied: `examples/vanillajs/`

Current TodoMVC branch heads were checked on 2026-05-13. `master` was at
`ff43b02e59dfa604386bb382034b2cd07c2bcd8a` and `gh-pages` was at
`983c8382ed28b6bbf1a3c6a49ba4d96400016103`, but neither contains the requested
`examples/vanillajs/` path. The current no-build replacement,
`examples/javascript-es5/`, uses in-memory storage and does not satisfy this
fixture's persistence-across-reload contract. This fixture therefore pins the
latest upstream commit found for the requested vanilla JS path.

## What Was Copied

- `examples/vanillajs/index.html`
- `examples/vanillajs/js/`
- Runtime files referenced by `index.html` under `examples/vanillajs/node_modules/`
- Root `license.md`

## What Changed

No behavior changes were made. The files were copied into `public/` with their
referenced paths preserved so a static server rooted at `public/` can serve the
app without rewriting `index.html`.

TodoMVC CI, lint, package, and test files were intentionally not copied.

## Bench Integration

`scripts/bench.ts` was intentionally left unchanged. The default bench run still
discovers `fixtures/known-bugs/` and `fixtures/broken-apps/` only, so adding this
realistic demo does not increase existing nightly bench runtime or cost.

A future change can add an explicit demo runner, for example `pnpm bench:demos`
or a bench filter flag that opts into `fixtures/realistic-demos/`.

## Update Procedure

1. Pick the new upstream commit and record it here.
2. Delete `public/`.
3. Copy only the static runtime files needed to serve the selected TodoMVC app.
4. Preserve or deliberately document any path rewrites needed by `index.html`.
5. Include the upstream license file.
6. Run the static asset smoke test and Iris build/type checks.

## License

TodoMVC is MIT licensed unless otherwise specified. The original upstream license
file is included at `public/license.md`.
