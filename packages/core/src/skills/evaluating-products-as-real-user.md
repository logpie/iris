# Evaluating Products as a Real User

Automated end-to-end evaluation should resemble a careful human reviewer with
limited time. Iris is trustworthy only when a human using the same product for
the same time would broadly agree with what was verified, what failed, and what
remained uncertain.

## Core Rule

Act like a curious first-time user, not a scripted selector runner.

Start with the primary value loop. If the page looks like a todo app, add a
todo and verify it appears. If it looks like a search engine, search for a real
query and inspect results. If it looks like an editor, create or edit meaningful
content and verify the visible document, canvas, or artifact changed.

Use realistic work. A text editor should get a real sentence or paragraph plus
formatting when available; a canvas editor should create visible objects with
labels or styling; a dashboard should change a data view; a CRUD app should
create or update a record.

## Materiality Rule

Inventory every visible surface, but do not treat every surface as a goal.

A first-class goal must represent a material user outcome: durable visible
artifact, state change, loaded result/content, saved/exported file, configured
setting, created record, or meaningful workflow boundary. Setup surfaces such as
cookie banners, promos, newsletter prompts, modals, support links, legal pages,
and footer destinations are normally context or blockers. Clear them when they
block real work, record them as seen or deferred, but do not promote them to
goals unless they are the product's own main purpose or they prevent a core
workflow.

Prefer depth on the primary value loop before broad secondary sampling. Secondary
workflows matter when they support the primary job, such as export, share,
import, account boundary, preferences, filtering, or language switching. They
should not displace core product-use evidence.

## Evidence Rule

Verify what the user sees, not what fired.

A goal is `verified` only when cited evidence contains the user-visible outcome.
The action event, a successful click, a focused field, an open dialog, or a 200
response is not enough by itself.

Good verification evidence includes a post-action observation, rich content for
inputs/editors, a screenshot, or a vision description naming the required visual
artifact. Weak evidence includes selected toolbar state, opened menu, focused
button, visible landing page, or a mode/panel being active with no resulting
artifact.

## Tool Rule

Use the UI that is actually visible. Click obvious buttons, links, menus, tabs,
and fields before inventing hidden selectors. Prefer accessible names and roles
when choosing elements.

Canvas drawing, diagramming, sliders, drag-and-drop reordering, and range
pickers require drag/click-drag primitives. A single click does not draw a
shape, move a slider, or reorder a row. For canvas or "create a
shape/figure/diagram" goals, use drag or vision_drag and verify the result with
vision_describe only if the DOM cannot expose the artifact.

After actions that should trigger confirmation, such as export, save, submit,
delete, send, or publish, use notifications_visible when confirmation matters.

## Uncertainty Rule

When the trace is thin, say "untested" or "unclear" instead of "broken."

Do not claim a product failure unless the trace contains positive failure
evidence: visible error message, pageerror or app console error, failed
first-party request, axe violation tied to the exercised surface, or a vision
description naming a broken state. Selector misses, tool failures, unavailable
primitives, and Iris infrastructure issues are evaluator limitations unless
separate user-visible evidence proves the product is inaccessible.

## Coverage Rule

Coverage is part of truthfulness. A high score from barely tested product use is
misleading.

Maintain a live product map: seen surfaces, deferred surfaces, core workflows,
secondary workflows, setup blockers, and open coverage risks. Prefer breadth
only until the primary product model is clear; then choose depth based on user
impact and uncovered material outcomes. If budget runs out, leave explicit
caveats rather than inflating low-value goals.
