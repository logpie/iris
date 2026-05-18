import type { TargetAdapter } from '@iris/adapter-types';
import { adapter as irisAdapter } from '@iris/core';
import type { trace as iristrace } from '@iris/core';
import { ulid } from 'ulid';
import type { CodexAppServerClient, JsonRpcNotification } from './codex-app-server-client.js';
import {
  type ScenarioCompletionGate,
  ScenarioCompletionGateVerifier,
} from './scenario-completion-gate.js';

type TraceWriter = iristrace.TraceWriter;
type TraceEventKind = iristrace.TraceEventKind;

export interface CodexSingleShotInput {
  systemPrompt: string;
  userPrompt: string;
  imagePath?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  timeoutS?: number;
  outputSchema?: unknown;
  cwd?: string;
}

export interface CodexSingleShotResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number };
  token_usage: CodexTokenUsageSnapshot;
  cost_usd: number;
  duration_s: number;
}

export interface TokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

interface ThreadTokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: { last?: TokenUsageBreakdown; total?: TokenUsageBreakdown };
}

export interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  non_cached_input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexTokenUsageSnapshot {
  last?: CodexTokenUsage;
  total?: CodexTokenUsage;
}

function textInput(text: string): { type: 'text'; text: string; text_elements: [] } {
  return { type: 'text', text, text_elements: [] };
}

function outputText(text: string): { type: 'inputText'; text: string } {
  return { type: 'inputText', text };
}

function isUnattemptedSkipRationale(rationale: string): boolean {
  return /\b(not (attempted|exercised|tested)|never reached|not reached|ran out|out of time|no time|before budget|budget ran out|budget was exhausted|did not (attempt|exercise|test|reach|visit)|not visited)\b/i.test(
    rationale,
  );
}

function invalidEvidenceEventIdsMessage(input: {
  unknown: readonly string[];
  unacceptable: readonly string[];
}): string {
  const parts: string[] = [];
  if (input.unknown.length > 0) {
    parts.push(`unknown event id(s): ${input.unknown.join(', ')}`);
  }
  if (input.unacceptable.length > 0) {
    parts.push(`not accepted outcome evidence: ${input.unacceptable.join(', ')}`);
  }
  return `ERROR: goal_status evidence_event_ids must cite existing accepted outcome evidence events (post-action observation, screenshot/vision_describe action_result, or post-action/post-explorer probe_result). ${parts.join('; ')}.`;
}

function matchesThreadTurn(
  params: Record<string, unknown> | undefined,
  threadId: string,
  turnId: string,
): params is Record<string, unknown> {
  if (!params || params.threadId !== threadId) return false;
  const turn = params.turn as { id?: unknown } | undefined;
  const notificationTurnId =
    typeof params.turnId === 'string' ? params.turnId : typeof turn?.id === 'string' ? turn.id : '';
  return !turnId || !notificationTurnId || notificationTurnId === turnId;
}

function agentTextFromCompletedTurn(params: Record<string, unknown>): string | undefined {
  const turn = params.turn as { items?: Array<{ type?: string; text?: unknown }> } | undefined;
  const items = turn?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === 'agentMessage' && typeof item.text === 'string') return item.text;
  }
  return undefined;
}

export function codexModelName(model?: string): string {
  return model && !model.startsWith('claude-') ? model : 'gpt-5.4-mini';
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const CODEX_APP_SERVER_REASONING_EFFORT: CodexReasoningEffort = 'low';

export function parseCodexReasoningEffort(input: string): CodexReasoningEffort {
  if (input === 'low' || input === 'medium' || input === 'high' || input === 'xhigh') {
    return input;
  }
  throw new Error(
    `invalid Codex reasoning effort "${input}" (expected low, medium, high, or xhigh)`,
  );
}

function normalizeUsage(usage?: TokenUsageBreakdown): CodexTokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    non_cached_input_tokens: Math.max(0, inputTokens - cachedInputTokens),
    output_tokens: usage.outputTokens ?? 0,
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoning_output_tokens: usage.reasoningOutputTokens }
      : {}),
  };
}

export function normalizeTokenUsageSnapshot(input?: {
  last?: TokenUsageBreakdown;
  total?: TokenUsageBreakdown;
}): CodexTokenUsageSnapshot {
  const last = normalizeUsage(input?.last);
  const total = normalizeUsage(input?.total);
  return {
    ...(last ? { last } : {}),
    ...(total ? { total } : {}),
  };
}

