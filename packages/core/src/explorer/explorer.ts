import type { TargetAdapter } from '@iris/adapter-types';
import { ulid } from 'ulid';
import type { LlmCallInput, LlmClient } from '../llm/client.js';
import type { TraceEvent } from '../trace/schema.js';
import type { TraceWriter } from '../trace/writer.js';
import type { Mode, TargetKind } from '../types.js';
import { LoopDetector } from './loop-detection.js';
import * as meta from './meta-tools.js';
import { type ExplorerState, type MetaToolResult, newExplorerState } from './meta-tools.js';
import type {
  GiveUpArgs,
  MarkSurfaceSeenArgs,
  NoteFindingArgs,
  NoteHypothesisArgs,
  NoteSurfaceUnexploredArgs,
  PushSubgoalArgs,
  RevisitArgs,
  StepDoneArgs,
  TryWeirdnessArgs,
} from './meta-tools.js';
import type { PersonaName } from './personas/index.js';
import { EXPLORER_CORE, buildSystemPrompt, buildUserPrompt } from './prompts.js';
import { shouldReflect } from './reflection.js';
import { SiteMap } from './site-map.js';

export interface ExplorerConfig {
  mode: Mode;
  target_kind: TargetKind;
  persona?: PersonaName;
  model: string;
  max_steps: number;
  max_cost_usd: number;
  timeout_s: number;
  spec_summary?: string;
  initial_plan_stack?: string[];
}

export interface ExplorerResult {
  state: ExplorerState;
  termination:
    | 'done'
    | 'give_up'
    | 'budget_steps'
    | 'budget_cost'
    | 'budget_time'
    | 'loop_detected';
  steps_taken: number;
  cost_usd: number;
  duration_s: number;
}

