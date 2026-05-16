import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import {
  type Mode,
  discovery as discoveryMod,
  explorer as explorerMod,
  trace as iristrace,
  judge as judgeMod,
  preflight as preflightMod,
  report as reportMod,
  specInterpreter,
} from '@iris/core';
import type { RubricProfile } from '@iris/rubrics';
import { ulid } from 'ulid';
import { CodexAppServerClient } from './codex-app-server-client.js';
import {
  CODEX_APP_SERVER_REASONING_EFFORT,
  type CodexReasoningEffort,
  type CodexTokenUsage,
  type CodexTokenUsageSnapshot,
  codexModelName,
  runCodexAppServerExplorer,
  runCodexAppServerSingleShot,
} from './codex-app-server-runner.js';
import { runMissingPostExplorerProbes } from './post-explorer-probes.js';
import {
  buildScenarioCompletionGates,
  formatScenarioGatePrompt,
  type ScenarioCompletionGate,
} from './scenario-completion-gate.js';

export interface CodexAppServerRunConfig {
  target: { kind: 'web'; url: string };
  mode: Mode;
  out_dir: string;
  spec_text?: string;
  spec_path?: string;
  initial_tasks?: Array<{ description: string; priority?: string }>;
  rubric_profiles: RubricProfile[];
  max_steps: number;
  timeout_s: number;
  threshold?: number;
  explorer_model: string;
  judge_model: string;
  reasoning_effort?: CodexReasoningEffort;
  no_html: boolean;
  no_clips?: boolean;
  persona?: string;
  steps_per_goal?: number;
  free_exploration_steps?: number;
  no_preflight?: boolean;
  preflight_timeout_s?: number;
  discover?: boolean;
  expand_goals?: boolean;
  max_expansion_goals?: number;
  scenario_gate?: boolean;
}

export interface CodexAppServerRunResult {
  report: ReturnType<typeof reportMod.buildReportJson>;
  out_dir: string;
  duration_s: number;
  cost_usd: number;
  termination: string;
  exit_code: 0 | 1 | 2 | 3 | 4;
}

function codexPhaseTimeoutS(totalTimeoutS: number): number {
  return Math.max(180, Math.min(totalTimeoutS, Math.ceil(totalTimeoutS * 0.5)));
}

