import type { TraceWriter } from '../trace/writer.js';
import type { TargetKind } from '../types.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ExplorerState {
  plan_stack: string[];
  goals_done: Set<string>;
  surfaces_seen: Array<{ id: string; summary: string }>;
  surfaces_unexplored: Array<{ id: string; where_seen: string; reason_skipped?: string }>;
  hypotheses: Array<{ claim: string; confidence: number; evidence_event_ids: string[] }>;
  give_up_reason: string | null;
  done: boolean;
}

export type MetaToolResult = { ok: true } | { ok: false; error: string };

export function newExplorerState(): ExplorerState {
  return {
    plan_stack: [],
    goals_done: new Set(),
    surfaces_seen: [],
    surfaces_unexplored: [],
    hypotheses: [],
    give_up_reason: null,
    done: false,
  };
}

// ---------------------------------------------------------------------------
// Shared envelope builder
// ---------------------------------------------------------------------------

type IdsFactory = () => string;

function envelope(
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
  kind: string,
  actor: 'explorer',
  payload: Record<string, unknown>,
) {
  return {
    v: 1 as const,
    id: ids(),
    ts: Date.now() / 1000,
    step,
    target_kind,
    kind,
    actor,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set(['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion']);
const VALID_SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit']);

// ---------------------------------------------------------------------------
// 1. note_finding
// ---------------------------------------------------------------------------

export interface NoteFindingArgs {
  title: string;
  category: string;
  severity_hint: string;
  evidence_event_ids: string[];
  rationale: string;
  where?: string;
}

export async function note_finding(
  writer: TraceWriter,
  state: ExplorerState,
  args: NoteFindingArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  if (!args.title || args.title.length < 1) {
    return { ok: false, error: 'title must be at least 1 character' };
  }
  if (!VALID_CATEGORIES.has(args.category)) {
    return {
      ok: false,
      error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}`,
    };
  }
  if (!VALID_SEVERITIES.has(args.severity_hint)) {
    return {
      ok: false,
      error: `severity_hint must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
    };
  }
  if (!args.evidence_event_ids || args.evidence_event_ids.length < 1) {
    return { ok: false, error: 'evidence_event_ids must have at least 1 entry' };
  }

  const payload: Record<string, unknown> = {
    title: args.title,
    category: args.category,
    severity_hint: args.severity_hint,
    evidence_event_ids: args.evidence_event_ids,
    rationale: args.rationale,
  };
  if (args.where !== undefined) {
    payload.where = args.where;
  }

  await writer.append(
    envelope(ids, step, target_kind, 'tentative_finding', 'explorer', payload) as Parameters<
      typeof writer.append
    >[0],
  );

  void state; // note_finding does not mutate state
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 2. note_hypothesis
// ---------------------------------------------------------------------------

export interface NoteHypothesisArgs {
  claim: string;
  confidence: number;
  evidence_event_ids: string[];
}

export async function note_hypothesis(
  writer: TraceWriter,
  state: ExplorerState,
  args: NoteHypothesisArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  if (args.confidence < 0 || args.confidence > 1) {
    return { ok: false, error: 'confidence must be between 0 and 1' };
  }

  state.hypotheses.push({
    claim: args.claim,
    confidence: args.confidence,
    evidence_event_ids: args.evidence_event_ids,
  });

  await writer.append(
    envelope(ids, step, target_kind, 'hypothesis', 'explorer', {
      claim: args.claim,
      confidence: args.confidence,
      evidence_event_ids: args.evidence_event_ids,
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. mark_surface_seen
// ---------------------------------------------------------------------------

export interface MarkSurfaceSeenArgs {
  surface_id: string;
  summary: string;
}

export async function mark_surface_seen(
  writer: TraceWriter,
  state: ExplorerState,
  args: MarkSurfaceSeenArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  // Remove from unexplored if present
  const idx = state.surfaces_unexplored.findIndex((s) => s.id === args.surface_id);
  if (idx !== -1) {
    state.surfaces_unexplored.splice(idx, 1);
  }

  // Add to seen if not already there
  const alreadySeen = state.surfaces_seen.some((s) => s.id === args.surface_id);
  if (!alreadySeen) {
    state.surfaces_seen.push({ id: args.surface_id, summary: args.summary });
  }

  await writer.append(
    envelope(ids, step, target_kind, 'surface_seen', 'explorer', {
      surface_id: args.surface_id,
      summary: args.summary,
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. note_surface_unexplored
// ---------------------------------------------------------------------------

export interface NoteSurfaceUnexploredArgs {
  surface_id: string;
  where_seen: string;
  reason_skipped?: string;
}

export async function note_surface_unexplored(
  writer: TraceWriter,
  state: ExplorerState,
  args: NoteSurfaceUnexploredArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  // Skip if already in seen
  const alreadySeen = state.surfaces_seen.some((s) => s.id === args.surface_id);
  if (!alreadySeen) {
    // Add if not already in unexplored
    const alreadyUnexplored = state.surfaces_unexplored.some((s) => s.id === args.surface_id);
    if (!alreadyUnexplored) {
      const entry: { id: string; where_seen: string; reason_skipped?: string } = {
        id: args.surface_id,
        where_seen: args.where_seen,
      };
      if (args.reason_skipped !== undefined) {
        entry.reason_skipped = args.reason_skipped;
      }
      state.surfaces_unexplored.push(entry);
    }
  }

  const payload: Record<string, unknown> = {
    surface_id: args.surface_id,
    where_seen: args.where_seen,
  };
  if (args.reason_skipped !== undefined) {
    payload.reason_skipped = args.reason_skipped;
  }

  await writer.append(
    envelope(ids, step, target_kind, 'surface_unexplored', 'explorer', payload) as Parameters<
      typeof writer.append
    >[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 5. revisit
// ---------------------------------------------------------------------------

export interface RevisitArgs {
  event_id: string;
}

export async function revisit(
  writer: TraceWriter,
  state: ExplorerState,
  args: RevisitArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  void state;
  await writer.append(
    envelope(ids, step, target_kind, 'action', 'explorer', {
      tool: 'revisit',
      args: { event_id: args.event_id },
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 6. try_weirdness
// ---------------------------------------------------------------------------

export interface TryWeirdnessArgs {
  kind: string;
  target?: string;
}

export async function try_weirdness(
  writer: TraceWriter,
  state: ExplorerState,
  args: TryWeirdnessArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  void state;
  await writer.append(
    envelope(ids, step, target_kind, 'action', 'explorer', {
      tool: 'try_weirdness',
      args,
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 7. step_done
// ---------------------------------------------------------------------------

export interface StepDoneArgs {
  goal_id: string;
  evidence_event_ids: string[];
}

export async function step_done(
  writer: TraceWriter,
  state: ExplorerState,
  args: StepDoneArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  state.goals_done.add(args.goal_id);

  await writer.append(
    envelope(ids, step, target_kind, 'step_done', 'explorer', {
      goal_id: args.goal_id,
      evidence_event_ids: args.evidence_event_ids,
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 8. push_subgoal
// ---------------------------------------------------------------------------

export interface PushSubgoalArgs {
  description: string;
}

export async function push_subgoal(
  writer: TraceWriter,
  state: ExplorerState,
  args: PushSubgoalArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  state.plan_stack.push(args.description);

  await writer.append(
    envelope(ids, step, target_kind, 'step_plan', 'explorer', {
      push_subgoal: args.description,
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 9. give_up
// ---------------------------------------------------------------------------

export interface GiveUpArgs {
  reason: string;
}

export async function give_up(
  writer: TraceWriter,
  state: ExplorerState,
  args: GiveUpArgs,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  state.give_up_reason = args.reason;

  await writer.append(
    envelope(ids, step, target_kind, 'give_up', 'explorer', {
      reason: args.reason,
    }) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 10. done
// ---------------------------------------------------------------------------

export async function done(
  writer: TraceWriter,
  state: ExplorerState,
  _args: Record<string, never>,
  ids: IdsFactory,
  step: number,
  target_kind: TargetKind,
): Promise<MetaToolResult> {
  state.done = true;

  await writer.append(
    envelope(ids, step, target_kind, 'done', 'explorer', {}) as Parameters<typeof writer.append>[0],
  );

  return { ok: true };
}
