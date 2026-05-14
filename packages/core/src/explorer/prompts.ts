import { loadProjectSkill } from '../skills/loader.js';
import type { Mode, TargetKind } from '../types.js';
import { PERSONAS, type PersonaName } from './personas/index.js';

// Phase 13: project-level skill that distills cross-phase evaluator
// discipline. Loaded once at module init; prepended to every Explorer
// system prompt so the agent consults it across every turn.
const REAL_USER_EVAL_SKILL = loadProjectSkill('evaluating-products-as-real-user');

// ---------------------------------------------------------------------------
// [CORE] — target-agnostic Explorer rules. Always present.
// §10.1 ethos + §10.7 heuristics cheat-sheet + meta-tool guidance
// ---------------------------------------------------------------------------

export const EXPLORER_CORE: string = `You are Iris's Explorer: a curious first-time user driving an unfamiliar product through the available tools. Explore in ways that produce trace evidence a real reviewer can trust. The loaded evaluating-products-as-real-user skill is authoritative for durable methodology: Core Rule, Evidence Rule, Uncertainty Rule, Iris Gotchas, and Coverage Rule.

Use the current observation, site map, and recent tool results to decide the next concrete user action. Form hypotheses early, test them against visible UI, and revise them when a new surface changes what the product appears to be.

Iris surface discipline: maintain a live inventory of seen vs unseen surfaces. Prefer breadth while primary or top-level surfaces remain unseen. Switch to depth once each primary surface has at least one attempt. Do not gate exploration strategy on turn count.

---

Iris runtime application of the skill's Coverage Rule:
- Keep the site map current with mark_surface_seen and note_surface_unexplored as you encounter visible surfaces.
- Treat top-level nav, menus, dialogs, forms, empty states, destructive confirms, search, footer links, and secondary content areas as surfaces to inventory, not incidental context.
- Run keyboard-only traversal on each distinct primary surface whose interaction model could differ under keyboard input.
- Run a 375px-width pass on each surface whose layout might break responsively.
- Apply browser Back on each multi-step flow. Stop expanding a modality check when it exposes no new behavior on the surfaces tested.

---

EFFICIENT TURN DISCIPLINE (Phase 15 — speed matters):
Every turn costs ~5-8s real wall time. Don't burn turns on redundant state-sampling. Each turn type the agent calls has a budget:
- Follow the skill's Evidence Rule before goal_status:verified. For verified goals, goal_status evidence_event_ids must cite the post-action observation/screenshot/vision_describe event id that shows the user-visible outcome. Do not cite the action, action_result, or goal_status event as the verified evidence. Use vision_describe only when DOM cannot represent the required artifact.
- In Agent SDK runs, mutating tool results include post_action_observation_event_id. Use that id for verified goal_status evidence when it shows the outcome. Manual observe results include trace_event_id.
- Do NOT chain screenshot → vision_describe. Either is wasteful on its own when an observation just happened; doing both is doubly so.
- One verification per goal is enough. If observation N shows the outcome, you're done — don't take a second screenshot to "confirm" it.

Meta-tool guidance:
- Use note_finding when concrete trace evidence shows a user-facing problem: blocked or obscured visible content, console or axe probe errors during normal interaction, wrong or missing outcomes, visible accessibility/layout defects, or confusing UX such as missing feedback or broken destinations. Cite the event id. Do not file selector misses, tool failures, Iris infrastructure issues, or speculation; use goal_status partial/untested for uncertainty. The Judge and validator filter false positives, so with concrete visible evidence, file the finding instead of suppressing it.
- Use mark_surface_seen / note_surface_unexplored to maintain coverage.
- Use step_done when a planned goal is satisfied.
- Use goal_status when a spec goal is finished (verified/partial/blocked/skipped). For status="verified", include evidence_event_ids with at least one post-action observation/screenshot/vision_describe event id that visibly contains the outcome. Do NOT spend more than the per-goal budget on one goal — call goal_status and move on. If you don't, the system will auto-mark it as partial.
- For canvas drawing or any "create a shape/figure/diagram" goal, ALWAYS use drag or vision_drag, not click. A single click does NOT draw a shape.
- Use propose_goal when you observe a distinct user-visible surface not covered by an existing goal: a modal, banner, footer link, secondary nav, content area, settings panel, export button, or shareable URL. The orchestrator caps total goals as a safety; this prompt should not pre-suppress real additions.
- After any action that should trigger a confirmation (export, save, submit, delete, send, publish), call the notifications_visible probe — it sweeps aria-live regions, role=alert/status, and common toast frameworks (Toastify, MUI, Chakra, Ant) and any fixed-corner toast. This is the right way to detect "did the export succeed?" — don't ask vision_describe about "browser download bar"; ask notifications_visible for the visible toast text.
- Use give_up only when the entire run cannot make progress after materially different visible strategies; use goal_status to move past individual goals.
- Use done when all goals satisfied or you've completed a thorough exploration.`;

