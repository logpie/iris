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

// Phase 11: agent-perspective phrasings in a finding TITLE that betray the
// finding is really about Iris's interaction strategy, not a product defect.
// A real product finding talks about what the user sees; an agent-perspective
// finding talks about what the agent's selectors/clicks/attempts did. The
// Dillinger dogfood (2026-05-11) caught the Judge emitting "CodeMirror editor
// not reachable via standard selectors" as a major finding against a Monaco-
// based product — the editor was perfectly reachable, the Explorer used the
// wrong CSS framework's selectors.
const AGENT_PERSPECTIVE_TITLE_PATTERNS: RegExp[] = [
  // "not Xable/typable/focusable via standard selectors" — with optional
  // /-separated alternatives between the verb and "via".
  /\bnot\s+(reachable|actionable|focusable|clickable|targetable|typable)(\/(reachable|actionable|focusable|clickable|targetable|typable))*\s+(via|by|through|with)\b/i,
  /\bnot\s+(reachable|actionable|focusable|clickable|targetable)\s+via\b/i,
  /\bnot\s+(reachable|actionable|focusable|clickable|targetable)\s+(by|through|with)\b/i,
  // "poor selector targeting" / "poor accessible name" — agent-perspective
  // wording about how hard the agent found the control, dressed as a product
  // finding.
  /\bpoor\s+(selector\s+targeting|accessible\s+name|aria(\s+selector|\s+labelling)?)\b/i,
  /\bselector\s+targeting\s+(is\s+)?(poor|weak|missing)\b/i,
  /\bcould\s+not\s+(be\s+)?(focused|located|reached|found|targeted)\b/i,
  /\bcannot\s+(be\s+)?(focused|located|reached|found|targeted)\b/i,
  // Selector / locator / accessibility-name strategy talk — present tense too.
  /\bselector\s+(failed|fails|timed\s+out|times?\s+out|not\s+found|mismatch)\b/i,
  /\b(locator|click|focus|fill|type)\s+(via|using|on|by)\s+(role=|css=|data-testid|accessible(\s+name)?|aria(\s+selector)?)\b/i,
  /\bclick\s+via\s+\w+\s+selector\s+times?\s+out\b/i,
  /\bdoes\s+not\s+respond\s+to\s+clicks?\b/i,
  /\b(lacks?|missing)\b.*\b(accessible|proper)\b.*\b(textbox\s+role|name|role|semantics)\b/i,
  /\b(role=\w+|css=|data-testid)\b.*\b(timed?\s+out|times?\s+out|failed|not\s+found)\b/i,
  // Any title that mentions a known automation-tool concept as the subject
  // ("ARIA selector", "accessible-name locator", "Playwright click") — these
  // are agent-perspective phrasings by construction.
  /\b(ARIA|accessible-name|playwright|locator)\s+(selector|locator|click|target)\b/i,
];

function looksLikeAgentPerspectiveFinding(title: string): boolean {
  return AGENT_PERSPECTIVE_TITLE_PATTERNS.some((p) => p.test(title));
}

