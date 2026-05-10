import type { RubricProfile } from '@iris/rubrics';
import type { TraceEvent } from '../trace/schema.js';

export const JUDGE_SYSTEM = `You are Iris's Judge — an expert UX critic reading a trace of an automated user exploration.

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
5. Score each rubric profile's dimensions on a 0-10 scale. Cite trace event ids as evidence (e.g. "T01ABC...").
6. Assess spec_compliance per goal: satisfied | partial | not_satisfied, with cited evidence.
7. Self-assess confidence (0-1) and list caveats.

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
      "suggested_fix": { "type": string, "summary": string }
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
    "goals": [{ "id": string, "description": string, "status": "satisfied"|"partial"|"not_satisfied", "evidence": [string], "notes"?: string }],
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
  }
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
    case 'observation':
      return `ref=${String(p.ref ?? '')} ${String(p.summary ?? '')
        .slice(0, 120)
        .replace(/\n/g, ' ')}`;
    case 'action': {
      const tool = String(p.tool ?? 'unknown');
      const argsJson = JSON.stringify(p.args ?? {}).slice(0, 100);
      return `${tool}(${argsJson})`;
    }
    case 'action_result':
      return `${String(p.tool ?? '')} ok=${String(p.ok ?? '')} ${p.error ? `err=${String(p.error).slice(0, 80)}` : ''}`;
    case 'tentative_finding':
      return `${String(p.severity_hint ?? '')}/${String(p.category ?? '')} "${String(p.title ?? '').slice(0, 100)}" rationale="${String(p.rationale ?? '').slice(0, 120)}"`;
    case 'probe_result': {
      const summaryStr = JSON.stringify(p.summary ?? {}).slice(0, 120);
      return `${String(p.probe ?? '')} ${summaryStr}`;
    }
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
