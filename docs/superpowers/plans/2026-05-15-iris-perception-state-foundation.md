# Iris PerceptionState Foundation Plan

**Date:** 2026-05-15
**Scope:** Add a compact, provider-neutral browser perception state to observations without changing Explorer prompting yet.

## Problem

Iris currently stores perception across ad hoc fields: observation summary text, DOM outline, body text, rich content, screenshots, `ui_state` probes, and report screenshot indexes. That makes later prompt compaction, replay, and self-healing harder because there is no stable state object with element ids, roles, names, bounds, and hashes.

## Decision

Add a minimal `PerceptionState` type to `@iris/adapter-types` and have the web adapter attach it to each observation payload as `perception_state`.

This is a foundation-only step:

- No prompt rewrite.
- No replay cache yet.
- No vision locator yet.
- No duplicate report section.

## Steps

1. Define shared types.
   - Verify: adapter-types build passes and downstream packages compile.

2. Populate `perception_state` in web observations.
   - Include URL, title, viewport, scroll, screenshot ref, text/outline samples, active element, and visible candidate elements with stable hashes and bounds.
   - Verify: adapter-web observation test asserts a visible button/input appears with a stable hash and bounds.

3. Keep legacy observation payloads intact.
   - Verify: existing observation summary, `outline`, `body_text`, `rich_content`, and `screenshot_ref` assertions continue to pass.

## Gate

Codex MCP Plan Gate is not available in this session. Fallback review criteria:

- This should consolidate state, not change behavior.
- Do not emit screenshots twice.
- Keep element caps bounded.
- Keep stable hashes free of runtime-only ids when possible.

## Verification

- `pnpm --filter @iris/adapter-types run build`
- `pnpm --filter @iris/adapter-web exec vitest run src/index.test.ts --reporter=dot`
- `pnpm --filter @iris/adapter-web run build`

## Outcome

Implemented the foundation:

- `@iris/adapter-types` now exports `PerceptionState`, `PerceptionElement`, and bounds types.
- Web observations attach `payload.perception_state` with URL/title, timestamp, screenshot ref, viewport, scroll, text/outline samples, active element, and up to 80 visible candidate elements.
- Each candidate element carries a compact stable hash, role/name/text/href/type/value where available, visibility, and bounds.
- Existing observation payload fields remain unchanged.

Verification completed:

- `pnpm --filter @iris/adapter-types run build`
- `pnpm --filter @iris/adapter-web exec vitest run src/index.test.ts --reporter=dot`
- `pnpm --filter @iris/adapter-web run build`
