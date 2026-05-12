---
name: evaluating-products-as-real-user
description: |
  Use when evaluating a software product end-to-end by driving its UI as a real
  user would — exercising features, verifying outcomes, and producing a
  trustworthy quality report. Covers automated UI testing with an LLM agent
  in the driver's seat (browser, eventually CLI/API). Triggers: any task that
  involves "use this app and tell me what works/doesn't," running an agent
  against a real product, building or operating an end-to-end evaluator, or
  reviewing whether a report from such an evaluator is honest. This is the
  durable knowledge Iris's Explorer and Judge consult every run.
---

# Evaluating products as a real user

Automated end-to-end testing with an LLM driving the UI. Same goal as a human
QA reviewer with limited time: form a hypothesis about what the product does,
exercise the primary flows, verify the user-visible outcomes, and report what
worked, what didn't, and what wasn't tested. The bar is **"a careful human
reviewer using the same product for the same time would broadly agree with the
report."** Not detail-perfect — but no claim materially wrong in either
direction.

This skill is the discipline that gets you to that bar. The rules are not
arbitrary; each one fixes a class of failure that real evaluators (Iris
included) keep producing.

---

## The first instinct: be a user, not a script

A real user is curious, observant, and committed to actually finishing
things. They:

- Try the obvious primary feature first ("this is a TODO list — let me add a
  todo"). Goal-test happy paths before edge cases.
- Use what they see. If the page has a `+ New` button visible, they click it.
  They do not enumerate selectors hoping one matches a hidden affordance.
- Trust what's on screen. If they typed "hello" and the screen shows "hello",
  the typing worked. They do not wait for a separate confirmation modal.
- Move on when stuck. If a button doesn't respond after two attempts, they
  try a different path or note "I expected this to work, it didn't" — they
  don't grind on the same interaction.

Internalize this before reading anything else below. The rules that follow
prevent agent-specific failures, but the foundation is the user mindset.

---

## Real-user interactions, real coverage

Real users do more than click and type. An agent missing these primitives
will fail on products that need them — and worse, will often blame the
product rather than admit the missing capability.

**Always-needed:** click, type, press (single key), navigate, scroll, hover.

**Needed for any non-trivial app:**

- **drag** / **click-drag** — canvas drawing, sliders, drag-and-drop
  reordering, range pickers. A single click does NOT draw a shape, set a
  slider, or move an item.
- **key chord** (Cmd+Z, Ctrl+A, Cmd+Enter) — undo, select-all, command
  palette, shortcut-based submission. Most productivity apps require these.
- **paste** — rich-text editors (ProseMirror, Lexical, Slate) handle paste
  events differently from keystroke-by-keystroke typing.
- **right-click** — context menus (file managers, IDEs, kanban boards).
- **double-click** — rename-in-place, open-in-list.
- **upload** — file input flows; without this you can't test image-upload,
  CSV-import, profile-photo, etc.
- **hover-and-wait** — tooltips, hover-revealed menus, popovers gated by
  intent timers.

If a goal requires a primitive the agent doesn't have, mark the goal
`untested` with a caveat that names the missing primitive. Do not invent a
"product is broken" finding from the agent's missing capability.

---

## Verify what the user sees, not what fired

The single largest source of fake passes is mistaking **side-effects** for
**outcomes**. They look similar in a trace but mean very different things.

| Side-effect (NOT proof of success) | Outcome (proof of success) |
|---|---|
| Properties panel appeared when tool was selected | The drawn shape visible on the canvas |
| The dialog/modal opened | The action the dialog offered actually happened |
| Request returned 200 | A follow-up read confirms the resource exists |
| Focus moved to the field | The text the user wanted is in that field |
| Toast appeared | The toast specifically says the operation succeeded |

When verifying a goal as `verified`, cite evidence that contains the
user-visible artifact. Not the action you took — the *result* on the page.

In a trace this means: cite the OBSERVATION event AFTER the interaction whose
summary visibly contains the artifact, or a vision_describe quote that names
it, or a screenshot. Not the action event. Not your own goal_status event.
Not "the request fired."

The same principle applies to other modalities when this skill is used
beyond the browser:
- **CLI**: outcome = stdout content or filesystem diff matching what the user
  asked for. Side-effect = the command exited cleanly.
- **API**: outcome = the response body plus a follow-up GET confirming the
  write persisted. Side-effect = the action endpoint returned 200.

---

## Selectors: accessible name first, CSS last

This is established Playwright / Cypress / Testing Library wisdom and it
applies fully:

1. **`role=` queries first** (`role=button[name="Sign in"]`). Survives
   layout shifts and CSS changes. Enforces accessibility.
2. **`getByLabel` / accessible-name** for form fields.
3. **Visible text** (`getByText("Save")`) when role isn't enough.
4. **`data-testid`** if the product cooperates.
5. **CSS selectors** as last resort.

Don't trust framework-specific CSS classes (`.CodeMirror`, `.cm-editor`) as
identifying selectors — products migrate (Dillinger moved CodeMirror →
Monaco) and the agent's stale framework guess becomes the source of fake
"X is broken" findings.

When typing into a complex editor (CodeMirror, Monaco, ACE) the right
strategy is:
1. Click the editor area (vision_click is fine if accessible-name isn't
   available).
2. Type using the keyboard — the editor's hidden textarea will receive it.
3. Verify the typed content via the RICH CONTENT section of the next
   observation (which captures editor framework content invisible to
   `body.innerText`).

---

## When the trace is thin, say "untested" — not "broken"

If the agent attempted a goal but the observations don't visibly reflect the
result, there are three possibilities and you cannot distinguish them from
the trace alone:

1. The product genuinely failed (real bug).
2. The agent's interaction missed the target (selector mistake, coord wrong).
3. The observation snapshot couldn't see the result (instrumentation gap —
   transient toast that already faded, content in a shadow DOM, etc.).

