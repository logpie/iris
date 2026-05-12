import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
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
type TraceEventKind =
  | 'run_start'
  | 'spec_interpreted'
  | 'step_plan'
  | 'action'
  | 'action_result'
  | 'observation'
  | 'probe_call'
  | 'probe_result'
  | 'evidence'
  | 'tentative_finding'
  | 'hypothesis'
  | 'surface_seen'
  | 'surface_unexplored'
  | 'step_done'
  | 'goal_status'
  | 'preflight'
  | 'retry_attempt'
  | 'give_up'
  | 'done'
  | 'budget_warn'
  | 'budget_abort'
  | 'run_end';

// --- Single-shot helper for spec-interpreter and Judge ---

export interface SingleShotInput {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
}

export interface SingleShotResult {
  text: string;
  cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
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
      ...(opts.model ? { model: opts.model } : {}),
    },
  });
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
  return { text, cost_usd };
}

export async function runAgentSdkSingleShot(opts: SingleShotInput): Promise<SingleShotResult> {
  let text = '';
  let cost_usd = 0;
  let input_tokens = 0;
  let output_tokens = 0;

  const q = query({
    prompt: opts.userPrompt,
    options: {
      systemPrompt: opts.systemPrompt,
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      ...(opts.model ? { model: opts.model } : {}),
    },
  });

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const content =
        (msg.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      for (const b of content) {
        if (b.type === 'text' && b.text) text += b.text;
      }
    } else if (msg.type === 'result') {
      const r = msg as {
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      cost_usd = r.total_cost_usd ?? 0;
      input_tokens = r.usage?.input_tokens ?? 0;
      output_tokens = r.usage?.output_tokens ?? 0;
    }
  }

  return { text, cost_usd, usage: { input_tokens, output_tokens } };
}

// --- Explorer-loop runner ---

export interface ExplorerSdkConfig {
  adapter: TargetAdapter;
  traceWriter: TraceWriter;
  systemPrompt: string;
  initialUserPrompt: string;
  maxSteps: number;
  maxCostUsd: number;
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
        await emit('action_result', 'adapter', {
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
        ]);
        if (MUTATING_TOOLS.has(spec.name)) {
          try {
            const obs = await config.adapter.observe();
            observationCounter++;
            await emit('observation', 'adapter', {
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
        const baseText = result.ok
          ? description
            ? `OK — vision: ${description}`
            : `OK${result.observation_ref ? ` (observation_ref=${result.observation_ref})` : ''}`
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
        await emit('observation', 'adapter', {
          ref: obs.observation_ref,
          summary: obs.summary.slice(0, 4000),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `${obs.summary.slice(0, 1500)}\n\n(observation_ref=${obs.observation_ref})`,
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
  const goalLedger = new Map<string, { description: string; status: string; rationale: string }>();
  for (const g of config.goals ?? []) {
    goalLedger.set(g.id, { description: g.description, status: 'pending', rationale: '' });
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
    await emit('goal_status', 'system', {
      id: gid,
      status: 'partial',
      rationale: entry.rationale,
      auto_cutover: true,
    });
    pendingCutoverNotice = `[system] ${gid} auto-cut to "partial" after exceeding the per-goal budget. The next pending goal is now active — call goal_status on the current goal explicitly when finished, or you risk further auto-cutovers.`;
    turnsOnCurrentGoal = 0;
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
          'Mark a spec goal as verified/partial/blocked/skipped. Call this when you have finished (or determined you cannot complete) a goal so the run can move on. verified = goal works end-to-end; partial = some evidence but incomplete; blocked = something prevents testing (e.g., modal); skipped = not applicable.',
          {
            id: z.string(),
            status: z.enum(['verified', 'partial', 'blocked', 'skipped']),
            rationale: z.string(),
          },
          async (args) => {
            const entry = goalLedger.get(args.id);
            if (entry) {
              entry.status = args.status;
              entry.rationale = args.rationale;
            }
            // Phase 12: reset the per-goal cutover counter so the next
            // pending goal gets a fresh budget.
            turnsOnCurrentGoal = 0;
            await emit('goal_status', 'explorer', { ...args, auto_cutover: false });
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

  const q = query({
    prompt: config.initialUserPrompt,
    options: {
      systemPrompt: config.systemPrompt,
      mcpServers: { iris: irisToolServer },
      allowedTools: allowedToolNames,
      tools: [],
      maxTurns: config.maxSteps,
      permissionMode: 'bypassPermissions',
      ...(config.model ? { model: config.model } : {}),
    },
  });

  let termination: ExplorerSdkResult['termination'] = 'budget_steps';

  try {
    for await (const msg of q) {
      if (totalCost >= config.maxCostUsd) {
        termination = 'budget_cost';
        await emit('budget_abort', 'system', { reason: 'max_cost_usd', cost_usd: totalCost });
        try {
          q.interrupt?.();
        } catch {
          /* ignore */
        }
        break;
      }
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
    }
  } catch (err) {
    // SDK throws on maxTurns or other errors; treat as graceful termination so Judge can still run
    const msg = err instanceof Error ? err.message : String(err);
    if (/maximum number of turns/i.test(msg)) {
      termination = 'max_turns';
      await emit('budget_abort', 'system', { reason: 'max_turns', error: msg });
    } else {
      termination = 'give_up';
      await emit('give_up', 'explorer', { reason: `sdk error: ${msg.slice(0, 200)}` });
    }
  }

  // Emit a final goal_status: untested for every goal the Explorer never closed.
  if (config.goals) {
    for (const [id, entry] of goalLedger) {
      if (entry.status === 'pending') {
        await emit('goal_status', 'system', {
          id,
          status: 'untested',
          rationale: 'never reached within budget',
        });
        entry.status = 'untested';
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
