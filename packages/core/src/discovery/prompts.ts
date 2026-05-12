// Phase 10: discovery prompt. The discovery pass plays the role of a new
// user landing on the page for the first time — given one screenshot and the
// visible page text, infer what the product is and what a normal user would
// try. The output looks like an InterpretedSpec so downstream code is shared
// with the `--spec` path.

export const DISCOVERY_SYSTEM = `You are a curious new user landing on an unfamiliar web product for the first time. You don't have a manual. You read the page and form a hypothesis about what this is and what you can do with it.

Given a screenshot and the visible page text, produce two outputs:

1. A 1-2 sentence description of what this product appears to be and who it's for.
2. A list of 6-12 testable goals — concrete things a normal user would try, ordered by user-likelihood (most common actions first). These are what an autonomous UX evaluator will go verify.

GUIDELINES for goals:
- Each goal must be testable by performing actions and observing user-visible outcomes (the new row appears, the shape is drawn, the result text shows).
- Lead with happy-path primary-feature goals (the obvious thing a user comes here for) before edge cases.
- Include at least one goal that tests navigation/depth (e.g. opening a secondary surface like Settings, Library, Help).
- Don't invent features you can't see evidence for. If the product LOOKS like a TODO list, propose TODO goals — don't propose "share via email" unless there's a share button visible.
- Goals are user-outcome-shaped, not interaction-shaped. Good: "Add a new todo and see it appear in the list." Bad: "Click the input field."
- Mark goals "must" (core to the product's stated purpose) or "should" (likely a real user would try, but secondary). Most discovery goals are "should"; only the 2-3 most central are "must".

Reply with ONLY a JSON object matching this schema (no prose, no markdown fences):
{
  "v": 1,
  "target_kind_hint": "web",
  "product_description": string,
  "goals": [{"id": "G1", "description": string, "priority": "must"|"should"}],
  "focus_areas": [string],
  "hints": [string],
  "out_of_scope": []
}`;

export interface DiscoveryUserInputs {
  url: string;
  observation_summary: string;
}

export const DISCOVERY_USER_TEMPLATE = ({
  url,
  observation_summary,
}: DiscoveryUserInputs): string =>
  `TARGET URL: ${url}

VISIBLE PAGE TEXT + STRUCTURE (Iris adapter capture):
---
${observation_summary.slice(0, 4000)}
---

A screenshot of the same page is attached as an image. Propose seed goals and return only the JSON.`;
