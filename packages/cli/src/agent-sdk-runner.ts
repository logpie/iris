import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { TargetAdapter } from '@iris/adapter-types';
import type { trace as iristrace } from '@iris/core';
import { ulid } from 'ulid';
import { type ZodRawShape, z } from 'zod';

/**
 * Agent SDK-based runner. Uses the local Claude Code subscription via
 * `@anthropic-ai/claude-agent-sdk`. Dramatically faster than `claude -p` because
 * one query() session keeps the subprocess warm across all turns of the loop.
 *
 * Architecture: the SDK drives the agentic loop; iris's adapter and meta-tools
 * are registered as MCP tools that the SDK invokes. iris observes the streaming
 * messages and emits trace events for each turn / tool call.
 */

type TraceWriter = iristrace.TraceWriter;
type TraceEventKind = iristrace.TraceEventKind;

type SdkQueryHandle = AsyncIterable<unknown> & {
  interrupt?: () => void;
  return?: () => Promise<unknown> | unknown;
  [Symbol.asyncDispose]?: () => Promise<unknown> | unknown;
};

async function sdkDisposeStep(fn: (() => Promise<unknown> | unknown) | undefined): Promise<void> {
  if (!fn) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Disposal is best-effort. Callers are already on teardown paths.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function disposeSdkQuery(q: SdkQueryHandle): Promise<void> {
  await sdkDisposeStep(q.return?.bind(q));
  await sdkDisposeStep(q[Symbol.asyncDispose]?.bind(q));
}

async function runSdkIteratorWithTimeout(
  q: SdkQueryHandle,
  label: string,
  timeoutS: number,
  iterate: () => Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let timeoutError: Error | undefined;
  const iteratorPromise = iterate();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutError = new Error(`${label} timed out after ${timeoutS}s`);
      process.stderr.write(`iris: ${label} timed out after ${timeoutS}s; disposing SDK query\n`);
      try {
        q.interrupt?.();
      } catch {
        // ignore interrupt errors; disposal follows
      }
      void disposeSdkQuery(q).finally(() => {
        reject(timeoutError);
      });
    }, timeoutS * 1000);
    timer.unref?.();
  });

  try {
    await Promise.race([iteratorPromise, timeoutPromise]);
    if (timeoutError) throw timeoutError;
  } catch (err) {
    if (timedOut) iteratorPromise.catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Single-shot helper for spec-interpreter and Judge ---

export interface SingleShotInput {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  /**
   * Historical caller-provided output token cap. The current Agent SDK exposes
   * `taskBudget.total`, but that is an input+output task budget, not an output
   * cap, so this is intentionally a no-op for now.
   *
   * TODO: forward this when the Agent SDK exposes a real output-only token cap.
   */
  maxTokens?: number;
  timeoutS?: number;
}

export interface SingleShotResult {
  text: string;
  cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
  /** True when the SDK returned text after an error/cap signal, so callers should treat it as partial. */
  partial: boolean;
  partial_error?: string;
  hit_output_cap?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isOutputCapSignal(value: unknown): boolean {
  return /max[_ -]?output[_ -]?tokens|output cap|output token/i.test(errorMessage(value));
}

// Phase 8: vision through the Agent SDK. The SDK's query() accepts either a
// string prompt or an AsyncIterable<SDKUserMessage> whose `message` field is
// an Anthropic MessageParam — which supports image content blocks. We use
// the iterable form to send a screenshot + a text instruction in one user
// turn.
export interface VisionViaSdkInput {
  systemPrompt: string;
  imagePath: string;
  textPrompt: string;
  model?: string;
  timeoutS?: number;
}

export async function visionDescribeViaSdk(
  opts: VisionViaSdkInput,
): Promise<{ text: string; cost_usd: number }> {
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(opts.imagePath);
  const base64 = buf.toString('base64');

  const messages: AsyncIterable<{
    type: 'user';
    message: { role: 'user'; content: Array<unknown> };
    parent_tool_use_id: null;
  }> = (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          { type: 'text', text: opts.textPrompt },
        ],
      },
      parent_tool_use_id: null,
    };
  })();

  let text = '';
  let cost_usd = 0;
  const q = query({
    // biome-ignore lint/suspicious/noExplicitAny: SDK accepts AsyncIterable<SDKUserMessage>; our message shape conforms but cross-package types diverge.
    prompt: messages as any,
    options: {
      systemPrompt: opts.systemPrompt,
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      // Phase 19: see runAgentSdkSingleShot for the rationale.
      settingSources: [],
      strictMcpConfig: true,
      ...(opts.model ? { model: opts.model } : {}),
    },
  });
  await runSdkIteratorWithTimeout(q, 'visionDescribeViaSdk', opts.timeoutS ?? 60, async () => {
    try {
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const content =
            (msg.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
          for (const b of content) if (b.type === 'text' && b.text) text += b.text;
        } else if (msg.type === 'result') {
          const r = msg as { total_cost_usd?: number };
          cost_usd = r.total_cost_usd ?? 0;
        }
      }
    } finally {
      await disposeSdkQuery(q);
    }
  });
  return { text, cost_usd };
}

