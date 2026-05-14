# Explorer Failure Patterns

These examples are reference material for Iris maintainers. They were removed
from the always-loaded Explorer skill so routine runs carry the rules, not the
long casebook.

## F1: Custom editor input looked unchanged

Symptom: post-action observation looked identical to pre-action, so the
Explorer concluded typing failed. Reality: CodeMirror, Monaco, ACE, or another
editor framework stored the text in state that normal body text did not expose.

Action: read the RICH CONTENT section. If it contains the typed text, verify the
goal. If it does not, the editor may genuinely have rejected input.

## F2: Export was reported as no-confirmation

Symptom: the Explorer clicked Export, asked vision_describe about browser chrome
or a guessed region, saw nothing, and reported no confirmation. Reality: the
app showed an in-page toast such as "Exported as HTML".

Action: run `notifications_visible` after any action that should confirm. Never
claim "no confirmation" without that probe.

## F3: Console noise was treated as product failure

Symptom: console or network probes showed many resource errors. Reality: they
were blocked third-party trackers or environment-only resource failures.

Action: separate first-party app errors from third-party resource noise. Count
JavaScript exceptions, app console.error calls, and first-party 4xx/5xx as
product evidence; treat blocked trackers as caveats at most.

## F4: One goal consumed the run

Symptom: the Explorer spent most of the budget trying to focus one editor or
control, leaving the rest of the goals unattempted.

Action: use per-goal cutover. After the per-goal budget is spent, call
`goal_status` with partial or untested and move on.

## F5: Verified status cited only a side-effect

Symptom: a goal was marked verified, but the evidence was only an action event,
tool selection, open panel, or dialog. The required user-visible artifact was
not shown.

Action: require a post-interaction outcome artifact: observation, rich content,
vision_describe quote, or screenshot that names or shows the required result.
Downgrade verified claims that cite only side-effects.
