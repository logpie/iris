# Dynamic Website Testing

## What Iris Needs

There are two different reproducibility problems:

1. **Iris regression testing.** We need to know whether Iris itself got better or worse after a code, prompt, rubric, model, or harness change. The target must be stable enough that a changed result usually means Iris changed.
2. **End-user product evaluation.** Users need an honest evaluation of the product/page they pointed Iris at. Dynamic content is part of that reality; Iris should preserve enough metadata for them to understand and compare runs, not pretend live sites are fixed test fixtures.

Wikipedia is useful as an occasional real-world smoke run, but it is a bad validation target for Iris regressions. A donation banner changing between P20 and P26 changes the product surface, so "2 bugs yesterday, 0 today" is not clean evidence about Iris.

## Iris Regression Testing

### Versioned Local Fixtures

This should be the default CI path. The repo already has two useful fixture families:

- `fixtures/known-bugs/` powers the bench described in `docs/bench.md`: empty form feedback, focus-trap modal, broken export, console errors, empty state, keyboard-inaccessible control, clean baseline, and many-copy-issues.
- `packages/adapter-web/test-fixtures/` covers adapter/browser capabilities such as interactions, toasts/notifications, forms, editors, and multi-page navigation.

Local fixtures are deterministic, cheap, offline, and easy to assert against. They should cover modal/banner edge cases by adding pinned pages that intentionally include transient-looking UI such as donation banners, cookie banners, modals, notification toasts, and dismissible overlays. The point is not to mimic Wikipedia exactly; it is to create stable surfaces where Iris must notice or dismiss the same UI every run.

### Snapshotted Real Sites

Snapshots are useful when we want the complexity of a real site without live-site drift. A snapshot should include at least DOM, critical assets, screenshots, viewport, console/network summaries, and response metadata. Replay should happen from a local server with network blocked or tightly controlled.

This is heavier than local hand-written fixtures. It is worth using for a small number of "realistic complexity" cases, not as the main regression net. Snapshot freshness is a maintenance cost, and replay can hide bugs that only appear with real network/API behavior.

### Public Stable Demos

Public demos like TodoMVC or framework examples are fine as optional canaries, but they are not stable enough for required CI unless Iris vendors a pinned copy or locks to a specific commit/build served locally. External demos can change, disappear, rate-limit, or serve different content by region.

Use live public demos to answer "does Iris still work against the web?" Use local/vendored demos to answer "did Iris regress?"

## End-User Runs On Dynamic Content

Reports should say plainly that the result reflects the page at the time Iris ran it. Suggested wording:

> This report reflects the target as observed during this run. Live content, personalization, experiments, ads, banners, auth state, and regional variation may change later results.

The report metadata should include:

- Run timestamps: `started_at`, `finished_at`, duration, timezone.
- Target identity: requested URL, final URL after redirects, page title, canonical URL if present.
- Environment: browser name/version, viewport, device scale factor, locale, timezone, user agent, network mode.
- Iris identity: Iris version/git SHA, model IDs, SDK/provider versions, rubric/profile names and versions, prompt/build hash if available.
- Page evidence: first and final screenshot paths, trace path, DOM or accessibility snapshot hashes, console/network summaries.
- HTTP/content hints: status code, ETag, Last-Modified, Cache-Control, response content hash when feasible.
- Dynamic-state hints: auth state used, cookies/storage state hash, geolocation if configured, experiment/campaign parameters if visible.

For comparisons, Iris should compare runs only when metadata is compatible. If a content hash, final URL, locale, viewport, or auth-state hash changes, the report diff should call that out as "target changed" instead of treating all finding deltas as evaluator changes.

## Recommendation

Use these targets to validate Iris itself:

1. **`fixtures/known-bugs/` bench as the primary regression suite.** It already encodes expected recall, precision, and score ranges for product-level bugs, including a modal/focus fixture and a clean positive control.
2. **`packages/adapter-web/test-fixtures/` capability fixtures as targeted CI checks.** They are ideal for proving Iris can observe and exercise interaction primitives, notifications/toasts, forms, editors, and navigation. Add pinned banner/modal-overlay pages here when needed.
3. **One vendored realistic demo served locally.** Prefer a pinned TodoMVC or Vue/React demo checked into the repo over a live public URL. This gives Iris a fuller app-shaped surface without letting public-web drift drive CI outcomes.

Keep Wikipedia and other live sites as labeled exploratory canaries, not pass/fail validation for Iris regressions.