export async function runAgentSdkSingleShot(opts: SingleShotInput): Promise<SingleShotResult> {
  let text = '';
  let streamedText = '';
  let cost_usd = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let hitOutputCap = false;
  const sdkErrors: string[] = [];

  const q = query({
    prompt: opts.userPrompt,
    options: {
      systemPrompt: opts.systemPrompt,
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      // Phase 19: ISOLATE this call from the user's global Claude Code config.
      // Without settingSources:[], the SDK loads ~/.claude/settings.json which
      // can declare many MCP servers (excalidraw, lark, chrome-devtools, etc.),
      // each opened with a 30s connection timeout. With ~14 servers configured,
      // the Judge subprocess can sit 6-8 min just initializing them before the
      // actual API call. Diagnosed via debug:true log showing the SDK fetching
      // mcp_servers from api.anthropic.com and dialing each one per spawn.
      settingSources: [],
      strictMcpConfig: true,
      // Phase 19: surface streaming progress so callers can detect a healthy
      // long-running call vs an actual hang. Sonnet 4.6 default thinking on a
      // complex Judge prompt can spend 5+ minutes in extended reasoning before
      // emitting its first text token. With default false, the SDK buffers all
      // thinking_delta events and the caller sees zero progress; that pattern
      // is indistinguishable from a stalled HTTP stream. With partial messages
      // on, the iterator yields thinking_delta events as they arrive — we can
      // log a counter to stderr so users see the model is working.
      includePartialMessages: true,
      // Intentionally do not forward opts.maxTokens. Callers use it as an
      // output cap, while the SDK's taskBudget is a total input+output task
      // budget and can be smaller than large Judge prompts.
      ...(opts.model ? { model: opts.model } : {}),
    },
  });

  // Phase 19: heartbeat for visibility into long thinking phases.
  let thinkingChunks = 0;
  let lastReportedTick = 0;
  const reportProgress = () => {
    if (thinkingChunks - lastReportedTick >= 50) {
      lastReportedTick = thinkingChunks;
      process.stderr.write(
        `iris:   judge thinking — ${thinkingChunks} chunks streamed so far...\n`,
      );
    }
  };

  try {
    await runSdkIteratorWithTimeout(q, 'SingleShot', opts.timeoutS ?? 600, async () => {
      try {
        for await (const msg of q) {
          if (msg.type === 'stream_event') {
            const ev = (msg as { event?: { delta?: { type?: string; text?: string } } }).event;
            if (ev?.delta?.type === 'thinking_delta') {
              thinkingChunks++;
              reportProgress();
            } else if (ev?.delta?.type === 'text_delta' && ev.delta.text) {
              streamedText += ev.delta.text;
            }
          } else if (msg.type === 'assistant') {
            const assistantError = (msg as { error?: string }).error;
            if (assistantError) {
              sdkErrors.push(`assistant error: ${assistantError}`);
              if (assistantError === 'max_output_tokens') hitOutputCap = true;
            }
            const content =
              (msg.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
            for (const b of content) {
              if (b.type === 'text' && b.text) text += b.text;
            }
          } else if (msg.type === 'result') {
            const r = msg as {
              total_cost_usd?: number;
              usage?: { input_tokens?: number; output_tokens?: number };
              subtype?: string;
              errors?: string[];
            };
            cost_usd = r.total_cost_usd ?? 0;
            input_tokens = r.usage?.input_tokens ?? 0;
            output_tokens = r.usage?.output_tokens ?? 0;
            if (r.subtype && r.subtype !== 'success') {
              const errors = r.errors?.length ? `: ${r.errors.join('; ')}` : '';
              sdkErrors.push(`result ${r.subtype}${errors}`);
              if (isOutputCapSignal(`${r.subtype}${errors}`)) hitOutputCap = true;
            }
          }
        }
      } finally {
        await disposeSdkQuery(q);
      }
    });
  } catch (err) {
    const partialText = text || streamedText;
    if (partialText.length > 0) {
      const msg = errorMessage(err);
      return {
        text: partialText,
        cost_usd,
        usage: { input_tokens, output_tokens },
        partial: true,
        partial_error: msg,
        ...(hitOutputCap || isOutputCapSignal(msg) ? { hit_output_cap: true } : {}),
      };
    }
    throw err;
  }

  if (!text && streamedText) text = streamedText;
  const partial = hitOutputCap || sdkErrors.length > 0;
  const partialError = sdkErrors.join('; ');
  return {
    text,
    cost_usd,
    usage: { input_tokens, output_tokens },
    partial,
    ...(partialError ? { partial_error: partialError } : {}),
    ...(hitOutputCap ? { hit_output_cap: true } : {}),
  };
}

// --- Explorer-loop runner ---

export interface ExplorerSdkConfig {
  adapter: TargetAdapter;
  traceWriter: TraceWriter;
  systemPrompt: string;
  initialUserPrompt: string;
  maxSteps: number;
  timeoutS: number;
  model?: string;
  /** When provided, registers a goal_status MCP tool and emits a final
   * `goal_status: untested` event for every goal the Explorer never closed. */
  goals?: Array<{ id: string; description: string }>;
  /** Phase 10: max number of expansion goals the Explorer can append via
   * propose_goal during the run. Defaults to 6. Set to 0 to disable expansion. */
  maxExpansionGoals?: number;
  /** Phase 12: per-goal budget for auto-cutover. When the Explorer spends
   * more than 1.5× this on the current goal without calling goal_status,
   * the system force-emits goal_status(partial, auto_cutover=true) and
   * advances. Set to 0 to disable cutover. */
  stepsPerGoal?: number;
}

export interface ExplorerSdkResult {
  state: {
    plan_stack: string[];
    surfaces_seen: number;
    surfaces_unexplored: number;
    hypotheses: number;
    done: boolean;
    give_up_reason: string | null;
  };
  termination: 'done' | 'give_up' | 'budget_steps' | 'budget_cost' | 'budget_time' | 'max_turns';
  cost_usd: number;
  steps_taken: number;
  duration_s: number;
  goal_ledger?: Array<{
    id: string;
    description: string;
    status: 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested';
    rationale: string;
    evidence_event_ids?: string[];
  }>;
}

interface ExplorerState {
  plan_stack: string[];
  surfaces_seen: Array<{ id: string; summary: string }>;
  surfaces_unexplored: Array<{ id: string; where_seen: string; reason_skipped?: string }>;
  hypotheses: Array<{ claim: string; confidence: number }>;
  goals_done: Set<string>;
  done: boolean;
  give_up_reason: string | null;
}

/**
 * Convert a JSON-Schema-shaped object (the kind iris ToolSpec.input_schema uses)
 * into a Zod raw shape suitable for SDK tool() registration.
 *
 * Iris tools use a small subset of JSON Schema: string, number, boolean, object, array.
 * This converter handles that subset; more complex schemas degrade to z.unknown().
 */
function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodRawShape {
  const out: ZodRawShape = {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonPropToZod(prop);
    if (!required.has(key)) zodType = zodType.optional();
    out[key] = zodType;
  }
  return out;
}

function jsonPropToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const t = prop.type as string | string[] | undefined;
  if (t === 'string') {
    if (Array.isArray(prop.enum)) return z.enum(prop.enum as [string, ...string[]]);
    return z.string();
  }
  if (t === 'number' || t === 'integer') return z.number();
  if (t === 'boolean') return z.boolean();
  if (t === 'array') {
    const items = (prop.items ?? { type: 'string' }) as Record<string, unknown>;
    return z.array(jsonPropToZod(items));
  }
  if (t === 'object') {
    if (prop.properties) {
      return z.object(jsonSchemaToZodShape(prop));
    }
    return z.record(z.string(), z.unknown());
  }
  return z.unknown() as z.ZodTypeAny;
}