function extractJsonObjectCandidate(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJudgeOutput(text: string): judgeMod.JudgeOutput {
  const candidates = judgeJsonCandidates(text);
  if (candidates.length === 0) {
    throw new Error(`Judge returned no JSON object:\n${text.slice(0, 500)}`);
  }
  let lastErr: unknown;
  for (const candidateText of candidates) {
    try {
      return judgeMod.JudgeOutputSchema.parse(normalizeJudgeJsonShape(JSON.parse(candidateText)));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function judgeJsonCandidates(text: string): string[] {
  const balanced = extractJsonObjectCandidate(text);
  const bases = balanced
    ? repairedPrematureCloseCandidates(text, balanced)
    : repairedUnbalancedJsonCandidates(text);
  const out: string[] = [];
  for (const base of bases) {
    out.push(...withTrailingBraceRepairs(base));
  }
  return [...new Set(out)];
}

function repairedUnbalancedJsonCandidates(text: string): string[] {
  const start = text.indexOf('{');
  if (start < 0) return [];
  const body = text.slice(start).trim();
  const repaired = repairKnownTopLevelSectionDepth(body);
  return repaired === body ? [body] : [repaired, body];
}

function repairKnownTopLevelSectionDepth(body: string): string {
  let next = body;
  for (const marker of [
    ',"spec_compliance"',
    ',"coverage_review"',
    ',"meta"',
    ',"access_blocks"',
  ]) {
    const idx = next.indexOf(marker);
    if (idx < 0) continue;
    const depth = jsonStructuralDepthAt(next, idx);
    if (depth > 1) {
      next = `${next.slice(0, idx)}${'}'.repeat(depth - 1)}${next.slice(idx)}`;
    }
  }
  return next;
}

function jsonStructuralDepthAt(text: string, endExclusive: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < endExclusive; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

function withTrailingBraceRepairs(base: string): string[] {
  const out = [base];
  for (let missing = 1; missing <= 8; missing++) {
    out.push(`${base}${'}'.repeat(missing)}`);
  }
  return out;
}

function normalizeJudgeJsonShape(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const root = value as { scores?: { profiles?: Record<string, unknown> } };
  const profiles = root.scores?.profiles;
  if (!profiles || typeof profiles !== 'object') return value;
  for (const profile of Object.values(profiles)) {
    if (!profile || typeof profile !== 'object') continue;
    liftNestedScoreProfiles(profiles, profile as Record<string, unknown>);
  }
  return value;
}

function liftNestedScoreProfiles(
  profiles: Record<string, unknown>,
  parent: Record<string, unknown>,
): void {
  for (const [key, nested] of Object.entries(parent)) {
    if (key === 'score' || key === 'dimensions') continue;
    if (!nested || typeof nested !== 'object') continue;
    const candidate = nested as Record<string, unknown>;
    if (typeof candidate.score === 'number' && candidate.dimensions && !profiles[key]) {
      profiles[key] = candidate;
      delete parent[key];
      liftNestedScoreProfiles(profiles, candidate);
      continue;
    }
    liftNestedScoreProfiles(profiles, candidate);
  }
}

function repairedPrematureCloseCandidates(text: string, firstCandidate: string): string[] {
  const out = [firstCandidate];
  const start = text.indexOf(firstCandidate);
  if (start < 0) return out;
  const end = start + firstCandidate.length;
  const tail = text.slice(end);
  if (!/^\s*,\s*"(spec_compliance|coverage_review|meta)"/.test(tail)) return out;
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace <= end) return out;
  out.unshift(`${firstCandidate.slice(0, -1)}${text.slice(end, lastBrace + 1)}`);
  return out;
}

const CODEX_APP_SERVER_JUDGE_SYSTEM = `You are Iris's Judge. Return ONLY one complete JSON object. Keep output compact but complete. Use the latest goal_status for each goal. At most 3 findings. All strings short.
Scores are mandatory: scores.profiles MUST contain every profile listed under RUBRIC PROFILES TO SCORE, and each profile.dimensions MUST contain every listed dimension id. Do not omit frontend, usability, accessibility, coverage, or UX baseline profiles to save tokens. Use score:null only for a dimension that is genuinely untestable from this run; still include that dimension with a short rationale.
Raw axe impact is not product severity: machine-only axe/a11y issues should usually be minor findings or rubric-score evidence, not major/blocker findings, unless trace evidence shows a core flow blocked, explicit accessibility/compliance focus, or broad user impact.
If discovery includes product_use_contract, grade real-use depth against it: high coverage/completeness requires the primary value loop and expected artifact/state evidence, not only menus/toolbars/focus/mode selection. When user_jobs include scenario_brief, test_data, required_outputs, or quality_bar, a verified goal must show those concrete user-visible details in cited evidence; generic filler, empty artifacts, or opened panels are partial at best.
Required exact shape:
{"v":1,"findings":[{"id":"F-001","title":"...","category":"bug|a11y|ux|perf|copy|suggestion","severity":"blocker|major|minor|nit|suggestion","evidence":["EVENT"],"rationale":"..."}],"discarded_findings":[],"scores":{"overall":{"score":0,"weighted_from":["quality"]},"profiles":{"quality":{"score":0,"dimensions":{"correctness":{"score":0,"rationale":"...","evidence":["EVENT"]},"completeness":{"score":0,"rationale":"...","evidence":["EVENT"]},"polish":{"score":0,"rationale":"...","evidence":["EVENT"]}}}}},"spec_compliance":{"applicable":true,"goals":[{"id":"G1","description":"...","status":"verified|partial|blocked|skipped|untested","evidence":["EVENT"],"notes":"..."}],"summary":"..."},"coverage_review":{"surfaces_explored":0,"surfaces_unexplored":0,"judgement":"..."},"meta":{"confidence_overall":0.8,"confidence_caveats":[],"would_re_explore_with":[]},"access_blocks":[]}
If rubric profile names or dimensions differ, replace quality/correctness/completeness/polish with the actual RUBRIC PROFILES ids. scores.overall.weighted_from must list every scored profile id. Use [] for empty arrays. Use null for untested dimension scores. Do not use v:2. Do not add extra top-level keys.`;

function buildCodexAppServerJudgePrompt(basePrompt: string): string {
  return `${basePrompt}

Return the exact required shape from the system message. Do not use v:2. Do not use category names outside the allowed enum. Do not add goal_status or caveats as top-level keys. Include every rubric profile and dimension from RUBRIC PROFILES TO SCORE; terse rationales are fine, omissions are not. Keep all strings to one short sentence so the JSON completes. Every verified goal note must be at least 20 characters and name the visible outcome in its cited evidence. For goal evidence, prefer the observation/action ids inside the matching goal_status evidence_event_ids over the goal_status id itself.`;
}

function parseInterpretedSpec(text: string): specInterpreter.InterpretedSpec | null {
  const candidate = extractJsonObjectCandidate(text);
  if (!candidate) return null;
  return specInterpreter.InterpretedSpecSchema.parse(JSON.parse(candidate));
}

function addTokenUsage(a: CodexTokenUsage | undefined, b: CodexTokenUsage): CodexTokenUsage {
  return {
    input_tokens: (a?.input_tokens ?? 0) + b.input_tokens,
    cached_input_tokens: (a?.cached_input_tokens ?? 0) + b.cached_input_tokens,
    non_cached_input_tokens: (a?.non_cached_input_tokens ?? 0) + b.non_cached_input_tokens,
    output_tokens: (a?.output_tokens ?? 0) + b.output_tokens,
    ...(a?.total_tokens !== undefined || b.total_tokens !== undefined
      ? { total_tokens: (a?.total_tokens ?? 0) + (b.total_tokens ?? 0) }
      : {}),
    ...(a?.reasoning_output_tokens !== undefined || b.reasoning_output_tokens !== undefined
      ? {
          reasoning_output_tokens:
            (a?.reasoning_output_tokens ?? 0) + (b.reasoning_output_tokens ?? 0),
        }
      : {}),
  };
}

function summarizeTokenUsage(phases: Record<string, CodexTokenUsageSnapshot>):
  | {
      total?: CodexTokenUsage;
      last?: CodexTokenUsage;
      phases: Record<string, CodexTokenUsageSnapshot>;
    }
  | undefined {
  const entries = Object.entries(phases).filter(([, usage]) => usage.total || usage.last);
  if (entries.length === 0) return undefined;
  let total: CodexTokenUsage | undefined;
  let last: CodexTokenUsage | undefined;
  for (const [, usage] of entries) {
    if (usage.total) total = addTokenUsage(total, usage.total);
    if (usage.last) last = addTokenUsage(last, usage.last);
  }
  return {
    ...(total ? { total } : {}),
    ...(last ? { last } : {}),
    phases: Object.fromEntries(entries),
  };
}

function buildJudgeFailureOutput(input: {
  reason: string;
  goals: Array<{ description: string }>;
  rubricProfiles: RubricProfile[];
  events: iristrace.TraceEvent[];
}): judgeMod.JudgeOutput {
  const allowedStatuses = new Set(['verified', 'partial', 'blocked', 'skipped', 'untested']);
  const latestGoalStatus = new Map<
    string,
    {
      status: 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested';
      rationale: string;
      evidence: string[];
    }
  >();
  for (const event of input.events) {
    if (event.kind !== 'goal_status') continue;
    const payload = event.payload as {
      id?: unknown;
      status?: unknown;
      rationale?: unknown;
      evidence_event_ids?: unknown;
    };
    const id = String(payload.id ?? '');
    if (!id) continue;
    const rawStatus = String(payload.status ?? 'untested');
    latestGoalStatus.set(id, {
      status: allowedStatuses.has(rawStatus)
        ? (rawStatus as 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested')
        : 'untested',
      rationale: String(payload.rationale ?? input.reason),
      evidence: Array.isArray(payload.evidence_event_ids)
        ? payload.evidence_event_ids.map(String)
        : [],
    });
  }

  const goalRows =
    input.goals.length > 0
      ? input.goals.map((goal, i) => {
          const id = `G${i + 1}`;
          const status = latestGoalStatus.get(id);
          return {
            id,
            description: goal.description,
            status: status?.status ?? 'untested',
            evidence: status?.evidence ?? [],
            notes: status?.rationale ?? input.reason,
          };
        })
      : Array.from(latestGoalStatus, ([id, status]) => ({
          id,
          description: id,
          status: status.status,
          evidence: status.evidence,
          notes: status.rationale,
        }));
  const fallbackScore = fallbackScoreFromGoalRows(goalRows);
  const profileNames = input.rubricProfiles.map((profile) => profile.name);
  const fallbackRationale =
    fallbackScore > 0
      ? `Fallback score from goal_status after Judge JSON failure: ${input.reason}`
      : `Judge did not complete: ${input.reason}`;

  return {
    v: 1,
    findings: [],
    discarded_findings: [],
    scores: {
      overall: { score: fallbackScore, weighted_from: fallbackScore > 0 ? profileNames : [] },
      profiles: Object.fromEntries(
        input.rubricProfiles.map((profile) => [
          profile.name,
          {
            score: fallbackScore,
            dimensions: Object.fromEntries(
              profile.dimensions.map((dimension) => [
                dimension.id,
                {
                  score: fallbackScore > 0 ? fallbackScore : null,
                  rationale: fallbackRationale,
                  evidence: goalRows.flatMap((goal) => goal.evidence).slice(0, 6),
                },
              ]),
            ),
          },
        ]),
      ),
    },
    spec_compliance: {
      applicable: goalRows.length > 0,
      goals: goalRows,
      summary:
        fallbackScore > 0
          ? `Judge scoring fell back to latest goal_status events: ${goalRows.filter((goal) => goal.status === 'verified').length}/${goalRows.length} verified.`
          : `Judge did not complete: ${input.reason}`,
    },
    coverage_review: {
      surfaces_explored: input.events.filter((event) => event.kind === 'surface_seen').length,
      surfaces_unexplored: input.events.filter((event) => event.kind === 'surface_unexplored')
        .length,
      judgement:
        fallbackScore > 0
          ? 'Coverage judgement is provisional because Judge JSON parsing failed.'
          : `Judge did not complete: ${input.reason}`,
    },
    meta: {
      confidence_overall: fallbackScore > 0 ? 0.55 : 0,
      confidence_caveats: [input.reason],
      would_re_explore_with: ['Rerun Judge with a lower-overhead Codex App Server configuration.'],
    },
  };
}

function fallbackScoreFromGoalRows(
  goalRows: Array<{ status: 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested' }>,
): number {
  const attempted = goalRows.filter((goal) =>
    ['verified', 'partial', 'blocked'].includes(goal.status),
  );
  if (attempted.length === 0) return 0;
  const verified = attempted.filter((goal) => goal.status === 'verified').length;
  const partial = attempted.filter((goal) => goal.status === 'partial').length;
  const blocked = attempted.filter((goal) => goal.status === 'blocked').length;
  const raw = 4 + (verified / attempted.length) * 4 + (partial / attempted.length) * 1.5;
  const penalty = blocked > 0 ? Math.min(2, (blocked / attempted.length) * 3) : 0;
  return Math.max(0, Math.min(8, Math.round((raw - penalty) * 10) / 10));
}

export async function runIrisViaCodexAppServer(
  config: CodexAppServerRunConfig,
  adapter: TargetAdapter,
): Promise<CodexAppServerRunResult> {
  const appServerCwd = mkdtempSync(join(tmpdir(), 'iris-codex-appserver-cwd-'));
  const client = new CodexAppServerClient();
  await client.start();
  await client.initialize();
  const reasoningEffort = config.reasoning_effort ?? CODEX_APP_SERVER_REASONING_EFFORT;
  const phaseTimeoutS = codexPhaseTimeoutS(config.timeout_s);
  const adapterWithOpts = adapter as unknown as {
    opts?: {
      vision_describer?: (input: {
        imagePath: string;
        prompt: string;
        model?: string;
      }) => Promise<{ text: string }>;
    };
  };
  adapterWithOpts.opts ??= {};
  adapterWithOpts.opts.vision_describer = async (input) => {
    const r = await runCodexAppServerSingleShot(client, {
      systemPrompt: '',
      userPrompt: input.prompt,
      imagePath: input.imagePath,
      ...(input.model ? { model: input.model } : {}),
      reasoningEffort,
      timeoutS: phaseTimeoutS,
      cwd: appServerCwd,
    });
    return { text: r.text };
  };

  const startedAt = new Date();
  const startMs = Date.now();
  mkdirSync(config.out_dir, { recursive: true });

  try {
    writeFileSync(
      join(config.out_dir, 'config.json'),
      `${JSON.stringify({ ...config, transport: 'codex-appserver', app_server_cwd: appServerCwd, _written_at: startedAt.toISOString() }, null, 2)}\n`,
    );

    let specText: string | undefined;
    if (config.spec_text !== undefined) {
      specText = config.spec_text;
      writeFileSync(join(config.out_dir, 'spec.input.txt'), specText);
    } else if (config.spec_path && existsSync(config.spec_path)) {
      specText = readFileSync(config.spec_path, 'utf8');
      copyFileSync(config.spec_path, join(config.out_dir, 'spec.input.txt'));
    }

    let interpreted: specInterpreter.InterpretedSpec | undefined;
    let totalCost = 0;
    let discoveryExplorerContext = '';
    let scenarioGates: ScenarioCompletionGate[] = [];
    const phaseTokenUsage: Record<string, CodexTokenUsageSnapshot> = {};
    if (config.mode === 'grounded' && specText) {
      process.stderr.write('iris: running spec interpreter via Codex App Server...\n');
      const r = await runCodexAppServerSingleShot(client, {
        systemPrompt: specInterpreter.SPEC_INTERPRETER_SYSTEM,
        userPrompt: specInterpreter.SPEC_INTERPRETER_USER_TEMPLATE(specText),
        model: config.explorer_model,
        reasoningEffort,
        timeoutS: phaseTimeoutS,
        cwd: appServerCwd,
      });
      totalCost += r.cost_usd;
      phaseTokenUsage.spec_interpreter = r.token_usage;
      interpreted = parseInterpretedSpec(r.text) ?? undefined;
      if (interpreted) {
        writeFileSync(
          join(config.out_dir, 'spec.interpreted.json'),
          `${JSON.stringify(interpreted, null, 2)}\n`,
        );
      }
    }

    if (!interpreted && config.initial_tasks && config.initial_tasks.length > 0) {
      interpreted = {
        v: 1,
        target_kind_hint: 'web',
        goals: config.initial_tasks.map((task, i) => ({
          id: `G${i + 1}`,
          description: task.description,
          priority: task.priority === 'should' ? 'should' : 'must',
        })),
        focus_areas: [],
        hints: [],
        out_of_scope: [],
      };
      process.stderr.write(`iris: targeted run - ${interpreted.goals.length} initial tasks\n`);
    }

    await adapter.start({ kind: 'web', target: config.target.url, out_dir: config.out_dir });
    const tracePath = join(config.out_dir, 'trace.jsonl');
    const traceWriter = new iristrace.TraceWriter(tracePath);

    if (!config.no_preflight && adapter.preflightProbe) {
      process.stderr.write('iris: running preflight...\n');
      const preflight = await preflightMod.runPreflight(adapter, {
        timeoutS: config.preflight_timeout_s ?? 15,
      });
      await traceWriter.append({
        v: 1,
        id: ulid(),
        ts: Date.now() / 1000,
        step: 0,
        target_kind: 'web',
        kind: 'preflight',
        actor: 'system',
        payload: {
          ok: preflight.ok,
          checks: preflight.checks,
          ...(preflight.screenshot ? { screenshot: preflight.screenshot } : {}),
        },
      });
      if (!preflight.ok) {
        await traceWriter.close();
        const artifacts = await adapter.stop();
        const failedReasons = preflight.checks.filter((c) => !c.ok).map((c) => c.name);
        const blockedReport = reportMod.buildReportJson({
          judge: {
            v: 1,
            findings: [],
            discarded_findings: [],
            scores: { overall: { score: 0, weighted_from: [] }, profiles: {} },
            spec_compliance: { applicable: false, goals: [], summary: 'blocked at preflight' },
            coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: 'blocked' },
            meta: {
              confidence_overall: 0,
              confidence_caveats: [`Run blocked at preflight: ${failedReasons.join(', ')}`],
              would_re_explore_with: [],
            },
          },
          run: {
            id: startedAt.toISOString().replace(/[:]/g, '-'),
            target: { kind: 'web', url: config.target.url },
            mode: config.mode,
            started_at: startedAt.toISOString(),
            ended_at: new Date().toISOString(),
            duration_s: (Date.now() - startMs) / 1000,
            cost_usd: totalCost,
            transport: 'codex-appserver',
            models: {
              discovery: codexModelName(config.explorer_model),
              explorer: codexModelName(config.explorer_model),
              judge: codexModelName(config.judge_model),
            },
            reasoning_efforts: {
              discovery: reasoningEffort,
              explorer: reasoningEffort,
              judge: reasoningEffort,
            },
            termination: 'blocked',
            step_count: 0,
          },
          preflight,
          blocked: { reasons: failedReasons },
          artifacts: {
            trace: './trace.jsonl',
            ...(artifacts.artifact_files.trace_zip
              ? { trace_zip: artifacts.artifact_files.trace_zip }
              : {}),
          },
        });
        writeFileSync(
          join(config.out_dir, 'report.json'),
          `${JSON.stringify(blockedReport, null, 2)}\n`,
        );
        writeFileSync(join(config.out_dir, 'report.md'), reportMod.buildReportMd(blockedReport));
        if (!config.no_html) {
          writeFileSync(
            join(config.out_dir, 'report.html'),
            reportMod.buildReportHtml(blockedReport, { runDir: config.out_dir }),
          );
        }
        return {
          report: blockedReport,
          out_dir: config.out_dir,
          duration_s: (Date.now() - startMs) / 1000,
          cost_usd: totalCost,
          termination: 'blocked',
          exit_code: 4,
        };
      }
      process.stderr.write('iris: preflight passed\n');
    }

    if (adapter.interactionKit) {
      const kit = adapter.interactionKit();
      await traceWriter.append({
        v: 1,
        id: ulid(),
        ts: Date.now() / 1000,
        step: 0,
        target_kind: 'web',
        kind: 'interaction_kit',
        actor: 'system',
        payload: { kind: kit.kind, primitives: kit.primitives },
      });
    }

    const wantDiscovery = config.discover !== false && !interpreted;
    if (wantDiscovery) {
      process.stderr.write('iris: running discovery pass via Codex App Server...\n');
      try {
        const obs = await adapter.observe();
        const ssResult = await adapter.callTool('screenshot', { full_page: false });
        const survey = await adapter
          .discoverySurvey?.({ max_scrolls: 2, peek_menus: true, dismiss_banners: true })
          .catch((err: unknown) => {
            process.stderr.write(
              `iris: discovery survey failed via Codex App Server: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            return undefined;
          });
        const ssPath =
          ssResult.ok && ssResult.evidence_refs && ssResult.evidence_refs.length > 0
            ? ssResult.evidence_refs[0]
            : undefined;
        if (ssPath) {
          let discoveryRawText = '';
          const discoveryResult = await discoveryMod.runDiscovery({
            url: config.target.url,
            observation_summary: obs.summary,
            ...(survey?.summary ? { survey_summary: survey.summary } : {}),
            ...(survey?.payload ? { survey_payload: survey.payload } : {}),
            screenshot_path: ssPath,
            model: config.explorer_model,
            discoverer: async (i) => {
              const r = await runCodexAppServerSingleShot(client, {
                systemPrompt: i.systemPrompt,
                userPrompt: i.userPrompt,
                imagePath: i.imagePath,
                ...(i.model ? { model: i.model } : {}),
                reasoningEffort,
                timeoutS: phaseTimeoutS,
                cwd: appServerCwd,
              });
              phaseTokenUsage.discovery = r.token_usage;
              discoveryRawText = r.text;
              return { text: r.text, cost_usd: r.cost_usd };
            },
          });
          if (discoveryResult) {
            totalCost += discoveryResult.cost_usd;
            const out = discoveryResult.output;
            await traceWriter.append({
              v: 1,
              id: ulid(),
              ts: Date.now() / 1000,
              step: 0,
              target_kind: 'web',
              kind: 'discovery',
              actor: 'system',
              payload: {
                product_description: out.product_description,
                goals: out.goals,
                surfaces: out.surfaces,
                journeys: out.journeys,
                capabilities: out.capabilities,
                ...(out.product_use_contract
                  ? { product_use_contract: out.product_use_contract }
                  : {}),
                ...(out.coverage_plan ? { coverage_plan: out.coverage_plan } : {}),
                focus_areas: out.focus_areas,
                hints: out.hints,
                ...(survey?.summary ? { survey_summary: survey.summary.slice(0, 4000) } : {}),
                ...(survey?.payload ? { survey_payload: survey.payload } : {}),
              },
            });
            if (survey?.payload) {
              writeFileSync(
                join(config.out_dir, 'discovery-survey.json'),
                `${JSON.stringify(survey.payload, null, 2)}\n`,
              );
            }
            writeFileSync(
              join(config.out_dir, 'discovery.json'),
              `${JSON.stringify(out, null, 2)}\n`,
            );
            discoveryExplorerContext = discoveryMod.formatDiscoveryExplorerContext(out);
            scenarioGates = config.scenario_gate ? buildScenarioCompletionGates(out) : [];
            interpreted = {
              v: 1,
              target_kind_hint: 'web',
              goals: out.goals,
              focus_areas: out.focus_areas,
              hints: out.hints,
              out_of_scope: out.out_of_scope,
            };
            if (config.mode === 'free') (config as { mode: Mode }).mode = 'grounded';
            process.stderr.write(`iris: discovery - ${out.goals.length} seed goals proposed\n`);
          } else {
            if (discoveryRawText) {
              writeFileSync(join(config.out_dir, 'discovery.raw.txt'), discoveryRawText);
            }
            process.stderr.write(
              'iris: discovery returned no parseable goals via Codex App Server — falling back\n',
            );
          }
        }
      } catch (err) {
        process.stderr.write(
          `iris: discovery failed via Codex App Server: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    const personaName = (config.persona ?? 'default') as
      | 'default'
      | 'power_user'
      | 'novice'
      | 'adversarial'
      | 'keyboard_only';
    const systemPrompt = explorerMod.buildSystemPrompt({
      core: explorerMod.EXPLORER_CORE,
      target_kind: 'web',
      mode: config.mode,
      persona: personaName,
    });
    const goals = interpreted?.goals ?? [];
    const hasGoals = goals.length > 0;
    const goalList = hasGoals
      ? goals.map((g, i) => `  G${i + 1}. ${g.description}`).join('\n')
      : '';
    const stepsPerGoal = config.steps_per_goal;
    const perGoalLine =
      stepsPerGoal && stepsPerGoal > 0
        ? `Per-goal budget: ~${stepsPerGoal} turns per goal. When a goal is finished, call goal_status with evidence_event_ids for verified goals. Skipped means not applicable to this product/run; never use skipped because time or budget remains.`
        : '';
    const scenarioGatePrompt =
      config.scenario_gate && scenarioGates.length > 0
        ? `${formatScenarioGatePrompt(scenarioGates)}\n\n`
        : '';
    const initialUserPrompt = `Target: ${config.target.url}

${hasGoals ? `What this app is supposed to do:\n${goalList}\n\n${discoveryExplorerContext ? `${discoveryExplorerContext}\n\n` : ''}${scenarioGatePrompt}Use the app and verify each goal as a normal user would. If Discovery names scenario content/data, required outputs, or a quality bar, use that exact content in the product and verify the visible result; do not substitute generic filler. For verified goals, cite post-action observation/screenshot/vision_describe event ids in goal_status. Use skipped only when the goal is not applicable, not when you have not tried it yet.\n\n${perGoalLine}` : 'Your job: USE THIS APP. Open it, find the primary feature, exercise it like a curious new user. Type real text. Click real buttons.'}

PRIORITY ORDER:
  1. Happy paths first.
  2. Then try edge cases relevant to the assigned goals.

Iris will run axe, console_errors_since, network_all_since, and mobile_viewport automatically after your Explorer turn. Do not spend model turns calling those probes unless a goal specifically needs their evidence.
Do not mark a goal partial until you have tried the strongest cheap proof available. For focus, layout, sidebar, collapse, selected-state, text-size, width, or color-mode goals, use the ui_state probe after interaction. If Iris reports that budget remains for partial retries, retry only those partial goals before stopping.
Do not use direct URL navigation after initial load to satisfy product feature goals such as search, auth, donate, or settings. Interact with visible UI like a user. Direct navigation is only acceptable for initial target load, browser back/forward/reload, or explicit URL-handling goals.
If all assigned goals are terminal after goal_status and Iris does not request a retry, stop; do not call extra tools just to say done.

Avoid treating selector misses as product evidence. Use dynamic tools directly. Budget: ${config.timeout_s}s wall-clock.`;

    process.stderr.write('iris: starting Explorer via Codex App Server...\n');
    const explorerResult = await runCodexAppServerExplorer({
      client,
      adapter,
      traceWriter,
      systemPrompt,
      initialUserPrompt,
      maxSteps: config.max_steps,
      timeoutS: config.timeout_s,
      model: config.explorer_model,
      reasoningEffort,
      maxExpansionGoals: config.expand_goals === false ? 0 : (config.max_expansion_goals ?? 6),
      ...(stepsPerGoal && stepsPerGoal > 0 ? { stepsPerGoal } : {}),
      ...(hasGoals
        ? { goals: goals.map((g, i) => ({ id: `G${i + 1}`, description: g.description })) }
        : {}),
      ...(config.scenario_gate ? { scenarioGates } : {}),
      cwd: appServerCwd,
    });
    totalCost += explorerResult.cost_usd;
    phaseTokenUsage.explorer = explorerResult.token_usage;
    process.stderr.write(
      `iris: Explorer done - termination=${explorerResult.termination}, ${explorerResult.steps_taken} steps\n`,
    );

    await runMissingPostExplorerProbes({
      adapter,
      traceWriter,
      tracePath,
      log: (message) => process.stderr.write(message),
    });

    await traceWriter.close();
    const artifacts = await adapter.stop();

    process.stderr.write('iris: running Judge via Codex App Server...\n');
    const events = await iristrace.readTraceArray(tracePath);
    const tentativeCount = events.filter((e) => e.kind === 'tentative_finding').length;
    const digest = judgeMod.buildTraceDigest(events);
    const judgeUserPrompt = judgeMod.buildJudgeUserPrompt({
      trace_digest: digest,
      ...(specText !== undefined ? { spec_text: specText } : {}),
      ...(interpreted ? { spec_goals: interpreted.goals } : {}),
      rubric_profiles: config.rubric_profiles,
      tentative_findings_count: tentativeCount,
    });
    let judgeFailedReason: string | null = null;
    let judgeOutput: judgeMod.JudgeOutput;
    const elapsedBeforeJudge = (Date.now() - startMs) / 1000;
    const judgeTimeoutS = Math.max(45, Math.ceil(config.timeout_s - elapsedBeforeJudge));
    let judgeRecoveredFromGoalStatus = false;
    try {
      const judgeResponse = await runCodexAppServerSingleShot(client, {
        systemPrompt: CODEX_APP_SERVER_JUDGE_SYSTEM,
        userPrompt: buildCodexAppServerJudgePrompt(judgeUserPrompt),
        model: config.judge_model,
        reasoningEffort,
        timeoutS: judgeTimeoutS,
        cwd: appServerCwd,
      });
      totalCost += judgeResponse.cost_usd;
      phaseTokenUsage.judge = judgeResponse.token_usage;
      writeFileSync(
        join(config.out_dir, 'judge.raw.txt'),
        `_written_at: ${new Date().toISOString()}\n\n${judgeResponse.text}`,
      );
      judgeOutput = parseJudgeOutput(judgeResponse.text);
    } catch (err) {
      judgeFailedReason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`iris: Judge failed via Codex App Server: ${judgeFailedReason}\n`);
      judgeOutput = buildJudgeFailureOutput({
        reason: judgeFailedReason,
        goals: interpreted?.goals ?? [],
        rubricProfiles: config.rubric_profiles,
        events,
      });
      judgeRecoveredFromGoalStatus = judgeOutput.spec_compliance.goals.some((goal) =>
        ['verified', 'partial', 'blocked'].includes(goal.status),
      );
    }
    judgeOutput = judgeMod.ensureRubricScoreCoverage(judgeOutput, config.rubric_profiles);

    const validation = judgeMod.validateFindings(judgeOutput.findings, events);
    judgeOutput = {
      ...judgeOutput,
      findings: validation.kept,
      discarded_findings: [...(judgeOutput.discarded_findings ?? []), ...validation.discarded],
      evidence_validation: validation.summary,
    };
    if (adapter.outcomeContract) {
      const goalClaimResult = judgeMod.validateGoalClaims({
        judge: judgeOutput,
        trace: events,
        outcome_contract: adapter.outcomeContract(),
      });
      judgeOutput = judgeMod.applyGoalClaimValidationToJudgeOutput(judgeOutput, goalClaimResult);
    }

    writeFileSync(
      join(config.out_dir, 'findings.json'),
      `${JSON.stringify({ findings: judgeOutput.findings, discarded_findings: judgeOutput.discarded_findings, evidence_validation: validation.summary, _written_at: new Date().toISOString() }, null, 2)}\n`,
    );
    writeFileSync(
      join(config.out_dir, 'scores.json'),
      `${JSON.stringify({ ...judgeOutput.scores, _written_at: new Date().toISOString() }, null, 2)}\n`,
    );

    const clipPaths: Record<string, string> = {};
    if (!config.no_clips) {
      try {
        const evidence = await reportMod.collectClaimEvidenceArtifacts({
          adapter,
          judge: judgeOutput,
          trace: events,
          runDir: config.out_dir,
        });
        Object.assign(clipPaths, evidence.clips);
        if (evidence.files.length > 0) {
          process.stderr.write(`iris: sliced ${evidence.files.length} claim evidence files\n`);
        }
      } catch (err) {
        writeFileSync(
          join(config.out_dir, 'clips-error.txt'),
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const duration_s = (Date.now() - startMs) / 1000;
    const runUsage = summarizeTokenUsage(phaseTokenUsage);
    const report = reportMod.buildReportJson({
      judge: judgeOutput,
      trace_events: events,
      run: {
        id: startedAt.toISOString().replace(/[:]/g, '-'),
        target: { kind: 'web', url: config.target.url },
        mode: config.mode,
        started_at: startedAt.toISOString(),
        ended_at: new Date().toISOString(),
        duration_s,
        cost_usd: totalCost,
        transport: 'codex-appserver',
        models: {
          discovery: codexModelName(config.explorer_model),
          explorer: codexModelName(config.explorer_model),
          judge: codexModelName(config.judge_model),
        },
        reasoning_efforts: {
          discovery: reasoningEffort,
          explorer: reasoningEffort,
          judge: reasoningEffort,
        },
        termination:
          judgeFailedReason && !judgeRecoveredFromGoalStatus
            ? 'judge_failed'
            : explorerResult.termination,
        step_count: explorerResult.steps_taken,
        ...(runUsage ? { usage: runUsage } : {}),
      },
      ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
      ...(judgeFailedReason && !judgeRecoveredFromGoalStatus
        ? { blocked: { reasons: [judgeFailedReason] } }
        : {}),
      artifacts: {
        ...(config.no_html ? {} : { report_html: './report.html' }),
        report_md: './report.md',
        trace: './trace.jsonl',
        ...(artifacts.artifact_files.trace_zip
          ? { trace_zip: artifacts.artifact_files.trace_zip }
          : {}),
        ...(artifacts.artifact_files.full_recording
          ? { video: artifacts.artifact_files.full_recording }
          : {}),
        ...(Object.keys(clipPaths).length > 0 ? { clips: clipPaths } : {}),
      },
    });
    writeFileSync(join(config.out_dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(config.out_dir, 'report.md'), reportMod.buildReportMd(report));
    if (!config.no_html) {
      writeFileSync(
        join(config.out_dir, 'report.html'),
        reportMod.buildReportHtml(report, { runDir: config.out_dir }),
      );
    }

    let exitCode: 0 | 1 | 2 | 3 | 4 = 0;
    if (judgeFailedReason && !judgeRecoveredFromGoalStatus) {
      exitCode = 3;
    } else if (
      explorerResult.termination === 'budget_steps' ||
      explorerResult.termination === 'budget_time'
    ) {
      exitCode = 2;
    } else if (!report.headline.threshold_passed) {
      exitCode = 1;
    }

    return {
      report,
      out_dir: config.out_dir,
      duration_s,
      cost_usd: totalCost,
      termination:
        judgeFailedReason && !judgeRecoveredFromGoalStatus
          ? 'judge_failed'
          : explorerResult.termination,
      exit_code: exitCode,
    };
  } finally {
    await client.close();
    rmSync(appServerCwd, { recursive: true, force: true });
  }
}
