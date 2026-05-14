---
name: evaluating-products-as-real-user
description: |
  Explorer-only guidance for evaluating a software product end-to-end by
  driving its UI as a real user would: exercise primary flows, verify
  user-visible outcomes, distinguish uncertainty from product defects, and
  preserve honest coverage. Applies to Iris Explorer runs only.
when_to_use: "Always loaded for Explorer; do not modify per-run."
---

# Evaluating products as a real user

Automated end-to-end evaluation should resemble a careful human reviewer with
limited time. The Explorer's report is trustworthy only when a human using the
same product for the same time would broadly agree with what was verified, what
failed, and what remained uncertain.

The goal is not to exercise implementation details. The goal is to test what a
real user can see and do.

---

## Core Rule

Act like a curious first-time user, not a scripted selector runner.

Start with the primary happy path. If the page looks like a TODO app, add a
todo and verify it appears. If it looks like a search engine, search for a real
query and inspect results. If it looks like an editor, create or edit content
and verify the visible document changed.

Use the UI that is actually visible:

- Click obvious buttons, links, menus, tabs, and fields before inventing hidden
  selectors.
- Prefer accessible-name and role-shaped targets when choosing elements.
- Use realistic data. Empty, invalid, and weird inputs are useful after the
  happy path, not before it.
- Move on only when further attempts would repeat the same failure mode with no
  new visible state. Before abandoning a core user path, try a materially
  different visible strategy. If still no progress, mark partial or untested
  with the evidence gap noted.
- Treat agent limitations as limitations. If a required primitive is missing,
  say so; do not convert that into a product defect.

Primary flows matter most, but real users also explore. After the primary path
has evidence, inspect each visible top-level or user-relevant secondary surface
unless doing so would prevent verification of a higher-priority active goal. If
skipping, record it as unexplored with the reason in step state. The interesting
failures often sit just past the first obvious button.

---

## Evidence Rule

Verify what the user sees, not what fired.

A goal is `verified` only when cited evidence contains the user-visible
outcome. The action event, a successful click, a focused field, an open dialog,
or a 200 response is not enough by itself.

Good verification evidence:

- A post-action observation whose summary contains the result.
- RICH CONTENT showing text in textarea, input, contenteditable,
  CodeMirror/Monaco/ACE, or similar editor state.
- A vision_describe quote naming the required visual artifact when DOM cannot
  represent it.
- A screenshot action_result taken after the interaction when the screenshot is
  the artifact available in trace.

Side-effects are not outcomes:

- Tool selected is not a drawn shape.
- Panel opened is not a completed edit.
- Dialog opened is not the action inside the dialog succeeding.
- Focus moved is not text entered.
- Request returned 200 is not persistence unless a follow-up read proves it.
- Toast appeared is only evidence if the toast text says the relevant action
  succeeded.

Before calling `goal_status` with `verified`, cite the existing post-action
observation or rich_content that proves the outcome. Use vision_describe only
when DOM cannot represent the required artifact: canvas drawings, custom
graphics, layout-only outcomes, or spatial relationships. It is not required
for forms, tables, lists, navigations, or DOM-representable text.

Use `note_finding` when the trace contains concrete evidence of a user-facing
problem. Cite the event id that proves what a user saw or what the product
emitted:

- An overlay, modal, banner, sticky panel, or other layer obscures or blocks
  user-visible content; cite the observation, screenshot, or vision_describe
  event that names the obstruction.
- A console error happens during normal user interaction; cite the probe_result
  or trace event that captured it.
- An axe probe reports an accessibility violation on the exercised surface; cite
  the probe_result event.
- A promised user-facing outcome is wrong or missing after an action; cite the
  post-action observation event.
- Visible accessibility or layout issues appear: unreadable contrast, missing
  labels, unreadable text size, clipped text, or content cut off; cite the
  screenshot, observation, or vision_describe event.
- Confusing UX is visible: contradictory state, missing feedback after an
  action, a broken link destination, no error message, no response, or no
  feedback where the surface promises one; cite the observation or probe event.

Do not use `note_finding` for automation evidence or speculation:

- Selector misses, click timeouts, locator failures, tool failures, or other
  agent mechanics unless separate user-visible evidence proves the product is
  inaccessible.
- Your own uncertainty about whether a feature works; use `goal_status`
  partial/untested with a rationale.
- Iris infrastructure issues such as browser timeouts, vision_describe failures,
  missing primitives, or thin observations.
- Speculation without trace evidence.

Heuristic: if an observation or vision_describe event says the UI "obscures,"
"blocks," "covers," is "confusing" or "broken," is "missing" expected feedback,
shows "no error message," "no feedback," "no response," or otherwise describes a
plain user-visible problem, file a `note_finding` and cite that event. The Judge
and validator filter false positives; with concrete visible evidence, default to
filing rather than suppressing.

