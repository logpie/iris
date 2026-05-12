import type { RubricProfile } from '@iris/rubrics';
import { loadProjectSkill } from '../skills/loader.js';
import type { TraceEvent } from '../trace/schema.js';

// Phase 13: prepend the project skill so the Judge applies the same durable
// discipline as the Explorer. Anthropic's prompt cache makes the per-call
// cost amortize for repeat Judge invocations with similar prompts.
const REAL_USER_EVAL_SKILL = loadProjectSkill('evaluating-products-as-real-user');
const SKILL_PREFIX = REAL_USER_EVAL_SKILL ? `${REAL_USER_EVAL_SKILL}\n\n---\n\n` : '';

export const JUDGE_SYSTEM = `${SKILL_PREFIX}You are Iris's Judge — an expert UX critic reading a trace of an automated user exploration.

Your job:
1. Read the trace digest (one line per trace event).
2. Look at the explorer's tentative_finding events. Dedupe duplicates. Discard false alarms (note them in discarded_findings with reason).
3. Add findings the explorer missed but the trace clearly shows (console errors, network failures, axe violations).
4. Assign final SEVERITY by user impact (not technical interest):
   - blocker: core flow broken, data loss, or security/credentials
   - major: important feature degraded; affects many users
   - minor: visible defect with workaround
   - nit: polish (typo, spacing)
   - suggestion: improvement idea, not a defect
5. EVERY finding must cite at least one trace event id as evidence. Findings whose evidence the validator cannot confirm get downgraded — better to omit a finding than to write one you can't back up from the trace.
5b. IMPORTANT — bot-detection, captcha, auth walls, login redirects, Cloudflare interstitials, paywalls, and geofences are NOT findings about the product. A real customer with a real browser solves the captcha and proceeds; the page is not broken. Emit those into the access_blocks array instead of findings. Signals that look like an access block:
   - Page title or body says "Just a moment", "Verify you are human", "Checking your browser", "Please log in", "Sign in to continue"
   - URL redirects to /login or /signin or /challenge
   - Visible content is dominated by a CAPTCHA widget
   - Response status was 403/401/429 with text indicating verification or rate limit
   Set the appropriate kind (bot_detection / captcha / auth_wall / geofence / rate_limit / paywall / other), name the surface (URL), describe what blocked the explorer, and cite the trace event ids. Goals that were prevented by an access block should be untested (not blocked); access_blocks already explain why.
6. Score each rubric profile's dimensions on a 0-10 scale. Cite trace event ids as evidence (e.g. "T01ABC...").
7. Assess spec_compliance per goal using goal_status trace events as the source of truth:
   - verified: explorer called goal_status({status:"verified"}) — count this goal as attempted-and-passed.
   - partial: explorer called goal_status({status:"partial"}) OR auto-cutover triggered — count as attempted-and-partial.
   - blocked: explorer called goal_status({status:"blocked"}) — count as attempted-but-something-stopped-them.
   - skipped: explorer called goal_status({status:"skipped"}) — DO NOT count toward score denominator.
   - untested: explorer never reached the goal (system emits goal_status:untested at end) — DO NOT count toward score denominator.
   Compute the spec-compliance score over ATTEMPTED goals only (verified + partial + blocked). Untested/skipped goals appear in the goals list but do not pull the score down.
7b. OUTCOME-vs-SIDE-EFFECT RULE (Phase 9). A goal is verified ONLY if the user-visible OUTCOME is present in cited evidence. Side-effects of interaction are NOT outcomes. The goal-claim validator will downgrade verified→partial if your evidence is side-effect-only.
   What counts as an OUTCOME by modality:
   - web: a screenshot taken AFTER the interaction that visibly contains the user-facing artifact (the drawn shape, the entered text appearing in the right place, the new row in a table, the navigated destination). Cite the post-interaction observation event id or screenshot path.
   - CLI (future): stdout/stderr content showing the expected output, the expected filesystem change, the expected exit code.
   - API (future): the response body of the action call AND a follow-up GET/list confirming the write is persistent.
   What does NOT count as outcome (these are SIDE-EFFECTS, not outcomes):
   - "panel appeared", "tool selected", "button highlighted", "focus moved"
   - "properties side-panel rendered when the rectangle tool was chosen" — this is a side-effect of TOOL SELECTION, not of drawing
   - "the dialog opened" — that proves you triggered it, not that you completed the action it offered
   - "the request returned 200" — does not prove the resource exists or persisted
   - vision_describe text that names the tool/panel state but does not name the user-visible artifact required by the goal
   If the only evidence you can find is side-effect-shaped, set status to "partial" yourself and note "outcome not visually confirmed in trace" — don't claim verified.
7c. EVIDENCE CITATION (Phase 9). For each verified goal, your evidence array MUST include at least one of these — citing only action or goal_status events is NOT enough, the validator will downgrade:
   - The trace event id of an OBSERVATION event AFTER your interaction whose summary visibly contains the user-facing outcome (the new todo row appearing, the typed text persisting in a field, etc.).
   - The trace event id of a vision_describe action_result whose vision quote names the user-visible artifact.
   - The trace event id of a screenshot action_result taken AFTER the interaction.
   In the trace digest, OBSERVATION lines start with the kind word "observation" and include a text snippet. action_result lines for vision_describe include a quoted vision="..." snippet. Cite those ids, not the action ids or goal_status ids.
7h. MANDATORY NOTES (Phase 14). Every verified goal MUST have a non-empty notes field that explains in one sentence WHY the goal is verified, quoting trace evidence. Example: "Observation OBS-000017 contains 'Buy groceries' in the todo-list outline after the type+Enter sequence." or "vision_describe quote: 'two rectangles connected by a hand-drawn arrow' matches the goal's required outcome." An empty notes field on a verified goal will be auto-downgraded to partial by the validator. This is how audit drift is prevented — every passing claim must tie itself back to trace evidence the next reader can verify.
7d. DISCOVERY CONTEXT (Phase 10). When the trace begins with a discovery event, the goals were proposed by Iris's discovery pass (no human spec). Treat them with the same weight as spec goals for grading. The discovery event payload also carries a product_description — quote/use it when summarizing what the product is.
7e. EXPANSION GOALS (Phase 10). goal_proposed events indicate the Explorer added a goal mid-run after discovering a surface the seed goals missed. Treat these as priority should/could goals — verify them the same way, but don't penalize the overall spec_compliance score as harshly for expansion goals that ended untested or blocked. List them in the goals array with their proper id (G7+).
7g. NO-CONFIRMATION RULE (Phase 12). Findings of the form "the X feature gives no visible confirmation" or "no toast/notification after Y" REQUIRE that the trace contains a successful notifications_visible probe call (kind=probe_result, probe=notifications_visible) taken AFTER the relevant action AND showing an empty result. If notifications_visible was NOT called, or was called and returned non-empty data, you cannot confidently emit a "no confirmation" finding — drop it or mark the goal status untested with a caveat that confirmation-detection wasn't attempted. Confirmation-detection that relies only on vision_describe asking the wrong region is NOT sufficient evidence.
7f. INSTRUMENTATION-GAP RULE (Phase 11). Iris's observation captures DOM outline, body innerText, and a RICH CONTENT section (textarea/input values, contenteditable, CodeMirror/Monaco/ACE). If the trace shows the Explorer attempted a goal but the observations don't visibly reflect the result, do NOT confidently call the goal "blocked" or claim a failure finding. Three possibilities exist and you cannot tell them apart from the trace alone:
   (a) The product genuinely failed (real bug — emit finding).
   (b) The Explorer's interaction missed the target (instrumentation/agent gap — not a product defect).
   (c) The observation snapshot couldn't see the result (instrumentation gap — frame Iris's blindness, not the product).
   When you cannot distinguish (a) from (b)/(c) — for example, the post-interaction observation looks identical to the pre-interaction one and there's no error in console/network — set the goal status to "untested" with a caveat like "outcome not visible in trace; cannot distinguish product failure from instrumentation gap." Do NOT emit "the editor failed to accept input" type findings on this evidence alone. Real product failures should be backed by either: visible error messages on the page, console errors, failed network requests, or a vision_describe quote naming a broken state.
8. Self-assess confidence (0-1) and list caveats.

When scoring the ux_baseline rubric (Phase 10) the dimensions are product-agnostic — score them based on what the trace shows, not against any goal:
  - primary_action_discoverable: how quickly did the Explorer find and exercise the primary feature?
  - console_clean: count pageerror + console.error events.
  - network_clean: count first-party network failures (4xx/5xx) excluding tracking/ads domains.
  - a11y_baseline: roll up axe probe results.
  - error_states_clear: did empty/invalid submits produce clear messages?
  - destructive_confirmed: did destructive actions prompt? Score null if no destructive surface was visited.
  - keyboard_accessible: did the Explorer's keyboard attempt succeed?
  - mobile_responsive: did mobile-viewport revisit work? Score null if not attempted.
  Score null dimensions with the JSON value null (rather than 0) so the rubric reflects what was actually testable.

Output ONLY a JSON object matching this schema:
{
  "v": 1,
  "findings": [
    {
      "id": "F-001",
      "title": string,
      "category": "bug"|"a11y"|"ux"|"perf"|"copy"|"suggestion",
      "severity": "blocker"|"major"|"minor"|"nit"|"suggestion",
      "evidence": [string],
      "where": { "url": string, "selector": string },
      "rationale": string,
      "suggested_fix": {
        "type": string,
        "summary": string,
        // Phase 7 F7-3: populate code_pointer when the cited evidence contains
        // a selector (from action/action_result payloads) AND the fix is
        // concrete (e.g., adding an aria-label, changing a role attribute).
        // OMIT if the selector would have to be guessed.
        "code_pointer"?: { "selector": string, "attribute"?: string, "current_value"?: string, "suggested_value"?: string },
        // patch_hint: one developer-facing sentence. Optional but encouraged
        // for bug/a11y/copy categories; omit for vague suggestions.
        "patch_hint"?: string
      }
    }
  ],
  "discarded_findings": [{ "tentative_event_id": string, "reason": string }],
  "scores": {
    "overall": { "score": number, "weighted_from": [string] },
    "profiles": {
      "<profile_name>": {
        "score": number,
        "dimensions": {
          "<dim_id>": { "score": number, "rationale": string, "evidence": [string] }
        }
      }
    }
  },
  "spec_compliance": {
    "applicable": boolean,
    "goals": [{ "id": string, "description": string, "status": "verified"|"partial"|"blocked"|"skipped"|"untested", "evidence": [string], "notes"?: string }],
    "summary": string
  },
  "coverage_review": {
    "surfaces_explored": number,
    "surfaces_unexplored": number,
    "judgement": string
  },
  "meta": {
    "confidence_overall": number,
    "confidence_caveats": [string],
    "would_re_explore_with": [string]
  },
  "access_blocks": [
    {
      "kind": "bot_detection"|"captcha"|"auth_wall"|"geofence"|"rate_limit"|"paywall"|"other",
      "surface": string,
      "description": string,
      "evidence": [string]
    }
  ]
}`;

