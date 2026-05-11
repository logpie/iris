// Evidence validator — deterministic post-Judge stage. For every finding,
// confirms the cited evidence event IDs actually exist in the trace and that
// at least one of them is a "backing" event (something concrete the user
// would consider proof of the finding). Findings whose IDs are bogus get
// discarded; severe findings without backing get downgraded one tier.
//
// This is the load-bearing step against Judge hallucination. We did not use
// an LLM to validate because (a) Otto needs to trust the result deterministically
// and (b) an LLM validator is just another fallible model in the loop.

import type { JudgeFinding, JudgeOutput } from '../judge/judge.js';
import type { TraceEvent } from '../trace/schema.js';

export interface DiscardedFinding {
  tentative_event_id: string;
  reason: string;
}

export interface ValidationOutput {
  kept: JudgeFinding[];
  discarded: DiscardedFinding[];
  summary: { verified: number; downgraded: number; discarded: number };
}

// Severity downgrade ladder. Suggestion is the floor.
const DOWNGRADE: Record<string, JudgeFinding['severity']> = {
  blocker: 'major',
  major: 'minor',
  minor: 'suggestion',
  nit: 'suggestion',
};

// Severities that require backing evidence. `suggestion` is an open-ended
// Tier-2 observation and is exempt — the Judge is allowed to suggest things
// from looking at the page without a specific event proving the suggestion.
function requiresBacking(severity: JudgeFinding['severity']): boolean {
  return severity !== 'suggestion';
}

export function validateFindings(findings: JudgeFinding[], trace: TraceEvent[]): ValidationOutput {
  const eventById = new Map<string, TraceEvent>();
  for (const e of trace) eventById.set(e.id, e);

  const kept: JudgeFinding[] = [];
  const discarded: DiscardedFinding[] = [];
  let verified = 0;
  let downgraded = 0;

  for (const f of findings) {
    const validIds = f.evidence.filter((id) => eventById.has(id));
    if (validIds.length === 0) {
      discarded.push({
        tentative_event_id: f.id,
        reason: 'all_evidence_ids_invalid',
      });
      continue;
    }
    if (!requiresBacking(f.severity)) {
      kept.push({ ...f, unverified_backing: false });
      verified++;
      continue;
    }
    const backed = hasBackingEvidence(validIds, trace, f.category);
    if (backed) {
      kept.push({ ...f, unverified_backing: false });
      verified++;
    } else {
      const newSev = DOWNGRADE[f.severity] ?? f.severity;
      kept.push({ ...f, severity: newSev, unverified_backing: true });
      downgraded++;
    }
  }

  return {
    kept,
    discarded,
    summary: { verified, downgraded, discarded: discarded.length },
  };
}

// Whether at least one of the cited events (within a ±2-turn window) provides
// concrete backing. Real trace kinds are documented in
// `packages/core/src/trace/schema.ts`. Probe results are payloads with shape
// `{probe, summary: {violations?|error_count?|failure_count?}, data}`.
function hasBackingEvidence(citedIds: string[], trace: TraceEvent[], category: string): boolean {
  const indices = citedIds.map((id) => trace.findIndex((e) => e.id === id)).filter((i) => i >= 0);
  for (const idx of indices) {
    const lo = Math.max(0, idx - 2);
    const hi = Math.min(trace.length, idx + 3);
    for (let i = lo; i < hi; i++) {
      const e = trace[i];
      if (!e) continue;
      if (eventIsBacking(e, category)) return true;
    }
  }
  return false;
}

function eventIsBacking(e: TraceEvent, category: string): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;

  switch (e.kind) {
    // Live tentative findings count — explorer flagged the issue in real time,
    // not the Judge inventing it from a trace digest.
    case 'tentative_finding':
      return true;
    // Hypotheses are explorer-side beliefs with evidence; treat as backing.
    case 'hypothesis':
      return true;
    // Observations are DOM dumps — substantive backing when non-empty.
    case 'observation': {
      const summary = (p.summary as string) ?? '';
      return summary.length > 20;
    }
    // Evidence events carry screenshot / clip / video refs.
    case 'evidence':
      return !!(p.screenshot || p.clip || p.video || p.kind);
    // Action results that produced screenshot refs or that failed.
    case 'action_result': {
      if (p.ok === false) return true;
      const refs = p.evidence_refs;
      return Array.isArray(refs) && refs.length > 0;
    }
    // Probe results: inspect the probe-specific summary shape. The real shapes
    // (verified against packages/adapter-web/src/probes/) are:
    //   axe:                    summary.violations: number (count)
    //   console_errors_since:   summary.error_count: number
    //   network_failures_since: summary.failure_count: number
    case 'probe_result': {
      const probe = p.probe as string | undefined;
      const summary = (p.summary as Record<string, unknown>) ?? {};
      if (probe === 'axe' && typeof summary.violations === 'number' && summary.violations > 0) {
        return true;
      }
      if (
        probe === 'console_errors_since' &&
        typeof summary.error_count === 'number' &&
        summary.error_count > 0
      ) {
        return true;
      }
      if (
        probe === 'network_failures_since' &&
        typeof summary.failure_count === 'number' &&
        summary.failure_count > 0
      ) {
        return true;
      }
      // Lighthouse: any execution counts as backing for perf-category findings.
      if (category === 'perf' && probe === 'lighthouse') return true;
      return false;
    }
    default:
      return false;
  }
}

// Helper: re-shape JudgeOutput after validation. Caller is the Orchestrator.
export function applyValidationToJudgeOutput(
  judge: JudgeOutput,
  validation: ValidationOutput,
): JudgeOutput {
  return {
    ...judge,
    findings: validation.kept,
    discarded_findings: [...(judge.discarded_findings ?? []), ...validation.discarded],
    evidence_validation: validation.summary,
  };
}