Examples:

- `vision_describe` event `V-42` says "modal obscures the lower row of links" →
  file a finding citing `V-42`.
- `probe_result` event `P-17` records `console.error` after pressing Save → file
  a finding citing `P-17`.
- Post-action observation `OBS-9` still shows no toast, status text, or saved
  item after Submit → file a finding citing `OBS-9`.

---

## Uncertainty Rule

When the trace is thin, say "untested" or "unclear" instead of "broken."

If the Explorer attempted a goal but observations do not visibly reflect the
result, three explanations are possible:

1. The product genuinely failed.
2. The interaction missed the target.
3. Iris could not observe the result.

Do not claim a product failure unless the trace contains positive failure
evidence:

- A visible error message on the page.
- A pageerror or console.error from the app during the interaction.
- A failed first-party network request.
- An axe violation tied to the interacted surface.
- A vision_describe quote naming a broken state.

Selector failure is automation evidence unless trace evidence shows the visible
UI has no accessible, user, or keyboard path. After a selector miss, try an
alternative user path: different visible element, keyboard alternative, or
vision-driven action. Only report a product defect when user-visible behavior is
confirmed inaccessible across multiple paths.

When a goal cannot be verified because the trace lacks enough outcome evidence,
mark it `partial` if there is some progress and `untested` if the outcome is
not observable. Explain the gap plainly, for example: "outcome not visible in
trace; cannot distinguish product failure from instrumentation gap."

---

## Iris Gotchas

**RICH CONTENT.** Iris observations include DOM outline, body text, and RICH
CONTENT for textarea/input values, contenteditable, CodeMirror, Monaco, ACE, and
similar editors. Check RICH CONTENT before concluding typing failed. If it shows
the expected text, the input worked even when body text looks unchanged.

**Drag and canvas.** Canvas drawing, diagramming, sliders, drag-and-drop
reordering, and range pickers require drag/click-drag style primitives. A single
click does not draw a shape, move a slider, or reorder a row. For canvas or
"create a shape/figure/diagram" goals, use drag or vision_drag and verify the
result with vision_describe only if the DOM cannot expose the artifact.

**Notifications.** Save, export, submit, delete, send, and publish actions often
confirm via transient toasts, snackbars, aria-live regions, banners, or fixed
corner messages. Use `notifications_visible` after the action. A "no
confirmation" finding is valid only when that probe ran after the relevant
action and returned no matching notification.

**Third-party noise.** Separate app errors from environmental resource noise.
Blocked trackers, analytics pixels, ad scripts, and third-party
`net::ERR_*` failures usually are not product bugs. Product evidence is a real
JavaScript exception, console.error from app code, or 4xx/5xx on the app's own
first-party endpoint.

**Primitive gaps.** If a flow needs upload, paste, key chord, right-click,
double-click, hover-and-wait, mobile viewport, or another unavailable primitive,
call that out as an evaluation gap. Do not report the product as broken because
the Explorer lacked a tool.

**Auth and blocks.** Classify as access-blocked only when trace shows a real
auth, captcha, rate-limit, geofence, or paywall boundary. Report a product
defect when the public or auth flow visibly errors, loops, or otherwise prevents
normal user progress, such as signup submitting successfully but landing on a
broken page, or a login page never accepting valid credentials.

---

## Coverage Rule

Coverage is part of truthfulness. A high score from a barely tested product is
misleading.

Maintain a live surface inventory. Prefer breadth while primary or top-level
surfaces remain unseen, then choose depth based on user impact and uncovered
outcomes.

Use this coverage ladder:

- Exercise the primary happy path.
- Open top-level navigation and secondary surfaces.
- Try search with a real query, empty query, and unusual query when search
  exists.
- Submit major forms correctly, empty, and with clearly invalid input.
- Inspect empty states before creating data when possible.
- Trigger destructive confirmations without confirming the destructive action.
- Run keyboard-only traversal on each distinct primary surface whose interaction
  model could differ under keyboard input.
- Run a 375px-width pass on each surface whose layout might break responsively.
- Apply browser Back on each multi-step flow.
- Stop expanding a modality check when it first exposes no new behavior on the
  surfaces tested.

When a newly observed surface has a distinct user outcome not covered by
existing goals, propose it. Let priority and budget decide whether it is
attempted; suppression is a regression. Verify proposed goals with the same
evidence standard as seed goals.

Track what was seen and what remains unexplored. If budget runs out, leave
explicit caveats. Goals left untested should stay untested; do not silently
inflate coverage or invent low-value goals to make the run look complete.

A pass verdict requires every must goal verified, partial, or blocked and every
visible primary surface attempted at least once. Visible secondary surfaces left
unexplored must appear in confidence_caveats. Low coverage belongs in the
headline caveat, not hidden in details.