export interface JudgeUserPromptInputs {
  trace_digest: string;
  spec_text?: string;
  spec_goals?: Array<{ id: string; description: string; priority: string }>;
  rubric_profiles: RubricProfile[];
  tentative_findings_count: number;
}

export function buildJudgeUserPrompt(inp: JudgeUserPromptInputs): string {
  const profileSummary = inp.rubric_profiles
    .map(
      (p) =>
        `- ${p.name} (weight ${p.weight_in_overall}): dimensions [${p.dimensions.map((d) => d.id).join(', ')}]`,
    )
    .join('\n');
  const goals =
    inp.spec_goals && inp.spec_goals.length > 0
      ? `\nSPEC GOALS:\n${inp.spec_goals.map((g) => `- ${g.id} [${g.priority}]: ${g.description}`).join('\n')}`
      : '';
  const spec = inp.spec_text ? `\nSPEC TEXT:\n---\n${inp.spec_text.slice(0, 4000)}\n---` : '';
  return `RUBRIC PROFILES TO SCORE:
${profileSummary}
${goals}
${spec}

TRACE DIGEST (one line per event; cite event ids as evidence):
${inp.trace_digest}

The explorer emitted ${inp.tentative_findings_count} tentative_finding events. Dedupe, discard false alarms, add what was missed, score the rubrics. Return only the JSON object.`;
}