export async function runAgentSdkExplorer(config: ExplorerSdkConfig): Promise<ExplorerSdkResult> {
  const start = Date.now();
  let stepCount = 0;
  let totalCost = 0;
  let observationCounter = 0;

  const state: ExplorerState = {
    plan_stack: [],
    surfaces_seen: [],
    surfaces_unexplored: [],
    hypotheses: [],
    goals_done: new Set(),
    done: false,
    give_up_reason: null,
  };

  const emit = async (
    kind: TraceEventKind,
    actor: 'system' | 'explorer' | 'adapter' | 'probe',
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const id = ulid();
    await config.traceWriter.append({
      v: 1,
      id,
      ts: Date.now() / 1000,
      step: stepCount,
      target_kind: 'web',
      kind,
      actor,
      payload,
    });
    return id;
  };

  await emit('run_start', 'system', { transport: 'agent-sdk', max_steps: config.maxSteps });

  // Build adapter tools as MCP tools
  const adapterToolSpecs = config.adapter.listTools();
  const adapterMcpTools = adapterToolSpecs.map((spec) =>
    tool(
      spec.name,
      spec.description,
      jsonSchemaToZodShape(spec.input_schema),
      async (args: Record<string, unknown>) => {
        stepCount++;
        turnsOnCurrentGoal++;
        await emit('action', 'explorer', { tool: spec.name, args });
        const result = await config.adapter.callTool(spec.name, args);
        // Phase 7 F7-1: retry_attempt events for trace audit.
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
              tool: spec.name,
              strategy: attempt.strategy,
              ok: attempt.ok,
              ...(attempt.error ? { error: attempt.error } : {}),
            });
          }
        }
        // Phase 9: vision_describe returns a `description` text. The previous
        // emission dropped it on the floor — the Judge then saw only the file
        // ref and concluded "no outcome evidence." Carry it through so the
        // Judge can read what the vision model actually saw.
        const description = (result as { description?: string }).description;
        const actionResultEventId = await emit('action_result', 'adapter', {
          tool: spec.name,
          ok: result.ok,
          ...(result.ok ? { evidence_refs: result.evidence_refs } : { error: result.error }),
          ...(description ? { description } : {}),
          ...(retryMeta ? { retried: retryMeta.retried, retry_count: retryMeta.retry_count } : {}),
        });
        // Some tools modify the page — auto-emit observation after every
        // primitive that mutates DOM state. Includes the Phase 9 interaction
        // primitives so post-drag/key-chord/paste/etc. observations get
        // recorded as outcome evidence the goal-claim validator needs.
        const MUTATING_TOOLS = new Set([
          'click',
          'type',
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
          // Phase 15: vision_click was missing — same state-change semantics
          // as click. Adding so post-coord-click state gets captured.
          'vision_click',
        ]);
        let postActionObservationEventId: string | null = null;
        let postActionObservationSummary = '';
        if (MUTATING_TOOLS.has(spec.name)) {
          try {
            const obs = await config.adapter.observe();
            observationCounter++;
            postActionObservationSummary = obs.summary.slice(0, 1500);
            postActionObservationEventId = await emit('observation', 'adapter', {
              ref: obs.observation_ref,
              summary: obs.summary.slice(0, 4000),
            });
          } catch {
            // observation failed; continue
          }
        }
        // Phase 12: check cutover after every action so a stuck goal cannot
        // burn the whole budget on selector retries.
        await checkAndApplyCutover();
        await finishIfAllAssignedGoalsTerminal();
        const evidenceHint =
          postActionObservationEventId !== null
            ? `\npost_action_observation_event_id=${postActionObservationEventId}\npost_action_observation_summary:\n${postActionObservationSummary}`
            : spec.name === 'screenshot' || spec.name === 'vision_describe'
              ? `\noutcome_action_result_event_id=${actionResultEventId}`
              : '';
        const baseText = result.ok
          ? description
            ? `OK — vision: ${description}${evidenceHint}`
            : `OK${result.observation_ref ? ` (observation_ref=${result.observation_ref})` : ''}${evidenceHint}`
          : `ERROR: ${result.error}`;
        const text = pendingCutoverNotice ? `${baseText}\n\n${pendingCutoverNotice}` : baseText;
        if (pendingCutoverNotice) pendingCutoverNotice = null;
        return { content: [{ type: 'text' as const, text }] };
      },
    ),
  );

  // Build probe tools as MCP tools
  const probeToolSpecs = config.adapter.listProbes();
  const probeMcpTools = probeToolSpecs.map((spec) =>
    tool(
      spec.name,
      spec.description,
      jsonSchemaToZodShape(spec.input_schema),
      async (args: Record<string, unknown>) => {
        await emit('probe_call', 'explorer', { probe: spec.name, args });
        const result = await config.adapter.runProbe(spec.name, args);
        await emit(
          'probe_result',
          'probe',
          result.ok
            ? { probe: spec.name, summary: result.summary, data: result.data }
            : { probe: spec.name, error: result.error },
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                result.ok ? { summary: result.summary } : { error: result.error },
              ),
            },
          ],
        };
      },
    ),
  );

  // Meta tools
  const metaTools = [
    tool(
      'observe',
      'Take a fresh observation of the current page (DOM outline + screenshot). Use when you need to re-check the page state.',
      {},
      async () => {
        const obs = await config.adapter.observe();
        observationCounter++;
        const observationEventId = await emit('observation', 'adapter', {
          ref: obs.observation_ref,
          summary: obs.summary.slice(0, 4000),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `${obs.summary.slice(0, 1500)}\n\n(observation_ref=${obs.observation_ref}, trace_event_id=${observationEventId})`,
            },
          ],
        };
      },
    ),
    tool(
      'note_finding',
      'Flag something noteworthy — a bug, a11y issue, ux issue, etc. The judge will dedupe and assign final severity. Cite at least one observation_ref or trace event id as evidence.',
      {
        title: z.string(),
        category: z.enum(['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion']),
        severity_hint: z.enum(['blocker', 'major', 'minor', 'nit']),
        evidence_event_ids: z.array(z.string()).min(1),
        rationale: z.string(),
        where: z.object({ url: z.string().optional(), selector: z.string().optional() }).optional(),
      },
      async (args) => {
        await emit('tentative_finding', 'explorer', args);
        return { content: [{ type: 'text' as const, text: 'noted' }] };
      },
    ),
    tool(
      'mark_surface_seen',
      'Record a surface (page/section) you have explored.',
      { surface_id: z.string(), summary: z.string() },
      async (args) => {
        if (!state.surfaces_seen.some((s) => s.id === args.surface_id)) {
          state.surfaces_seen.push({ id: args.surface_id, summary: args.summary });
        }
        const idx = state.surfaces_unexplored.findIndex((s) => s.id === args.surface_id);
        if (idx >= 0) state.surfaces_unexplored.splice(idx, 1);
        await emit('surface_seen', 'explorer', args);
        return { content: [{ type: 'text' as const, text: 'noted' }] };
      },
    ),
    tool(
      'note_surface_unexplored',
      'Record a surface you noticed but have not yet explored.',
      { surface_id: z.string(), where_seen: z.string(), reason_skipped: z.string().optional() },
      async (args) => {
        if (
          !state.surfaces_seen.some((s) => s.id === args.surface_id) &&
          !state.surfaces_unexplored.some((s) => s.id === args.surface_id)
        ) {
          const entry: { id: string; where_seen: string; reason_skipped?: string } = {
            id: args.surface_id,
            where_seen: args.where_seen,
          };
          if (args.reason_skipped !== undefined) entry.reason_skipped = args.reason_skipped;
          state.surfaces_unexplored.push(entry);
        }
        await emit('surface_unexplored', 'explorer', args);
        return { content: [{ type: 'text' as const, text: 'noted' }] };
      },
    ),
    tool(
      'note_hypothesis',
      'Record a belief about the product (what it is, who it serves, etc). May be revised as you learn.',
      {
        claim: z.string(),
        confidence: z.number().min(0).max(1),
        evidence_event_ids: z.array(z.string()),
      },
      async (args) => {
        state.hypotheses.push({ claim: args.claim, confidence: args.confidence });
        await emit('hypothesis', 'explorer', args);
        return { content: [{ type: 'text' as const, text: 'noted' }] };
      },
    ),
    tool(
      'step_done',
      'Mark a planned goal as complete.',
      { goal_id: z.string(), evidence_event_ids: z.array(z.string()) },
      async (args) => {
        state.goals_done.add(args.goal_id);
        await emit('step_done', 'explorer', args);
        return { content: [{ type: 'text' as const, text: 'noted' }] };
      },
    ),
    tool(
      'give_up',
      'Stop early because you are stuck or the target is unreachable.',
      { reason: z.string() },
      async (args) => {
        state.give_up_reason = args.reason;
        await emit('give_up', 'explorer', args);
        return { content: [{ type: 'text' as const, text: 'gave up — session will end' }] };
      },
    ),
    tool(
      'done',
      'Stop normally — all planned goals satisfied or thorough exploration complete.',
      {},
      async () => {
        state.done = true;
        await emit('done', 'explorer', {});
        return { content: [{ type: 'text' as const, text: 'done — session will end' }] };
      },
    ),
  ];

  // Track goal status across the run (only used when config.goals is provided).
  const goalLedger = new Map<
    string,
    { description: string; status: string; rationale: string; evidence_event_ids: string[] }
  >();
  for (const g of config.goals ?? []) {
    goalLedger.set(g.id, {
      description: g.description,
      status: 'pending',
      rationale: '',
      evidence_event_ids: [],
    });
  }

  // Phase 10: dynamic goal expansion. Explorer can append goals via
  // propose_goal mid-run. Tracked separately so the report can distinguish
  // seed vs expansion goals.
  const seedGoalCount = config.goals?.length ?? 0;
  const maxExpansion = config.maxExpansionGoals ?? 6;
  let expansionCount = 0;

  // Phase 12: per-goal auto-cutover. When the Explorer spends more than
  // 1.5× stepsPerGoal turns on a single pending goal without calling
  // goal_status, force-advance. Without this, a single stuck goal eats
  // the whole budget (Dillinger's G1 burning all 35 turns problem).
  const stepsPerGoalCutover = config.stepsPerGoal ?? 0;
  const cutoverThreshold = stepsPerGoalCutover > 0 ? Math.ceil(stepsPerGoalCutover * 1.5) : 0;
  let turnsOnCurrentGoal = 0;
  // Cutover notice to be prepended to the next tool result so the agent
  // notices the system has moved on.
  let pendingCutoverNotice: string | null = null;
  let activeQuery: SdkQueryHandle | undefined;
  let terminalGoalsReached = false;
  let termination: ExplorerSdkResult['termination'] = 'budget_steps';

  function currentPendingGoalId(): string | null {
    for (const [id, entry] of goalLedger) {
      if (entry.status === 'pending') return id;
    }
    return null;
  }

  async function checkAndApplyCutover(): Promise<void> {
    if (cutoverThreshold <= 0) return;
    if (turnsOnCurrentGoal < cutoverThreshold) return;
    const gid = currentPendingGoalId();
    if (!gid) return;
    const entry = goalLedger.get(gid);
    if (!entry) return;
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
    pendingCutoverNotice = `[system] ${gid} auto-cut to "partial" after exceeding the per-goal budget. The next pending goal is now active — call goal_status on the current goal explicitly when finished, or you risk further auto-cutovers.`;
    turnsOnCurrentGoal = 0;
  }

  function allGoalsTerminal(): boolean {
    if (goalLedger.size === 0) return false;
    return Array.from(goalLedger.values()).every((entry) =>
      ['verified', 'partial', 'blocked', 'skipped', 'untested'].includes(entry.status),
    );
  }

  async function finishIfAllAssignedGoalsTerminal(): Promise<boolean> {
    if (terminalGoalsReached) return true;
    if (maxExpansion > 0 || !allGoalsTerminal()) return false;
    terminalGoalsReached = true;
    termination = 'done';
    state.done = true;
    await emit('done', 'system', { reason: 'all_assigned_goals_terminal' });
    try {
      activeQuery?.interrupt?.();
    } catch {
      // ignore; loop disposal handles cleanup
    }
    return true;
  }

  // Phase 10: propose_goal — Explorer adds a goal mid-run. Only available
  // when expansion is enabled (maxExpansion > 0). Capped to prevent runaway.
  const proposeGoalTools =
    maxExpansion > 0
      ? [
          tool(
            'propose_goal',
            'Add a new goal mid-run when you discover a surface or behavior not covered by seed goals. Example: you found a Settings panel — propose "change theme and verify persistence." New goals are tagged as expansion goals (priority should/could, never must). Capped per run to keep scope finite.',
            {
              description: z
                .string()
                .describe(
                  'user-outcome-shaped goal, e.g. "Toggle dark mode and verify it persists across reload"',
                ),
              rationale: z.string().describe('why this matters / what you saw that prompted this'),
              priority: z.enum(['should', 'could']).default('should'),
            },
            async (args) => {
              if (expansionCount >= maxExpansion) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `expansion cap reached (${maxExpansion}); goal not added. Continue with existing goals.`,
                    },
                  ],
                };
              }
              expansionCount++;
              const newId = `G${seedGoalCount + expansionCount}`;
              goalLedger.set(newId, {
                description: args.description,
                status: 'pending',
                rationale: '',
                evidence_event_ids: [],
              });
              await emit('goal_proposed', 'explorer', {
                id: newId,
                description: args.description,
                rationale: args.rationale,
                priority: args.priority,
              });
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `goal ${newId} added: ${args.description}. Verify it before run end via goal_status({id: "${newId}", ...}).`,
                  },
                ],
              };
            },
          ),
        ]
      : [];

  const goalStatusTools = config.goals
    ? [
        tool(
          'goal_status',
          'Mark a spec goal as verified/partial/blocked/skipped. For verified goals, evidence_event_ids is required and must cite the post-action observation, screenshot, or vision_describe action_result event id that visibly shows the user-facing outcome. Do not cite the action, action_result for the mutation, or goal_status event itself as verified evidence. partial = some evidence but incomplete; blocked = something prevents testing (e.g., modal); skipped = not applicable.',
          {
            id: z.string(),
            status: z.enum(['verified', 'partial', 'blocked', 'skipped']),
            rationale: z.string(),
            evidence_event_ids: z
              .array(z.string())
              .default([])
              .describe(
                'For verified: post-action observation/screenshot/vision_describe event ids that show the outcome.',
              ),
          },
          async (args) => {
            const evidenceEventIds = args.evidence_event_ids ?? [];
            if (args.status === 'verified' && evidenceEventIds.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'ERROR: verified goal_status requires evidence_event_ids with a post-action observation/screenshot/vision_describe event id. Retry goal_status with the outcome event id from the trace.',
                  },
                ],
              };
            }
            const entry = goalLedger.get(args.id);
            if (entry) {
              entry.status = args.status;
              entry.rationale = args.rationale;
              entry.evidence_event_ids = evidenceEventIds;
            }
            // Phase 12: reset the per-goal cutover counter so the next
            // pending goal gets a fresh budget.
            turnsOnCurrentGoal = 0;
            await emit('goal_status', 'explorer', {
              ...args,
              evidence_event_ids: evidenceEventIds,
              auto_cutover: false,
            });
            await finishIfAllAssignedGoalsTerminal();
            return {
              content: [{ type: 'text' as const, text: `goal ${args.id}: ${args.status}` }],
            };
          },
        ),
      ]
    : [];

  const irisToolServer = createSdkMcpServer({
    name: 'iris',
    tools: [
      ...adapterMcpTools,
      ...probeMcpTools,
      ...metaTools,
      ...goalStatusTools,
      ...proposeGoalTools,
    ],
  });

  const allowedToolNames = [
    ...adapterToolSpecs.map((s) => `mcp__iris__${s.name}`),
    ...probeToolSpecs.map((s) => `mcp__iris__${s.name}`),
    'mcp__iris__observe',
    'mcp__iris__note_finding',
    'mcp__iris__mark_surface_seen',
    'mcp__iris__note_surface_unexplored',
    'mcp__iris__note_hypothesis',
    'mcp__iris__step_done',
    'mcp__iris__give_up',
    'mcp__iris__done',
    ...(config.goals ? ['mcp__iris__goal_status'] : []),
    ...(maxExpansion > 0 ? ['mcp__iris__propose_goal'] : []),
  ];

  // Phase 15: split the system prompt into a cacheable static prefix and a
  // dynamic suffix. The skill body + target/mode/persona slots are stable
  // across turns and across runs — making them the cacheable prefix gives
  // huge per-turn input-token savings. Anthropic's prompt cache makes the
  // cached portion ~10× cheaper after the first turn.
  const q = query({
    prompt: config.initialUserPrompt,
    options: {
      systemPrompt: [config.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ''],
      mcpServers: { iris: irisToolServer },
      allowedTools: allowedToolNames,
      tools: [],
      maxTurns: config.maxSteps,
      permissionMode: 'bypassPermissions',
      // Phase 19: see runAgentSdkSingleShot — isolate from user's global
      // Claude Code MCP servers. Each parallel Explorer session spawn would
      // otherwise re-initialize ~14 globally-configured MCP servers with 30s
      // timeouts each, adding minutes of startup tax per session.
      settingSources: [],
      strictMcpConfig: true,
      ...(config.model ? { model: config.model } : {}),
    },
  });
  activeQuery = q as SdkQueryHandle;

  try {
    for await (const msg of q) {
      if (terminalGoalsReached) break;
      // Phase 17: cost budget removed; time is the only spend cap.
      const elapsedS = (Date.now() - start) / 1000;
      if (elapsedS >= config.timeoutS) {
        termination = 'budget_time';
        await emit('budget_abort', 'system', { reason: 'timeout_s', elapsed_s: elapsedS });
        try {
          q.interrupt?.();
        } catch {
          /* ignore */
        }
        break;
      }

      if (msg.type === 'assistant') {
        const content =
          (msg.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
        const textBlock = content.find((b) => b.type === 'text');
        if (textBlock?.text) {
          await emit('step_plan', 'explorer', { reasoning: textBlock.text.slice(0, 1000) });
        }
      } else if (msg.type === 'result') {
        const r = msg as { total_cost_usd?: number; subtype?: string };
        totalCost = r.total_cost_usd ?? totalCost;
        if (r.subtype === 'success') {
          if (state.done) termination = 'done';
          else if (state.give_up_reason) termination = 'give_up';
          else termination = 'max_turns';
        } else {
          // SDK error result (max-turns, etc)
          if (state.done) termination = 'done';
          else if (state.give_up_reason) termination = 'give_up';
          else termination = 'max_turns';
        }
      }
      if (await finishIfAllAssignedGoalsTerminal()) break;
    }
  } catch (err) {
    // SDK throws on maxTurns or other errors; treat as graceful termination so Judge can still run
    const msg = err instanceof Error ? err.message : String(err);
    if (terminalGoalsReached) {
      termination = 'done';
    } else if (/maximum number of turns/i.test(msg)) {
      termination = 'max_turns';
      await emit('budget_abort', 'system', { reason: 'max_turns', error: msg });
    } else {
      termination = 'give_up';
      await emit('give_up', 'explorer', { reason: `sdk error: ${msg.slice(0, 200)}` });
    }
  } finally {
    await disposeSdkQuery(q as SdkQueryHandle);
  }

  // Emit a final goal_status: untested for every goal the Explorer never closed.
  if (config.goals) {
    for (const [id, entry] of goalLedger) {
      if (entry.status === 'pending') {
        await emit('goal_status', 'system', {
          id,
          status: 'untested',
          rationale: 'never reached within budget',
          evidence_event_ids: [],
        });
        entry.status = 'untested';
        entry.evidence_event_ids = [];
      }
    }
  }

  const duration_s = (Date.now() - start) / 1000;
  await emit('run_end', 'system', {
    termination,
    cost_usd: totalCost,
    duration_s,
    steps: stepCount,
  });

  const goal_ledger = config.goals
    ? Array.from(goalLedger.entries()).map(([id, entry]) => ({
        id,
        description: entry.description,
        status: entry.status as 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested',
        rationale: entry.rationale,
        evidence_event_ids: entry.evidence_event_ids,
      }))
    : undefined;

  return {
    state: {
      plan_stack: state.plan_stack,
      surfaces_seen: state.surfaces_seen.length,
      surfaces_unexplored: state.surfaces_unexplored.length,
      hypotheses: state.hypotheses.length,
      done: state.done,
      give_up_reason: state.give_up_reason,
    },
    termination,
    cost_usd: totalCost,
    steps_taken: stepCount,
    duration_s,
    ...(goal_ledger ? { goal_ledger } : {}),
  };
}
