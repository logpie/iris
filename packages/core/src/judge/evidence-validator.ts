// Evidence validator — deterministic post-Judge stage. For every finding,
// confirms the cited evidence event IDs actually exist in the trace and that
// at least one of them is a "backing" event (something concrete the user
// would consider proof of the finding). Findings whose IDs are bogus get
// discarded; severe findings without backing get downgraded one tier.
//
// This is the load-bearing step against Judge hallucination. We did not use
// an LLM to validate because (a) Otto needs to trust the result deterministically
// and (b) an LLM validator is just another fallible model in the loop.
//
// Phase 6 F1: distinguish Explorer selector-miss from genuine app failures.
// A failed action_result with "strict mode violation" or "resolved to 0
// elements" is the Explorer using a bad selector, not the app being broken.
// And if the same tool succeeded elsewhere in the trace, the original failure
// was a transient Explorer error and shouldn't count as backing.

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

// Phase 6 F1: error patterns that signal Explorer selector-miss, NOT app bug.
// These come from real Playwright errors captured in Phase 5 dogfood traces.
const SELECTOR_MISS_PATTERNS: RegExp[] = [
  /strict mode violation/i,
  /resolved to \d+ elements/i,
  /no element found/i,
  /Element is not attached to the DOM/i,
  /Target page, context or browser has been closed/i,
];

// Config / setup errors — neither app bugs nor selector errors. The adapter
// is in a bad state.
const ADAPTER_CONFIG_ERROR_PATTERNS: RegExp[] = [
  /requires an LlmClient/i,
  /adapter not started/i,
  /unknown tool:/i,
];

function isSelectorMissError(error?: string): boolean {
  if (!error) return false;
  return SELECTOR_MISS_PATTERNS.some((p) => p.test(error));
}

function isAdapterConfigError(error?: string): boolean {
  if (!error) return false;
  return ADAPTER_CONFIG_ERROR_PATTERNS.some((p) => p.test(error));
}

interface TraceContext {
  toolSuccessByTool: Map<string, number[]>; // tool -> indices where it succeeded
}

function buildTraceContext(trace: TraceEvent[]): TraceContext {
  const toolSuccessByTool = new Map<string, number[]>();
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (!e || e.kind !== 'action_result') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.ok !== true) continue;
    const tool = String(p.tool ?? '');
    if (!tool) continue;
    const arr = toolSuccessByTool.get(tool) ?? [];
    arr.push(i);
    toolSuccessByTool.set(tool, arr);
  }
  return { toolSuccessByTool };
}

// Whether a failed action_result at index `idx` was likely an Explorer error
// rather than an app bug. True if:
//  - the error message matches a known selector-miss pattern, OR
//  - the same tool succeeded within ±5 events around this failure
//    (Explorer retried with a different selector and succeeded; the failure
//    was transient Explorer behavior, not an app defect).
function isLikelyExplorerError(e: TraceEvent, idx: number, ctx: TraceContext): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const error = p.error as string | undefined;
  if (isAdapterConfigError(error)) return true;
  if (isSelectorMissError(error)) return true;
  // Same tool succeeded within ±5 events of this failure?
  const tool = String(p.tool ?? '');
  const successes = ctx.toolSuccessByTool.get(tool);
  if (successes) {
    for (const si of successes) {
      if (Math.abs(si - idx) <= 5) return true;
    }
  }
  return false;
}

export function validateFindings(findings: JudgeFinding[], trace: TraceEvent[]): ValidationOutput {
  const eventById = new Map<string, TraceEvent>();
  for (const e of trace) eventById.set(e.id, e);
  const ctx = buildTraceContext(trace);

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
    const result = checkBacking(validIds, trace, ctx, f.category);
    if (result.backed) {
      kept.push({ ...f, unverified_backing: false });
      verified++;
    } else {
      const newSev = DOWNGRADE[f.severity] ?? f.severity;
      kept.push({
        ...f,
        severity: newSev,
        unverified_backing: true,
        ...(result.likelyExplorerError ? { likely_explorer_error: true } : {}),
      });
      downgraded++;
    }
  }

  return {
    kept,
    discarded,
    summary: { verified, downgraded, discarded: discarded.length },
  };
}

interface BackingResult {
  backed: boolean;
  // Phase 6 F1: if the only "backing" we found was a failed action_result
  // that looks like an Explorer selector-miss, flag it so the report can
  // tell the user this finding is probably about the Explorer, not the app.
  likelyExplorerError: boolean;
}

// Whether at least one of the cited events (within a ±2-turn window) provides
// concrete backing. Real trace kinds are documented in
// `packages/core/src/trace/schema.ts`. Probe results are payloads with shape
// `{probe, summary: {violations?|error_count?|failure_count?}, data}`.
function checkBacking(
  citedIds: string[],
  trace: TraceEvent[],
  ctx: TraceContext,
  category: string,
): BackingResult {
  const indices = citedIds.map((id) => trace.findIndex((e) => e.id === id)).filter((i) => i >= 0);
  let sawSelectorMissOnly = false;
  for (const idx of indices) {
    const lo = Math.max(0, idx - 2);
    const hi = Math.min(trace.length, idx + 3);
    for (let i = lo; i < hi; i++) {
      const e = trace[i];
      if (!e) continue;
      const verdict = eventBackingVerdict(e, i, ctx, category);
      if (verdict === 'backing') return { backed: true, likelyExplorerError: false };
      if (verdict === 'selector_miss') sawSelectorMissOnly = true;
    }
  }
  return { backed: false, likelyExplorerError: sawSelectorMissOnly };
}

type BackingVerdict = 'backing' | 'selector_miss' | 'not_backing';

function eventBackingVerdict(
  e: TraceEvent,
  idx: number,
  ctx: TraceContext,
  category: string,
): BackingVerdict {
  const p = (e.payload ?? {}) as Record<string, unknown>;

  switch (e.kind) {
    case 'tentative_finding':
    case 'hypothesis':
      return 'backing';
    case 'observation': {
      const summary = (p.summary as string) ?? '';
      return summary.length > 20 ? 'backing' : 'not_backing';
    }
    case 'evidence':
      return p.screenshot || p.clip || p.video || p.kind ? 'backing' : 'not_backing';
    case 'action_result': {
      // Successful action with evidence_refs (screenshot etc) is backing.
      if (p.ok === true) {
        const refs = p.evidence_refs;
        return Array.isArray(refs) && refs.length > 0 ? 'backing' : 'not_backing';
      }
      // Failed action. Phase 6 F1: distinguish selector-miss from real bug.
      if (isLikelyExplorerError(e, idx, ctx)) return 'selector_miss';
      // Genuine app failure (timeout on an existing element, intercepted, etc).
      return 'backing';
    }
    case 'probe_result': {
      const probe = p.probe as string | undefined;
      const summary = (p.summary as Record<string, unknown>) ?? {};
      if (probe === 'axe' && typeof summary.violations === 'number' && summary.violations > 0) {
        return 'backing';
      }
      if (
        probe === 'console_errors_since' &&
        typeof summary.error_count === 'number' &&
        summary.error_count > 0
      ) {
        return 'backing';
      }
      if (
        probe === 'network_failures_since' &&
        typeof summary.failure_count === 'number' &&
        summary.failure_count > 0
      ) {
        return 'backing';
      }
      if (category === 'perf' && probe === 'lighthouse') return 'backing';
      return 'not_backing';
    }
    default:
      return 'not_backing';
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