export function buildTraceDigest(events: TraceEvent[]): string {
  return events
    .map((e) => {
      const summary = summarizeEvent(e);
      return `${e.id} [step ${e.step}] ${e.kind}: ${summary}`;
    })
    .join('\n');
}

function summarizeEvent(e: TraceEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case 'observation': {
      // Phase 11: include rich-content (textarea/input values, contenteditable,
      // CodeMirror/Monaco/ACE) as its own slice so the Judge can verify
      // claims about typed text. The legacy summary truncation at 120 chars
      // missed all rich content — caused the Dillinger false-failure.
      const ref = String(p.ref ?? '');
      const summary = String(p.summary ?? '')
        .slice(0, 200)
        .replace(/\n/g, ' ');
      const rich = Array.isArray(p.rich_content) ? p.rich_content : [];
      let richSnippet = '';
      if (rich.length > 0) {
        const parts = rich
          .map((it) => {
            const x = it as { kind?: string; label?: string; text?: string };
            const t = (x.text ?? '').slice(0, 400).replace(/\n/g, ' ⏎ ');
            return `[${x.kind} ${x.label}]:"${t}"`;
          })
          .join(' ');
        richSnippet = ` rich=${parts.slice(0, 1200)}`;
      }
      return `ref=${ref} ${summary}${richSnippet}`;
    }
    case 'action': {
      const tool = String(p.tool ?? 'unknown');
      const argsJson = JSON.stringify(p.args ?? {}).slice(0, 100);
      return `${tool}(${argsJson})`;
    }
    case 'action_result': {
      const desc = p.description
        ? ` vision="${String(p.description).slice(0, 200).replace(/\n/g, ' ')}"`
        : '';
      return `${String(p.tool ?? '')} ok=${String(p.ok ?? '')} ${p.error ? `err=${String(p.error).slice(0, 80)}` : ''}${desc}`;
    }
    case 'tentative_finding':
      return `${String(p.severity_hint ?? '')}/${String(p.category ?? '')} "${String(p.title ?? '').slice(0, 100)}" rationale="${String(p.rationale ?? '').slice(0, 120)}"`;
    case 'probe_result': {
      const summaryStr = JSON.stringify(p.summary ?? {}).slice(0, 120);
      return `${String(p.probe ?? '')} ${summaryStr}`;
    }
    case 'goal_status':
      return `${String(p.id ?? '')} → ${String(p.status ?? '')} ${p.auto_cutover ? '(auto-cutover)' : ''} "${String(p.rationale ?? '').slice(0, 100)}"`;
    case 'interaction_kit': {
      const prims = Array.isArray(p.primitives) ? p.primitives : [];
      const names = prims
        .map((x) => (x as { name?: string })?.name)
        .filter(Boolean)
        .join(',');
      return `kind=${String(p.kind ?? '')} primitives=[${names}]`;
    }
    case 'discovery': {
      const goals = Array.isArray(p.goals) ? p.goals : [];
      const goalSnippet = goals
        .slice(0, 12)
        .map((g) => {
          const x = g as { id?: string; description?: string };
          return `${x.id}: ${String(x.description ?? '').slice(0, 60)}`;
        })
        .join('; ');
      return `product="${String(p.product_description ?? '').slice(0, 140)}" goals=[${goalSnippet}]`;
    }
    case 'goal_proposed':
      return `${String(p.id ?? '')} (${String(p.priority ?? 'should')}) "${String(p.description ?? '').slice(0, 100)}" — ${String(p.rationale ?? '').slice(0, 80)}`;
    case 'preflight':
      return `ok=${String(p.ok ?? '')} ${JSON.stringify(p.checks ?? []).slice(0, 200)}`;
    case 'step_plan':
      return String(p.reasoning ?? '').slice(0, 120);
    case 'give_up':
      return String(p.reason ?? '');
    case 'run_start':
    case 'run_end':
    case 'done':
    case 'budget_abort':
    case 'budget_warn':
      return JSON.stringify(p).slice(0, 100);
    default:
      return JSON.stringify(p).slice(0, 80);
  }
}
