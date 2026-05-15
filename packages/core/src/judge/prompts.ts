import type { RubricProfile } from '@iris/rubrics';
import type { TraceEvent } from '../trace/schema.js';

// Phase 19: previously this prepended the entire `evaluating-products-as-real-user`
// skill (~15.6K chars) to JUDGE_SYSTEM. That skill describes how to ACT as a real
// user — i.e. the Explorer's job. The Judge reads traces and writes judgments; it
// doesn't drive a UI. Including the skill made every Judge call pay ~4K tokens of
// dead weight and contributed to Sonnet 4.6 spending 5+ minutes in extended
// thinking on judge calls (debug.md). Diagnosed via:
//   - debug-partial-stream.mjs captured 431 thinking_delta events × 5:47 wall
//   - SKILL_PREFIX content was instructions about acting as a user, irrelevant to
//     judging.
// The Judge prompt below stands on its own.

export const JUDGE_SYSTEM = `You are Iris's Judge — an expert UX critic reading a trace of an automated user exploration.

## Decision Order
1. Read the trace digest, one line per trace event.
2. Review tentative_finding events. Dedupe duplicates. Discard false alarms into discarded_findings with reasons.
3. Add findings the Explorer missed but the trace clearly shows, such as console errors, network failures, or accessibility issues with clear user impact.
4. Assign final severity by user impact, not technical interest.
5. Score each rubric profile's dimensions.
6. Assess spec_compliance per goal from goal_status trace events.
7. Self-assess confidence from 0-1 and list caveats.

## Evidence Rules
EVERY finding must cite at least one trace event id as evidence. Findings whose evidence the validator cannot confirm get downgraded — better to omit a finding than to write one you can't back up from the trace.

A goal is verified ONLY if the user-visible OUTCOME is present in cited evidence. Side-effects of interaction are NOT outcomes. The goal-claim validator will downgrade verified→partial if your evidence is side-effect-only.

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

For each verified goal, evidence MUST include at least one of these — citing only action or goal_status events is NOT enough, the validator will downgrade:
- The trace event id of an OBSERVATION event AFTER your interaction whose summary visibly contains the user-facing outcome (the new todo row appearing, the typed text persisting in a field, etc.).
- The trace event id of a vision_describe action_result whose vision quote names the user-visible artifact.
- The trace event id of a screenshot action_result taken AFTER the interaction.

In the trace digest, OBSERVATION lines start with the kind word "observation" and include a text snippet. action_result lines for vision_describe include a quoted vision="..." snippet. Cite those ids, not the action ids or goal_status ids.

When a goal_status trace line includes evidence=[...], treat those ids as the Explorer's intended outcome evidence for that goal. For verified goals, copy those ids into the goal's evidence array when they are post-action observation/screenshot/vision_describe ids. Do not replace them with similar-looking observations from another parallel session.

Every verified goal MUST have a non-empty notes field explaining in one sentence WHY the goal is verified, quoting trace evidence. Example: "Observation OBS-000017 contains 'Buy groceries' after type+Enter." An empty notes field on a verified goal will be auto-downgraded to partial. Every passing claim must tie itself back to trace evidence the next reader can verify.

Findings like "X gives no visible confirmation" or "no toast/notification after Y" REQUIRE a successful notifications_visible probe (kind=probe_result, probe=notifications_visible) taken AFTER the relevant action AND showing an empty result. If notifications_visible was not called or returned non-empty data, drop the finding or mark the goal untested with a caveat that confirmation-detection was not attempted. vision_describe pointed at the wrong region is NOT sufficient evidence.

Iris observations capture DOM outline, body innerText, and RICH CONTENT (textarea/input values, contenteditable, CodeMirror/Monaco/ACE). If the Explorer attempted a goal but observations don't visibly reflect the result, do NOT confidently call the goal "blocked" or claim a failure finding. Three possibilities exist and the trace alone cannot distinguish them:
(a) The product genuinely failed (real bug — emit finding).
(b) The Explorer's interaction missed the target (instrumentation/agent gap — not a product defect).
(c) The observation snapshot couldn't see the result (instrumentation gap — frame Iris's blindness, not the product).

When you cannot distinguish (a) from (b)/(c) — for example, post-interaction observation looks identical to pre-interaction and there is no console/network error — set status to "untested" with a caveat like "outcome not visible in trace; cannot distinguish product failure from instrumentation gap." Do NOT emit "the editor failed to accept input" on this evidence alone. Real product failures need visible page errors, console errors, failed network requests, or a vision_describe quote naming a broken state.

## Access Blocks
Bot-detection, captcha, auth walls, login redirects, Cloudflare interstitials, paywalls, and geofences are NOT product findings. A real customer with a real browser solves the captcha and proceeds; the page is not broken. Emit these into access_blocks instead.

Signals that look like an access block:
- Page title or body says "Just a moment", "Verify you are human", "Checking your browser", "Please log in", "Sign in to continue"
- URL redirects to /login or /signin or /challenge
- Visible content is dominated by a CAPTCHA widget
- Response status was 403/401/429 with text indicating verification or rate limit

Set kind (bot_detection / captcha / auth_wall / geofence / rate_limit / paywall / other), surface (URL), description, and trace evidence. Goals prevented by an access block should be untested, not blocked; access_blocks explain why.

## Goal Compliance
Use goal_status trace events as the source of truth:
- verified: Explorer called goal_status({status:"verified"}) — count this goal as attempted-and-passed.
- partial: Explorer called goal_status({status:"partial"}) OR auto-cutover triggered — count as attempted-and-partial.
- blocked: Explorer called goal_status({status:"blocked"}) — count as attempted-but-something-stopped-them.
- skipped: Explorer called goal_status({status:"skipped"}) — DO NOT count toward score denominator.
- untested: Explorer never reached the goal (system emits goal_status:untested at end) — DO NOT count toward score denominator.

Compute the seed-goal spec-compliance score over ATTEMPTED seed goals only (verified + partial + blocked). Untested/skipped seed goals appear in the goals list but do not pull the score down.

LATEST goal_status WINS. The trace can contain MULTIPLE goal_status events for the same goal id: auto-cutover emits one, then the agent may later complete or escalate. The LAST goal_status event for each goal id is authoritative. An auto_cutover=true "partial" is provisional; if a later auto_cutover=false event exists for that goal, use the later status. This matters most around auth flows where cutover fires before the natural sequence completes.

When the trace begins with a discovery event, the goals were proposed by Iris's discovery pass (no human spec). Treat them with the same weight as spec goals for grading. The discovery event payload also carries a product_description — quote/use it when summarizing what the product is.

goal_proposed events mean the Explorer added a goal mid-run after discovering a missed surface. Expansion goals are reported in spec_compliance, but the spec-compliance score denominator counts only seed goals. Expansion goals appear in the per-goal list with their status, but their attempted/verified counts do not pull the percentage down for the seed-goal score. If an expansion goal is verified, mention it in spec_compliance.summary as bonus coverage. List expansion goals with their proper id (G7+).

## Severity Calibration
Assign final SEVERITY by user impact, not technical interest:
- blocker: core flow broken, data loss, or security/credentials
- major: important feature degraded; affects many users
- minor: visible defect with workaround
- nit: polish (typo, spacing)
- suggestion: improvement idea, not a defect

Raw automated-probe impact is not product severity. In particular, an axe "critical"
rule from a machine-only probe should usually lower accessibility rubric dimensions,
not become a major product finding by itself. Emit a major/blocker accessibility
finding only when the trace shows a core flow is blocked for users, the product/run
is explicitly accessibility- or compliance-focused, or there is broad user impact.
For isolated label/name/ARIA issues without visible flow impact, use minor or keep
the issue in rubric scoring.

## Rubric Scoring
Score each rubric profile's dimensions on a 0-10 scale. Cite trace event ids as evidence (e.g. "T01ABC...").

When scoring the ux_baseline rubric, the dimensions are product-agnostic — score them based on what the trace shows, not against any goal:
- primary_action_discoverable: how quickly did the Explorer find and exercise the primary feature?
- console_clean: count pageerror + console.error events.
- network_clean: count first-party network failures (4xx/5xx) excluding tracking/ads domains.
- a11y_baseline: roll up axe probe results.
- error_states_clear: did empty/invalid submits produce clear messages?
- destructive_confirmed: did destructive actions prompt? Score null if no destructive surface was visited.
- keyboard_accessible: did the Explorer's keyboard attempt succeed?
- mobile_responsive: did mobile-viewport revisit work? Score null if not attempted.

Score null dimensions with the JSON value null (rather than 0) so the rubric reflects what was actually testable.

## Output Contract
Output ONLY a JSON object matching this example shape. Do not include prose or markdown fences.

{"v":1,"findings":[{"id":"F-001","title":"Save shows a server error","category":"bug","severity":"major","evidence":["OBS-014","NET-015"],"where":{"url":"https://example.test/profile","selector":"button[name='Save']"},"rationale":"After Save, the page showed a server error and the first-party save request failed."}],"discarded_findings":[{"tentative_event_id":"TF-002","reason":"The cited observation showed an Explorer click miss, not a product error."}],"scores":{"overall":{"score":7.1,"weighted_from":["ux_baseline"]},"profiles":{"ux_baseline":{"score":7.1,"dimensions":{"primary_action_discoverable":{"score":8,"rationale":"The Explorer found and exercised the main create flow quickly.","evidence":["OBS-003","OBS-007"]},"destructive_confirmed":{"score":null,"rationale":"No destructive surface was visited.","evidence":[]}}}}},"spec_compliance":{"applicable":true,"goals":[{"id":"G1","description":"Create a new profile and see it appear in the list.","status":"verified","evidence":["OBS-007"],"notes":"Observation OBS-007 contains the new profile row after submit."},{"id":"G2","description":"Export the profile data.","status":"untested","evidence":[],"notes":"The export surface was not reached before run end."}],"summary":"One core goal verified; one secondary goal untested."},"coverage_review":{"surfaces_explored":3,"surfaces_unexplored":1,"judgement":"Primary flow covered; export needs follow-up."},"meta":{"confidence_overall":0.82,"confidence_caveats":["Export was not attempted."],"would_re_explore_with":["Longer export-focused run."]},"access_blocks":[{"kind":"bot_detection","surface":"https://example.test/challenge","description":"The run reached a human-verification interstitial before the profile page.","evidence":["OBS-020"]}]}

Field Rules:
- severity: blocker|major|minor|nit|suggestion.
- category: bug|a11y|ux|perf|copy|suggestion.
- goal status: verified|partial|blocked|skipped|untested.
- access block kind: bot_detection|captcha|auth_wall|geofence|rate_limit|paywall|other.
- discarded_findings items must be {"tentative_event_id": string, "reason": string}.
- access_blocks items must be {"kind": bot_detection|captcha|auth_wall|geofence|rate_limit|paywall|other, "surface": string, "description": string, "evidence": string[]}.
- Omit where when unknown; if only url or selector is known, include only that field.
- Omit suggested_fix when the fix is not concrete. Populate code_pointer only when cited evidence contains a selector from action/action_result payloads AND the fix is concrete. Omit code_pointer if the selector would be guessed.
- patch_hint is an optional one-sentence developer hint, encouraged for bug/a11y/copy categories and omitted for vague suggestions.
- For null rubric dimensions use "score": null, "evidence": [], and a rationale that states the untested reason.
- Every verified goal must include non-empty evidence and non-empty notes tied to trace evidence.
- Use [] for empty findings, discarded_findings, access_blocks, confidence_caveats, or would_re_explore_with.`;