// Phase 12: a "no confirmation / no toast / no notification" finding is only
// legitimate if the trace actually checked for one. The notifications_visible
// probe sweeps aria-live, role=alert/status, common toast frameworks, and
// fixed-corner toasts. If it ran AND returned >0 items, the finding is
// disproved by direct evidence — the Judge ignored the probe (Dillinger
// dogfood 2026-05-11: probe returned "Preparing HTML... Exported as HTML"
// and the Judge still claimed "no confirmation").
const NO_CONFIRMATION_TITLE_PATTERNS: RegExp[] = [
  // Single "no <thing>" — covers download/toast/dialog/file-dialog variants.
  /\bno\s+(visible\s+)?(confirmation|toast|notification|feedback|indicator|response|notice|message|download|dialog|file\s+dialog|popup|modal)\b/i,
  // "produced no visible X, Y, or Z" — common Judge phrasing after Export.
  /\bproduced\s+no\s+(visible\s+)?\S+(\s*,\s*\S+){0,4}/i,
  /\b(does\s+not|doesn't|fails\s+to)\s+(show|provide|produce|display)\s+(any\s+)?(confirmation|toast|notification|feedback|indicator|download|dialog)\b/i,
  /\b(gives|provides|shows)\s+no\s+(visible\s+)?(confirmation|toast|notification|feedback|indicator|download|dialog)\b/i,
  /\bwithout\s+(any\s+)?(visible\s+)?(confirmation|toast|notification|feedback|indicator|download|dialog)\b/i,
];

function looksLikeNoConfirmationFinding(title: string): boolean {
  return NO_CONFIRMATION_TITLE_PATTERNS.some((p) => p.test(title));
}

function notificationsProbeShowedSomething(trace: TraceEvent[]): boolean {
  for (const e of trace) {
    if (e.kind !== 'probe_result') continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.probe !== 'notifications_visible') continue;
    if (p.ok === false) continue;
    const summary = (p.summary ?? {}) as Record<string, unknown>;
    if (typeof summary.count === 'number' && summary.count > 0) return true;
    // Defensive: also check data is a non-empty array.
    const data = p.data;
    if (Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}

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
  // Phase 7 F7-3: selectors the Explorer actually used. The Judge sometimes
  // hallucinates code_pointer selectors that never appeared in the trace —
  // we drop those at validation time.
  knownSelectors: Set<string>;
}

function buildTraceContext(trace: TraceEvent[]): TraceContext {
  const toolSuccessByTool = new Map<string, number[]>();
  const knownSelectors = new Set<string>();
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (!e) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === 'action') {
      const args = (p.args ?? {}) as Record<string, unknown>;
      const sel = args.selector;
      if (typeof sel === 'string' && sel.length > 0) knownSelectors.add(sel);
    }
    if (e.kind === 'action_result' && p.ok === true) {
      const tool = String(p.tool ?? '');
      if (tool) {
        const arr = toolSuccessByTool.get(tool) ?? [];
        arr.push(i);
        toolSuccessByTool.set(tool, arr);
      }
    }
  }
  return { toolSuccessByTool, knownSelectors };
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

  for (const rawFinding of findings) {
    // Phase 7 F7-3: strip code_pointer if its selector doesn't appear in the
    // trace (Judge fabricated it). Keep the rest of suggested_fix.
    const f = stripFabricatedCodePointer(rawFinding, ctx);

    const validIds = f.evidence.filter((id) => eventById.has(id));
    if (validIds.length === 0) {
      discarded.push({
        tentative_event_id: f.id,
        reason: 'all_evidence_ids_invalid',
      });
      continue;
    }

    // Phase 12: "no confirmation / no toast" finding is disproved if the
    // notifications_visible probe captured ≥1 notification anywhere in the
    // run. Direct evidence beats the Judge's eye-test.
    if (looksLikeNoConfirmationFinding(f.title) && notificationsProbeShowedSomething(trace)) {
      discarded.push({
        tentative_event_id: f.id,
        reason: 'no_confirmation_finding_contradicted_by_notifications_probe',
      });
      continue;
    }

    // Phase 11: agent-perspective title check. If the finding TITLE talks
    // about the agent's interaction strategy ("not reachable via selectors",
    // "could not focus", etc.), it is almost certainly a fabricated finding
    // about Iris's interaction limits, not a real product defect. Discard
    // unless there's clear non-agent evidence (a probe failure, a console
    // error, an explicit error message visible to the user).
    if (looksLikeAgentPerspectiveFinding(f.title)) {
      const hasNonAgentBacking = validIds.some((id) => {
        const e = eventById.get(id);
        if (!e) return false;
        const p = (e.payload ?? {}) as Record<string, unknown>;
        if (e.kind === 'probe_result' && p.ok === true) return true;
        if (
          e.kind === 'observation' &&
          typeof p.summary === 'string' &&
          /\berror\b|\bfailed\b|\bcrashed\b/i.test(p.summary)
        ) {
          return true;
        }
        return false;
      });
      if (!hasNonAgentBacking) {
        discarded.push({
          tentative_event_id: f.id,
          reason: 'agent_perspective_title_no_user_visible_failure',
        });
        continue;
      }
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

// Phase 7 F7-3: if the Judge's suggested_fix.code_pointer cites a selector
// the Explorer never actually used, drop the code_pointer. Keep summary
// and patch_hint (those can be valid without a code_pointer).
function stripFabricatedCodePointer(f: JudgeFinding, ctx: TraceContext): JudgeFinding {
  const sf = f.suggested_fix;
  if (!sf?.code_pointer) return f;
  const sel = sf.code_pointer.selector;
  if (!sel || ctx.knownSelectors.has(sel)) return f;
  // Selector not in trace — drop the code_pointer.
  const { code_pointer: _drop, ...rest } = sf;
  return { ...f, suggested_fix: rest };
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
      // Phase 7 F7-1: a successful action that needed a retry means the
      // Explorer's first selector was wrong. Treat as selector-miss for
      // backing purposes — the original failure shouldn't bolster a finding,
      // and the eventual success was just retry plumbing.
      if (p.ok === true && p.retried === true) return 'selector_miss';
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
