import type { TraceEvent } from '../trace/schema.js';

export interface TaskRunGoal {
  id: string;
  description: string;
  status: string;
  evidence?: string[] | undefined;
  notes?: string | undefined;
}

export interface TaskRunAction {
  event_id: string;
  result_event_id?: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok?: boolean;
  error?: string;
  evidence_refs?: string[];
  retried?: boolean;
  retry_count?: number;
  post_observation_event_id?: string;
}

export interface TaskRunObservationRef {
  event_id: string;
  observation_ref?: string;
  screenshot_ref?: string;
  url?: string;
  title?: string;
  element_hashes: string[];
}

export interface TaskRun {
  id: string;
  goal_id: string;
  description: string;
  status: string;
  notes?: string;
  goal_status_event_id?: string;
  evidence_event_ids: string[];
  started_event_id?: string;
  ended_event_id?: string;
  event_ids: string[];
  actions: TaskRunAction[];
  observations: TaskRunObservationRef[];
  replay: {
    source: 'trace';
    replayable: boolean;
    action_count: number;
    successful_action_count: number;
    reason?: string;
  };
}

export function buildTaskRuns(input: {
  goals: TaskRunGoal[];
  trace: TraceEvent[];
}): TaskRun[] {
  if (input.goals.length === 0 || input.trace.length === 0) return [];
  const indexById = new Map(input.trace.map((event, index) => [event.id, index]));
  const statusByGoal = latestGoalStatusByGoal(input.trace);

  return input.goals.map((goal) => {
    const statusEvent = statusByGoal.get(goal.id);
    const endIndex = statusEvent ? (indexById.get(statusEvent.id) ?? input.trace.length - 1) : -1;
    const startIndex = endIndex >= 0 ? previousGoalStatusIndex(input.trace, endIndex) + 1 : 0;
    const windowEvents = endIndex >= 0 ? input.trace.slice(startIndex, endIndex + 1) : [];
    const evidenceIds = uniqueStrings([
      ...(goal.evidence ?? []),
      ...stringArray((statusEvent?.payload as Record<string, unknown> | undefined)?.evidence_event_ids),
    ]);
    const evidenceEvents = evidenceIds
      .map((id) => input.trace[indexById.get(id) ?? -1])
      .filter((event): event is TraceEvent => Boolean(event));
    const eventIds = uniqueStrings([...windowEvents.map((event) => event.id), ...evidenceIds]);
    const observations = buildObservationRefs([...windowEvents, ...evidenceEvents]);
    const actions = buildActions(windowEvents);
    const replay = replaySummary(actions);
    const startedEventId = windowEvents[0]?.id ?? evidenceEvents[0]?.id;
    const endedEventId = statusEvent?.id ?? evidenceEvents[evidenceEvents.length - 1]?.id;

    return {
      id: `TR-${goal.id}`,
      goal_id: goal.id,
      description: goal.description,
      status: goal.status,
      ...(goal.notes ? { notes: goal.notes } : {}),
      ...(statusEvent ? { goal_status_event_id: statusEvent.id } : {}),
      evidence_event_ids: evidenceIds,
      ...(startedEventId ? { started_event_id: startedEventId } : {}),
      ...(endedEventId ? { ended_event_id: endedEventId } : {}),
      event_ids: eventIds,
      actions,
      observations,
      replay,
    };
  });
}

function latestGoalStatusByGoal(trace: TraceEvent[]): Map<string, TraceEvent> {
  const out = new Map<string, TraceEvent>();
  for (const event of trace) {
    if (event.kind !== 'goal_status') continue;
    const id = typeof event.payload.id === 'string' ? event.payload.id : undefined;
    if (id) out.set(id, event);
  }
  return out;
}

function previousGoalStatusIndex(trace: TraceEvent[], beforeIndex: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (trace[i]?.kind === 'goal_status') return i;
  }
  return -1;
}

function buildActions(events: TraceEvent[]): TaskRunAction[] {
  const actions: TaskRunAction[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || event.kind !== 'action') continue;
    const result = nextEventOfKind(events, i + 1, 'action_result');
    const postObservation = result
      ? nextEventOfKind(events, events.indexOf(result) + 1, 'observation')
      : undefined;
    const resultPayload = result?.payload ?? {};
    actions.push({
      event_id: event.id,
      ...(result ? { result_event_id: result.id } : {}),
      step: event.step,
      tool: typeof event.payload.tool === 'string' ? event.payload.tool : 'unknown',
      args: plainObject(event.payload.args) ? event.payload.args : {},
      ...(typeof resultPayload.ok === 'boolean' ? { ok: resultPayload.ok } : {}),
      ...(typeof resultPayload.error === 'string' ? { error: resultPayload.error } : {}),
      ...(Array.isArray(resultPayload.evidence_refs)
        ? { evidence_refs: stringArray(resultPayload.evidence_refs) }
        : {}),
      ...(typeof resultPayload.retried === 'boolean' ? { retried: resultPayload.retried } : {}),
      ...(typeof resultPayload.retry_count === 'number'
        ? { retry_count: resultPayload.retry_count }
        : {}),
      ...(postObservation ? { post_observation_event_id: postObservation.id } : {}),
    });
  }
  return actions;
}

function nextEventOfKind(
  events: TraceEvent[],
  startIndex: number,
  kind: TraceEvent['kind'],
): TraceEvent | undefined {
  for (let i = startIndex; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === 'action' || event.kind === 'goal_status') return undefined;
    if (event.kind === kind) return event;
  }
  return undefined;
}

function buildObservationRefs(events: TraceEvent[]): TaskRunObservationRef[] {
  const seen = new Set<string>();
  const observations: TaskRunObservationRef[] = [];
  for (const event of events) {
    if (event.kind !== 'observation' || seen.has(event.id)) continue;
    seen.add(event.id);
    const state = plainObject(event.payload.perception_state)
      ? event.payload.perception_state
      : undefined;
    const elements = Array.isArray(state?.elements) ? state.elements : [];
    observations.push({
      event_id: event.id,
      ...(typeof event.payload.ref === 'string' ? { observation_ref: event.payload.ref } : {}),
      ...(typeof state?.screenshot_ref === 'string' ? { screenshot_ref: state.screenshot_ref } : {}),
      ...(typeof state?.url === 'string' ? { url: state.url } : {}),
      ...(typeof state?.title === 'string' ? { title: state.title } : {}),
      element_hashes: uniqueStrings(
        elements
          .map((element) =>
            plainObject(element) && typeof element.stable_hash === 'string'
              ? element.stable_hash
              : undefined,
          )
          .filter((hash): hash is string => Boolean(hash))
          .slice(0, 20),
      ),
    });
  }
  return observations;
}

const REPLAYABLE_TOOLS = new Set([
  'click',
  'type',
  'select_option',
  'press',
  'hover',
  'vision_click',
]);

function replaySummary(actions: TaskRunAction[]): TaskRun['replay'] {
  const successful = actions.filter((action) => action.ok === true).length;
  if (actions.length === 0) {
    return {
      source: 'trace',
      replayable: false,
      action_count: 0,
      successful_action_count: 0,
      reason: 'no replayable user actions were captured for this goal',
    };
  }
  const unsupported = actions.find((action) => !REPLAYABLE_TOOLS.has(action.tool));
  const failed = actions.find((action) => action.ok === false);
  return {
    source: 'trace',
    replayable: !unsupported && !failed,
    action_count: actions.length,
    successful_action_count: successful,
    ...(unsupported
      ? { reason: `unsupported tool for deterministic replay: ${unsupported.tool}` }
      : failed
        ? { reason: `action failed in source trace: ${failed.tool}` }
        : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