interface ExplorerDeps {
  adapter: TargetAdapter;
  llmClient: LlmClient;
  traceWriter: TraceWriter;
  config: ExplorerConfig;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock | { type: string; [k: string]: unknown };

const META_TOOL_NAMES = new Set([
  'note_finding',
  'note_hypothesis',
  'mark_surface_seen',
  'note_surface_unexplored',
  'revisit',
  'try_weirdness',
  'step_done',
  'push_subgoal',
  'give_up',
  'done',
]);

const META_TOOL_SPECS = [
  {
    name: 'note_finding',
    description:
      'Flag something noteworthy — a bug, a11y issue, ux issue, etc. The judge will dedupe and assign final severity. Cite at least one observation event id as evidence.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string', enum: ['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion'] },
        severity_hint: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
        evidence_event_ids: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
        where: {
          type: 'object',
          properties: { url: { type: 'string' }, selector: { type: 'string' } },
        },
      },
      required: ['title', 'category', 'severity_hint', 'evidence_event_ids', 'rationale'],
    },
  },
  {
    name: 'mark_surface_seen',
    description: 'Record a surface (page/section) you have explored.',
    input_schema: {
      type: 'object',
      properties: { surface_id: { type: 'string' }, summary: { type: 'string' } },
      required: ['surface_id', 'summary'],
    },
  },
  {
    name: 'note_surface_unexplored',
    description: 'Record a surface you noticed but have not yet explored.',
    input_schema: {
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
    name: 'step_done',
    description: 'Mark a planned goal as complete.',
    input_schema: {
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
    description: 'Stop early because you are stuck or the target is unreachable.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
  {
    name: 'done',
    description: 'Stop normally — all planned goals satisfied or thorough exploration complete.',
    input_schema: { type: 'object', properties: {} },
  },
];

export class Explorer {
  private state: ExplorerState;
  private siteMap = new SiteMap();
  private loopDetector = new LoopDetector();
  private step = 0;
  private lastReflectionStep: number | null = null;
  private recentActions: string[] = [];
  private specGoalsSatisfied = false;
  private startTime = 0;
  private termination: ExplorerResult['termination'] = 'budget_steps';

  constructor(private readonly deps: ExplorerDeps) {
    this.state = newExplorerState();
    if (deps.config.initial_plan_stack) {
      this.state.plan_stack.push(...deps.config.initial_plan_stack);
    }
  }

  async run(): Promise<ExplorerResult> {
    this.startTime = Date.now();

    await this.emit('run_start', 'system', {
      mode: this.deps.config.mode,
      max_steps: this.deps.config.max_steps,
      initial_plan_stack: [...this.state.plan_stack],
    });

    const systemPrompt = buildSystemPrompt({
      core: EXPLORER_CORE,
      target_kind: this.deps.config.target_kind,
      mode: this.deps.config.mode,
      persona: this.deps.config.persona ?? 'default',
    });

    while (this.step < this.deps.config.max_steps) {
      // Budget checks
      if (this.deps.llmClient.totals().cost_usd >= this.deps.config.max_cost_usd) {
        this.termination = 'budget_cost';
        break;
      }
      const elapsedS = (Date.now() - this.startTime) / 1000;
      if (elapsedS >= this.deps.config.timeout_s) {
        this.termination = 'budget_time';
        break;
      }

      // Observe
      const observation = await this.deps.adapter.observe();
      const obsEventId = await this.emit('observation', 'adapter', {
        ref: observation.observation_ref,
        summary: observation.summary.slice(0, 4000),
      });

      // Loop detection on observation_ref (proxy for dom_digest in P3)
      const loopState = this.loopDetector.record(observation.observation_ref);
      if (loopState === 'force_give_up') {
        this.termination = 'loop_detected';
        await meta.give_up(
          this.deps.traceWriter,
          this.state,
          { reason: 'loop_detected' },
          ulid,
          this.step,
          this.deps.config.target_kind,
        );
        break;
      }

      // Reflection
      if (
        shouldReflect({
          step: this.step,
          mode: this.deps.config.mode,
          last_reflection_step: this.lastReflectionStep,
          spec_goals_satisfied: this.specGoalsSatisfied,
        })
      ) {
        this.lastReflectionStep = this.step;
      }

      // Build per-turn user message
      const sizes = this.siteMap.size();
      const totalSurfaces = sizes.seen + sizes.unexplored;
      const userPrompt = buildUserPrompt({
        observation_summary: observation.summary,
        plan_stack: this.state.plan_stack,
        site_map: {
          seen: sizes.seen,
          unexplored: sizes.unexplored,
          coverage: totalSurfaces === 0 ? 0 : sizes.seen / totalSurfaces,
        },
        recent_actions: this.recentActions.slice(-5),
        budget: {
          steps: this.deps.config.max_steps - this.step,
          usd: this.deps.config.max_cost_usd - this.deps.llmClient.totals().cost_usd,
          seconds: this.deps.config.timeout_s - elapsedS,
        },
      });

      // Call LLM with tool definitions
      const tools = [...this.deps.adapter.listTools(), ...META_TOOL_SPECS];
      const llmInput: LlmCallInput = {
        model: this.deps.config.model,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content:
              loopState === 'warning'
                ? `${userPrompt}\n\nNote: you appear stuck on this state. Try a different action or call give_up.`
                : userPrompt,
          },
        ],
        tools: tools as Array<Record<string, unknown>>,
        max_tokens: 4000,
        temperature: 0,
      };

      const response = await this.deps.llmClient.call(llmInput);

      // Emit step_plan with reasoning
      const reasoning = response.text || '(no text)';
      await this.emit('step_plan', 'explorer', { reasoning: reasoning.slice(0, 1000) });

      // Find tool_use blocks
      const blocks = response.raw.content as ContentBlock[];
      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      if (toolUses.length === 0) {
        // No tool — explorer didn't act. Treat as give_up.
        this.termination = 'give_up';
        await meta.give_up(
          this.deps.traceWriter,
          this.state,
          { reason: 'no tool use in response' },
          ulid,
          this.step,
          this.deps.config.target_kind,
        );
        break;
      }

      // Execute each tool_use
      let stopAfterTools = false;
      for (const tu of toolUses) {
        await this.dispatchTool(tu, obsEventId);
        if (this.state.done) {
          this.termination = 'done';
          stopAfterTools = true;
          break;
        }
        if (this.state.give_up_reason !== null) {
          this.termination = 'give_up';
          stopAfterTools = true;
          break;
        }
      }

      if (stopAfterTools) break;
      this.step++;
    }

    if (this.termination === 'budget_steps') {
      await this.emit('budget_abort', 'system', { reason: 'max_steps' });
    } else if (this.termination === 'budget_cost') {
      await this.emit('budget_abort', 'system', { reason: 'max_cost_usd' });
    } else if (this.termination === 'budget_time') {
      await this.emit('budget_abort', 'system', { reason: 'timeout_s' });
    }

    const duration_s = (Date.now() - this.startTime) / 1000;
    await this.emit('run_end', 'system', {
      termination: this.termination,
      steps: this.step,
      cost_usd: this.deps.llmClient.totals().cost_usd,
      duration_s,
    });

    return {
      state: this.state,
      termination: this.termination,
      steps_taken: this.step,
      cost_usd: this.deps.llmClient.totals().cost_usd,
      duration_s,
    };
  }

  private async dispatchTool(tu: ToolUseBlock, _obsEventId: string): Promise<void> {
    const name = tu.name;
    const args = tu.input;

    if (META_TOOL_NAMES.has(name)) {
      // Meta-tool dispatch
      const result = await this.callMetaTool(name, args);
      this.recentActions.push(
        `${name}(${JSON.stringify(args).slice(0, 80)}) → ${result.ok ? 'ok' : 'err'}`,
      );
      return;
    }

    // Adapter tool dispatch
    const callId = ulid();
    await this.emit(
      'action',
      'explorer',
      {
        tool: name,
        args,
        tool_use_id: tu.id,
      },
      callId,
    );

    const result = await this.deps.adapter.callTool(name, args);
    await this.emit('action_result', 'adapter', {
      tool: name,
      ok: result.ok,
      ...(result.ok ? { evidence_refs: result.evidence_refs } : { error: result.error }),
    });
    this.recentActions.push(
      `${name}(${JSON.stringify(args).slice(0, 80)}) → ${result.ok ? 'ok' : 'err'}`,
    );
  }

  private async callMetaTool(name: string, args: Record<string, unknown>): Promise<MetaToolResult> {
    const w = this.deps.traceWriter;
    const s = this.state;
    const step = this.step;
    const tk = this.deps.config.target_kind;
    const u = args as unknown;
    switch (name) {
      case 'note_finding':
        return meta.note_finding(w, s, u as NoteFindingArgs, ulid, step, tk);
      case 'note_hypothesis':
        return meta.note_hypothesis(w, s, u as NoteHypothesisArgs, ulid, step, tk);
      case 'mark_surface_seen': {
        const r = await meta.mark_surface_seen(w, s, u as MarkSurfaceSeenArgs, ulid, step, tk);
        if (r.ok) {
          const a = u as MarkSurfaceSeenArgs;
          this.siteMap.markSeen(a.surface_id, a.summary);
        }
        return r;
      }
      case 'note_surface_unexplored': {
        const r = await meta.note_surface_unexplored(
          w,
          s,
          u as NoteSurfaceUnexploredArgs,
          ulid,
          step,
          tk,
        );
        if (r.ok) {
          const a = u as NoteSurfaceUnexploredArgs;
          this.siteMap.noteUnexplored(a.surface_id, a.where_seen, a.reason_skipped);
        }
        return r;
      }
      case 'revisit':
        return meta.revisit(w, s, u as RevisitArgs, ulid, step, tk);
      case 'try_weirdness':
        return meta.try_weirdness(w, s, u as TryWeirdnessArgs, ulid, step, tk);
      case 'step_done':
        return meta.step_done(w, s, u as StepDoneArgs, ulid, step, tk);
      case 'push_subgoal':
        return meta.push_subgoal(w, s, u as PushSubgoalArgs, ulid, step, tk);
      case 'give_up':
        return meta.give_up(w, s, u as GiveUpArgs, ulid, step, tk);
      case 'done':
        return meta.done(w, s, u as Record<string, never>, ulid, step, tk);
      default:
        return { ok: false, error: `unknown meta-tool: ${name}` };
    }
  }

  private async emit(
    kind: TraceEvent['kind'],
    actor: TraceEvent['actor'],
    payload: Record<string, unknown>,
    overrideId?: string,
  ): Promise<string> {
    const id = overrideId ?? ulid();
    await this.deps.traceWriter.append({
      v: 1,
      id,
      ts: Date.now() / 1000,
      step: this.step,
      target_kind: this.deps.config.target_kind,
      kind,
      actor,
      payload,
    });
    return id;
  }
}