**Default verdict when undistinguishable**: goal status `untested`, with a
caveat naming the gap. Do NOT emit a "the feature doesn't work" finding on
this evidence alone.

A real product-failure finding needs **positive** evidence of failure:
- A visible error message on the page
- A pageerror or console.error (NOT a "Failed to load resource: net::ERR_..."
  network noise — that's blocked trackers, not bugs)
- A failed first-party network request (4xx/5xx on the app's own API)
- A vision_describe quote explicitly naming a broken state

Without one of those, the conclusion is "I couldn't tell," not "it's broken."

---

## Detect confirmation with the right tool

Most apps signal success via transient UI: toasts, snackbars, aria-live
regions, banners. They appear briefly then fade. Vision_describe at a guessed
region ("the browser download bar") will miss them.

For any "did this action confirm?" check, use a probe that sweeps:
- `[aria-live]` regions (polite/assertive)
- `[role="alert"]`, `[role="status"]`
- Toast framework classes: `.Toastify__toast`, `.MuiSnackbar-root`,
  `.chakra-toast`, `.ant-notification`, `.ant-message`, `[class*="Toast"]`,
  `[class*="Snackbar"]`, `[class*="notification"]`
- Fixed-position corner elements with short text (custom toasts)

In Iris this is the `notifications_visible` probe. If the probe returns >0
notifications after an action, that's confirmation evidence. If it ran and
returned nothing, that's a real "no confirmation" finding — but not before
the probe ran.

A "no confirmation" finding without a probe that specifically checked is
almost always a fake produced by guessing wrong about where confirmation
would appear.

---

## Tell agent confusion apart from product defects

The single most-recurring fake-finding pattern: the agent tried a selector,
it didn't work, and the Judge wrote up "the X control is not reachable" as a
product bug. This is the agent's confusion, not the product's defect.

**Phrasings that mean "the agent was confused"**:
- "not reachable / actionable / focusable / clickable / targetable via [...]"
- "could not be focused / located / found / targeted"
- "selector failed / timed out / not found"
- "ARIA selector / accessible-name locator click timed out"
- "X has poor selector targeting / accessible name"
- "X is not exposed as a button to assistive tech" *(unless backed by axe)*
- "lacks proper accessible textbox role / semantics" *(unless backed by axe)*

These titles describe **automation strategy**, not user experience. Real
product findings describe what the user sees:
- "Submit button is invisible at mobile width"
- "Clicking Save shows 'Error 500'"
- "Login form accepts invalid email format silently"

If a finding sounds like agent-strategy, treat it as one. Drop it unless
you have positive evidence of user-visible failure.

---

## When you have no spec, discover one

A real user lands on a page and forms a hypothesis: "This looks like a TODO
list — I should try adding a todo." Discovery does the same:

1. Capture an initial observation: URL, DOM outline, visible page text, one
   screenshot.
2. Ask: what is this product? Who is it for? What would a normal user do
   first? List 8–12 testable goals in user-likelihood order.
3. Mark goals `must` (core to the product's purpose) or `should`/`could`
   (likely a user would try, secondary).
4. Treat these as the spec for the rest of the run.

Don't invent features you can't see evidence for. If the page shows a search
bar, propose "use the search." If there's no visible Sign-In, don't propose
"create an account."

**Mid-run discovery is real too.** When you exercise the product and find a
surface the seed goals didn't cover (Settings panel, Library, Share dialog),
propose a new goal at that point. The agent should add high-signal goals
sparingly — a cap of ~6 expansion goals per run prevents runaway scope.

---

## Coverage is part of the verdict

A high score on a barely-tested product is misleading. A "passes threshold"
verdict requires:

- Score meets the bar
- **At least 50% of discovered goals were actually attempted** (verified /
  partial / blocked), not all-untested
- Zero blocker findings

If only 3 of 12 goals were attempted, the report says "threshold not met
(coverage)," not "passed." This protects readers from the failure mode
where 4/12 verified looks pass-able but isn't.

The corollary: be honest about budget. If the agent runs out of cost or time
before attempting all goals, surface that as a run-meta caveat, don't
silently leave goals as `untested` without explanation.

---

## Common failure patterns to recognize

Drawn from running this exact discipline against Excalidraw, TodoMVC,
Dillinger, Desmos, Wikipedia, and across phases of Iris dogfood. When you
see these in a trace or finding, act on them.

### F1 — "I typed but nothing happened" but the editor is a custom framework

**Symptom**: post-action observation looks identical to pre-action. Agent
concludes typing failed. Reality: the editor (CodeMirror / Monaco / ACE)
renders text in its own DOM that `body.innerText` cannot see.

**Action**: read the RICH CONTENT section of the observation, which captures
editor framework content. If RICH CONTENT shows the typed text, the action
worked — verify the goal. If it doesn't, the editor may genuinely have
rejected input.

### F2 — "Export gives no confirmation" when the app shows a toast

**Symptom**: agent clicked Export → HTML, ran vision_describe asking about
"browser chrome / download bar," got "nothing visible," concluded no
confirmation. Reality: an in-app toast ("Exported as HTML") appeared in the
bottom-right corner.

**Action**: run the notifications_visible probe AFTER any action that should
trigger a confirmation. Cite its output. Never claim "no confirmation"
without it.

### F3 — "Console errors during normal use" when they're all `net::ERR_...`

**Symptom**: console probe reports 15 errors, agent treats as product bug.
Reality: all 15 are "Failed to load resource: net::ERR_CONNECTION_CLOSED"
on third-party trackers blocked by adblock or unreachable from a headless
context.

**Action**: separate resource_error from app_error. Only app_error (real
JavaScript exceptions, console.error calls from the app's own code) counts
as a product bug. Resource errors are noise unless they're 4xx/5xx on the
app's own first-party endpoints.

### F4 — Single-goal grind eats the budget

**Symptom**: agent spends 30+ turns trying to focus an editor. None of the
other 11 goals get attempted. Run looks like a total failure.

**Action**: per-goal cutover. After ~1.5× the per-goal budget on one goal
without calling `goal_status`, force-advance with `goal_status(partial,
auto_cutover=true)`. The remaining goals get their fair shot.

### F5 — Fake verified from side-effect citation

**Symptom**: goal verified, but evidence cites only the action event or a
"panel opened" vision_describe. Screenshot at that moment shows the user-
visible artifact is NOT present.

**Action**: goal-claim validator. For every `verified` claim, require that
the evidence array cites a post-interaction outcome artifact (observation
containing the artifact in its summary or rich content, or a vision_describe
quote naming it). Downgrade `verified → partial` when only side-effects are
cited.

---

## Things to avoid

- **Reading the page for many turns before acting.** ONE observe, then act.
  Agents that hesitate produce thin coverage.
- **Calling probes before any interaction.** Probes catch issues that arise
  during use; running axe on a static page before exercising any feature is
  premature.
- **Trying many alternate selectors after the first failed.** After one
  selector miss, switch strategy (different element, different action, or
  note "I expected X but couldn't find it" and move on). Selector grinding
  produces fake findings.
- **Spending more than per-goal budget on one goal.** The auto-cutover is a
  safety net — better to declare `partial` yourself and move on.
- **Claiming "X is broken" without positive failure evidence.** Default to
  `untested`/`unclear` instead.
- **Treating each automation hiccup as a product complaint.** When you're
  unsure, the answer is to lower confidence, not invent a finding.

---

## The handoff to the Judge

When you're scoring after a run, your job is to be a skeptical reader of the
trace, not a credulous reporter:

- The agent's self-reported `verified` is a *claim*, not proof. Require an
  outcome artifact.
- The agent's selector-miss errors are *not* product findings. Drop those
  titles wholesale.
- The agent's "no confirmation visible" is suspect unless a notifications
  sweep confirms it.
- Console errors need triage (app vs resource).
- The score must not exceed honest coverage. Low coverage = caveat in the
  headline, not buried.

When in doubt, **the trustworthy report under-claims rather than over-claims**.
A reader can act on "uncertain — needs human follow-up." A reader cannot
act on "verified" that turns out to be fake.

---

## When this skill is wrong, update it

The principles above were learned from real failures. New apps will produce
new failures we don't have rules for yet. When the audit finds a divergence
between the report and reality:

1. Classify the failure (Class A: fake failure / Class B: fake pass / Class
   C: coverage gap / Class D: misleading score).
2. Identify the structural cause (instrumentation, prompt, validator,
   scoring).
3. Fix the cause AND add the lesson to this skill.

The skill is a living artifact. The codebase enforces what the skill
teaches. They evolve together.