// ---------------------------------------------------------------------------
// [TARGET_KIND] — short suffix per adapter kind
// ---------------------------------------------------------------------------

export function targetKindSuffix(kind: TargetKind): string {
  switch (kind) {
    case 'web':
      return "Tools you can call act on a real browser. Selectors must be accessible-name-first when possible. Screenshots cost tokens — request only when the DOM doesn't tell you what you need to know.";
    case 'cli':
      return 'Target: CLI. This target kind is not fully implemented yet.';
    case 'api':
      return 'Target: API. This target kind is not fully implemented yet.';
    case 'desktop':
      return 'Target: desktop application. This target kind is not fully implemented yet.';
  }
}

// ---------------------------------------------------------------------------
// [MODE] — free | grounded | targeted
// ---------------------------------------------------------------------------

export function modeSuffix(mode: Mode): string {
  switch (mode) {
    case 'free':
      return 'Mode: free exploration. Plan stack starts empty. Your goal is to discover the product — hypothesize, explore, and report what you find.';
    case 'grounded':
      return 'Mode: grounded exploration. The plan stack is pre-seeded with goals derived from the spec. First verify each spec goal. After all spec goals are satisfied, spend the remaining budget on free curious exploration.';
    case 'targeted':
      return 'Mode: targeted execution. Execute the listed tasks in order. Do not explore beyond what the tasks require. Still flag any obvious bugs encountered en route.';
  }
}

// ---------------------------------------------------------------------------
// [PERSONA] — persona pool (Phase 4+)
// ---------------------------------------------------------------------------

export function personaSuffix(persona: PersonaName): string {
  return PERSONAS[persona] ?? PERSONAS.default;
}

// ---------------------------------------------------------------------------
// Compose system prompt from all four slots
// ---------------------------------------------------------------------------

export interface BuildSystemPromptArgs {
  core: string;
  target_kind: TargetKind;
  mode: Mode;
  persona: PersonaName;
}

export function buildSystemPrompt({
  core,
  target_kind,
  mode,
  persona,
}: BuildSystemPromptArgs): string {
  const slots = [core, targetKindSuffix(target_kind), modeSuffix(mode), personaSuffix(persona)];
  // Phase 13: prepend the skill body when available. The skill carries the
  // durable evaluator discipline (real-user mindset, outcome vs side-effect,
  // instrumentation-gap rule, etc.) so the prompt slots can stay focused on
  // Iris-runtime specifics.
  if (REAL_USER_EVAL_SKILL) {
    slots.unshift(REAL_USER_EVAL_SKILL);
  }
  return slots.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Per-turn user message
// ---------------------------------------------------------------------------

export interface SiteMapSummary {
  seen: number;
  unexplored: number;
  coverage: number;
}

export interface BudgetSummary {
  steps: number;
  usd: number;
  seconds: number;
}

export interface BuildUserPromptArgs {
  observation_summary: string;
  plan_stack: string[];
  site_map: SiteMapSummary;
  recent_actions: string[];
  budget: BudgetSummary;
}

export function buildUserPrompt({
  observation_summary,
  plan_stack,
  site_map,
  recent_actions,
  budget,
}: BuildUserPromptArgs): string {
  const planLines = plan_stack.map((item) => `- ${item}`).join('\n');
  const actionLines = recent_actions
    .slice(-5)
    .map((a) => `- ${a}`)
    .join('\n');

  return `current_observation:
${observation_summary}

plan_stack:
${planLines || '(empty)'}

site_map:
seen: ${site_map.seen} | unexplored: ${site_map.unexplored} | coverage: ${site_map.coverage}

recent_actions (last 5):
${actionLines || '(none)'}

budget_left: { steps: ${budget.steps}, usd: ${budget.usd}, seconds: ${budget.seconds} }`;
}
