import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { TargetAdapter } from '@iris/adapter-types';
import type { trace as iristrace } from '@iris/core';
import { ulid } from 'ulid';
import { z, type ZodRawShape } from 'zod';

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
      const content = (msg.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      for (const b of content) {
        if (b.type === 'text' && b.text) text += b.text;
      }
    } else if (msg.type === 'result') {
      const r = msg as { total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } };
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

  const emit = async (kind: TraceEventKind, actor: 'system' | 'explorer' | 'adapter' | 'probe', payload: Record<string, unknown>): Promise<string> => {
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
        await emit('action', 'explorer', { tool: spec.name, args });
        const result = await config.adapter.callTool(spec.name, args);
        await emit('action_result', 'adapter', {
          tool: spec.name,
          ok: result.ok,
          ...(result.ok ? { evidence_refs: result.evidence_refs } : { error: result.error }),
        });
        // Some tools modify the page — auto-emit observation after navigation/click/type
        if (['click', 'type', 'navigate', 'press', 'back', 'forward', 'reload'].includes(spec.name)) {
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
        return {
          content: [
            {
              type: 'text' as const,
              text: result.ok
                ? `OK${result.observation_ref ? ` (observation_ref=${result.observation_ref})` : ''}`
                : `ERROR: ${result.error}`,
            },
          ],
        };
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
        await emit('probe_result', 'probe', result.ok
          ? { probe: spec.name, summary: result.summary, data: result.data }
          : { probe: spec.name, error: result.error });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.ok ? { summary: result.summary } : { error: result.error }),
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
      "Take a fresh observation of the current page (DOM outline + screenshot). Use when you need to re-check the page state.",
      {},
      async () => {
        const obs = await config.adapter.observe();
        observationCounter++;
        await emit('observation', 'adapter', {
          ref: obs.observation_ref,
          summary: obs.summary.slice(0, 4000),
        });
        return { content: [{ type: 'text' as const, text: `${obs.summary.slice(0, 1500)}\n\n(observation_ref=${obs.observation_ref})` }] };
      },
    ),
    tool(
      'note_finding',
      "Flag something noteworthy — a bug, a11y issue, ux issue, etc. The judge will dedupe and assign final severity. Cite at least one observation_ref or trace event id as evidence.",
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
        if (!state.surfaces_seen.some((s) => s.id === args.surface_id) &&
            !state.surfaces_unexplored.some((s) => s.id === args.surface_id)) {
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
      { claim: z.string(), confidence: z.number().min(0).max(1), evidence_event_ids: z.array(z.string()) },
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

  const irisToolServer = createSdkMcpServer({
    name: 'iris',
    tools: [...adapterMcpTools, ...probeMcpTools, ...metaTools],
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
        try { q.interrupt?.(); } catch { /* ignore */ }
        break;
      }
      const elapsedS = (Date.now() - start) / 1000;
      if (elapsedS >= config.timeoutS) {
        termination = 'budget_time';
        await emit('budget_abort', 'system', { reason: 'timeout_s', elapsed_s: elapsedS });
        try { q.interrupt?.(); } catch { /* ignore */ }
        break;
      }

      if (msg.type === 'assistant') {
        const content = (msg.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
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

  const duration_s = (Date.now() - start) / 1000;
  await emit('run_end', 'system', { termination, cost_usd: totalCost, duration_s, steps: stepCount });

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
  };
}