function legacyUsageFrom(snapshot: CodexTokenUsageSnapshot): CodexSingleShotResult['usage'] {
  const usage = snapshot.total ?? snapshot.last;
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cached_input_tokens: usage?.cached_input_tokens ?? 0,
  };
}

export async function runCodexAppServerSingleShot(
  client: CodexAppServerClient,
  opts: CodexSingleShotInput,
): Promise<CodexSingleShotResult> {
  const started = Date.now();
  const threadResponse = (await client.request(
    'thread/start',
    {
      model: codexModelName(opts.model),
      modelProvider: 'openai',
      cwd: opts.cwd ?? process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: opts.systemPrompt,
      developerInstructions: 'Return the requested answer directly.',
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      dynamicTools: [],
    },
    30_000,
  )) as { thread?: { id?: string } };
  const threadId = threadResponse.thread?.id;
  if (!threadId) throw new Error('codex app-server thread/start returned no thread id');

  let turnId = '';
  let finalText = '';
  let deltaText = '';
  let tokenUsage: { last?: TokenUsageBreakdown; total?: TokenUsageBreakdown } | undefined;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        if (turnId) {
          client.request('turn/interrupt', { threadId, turnId }).catch(() => {
            // best effort
          });
        }
        cleanup();
        reject(new Error(`codex app-server single-shot timed out after ${opts.timeoutS ?? 600}s`));
      },
      (opts.timeoutS ?? 600) * 1000,
    );
    timer.unref?.();

    const onNotification = (msg: JsonRpcNotification) => {
      const params = msg.params as Record<string, unknown> | undefined;
      if (!matchesThreadTurn(params, threadId, turnId)) return;

      if (msg.method === 'item/agentMessage/delta') {
        const delta = (params as { delta?: string }).delta;
        if (delta) deltaText += delta;
      } else if (msg.method === 'item/completed') {
        const item = (params as { item?: { type?: string; text?: string } }).item;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') finalText = item.text;
      } else if (msg.method === 'thread/tokenUsage/updated') {
        const usage = (params as unknown as ThreadTokenUsageNotification).tokenUsage;
        tokenUsage = usage;
      } else if (msg.method === 'turn/completed') {
        const completedText = agentTextFromCompletedTurn(params);
        if (completedText) finalText = completedText;
        cleanup();
        resolve();
      } else if (msg.method === 'turn/failed') {
        cleanup();
        reject(new Error(`codex app-server turn failed: ${JSON.stringify(params).slice(0, 500)}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off('notification', onNotification);
    };
    client.on('notification', onNotification);
  });

  const input = opts.imagePath
    ? [{ type: 'localImage', path: opts.imagePath }, textInput(opts.userPrompt)]
    : [textInput(opts.userPrompt)];
  const turnResponse = (await client.request(
    'turn/start',
    {
      threadId,
      input,
      approvalPolicy: 'never',
      model: codexModelName(opts.model),
      effort: opts.reasoningEffort ?? CODEX_APP_SERVER_REASONING_EFFORT,
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    },
    30_000,
  )) as { turn?: { id?: string } };
  turnId = turnResponse.turn?.id ?? '';
  if (!turnId) throw new Error('codex app-server turn/start returned no turn id');

  await done;
  const normalizedUsage = normalizeTokenUsageSnapshot(tokenUsage);
  return {
    text: finalText || deltaText,
    usage: legacyUsageFrom(normalizedUsage),
    token_usage: normalizedUsage,
    cost_usd: 0,
    duration_s: (Date.now() - started) / 1000,
  };
}

export interface CodexExplorerConfig {
  client: CodexAppServerClient;
  adapter: TargetAdapter;
  traceWriter: TraceWriter;
  systemPrompt: string;
  initialUserPrompt: string;
  maxSteps: number;
  timeoutS: number;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  goals?: Array<{ id: string; description: string }>;
  scenarioGates?: ScenarioCompletionGate[];
  maxExpansionGoals?: number;
  stepsPerGoal?: number;
  cwd?: string;
}

export interface CodexExplorerResult {
  state: {
    surfaces_seen: number;
    surfaces_unexplored: number;
    hypotheses: number;
    done: boolean;
    give_up_reason: string | null;
  };
  termination: 'done' | 'give_up' | 'budget_steps' | 'budget_time' | 'max_turns';
  cost_usd: number;
  steps_taken: number;
  duration_s: number;
  token_usage: CodexTokenUsageSnapshot;
}

interface GoalEntry {
  description: string;
  status: 'pending' | 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested';
  rationale: string;
  evidence_event_ids: string[];
}

const MUTATING_TOOLS = new Set([
  'click',
  'type',
  'select_option',
  'navigate',
  'press',
  'back',
  'forward',
  'reload',
  'drag',
  'vision_drag',
  'key_chord',
  'paste',
  'vision_paste',
  'right_click',
  'vision_right_click',
  'double_click',
  'vision_double_click',
  'hover_wait',
  'vision_hover_wait',
  'upload',
  'click_upload',
  'click_download',
  'vision_click',
]);

export async function runCodexAppServerExplorer(
  config: CodexExplorerConfig,
): Promise<CodexExplorerResult> {
  const start = Date.now();
  let stepCount = 0;
  let totalCost = 0;
  let termination: CodexExplorerResult['termination'] = 'budget_steps';
  let done = false;
  let giveUpReason: string | null = null;
  let surfacesSeen = 0;
  let surfacesUnexplored = 0;
  let hypotheses = 0;
  let activeTurnId = '';
  let finalAgentText = '';
  let deltaAgentText = '';
  let dynamicToolCallCount = 0;
  let observationSummaryChars = 0;
  const scenarioGate = new ScenarioCompletionGateVerifier(config.scenarioGates);

  const goalLedger = new Map<string, GoalEntry>();
  for (const goal of config.goals ?? []) {
    goalLedger.set(goal.id, {
      description: goal.description,
      status: 'pending',
      rationale: '',
      evidence_event_ids: [],
    });
  }
  const seedGoalCount = goalLedger.size;
  const maxExpansion = config.maxExpansionGoals ?? 6;
  let expansionCount = 0;
  let partialRetryPasses = 0;
  const maxPartialRetryPasses = goalLedger.size > 0 ? 1 : 0;
  const cutoverThreshold =
    config.stepsPerGoal && config.stepsPerGoal > 0 ? Math.ceil(config.stepsPerGoal * 1.5) : 0;
  let turnsOnCurrentGoal = 0;

  const emit = async (
    kind: TraceEventKind,
    actor: 'system' | 'explorer' | 'adapter' | 'probe',
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const id = ulid();
    const event = {
      v: 1 as const,
      id,
      ts: Date.now() / 1000,
      step: stepCount,
      target_kind: 'web' as const,
      kind,
      actor,
      payload,
    };
    await config.traceWriter.append(event);
    scenarioGate.recordTraceEvent(id, kind, payload);
    return id;
  };

  await emit('run_start', 'system', {
    transport: 'codex-appserver',
    model: codexModelName(config.model),
    reasoning_effort: config.reasoningEffort ?? CODEX_APP_SERVER_REASONING_EFFORT,
    max_steps: config.maxSteps,
  });

  const initialObservation = await config.adapter.observe();
  observationSummaryChars += initialObservation.summary.slice(0, 4000).length;
  const initialObservationEventId = await emit(
    'observation',
    'adapter',
    irisAdapter.observationTracePayload(initialObservation),
  );

  const currentPendingGoalId = (): string | null => {
    for (const [id, entry] of goalLedger) if (entry.status === 'pending') return id;
    return null;
  };

  const allGoalsTerminal = (): boolean =>
    goalLedger.size > 0 &&
    Array.from(goalLedger.values()).every((entry) => entry.status !== 'pending');

  const retryablePartialGoalIds = (): string[] =>
    Array.from(goalLedger.entries())
      .filter(([, entry]) => entry.status === 'partial')
      .map(([id]) => id);

  const pendingGoalIds = (): string[] =>
    Array.from(goalLedger.entries())
      .filter(([, entry]) => entry.status === 'pending')
      .map(([id]) => id);

  const hasRetryBudget = (): boolean => {
    const elapsedS = (Date.now() - start) / 1000;
    const reserveS = Math.min(10, Math.max(1, config.timeoutS * 0.1));
    return stepCount < config.maxSteps && elapsedS < Math.max(0, config.timeoutS - reserveS);
  };

  const maybeStartPartialRetryPass = async (): Promise<string | null> => {
    if (partialRetryPasses >= maxPartialRetryPasses || !hasRetryBudget()) return null;
    const ids = retryablePartialGoalIds();
    if (ids.length === 0) return null;
    partialRetryPasses++;
    for (const id of ids) {
      const entry = goalLedger.get(id);
      if (entry) entry.status = 'pending';
    }
    await emit('budget_warn', 'system', {
      reason: 'partial_retry',
      pass: partialRetryPasses,
      goals: ids,
      steps_remaining: Math.max(0, config.maxSteps - stepCount),
    });
    return `[system] Budget remains, so Iris is retrying partial goals instead of ending. Retry only these goals: ${ids.join(', ')}. Use the strongest available evidence; for focus/layout/sidebar/theme goals, call ui_state with relevant selectors after interacting.`;
  };

  const rejectDoneIfGoalsRemain = async (): Promise<string | null> => {
    if (goalLedger.size === 0 || !hasRetryBudget()) return null;
    const pending = pendingGoalIds();
    const partial = retryablePartialGoalIds();
    if (pending.length === 0 && partial.length === 0) return null;

    if (pending.length === 0) {
      const retryNotice = await maybeStartPartialRetryPass();
      if (retryNotice) return retryNotice;
      return null;
    }

    await emit('budget_warn', 'system', {
      reason: 'done_rejected',
      pending_goals: pending,
      partial_goals: partial,
      steps_remaining: Math.max(0, config.maxSteps - stepCount),
    });
    return `[system] Cannot finish yet: ${pending.length} assigned goal(s) are still pending (${pending.join(', ')})${
      partial.length > 0 ? ` and ${partial.length} goal(s) are partial (${partial.join(', ')})` : ''
    }. Continue with the pending goals, then call goal_status for each goal before ending.`;
  };

  const checkCutover = async (): Promise<string> => {
    if (cutoverThreshold <= 0 || turnsOnCurrentGoal < cutoverThreshold) return '';
    const gid = currentPendingGoalId();
    if (!gid) return '';
    const entry = goalLedger.get(gid);
    if (!entry) return '';
    entry.status = 'partial';
    entry.rationale = `auto-cutover after ${turnsOnCurrentGoal} turns without explicit goal_status`;
    entry.evidence_event_ids = [];
    await emit('goal_status', 'system', {
      id: gid,
      status: 'partial',
      rationale: entry.rationale,
      evidence_event_ids: [],
      auto_cutover: true,
    });
    turnsOnCurrentGoal = 0;
    return `[system] ${gid} auto-cut to partial after exceeding the per-goal budget. Move to the next pending goal.`;
  };

  const handleAdapterTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; success: boolean }> => {
    if (stepCount >= config.maxSteps) {
      termination = 'budget_steps';
      await emit('budget_abort', 'system', { reason: 'max_steps' });
      return { text: 'ERROR: step budget exceeded; stop now.', success: false };
    }
    stepCount++;
    turnsOnCurrentGoal++;
    await emit('action', 'explorer', { tool: name, args });
    const result = await config.adapter.callTool(name, args);
    const retryMeta = (
      result as {
        retry_meta?: {
          retried: boolean;
          retry_count: number;
          attempts?: Array<{ strategy: string; ok: boolean; error?: string }>;
        };
      }
    ).retry_meta;
    if (retryMeta?.retried && retryMeta.attempts) {
      for (const attempt of retryMeta.attempts) {
        await emit('retry_attempt', 'adapter', {
          tool: name,
          strategy: attempt.strategy,
          ok: attempt.ok,
          ...(attempt.error ? { error: attempt.error } : {}),
        });
      }
    }
    const description = (result as { description?: string }).description;
    const actionResultEventId = await emit('action_result', 'adapter', {
      tool: name,
      ok: result.ok,
      ...(result.ok ? { evidence_refs: result.evidence_refs } : { error: result.error }),
      ...(description ? { description } : {}),
      ...(retryMeta ? { retried: retryMeta.retried, retry_count: retryMeta.retry_count } : {}),
    });

    let observationHint = '';
    if (result.ok && MUTATING_TOOLS.has(name)) {
      try {
        const obs = await config.adapter.observe();
        observationSummaryChars += obs.summary.slice(0, 4000).length;
        const obsEventId = await emit(
          'observation',
          'adapter',
          irisAdapter.observationTracePayload(obs),
        );
        observationHint = `\npost_action_observation_event_id=${obsEventId}\npost_action_observation_summary:\n${obs.summary.slice(0, 1500)}`;
      } catch {
        // Keep the underlying action result.
      }
    } else if (name === 'screenshot' || name === 'vision_describe') {
      observationHint = `\noutcome_action_result_event_id=${actionResultEventId}`;
    }
    const artifactHint =
      result.ok && result.evidence_refs.length > 0
        ? `\naction_result_event_id=${actionResultEventId}\nevidence_refs=${JSON.stringify(result.evidence_refs)}`
        : '';
    const cutoverNotice = await checkCutover();
    const text = result.ok
      ? description
        ? `OK - vision: ${description}${artifactHint}${observationHint}`
        : `OK${artifactHint}${observationHint}`
      : `ERROR: ${result.error}`;
    return {
      text: cutoverNotice ? `${text}\n\n${cutoverNotice}` : text,
      success: result.ok,
    };
  };

  const handleProbeTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; success: boolean }> => {
    await emit('probe_call', 'explorer', { probe: name, args });
    const result = await config.adapter.runProbe(name, args);
    await emit(
      'probe_result',
      'probe',
      result.ok
        ? { probe: name, ok: true, summary: result.summary, data: result.data }
        : { probe: name, ok: false, error: result.error },
    );
    return {
      text: JSON.stringify(result.ok ? { summary: result.summary } : { error: result.error }),
      success: result.ok,
    };
  };

  const handleMetaTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; success: boolean }> => {
    if (name === 'observe') {
      const obs = await config.adapter.observe();
      observationSummaryChars += obs.summary.slice(0, 4000).length;
      const eventId = await emit(
        'observation',
        'adapter',
        irisAdapter.observationTracePayload(obs),
      );
      return {
        text: `${obs.summary.slice(0, 1500)}\n\n(observation_ref=${obs.observation_ref}, trace_event_id=${eventId})`,
        success: true,
      };
    }
    if (name === 'note_finding') {
      await emit('tentative_finding', 'explorer', args);
      return { text: 'noted', success: true };
    }
    if (name === 'mark_surface_seen') {
      surfacesSeen++;
      await emit('surface_seen', 'explorer', args);
      return { text: 'noted', success: true };
    }
    if (name === 'note_surface_unexplored') {
      surfacesUnexplored++;
      await emit('surface_unexplored', 'explorer', args);
      return { text: 'noted', success: true };
    }
    if (name === 'note_hypothesis') {
      hypotheses++;
      await emit('hypothesis', 'explorer', args);
      return { text: 'noted', success: true };
    }
    if (name === 'step_done') {
      await emit('step_done', 'explorer', args);
      return { text: 'noted', success: true };
    }
    if (name === 'goal_status') {
      const id = String(args.id ?? '');
      const status = String(args.status ?? '') as GoalEntry['status'];
      const rationale = String(args.rationale ?? '');
      const evidence = Array.isArray(args.evidence_event_ids)
        ? args.evidence_event_ids.map(String)
        : [];
      if (!goalLedger.has(id)) {
        return {
          text: `ERROR: unknown goal_status id "${id}". Use one of the active Iris goal ids: ${[
            ...goalLedger.keys(),
          ].join(', ')}.`,
          success: false,
        };
      }
      if (status === 'verified' && evidence.length === 0) {
        return {
          text: 'ERROR: verified goal_status requires evidence_event_ids with a post-action observation/screenshot/vision_describe event id.',
          success: false,
        };
      }
      if (evidence.length > 0) {
        const evidenceCheck = scenarioGate.checkEvidenceEventIds(evidence);
        if (!evidenceCheck.ok) {
          return {
            text: invalidEvidenceEventIdsMessage(evidenceCheck),
            success: false,
          };
        }
      }
      if (status === 'verified' && scenarioGate.enabled) {
        const check = scenarioGate.check(id, evidence);
        if (!check.ok) {
          return {
            text: `ERROR: scenario completion gate rejected verified for ${id}. Cited evidence is missing required visible output(s): ${check.missing.join('; ')}. Required checklist: ${check.required.join('; ')}. Repair the product state and call observe/vision_describe, then cite that evidence; otherwise mark the goal partial with evidence.`,
            success: false,
          };
        }
      }
      if ((status === 'partial' || status === 'blocked') && evidence.length === 0) {
        return {
          text: `ERROR: ${status} goal_status requires evidence_event_ids showing the incomplete outcome or blocker. If the goal has not been attempted, keep working on it instead of closing it.`,
          success: false,
        };
      }
      if (status === 'skipped' && hasRetryBudget() && isUnattemptedSkipRationale(rationale)) {
        return {
          text: 'ERROR: skipped means the goal is not applicable to this product/run. Do not mark assigned goals skipped because time or budget remains; attempt it, or use partial/blocked with evidence after a real attempt.',
          success: false,
        };
      }
      const entry = goalLedger.get(id);
      if (entry && ['verified', 'partial', 'blocked', 'skipped'].includes(status)) {
        entry.status = status;
        entry.rationale = rationale;
        entry.evidence_event_ids = evidence;
      }
      turnsOnCurrentGoal = 0;
      await emit('goal_status', 'explorer', {
        id,
        status,
        rationale,
        evidence_event_ids: evidence,
        auto_cutover: false,
      });
      let retryNotice: string | null = null;
      if (allGoalsTerminal()) {
        retryNotice = await maybeStartPartialRetryPass();
        if (!retryNotice) done = true;
      }
      return {
        text: retryNotice
          ? `goal ${id}: ${status}\n${retryNotice}`
          : done
            ? `goal ${id}: ${status}\nAll assigned goals are terminal; stop now without calling more tools.`
            : `goal ${id}: ${status}`,
        success: true,
      };
    }
    if (name === 'propose_goal') {
      if (expansionCount >= maxExpansion) {
        return { text: `expansion cap reached (${maxExpansion}); goal not added.`, success: false };
      }
      expansionCount++;
      const newId = `G${seedGoalCount + expansionCount}`;
      const description = String(args.description ?? '');
      goalLedger.set(newId, {
        description,
        status: 'pending',
        rationale: '',
        evidence_event_ids: [],
      });
      await emit('goal_proposed', 'explorer', {
        id: newId,
        description,
        rationale: String(args.rationale ?? ''),
        priority: args.priority ?? 'should',
        ...(args.surface_id ? { surface_id: String(args.surface_id) } : {}),
        ...(args.journey_id ? { journey_id: String(args.journey_id) } : {}),
      });
      return { text: `goal ${newId} added: ${description}`, success: true };
    }
    if (name === 'give_up') {
      giveUpReason = String(args.reason ?? 'give_up');
      await emit('give_up', 'explorer', { reason: giveUpReason });
      return { text: 'gave up - session will end', success: true };
    }
    if (name === 'done') {
      const doneRejection = await rejectDoneIfGoalsRemain();
      if (doneRejection) return { text: doneRejection, success: false };
      done = true;
      await emit('done', 'explorer', {});
      return { text: 'done - session will end', success: true };
    }
    return { text: `unknown meta tool: ${name}`, success: false };
  };

  const adapterTools = new Set(config.adapter.listTools().map((tool) => tool.name));
  const probeTools = new Set(config.adapter.listProbes().map((tool) => tool.name));
  const dynamicTools = [
    ...config.adapter.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
    ...config.adapter.listProbes().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
    ...metaDynamicTools(goalLedger.size > 0, maxExpansion > 0, scenarioGate.enabled),
  ];
  const dynamicToolSchemaChars = JSON.stringify(dynamicTools).length;

  config.client.setServerRequestHandler(async (request) => {
    if (request.method !== 'item/tool/call') {
      throw new Error(`unhandled app-server request: ${request.method}`);
    }
    const params = request.params as {
      threadId: string;
      turnId: string;
      tool: string;
      arguments?: Record<string, unknown>;
    };
    if (activeTurnId && params.turnId !== activeTurnId) {
      throw new Error(`tool call for unexpected turn: ${params.turnId}`);
    }
    dynamicToolCallCount++;
    if (done && params.tool !== 'done') {
      return {
        contentItems: [
          outputText('Run is already complete because all assigned goals are terminal.'),
        ],
        success: false,
      };
    }
    const args = params.arguments ?? {};
    let result: { text: string; success: boolean };
    if (adapterTools.has(params.tool)) result = await handleAdapterTool(params.tool, args);
    else if (probeTools.has(params.tool)) result = await handleProbeTool(params.tool, args);
    else result = await handleMetaTool(params.tool, args);
    return { contentItems: [outputText(result.text)], success: result.success };
  });

  let tokenUsage: { last?: TokenUsageBreakdown; total?: TokenUsageBreakdown } | undefined;
  let threadId = '';
  try {
    const threadResponse = (await config.client.request(
      'thread/start',
      {
        model: codexModelName(config.model),
        modelProvider: 'openai',
        cwd: config.cwd ?? process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: config.systemPrompt,
        developerInstructions:
          'You are driving Iris through App Server dynamic tools. Use the provided real browser observation as evidence. Do not answer in prose instead of tool calls. When exploration is complete, call goal_status/done/give_up as appropriate.',
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        dynamicTools,
      },
      30_000,
    )) as { thread?: { id?: string } };
    threadId = threadResponse.thread?.id ?? '';
    if (!threadId) throw new Error('codex app-server thread/start returned no thread id');

    let timedOut = false;
    const waitForTurn = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(async () => {
        timedOut = true;
        termination = 'budget_time';
        await emit('budget_abort', 'system', { reason: 'timeout_s' });
        if (activeTurnId) {
          config.client.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {
            // best effort
          });
        }
        cleanup();
        reject(new Error(`codex app-server Explorer timed out after ${config.timeoutS}s`));
      }, config.timeoutS * 1000);
      timer.unref?.();

      const onNotification = (msg: JsonRpcNotification) => {
        const params = msg.params as Record<string, unknown> | undefined;
        if (!params || params.threadId !== threadId) return;
        if (msg.method === 'thread/tokenUsage/updated') {
          const usage = (params as unknown as ThreadTokenUsageNotification).tokenUsage;
          tokenUsage = usage;
        } else if (msg.method === 'item/agentMessage/delta') {
          const delta = (params as { delta?: string }).delta;
          if (delta) deltaAgentText += delta;
        } else if (msg.method === 'item/completed') {
          const item = (params as { item?: { type?: string; text?: string } }).item;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') {
            finalAgentText = item.text;
          }
        } else if (msg.method === 'turn/completed') {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        config.client.off('notification', onNotification);
      };
      config.client.on('notification', onNotification);
    });

    const turnResponse = (await config.client.request(
      'turn/start',
      {
        threadId,
        input: [
          textInput(`APP SERVER TOOL CONTRACT:
- Iris has already captured a real browser observation for you below. Use its trace_event_id as evidence when it is sufficient.
- Use the available dynamic tools for every browser action, probe, note, and completion marker.
- Do not provide a final prose-only answer. A run without goal_status, done, or give_up is invalid.
- For verified goals, call goal_status with evidence_event_ids.

Initial real browser observation:
trace_event_id=${initialObservationEventId}
${initialObservation.summary.slice(0, 4000)}

${config.initialUserPrompt}`),
        ],
        approvalPolicy: 'never',
        model: codexModelName(config.model),
        effort: config.reasoningEffort ?? CODEX_APP_SERVER_REASONING_EFFORT,
      },
      30_000,
    )) as { turn?: { id?: string } };
    activeTurnId = turnResponse.turn?.id ?? '';
    if (!activeTurnId) throw new Error('codex app-server turn/start returned no turn id');

    try {
      await waitForTurn;
    } catch (err) {
      if (!timedOut) throw err;
    }
  } finally {
    config.client.setServerRequestHandler(null);
  }

  if (termination === 'budget_steps') {
    if (done) termination = 'done';
    else if (giveUpReason) termination = 'give_up';
    else if (stepCount === 0) {
      termination = 'give_up';
      giveUpReason = 'app-server turn completed without any dynamic tool calls';
      await emit('give_up', 'system', { reason: giveUpReason });
    } else termination = 'max_turns';
  }

  for (const [id, entry] of goalLedger) {
    if (entry.status === 'pending') {
      entry.status = 'untested';
      await emit('goal_status', 'system', {
        id,
        status: 'untested',
        rationale: 'never reached within budget',
        evidence_event_ids: [],
      });
    }
  }

  const duration_s = (Date.now() - start) / 1000;
  const tokenUsageSnapshot = normalizeTokenUsageSnapshot(tokenUsage);
  const usage = legacyUsageFrom(tokenUsageSnapshot);
  const cachedInputRatio =
    usage.input_tokens > 0 ? usage.cached_input_tokens / usage.input_tokens : 0;
  const modelContinuationEstimate =
    tokenUsageSnapshot.last?.input_tokens && tokenUsageSnapshot.last.input_tokens > 0
      ? usage.input_tokens / tokenUsageSnapshot.last.input_tokens
      : undefined;
  totalCost = 0;
  await emit('run_end', 'system', {
    termination,
    cost_usd: totalCost,
    duration_s,
    steps: stepCount,
    usage,
    token_usage: tokenUsageSnapshot,
    provider_overhead: {
      dynamic_tool_count: dynamicTools.length,
      dynamic_tool_schema_chars: dynamicToolSchemaChars,
      observation_summary_chars: observationSummaryChars,
      dynamic_tool_call_count: dynamicToolCallCount,
      cached_input_ratio: Number(cachedInputRatio.toFixed(4)),
      ...(modelContinuationEstimate !== undefined
        ? { model_continuation_estimate: Number(modelContinuationEstimate.toFixed(2)) }
        : {}),
    },
    ...(finalAgentText || deltaAgentText
      ? { agent_text_preview: (finalAgentText || deltaAgentText).slice(0, 2000) }
      : {}),
  });

  return {
    state: {
      surfaces_seen: surfacesSeen,
      surfaces_unexplored: surfacesUnexplored,
      hypotheses,
      done,
      give_up_reason: giveUpReason,
    },
    termination,
    cost_usd: totalCost,
    steps_taken: stepCount,
    duration_s,
    token_usage: tokenUsageSnapshot,
  };
}

function metaDynamicTools(
  hasGoals: boolean,
  allowExpansion: boolean,
  scenarioGateEnabled = false,
): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> = [
    {
      name: 'observe',
      description: 'Take a fresh observation of the current page.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'note_finding',
      description:
        'Flag a bug, a11y issue, UX issue, performance issue, copy issue, or suggestion.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: ['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion'] },
          severity_hint: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          evidence_event_ids: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          where: { type: 'object' },
        },
        required: ['title', 'category', 'severity_hint', 'evidence_event_ids', 'rationale'],
      },
    },
    {
      name: 'mark_surface_seen',
      description: 'Record a page or section you explored.',
      inputSchema: {
        type: 'object',
        properties: { surface_id: { type: 'string' }, summary: { type: 'string' } },
        required: ['surface_id', 'summary'],
      },
    },
    {
      name: 'note_surface_unexplored',
      description: 'Record a noticed surface that you did not explore.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string' },
          where_seen: { type: 'string' },
          reason_skipped: { type: 'string' },
        },
        required: ['surface_id', 'where_seen'],
      },
    },
    {
      name: 'note_hypothesis',
      description: 'Record a belief about the product.',
      inputSchema: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          confidence: { type: 'number' },
          evidence_event_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['claim', 'confidence', 'evidence_event_ids'],
      },
    },
    {
      name: 'step_done',
      description: 'Mark a planned goal as complete.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: { type: 'string' },
          evidence_event_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['goal_id', 'evidence_event_ids'],
      },
    },
    {
      name: 'give_up',
      description: 'Stop early because the target is unreachable or you are stuck.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
    },
    {
      name: 'done',
      description: 'Stop normally after thorough exploration.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  if (hasGoals) {
    tools.push({
      name: 'goal_status',
      description: `Mark a spec goal as verified, partial, blocked, or skipped. Verified goals require outcome evidence_event_ids. Partial and blocked goals also require evidence_event_ids showing the incomplete outcome or blocker; do not close an unattempted goal as partial/blocked. Skipped means not applicable, not out of time.${scenarioGateEnabled ? ' Scenario completion gate is enabled: verified will be rejected unless cited evidence contains every required visible output for that goal.' : ''}`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['verified', 'partial', 'blocked', 'skipped'] },
          rationale: { type: 'string' },
          evidence_event_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'status', 'rationale'],
      },
    });
  }
  if (allowExpansion) {
    tools.push({
      name: 'propose_goal',
      description:
        'Add a new goal only for a material product ability not covered by seed goals or listed capability gaps. Prefer user-visible outcomes over raw surfaces; do not add promo/banner/legal/menu-only checks unless they block core use.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          rationale: { type: 'string' },
          priority: { type: 'string', enum: ['should', 'could'] },
          surface_id: { type: 'string' },
          journey_id: { type: 'string' },
        },
        required: ['description', 'rationale'],
      },
    });
  }
  return tools;
}
