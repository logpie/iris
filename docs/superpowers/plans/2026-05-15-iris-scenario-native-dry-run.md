# Iris Scenario-Native Design Dry Run

**Date:** 2026-05-15
**Purpose:** Dry-run a simpler Iris system model across several product shapes before changing schema or prompts.

## Problem

The current public model leaks too many internal layers:

- surfaces
- journeys
- goals
- product-use contract
- value loops
- user jobs
- scenario checks

Those layers helped us debug Discovery and prevent shallow tests, but they are not the right product-facing model. The user-facing model should be:

```text
Product -> user journeys -> user scenarios -> evidence -> findings / scores
```

The key distinction:

- **User journey:** a coherent workflow group, such as "create and share a whiteboard" or "find and read reference content."
- **User scenario:** the atomic thing Iris actually tries and proves, such as "create a labeled diagram" or "search for a topic and open the article."

Do not expose surfaces, contracts, value loops, user jobs, or goals in the main report.

## Proposed Canonical Model

```ts
interface TestingPlan {
  v: 1;
  product_summary: string;
  primary_journey_id: string;
  journeys: UserJourney[];
  scenarios: UserScenario[];
  deferred: DeferredArea[];
  internal_map?: {
    surface_ids?: string[];
    raw_discovery_refs?: string[];
  };
}

interface UserJourney {
  id: string;
  title: string;
  user_goal: string;
  success_state: string;
  priority: 'primary' | 'supporting' | 'sample';
  scenario_ids: string[];
}

interface UserScenario {
  id: string;
  journey_id: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  intent: string;
  actions: string[];
  expected_result: string;
  strong_evidence: string[];
  weak_evidence: string[];
  source_surface_ids: string[];
}

interface ScenarioResult {
  scenario_id: string;
  status: 'verified' | 'partial' | 'blocked' | 'not_tested';
  observed: string;
  evidence_refs: string[];
  finding_ids: string[];
}
```

Compatibility path: keep the existing Discovery JSON for now, but normalize it immediately into `TestingPlan`. Long term, make Discovery output `testing_plan` directly and demote the old structures to debug appendix fields.

## Dry Run 1: tldraw

Product shape: canvas/whiteboard editor.

Primary journey:

```text
Create and refine a whiteboard artifact, then make it shareable or exportable.
```

Journeys:

1. Create and refine board content
2. Share or export the board

Scenarios:

| Scenario | Priority | Expected result | Weak evidence |
| --- | --- | --- | --- |
| Create a small labeled diagram | must | Multiple visible board objects, with readable text and a visible relationship such as connector or layout | Tool selected, empty canvas, one trivial mark |
| Apply a visible style or layout change | must | Existing object visibly changes color, fill, size, position, or arrangement | Palette opened, style selected but no object changes |
| Revise the artifact with duplicate/delete/undo | should | Object count or arrangement changes and can be restored | Button clicked with no visible board change |
| Use a richer creation tool | should | A non-default shape, drawing, connector, media, or note appears on canvas | Shape menu opened but nothing placed |
| Export the current board | should | Download/export flow starts for the current artifact | Export menu opened only |
| Enter sharing/collaboration boundary | should | Share sheet or sign-in boundary tied to the current board appears | Share button focused only |

Deferred:

- SDK promo
- footer/legal links
- generic help/settings unless needed for the active scenario

Design implication:

Do not show "canvas creation value loop" and "user job" separately. Show one journey group with scenario cards and evidence clips.

## Dry Run 2: Wikipedia Article / Main Page

Product shape: search/content product.

Primary journey:

```text
Find, open, read, and navigate reference content.
```

Journeys:

1. Find and read content
2. Navigate article context
3. Personalize or account-support reading

Scenarios:

| Scenario | Priority | Expected result | Weak evidence |
| --- | --- | --- | --- |
| Search for a known topic and open the article | must | Topic page loads with readable article content | Search box focused, homepage still visible |
| Open featured/news content from the page | must or should | A linked article/news destination loads | Link clicked but destination not verified |
| Use article navigation such as sections, language, talk, edit, or history | should | Article-specific navigation changes the visible page or destination | Toolbar/tab visible only |
| Change reader appearance | should | Text/theme/width state visibly changes | Appearance menu opened only |
| Reach login/create-account boundary | should | Auth page opens with return context | Generic login link visible only |

Deferred:

- donation flow unless it blocks reading or the target is specifically a donation/foundation page
- app downloads
- sister projects
- legal/footer links

Design implication:

Wikipedia should not be judged by donation or footer behavior in a normal content audit. Those can be deferred areas, not scenario cards, unless the target URL is the Wikipedia landing page and language selection is the primary job.

## Dry Run 3: Issue Tracker / Linear-Like CRUD Product

Product shape: CRUD/workflow app.

Primary journey:

```text
Create, organize, update, and find work items.
```

Journeys:

1. Create and update work
2. Organize and search work
3. Collaborate around work

Scenarios:

| Scenario | Priority | Expected result | Weak evidence |
| --- | --- | --- | --- |
| Create a new issue with title/body/priority | must | New issue appears in list/detail view with entered content | Create form opened only |
| Change status, assignee, label, or priority | must | Existing issue state visibly updates and persists after navigation/reload | Dropdown opened only |
| Filter or search issues | should | List/table changes to match query/filter | Filter menu opened only |
| Add a comment or activity entry | should | Comment appears on issue timeline | Comment editor focused only |
| Use workspace/project setup if needed | setup | Required workspace/project exists before issue scenarios run | Treating setup as product success |

Deferred:

- billing
- profile settings
- invite/admin flows unless central to the target product

Design implication:

Setup blockers should be visible in the report, but not counted as the product's core scenarios. If workspace creation fails, downstream issue scenarios are blocked by setup, not "untested because Iris stopped."

## Dry Run 4: Commerce Product

Product shape: browse/product/cart/checkout.

Primary journey:

```text
Find a product, evaluate it, add it to cart, and reach a purchase boundary.
```

Journeys:

1. Browse and choose product
2. Configure and cart product
3. Checkout boundary

Scenarios:

| Scenario | Priority | Expected result | Weak evidence |
| --- | --- | --- | --- |
| Search or browse to a product detail page | must | Product detail page loads with price/details/options | Category menu opened only |
| Apply filter/sort and verify product list changes | should | Product list updates according to filter/sort | Filter drawer opened only |
| Select variant and add to cart | must | Cart contains selected item/variant/quantity | Add button clicked but cart not verified |
| Reach checkout boundary | should | Checkout/login/payment boundary appears for cart | Checkout link visible only |
| Handle cookie/promo obstruction | setup | Obstruction removed so shopping can continue | Promo dismissed as a standalone product win |

Deferred:

- newsletter signup
- rewards/account marketing
- footer/legal links

Design implication:

Promos and banners are setup unless they prevent purchase. The score should come from product finding/cart/checkout scenarios.

## Dry Run 5: Analytics Dashboard

Product shape: data dashboard.

Primary journey:

```text
Inspect data, change the view, and extract or act on insight.
```

Journeys:

1. Read dashboard state
2. Change filters/drilldowns
3. Export/share/save insight

Scenarios:

| Scenario | Priority | Expected result | Weak evidence |
| --- | --- | --- | --- |
| Apply a filter/date range and verify chart/table changes | must | Data view visibly updates | Filter menu opened only |
| Sort, group, or drill into a row/segment | should | Detail state or reordered data appears | Sort menu focused only |
| Save/share/export the current view | should | Download/share/save state tied to current view appears | Export menu opened only |
| Trigger an empty/error state with invalid/no-data filter | could | Clear empty/error state appears and can be recovered | No assertion on state |

Deferred:

- user profile
- billing/admin settings
- documentation/help links

Design implication:

For dashboards, "looked at the chart" is baseline observation, not a scenario. A scenario needs a data state change or a meaningful extracted/exported result.

## What The Dry Runs Show

The simpler model works across the products if we enforce these rules:

1. **Scenario is the execution unit.**
   Explorer should receive a scenario with actions, expected result, strong evidence, and weak evidence.

2. **Journey is only a grouping.**
   It groups scenarios into a user workflow. It should not be separately scored or separately "verified."

3. **Surfaces are support data.**
   They explain why a scenario was selected and help the agent find controls. They belong in debug or a collapsed discovery appendix.

4. **Setup is not product success.**
   Cookie banners, donation prompts, promos, login gates, and workspace prerequisites can block or enable scenarios. They should not consume core scenario slots unless the product's purpose is setup/account/admin.

5. **Scores summarize scenario evidence.**
   Rubrics should not create another hierarchy. Correctness, UX, frontend quality, accessibility, and coverage are dimensions over scenario evidence.

6. **Reports should be scenario-first.**
   The main report should show scenario result cards with evidence. Findings attach to the relevant scenario card. Discovery inventory and raw traces stay in the appendix.

## Recommended New Architecture

```text
Discovery
  -> TestingPlan
       journeys[]
       scenarios[]
       deferred[]

Explorer
  -> ScenarioAttempt[]
       scenario_id
       actions_taken
       evidence_refs
       observed_result

Judge / Validator
  -> ScenarioResult[]
       status
       observed
       findings

Report
  -> What Iris tested
       journey groups
       scenario evidence cards
       findings attached to scenarios
       score matrix
       debug appendix
```

## Migration Plan

1. Add a `TestingPlan` type in core.
2. Add `deriveTestingPlanFromDiscovery(discovery)` that maps current `product_use_contract`, `journeys`, `goals`, and `coverage_plan` into the new shape.
3. Update report rendering to consume `TestingPlan` and `ScenarioResult` labels, while preserving old JSON fields.
4. Update Explorer prompts to receive `UserScenario` instead of "goal plus product-use contract context."
5. Update Judge prompts and deterministic validators to evaluate `ScenarioResult`.
6. After compatibility is stable, simplify Discovery prompt output to produce `testing_plan` directly.

## Decision

Yes, redesign toward scenario-native Iris.

Do not keep adding report labels around the current structures. The current internals can be retained short term, but the canonical product model should become:

```text
Journey group -> scenario -> evidence -> result/finding
```

This is simpler for users and still preserves enough structure for rigorous evaluation.
