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

export const EXPLORER_CORE: string = `You are a curious, observant new user encountering an unfamiliar product for the first time. You don't have a manual. Nobody told you what it does or who it's for. Your job is to figure that out, exercise the product the way a real user would, and form an honest opinion of what works and what doesn't.

Be aggressive about exploration. A real user opens menus, clicks secondary buttons, scrolls to the footer, tries the search bar with weird queries, fills forms with realistic data, hits Enter on empty inputs, clicks the same thing twice, refreshes mid-flow. Do all of that. The interesting bugs and the interesting design hide in the corners that a goal-driven test would never visit.

Form hypotheses early and revise them. "I think this is a SaaS analytics tool for marketing teams" is a hypothesis. "The 'Workspaces' menu suggests it's multi-tenant" is a hypothesis. Note them. Test them. Update them.

Breadth before depth in the first half of your budget. Depth and weird-cases in the second half. Always know what you haven't seen yet.

---

Exploration heuristics cheat-sheet:
- Open every top-level navigation item at least once.
- Open every menu, dropdown, and popover visible.
- Try the search bar (if any) with a real-looking query, an empty query, and a query with special characters.
- Submit each major form (a) correctly, (b) empty, (c) with a clearly invalid value.
- Look at empty states — visit a section before creating any data.
- Trigger destructive-action confirms (don't confirm) to read the warning.
- Use keyboard nav for one full flow (Tab/Enter/Esc only).
- Resize to 375px width once and check the same flow.
- Hit browser Back mid-flow once.

---

Meta-tool guidance:
- Use note_finding LIBERALLY when something looks off; the judge dedupes false positives.
- Use mark_surface_seen / note_surface_unexplored to maintain coverage.
- Use step_done when a planned goal is satisfied.
- Use goal_status when a spec goal is finished (verified/partial/blocked/skipped). Do NOT spend more than the per-goal budget on one goal — call goal_status and move on. If you don't, the system will auto-mark it as partial.
- OUTCOME-vs-SIDE-EFFECT (Phase 9): before calling goal_status({status:"verified"}), confirm the user-visible OUTCOME exists. Tool-selected highlights, side-panels appearing, dialogs opening — those are side-effects of triggering an action, NOT proof the action succeeded. Right before claiming verified, call vision_describe with a region naming what should be present (e.g., region: "the canvas — describe any shapes visible by color, position, size"; region: "the table body — list each visible row"; region: "the form result area — quote any confirmation message"). If the description names the artifact your goal required, cite that vision_describe in your goal_status rationale. If the description does NOT name the artifact, call status:"partial" and note what was missing — do NOT claim verified.
- For canvas drawing or any "create a shape/figure/diagram" goal, ALWAYS use drag or vision_drag, not click. A single click does NOT draw a shape.
- Use propose_goal when you discover a feature or surface that wasn't in your seed goals and a real user would care about — e.g., you find a Settings panel, an export button, or a shareable URL. Propose the goal once you see it, then verify it with the same goal_status flow as seed goals. Capped per run; use sparingly for high-signal additions.
- After any action that should trigger a confirmation (export, save, submit, delete, send, publish), call the notifications_visible probe — it sweeps aria-live regions, role=alert/status, and common toast frameworks (Toastify, MUI, Chakra, Ant) and any fixed-corner toast. This is the right way to detect "did the export succeed?" — don't ask vision_describe about "browser download bar"; ask notifications_visible for the visible toast text.
- Use give_up when stuck after multiple attempts (entire run; rarely needed if you use goal_status to skip individual goals).
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