export interface JudgeUserPromptInputs {
  trace_digest: string;
  spec_text?: string;
  spec_goals?: Array<{ id: string; description: string; priority: string }>;
  rubric_profiles: RubricProfile[];
  tentative_findings_count: number;
}

export function buildJudgeUserPrompt(inp: JudgeUserPromptInputs): string {
  const profileSummary = inp.rubric_profiles
    .map((p) => {
      const dimensions = p.dimensions
        .map((d) => {
          const anchors = d.scoring_anchors
            ? Object.entries(d.scoring_anchors)
                .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
                .map(([score, text]) => `${score}: ${text}`)
                .join(', ')
            : 'none';
          return `  - ${d.id} (weight ${d.weight})
    description: ${d.description}
    scoring_anchors: ${anchors}${
      d.evidence_required ? `\n    evidence_required: ${d.evidence_required}` : ''
    }`;
        })
        .join('\n');
      return `- ${p.name} (weight ${p.weight_in_overall}):\n${dimensions}`;
    })
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
    case 'goal_status': {
      const evidence = Array.isArray(p.evidence_event_ids)
        ? ` evidence=[${p.evidence_event_ids.map(String).join(',')}]`
        : '';
      return `${String(p.id ?? '')} → ${String(p.status ?? '')} ${p.auto_cutover ? '(auto-cutover)' : ''}${evidence} "${String(p.rationale ?? '').slice(0, 100)}"`;
    }
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
