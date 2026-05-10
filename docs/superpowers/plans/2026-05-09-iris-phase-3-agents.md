# Iris — Phase 3: Spec Interpreter + Explorer + Judge + Report Builder

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Wire LLM-driven agents into Iris so `iris eval https://example.com --spec spec.md` produces a real `report.json` with findings and rubric scores. Phase 3 is the marquee phase — after this, Iris does real evaluation work.

**Architecture:** Three new sub-modules in `@iris/core`: `spec-interpreter/` (one Claude call), `explorer/` (the curious-user loop), `judge/` (Opus-driven trace reader). Plus `report/` (deterministic JSON/MD/HTML assembly) and `orchestrator/` (lifecycle wiring). The CLI's three verbs get real implementations.

**Tech Stack:** Reuses Phase 1 LLM wrapper + cassettes for deterministic tests. Anthropic SDK with prompt caching on system messages. zod for parsing structured LLM JSON output.

**Spec reference:** `docs/superpowers/specs/2026-05-09-iris-design.md` §9 (spec interpreter), §10 (Explorer), §11 (Judge), §12 (Report). Persona pool, ffmpeg clips, all rubric profiles tuned, known-bug bench all defer to Phase 4.

**Out of scope:** Persona variants beyond `default` (Phase 4); `--mode targeted` task-list ergonomics beyond minimal (covered structurally but not deeply); ffmpeg clip slicing (Phase 4); `--engine vision` LLM-driven vision (only DOM engine in P3, vision_describe stays stub).

---

## File structure (Phase 3 additions)

```
packages/core/src/
├── spec-interpreter/
│   ├── interpreter.ts         ← LLM call: free-form spec → structured plan
│   ├── interpreter.test.ts    ← cassette-based
│   ├── prompts.ts             ← system prompt + JSON schema for output
│   └── index.ts
├── explorer/
│   ├── explorer.ts            ← class Explorer, owns the loop
│   ├── explorer.test.ts       ← cassette-based, exercises full loop
│   ├── prompts.ts             ← composable [CORE] [TARGET_KIND] [MODE] [PERSONA]
│   ├── meta-tools.ts          ← note_finding, mark_surface_seen, …
│   ├── meta-tools.test.ts
│   ├── site-map.ts            ← SiteMap class
│   ├── site-map.test.ts
│   ├── reflection.ts          ← reflection turn injection
│   ├── reflection.test.ts
│   ├── loop-detection.ts      ← dom_digest sliding window
│   ├── loop-detection.test.ts
│   └── index.ts
├── judge/
│   ├── judge.ts               ← Claude Opus call, finding dedup, scoring
│   ├── judge.test.ts          ← cassette-based; golden trace fixture
│   ├── prompts.ts             ← system + per-rubric prompts
│   ├── dedup.ts               ← group-by-where, group-by-symptom, merge logic
│   ├── dedup.test.ts          ← pure unit, no LLM
│   └── index.ts
├── report/
│   ├── report-json.ts         ← report.json builder (Otto-feedback contract)
│   ├── report-json.test.ts
│   ├── report-md.ts           ← report.md PR-comment builder
│   ├── report-md.test.ts
│   ├── report-html.ts         ← report.html with embedded screenshots
│   ├── report-html.test.ts
│   └── index.ts
└── orchestrator/
    ├── orchestrator.ts        ← Run lifecycle: config → spec → adapter → explorer → judge → report
    ├── orchestrator.test.ts   ← cassette-based end-to-end against fixture
    └── index.ts

packages/rubrics/profiles/
├── web/
│   ├── usability.yaml         ← already exists from P1
│   ├── quality.yaml           ← NEW
│   ├── accessibility.yaml     ← NEW
│   ├── frontend-correctness.yaml ← NEW
│   └── coverage.yaml          ← NEW
└── shared/
    └── correctness.yaml       ← NEW (target-agnostic baseline)

packages/cli/src/commands/
├── eval.ts                    ← REPLACED: real impl using orchestrator
├── judge.ts                   ← REPLACED: real impl (replay-only)
└── report.ts                  ← REPLACED: real impl (re-render)
```

**Per-file responsibilities:**

- `spec-interpreter/interpreter.ts` — `interpretSpec(text, llmClient): Promise<InterpretedSpec>`. One Claude call with structured-JSON output schema. Returns `{goals[], focus_areas[], hints[], target_kind_hint, out_of_scope[]}`.
- `explorer/explorer.ts` — `class Explorer`. Owns: loop state (step counter, plan stack, site map, budget), per-turn prompt assembly, observe→plan→act→record cycle, termination decision. Constructor takes `{adapter, llmClient, traceWriter, evidenceDir, config}`.
- `explorer/meta-tools.ts` — implements the orchestrator-provided tools (note_finding, step_done, give_up, etc.). Each accepts `(state, args)` and returns a `ToolResult`-like value, plus emits a trace event.
- `judge/judge.ts` — `class Judge` with `run(trace, spec, rubrics): Promise<{findings, scores}>`. Single Opus call with the trace digest as input + dedup of explorer-emitted tentative findings.
- `judge/dedup.ts` — pure function `dedupFindings(tentatives): MergedGroup[]` for the symptom-signature grouping. No LLM.
- `report/*` — pure functions producing files from the structured outputs. No LLM.
- `orchestrator/orchestrator.ts` — `class Orchestrator` with `run(config): Promise<RunResult>`. Pulls the pieces together.
- New rubric YAMLs follow the §11.4 shape, each ~30-50 lines.

---

## Conventions (same as Phase 1/2)

- TDD always, frequent commits, exact paths.
- Cassette-based LLM tests: every Claude call recorded once via `IRIS_RERECORD_CASSETTES=1` and replayed in CI.
- Cassettes live in `packages/core/test-fixtures/llm-cassettes/<test-name>/`.
- For tests that need the LLM but no real API key is set, the cassette must already exist; otherwise the test fails with a clear "re-record" hint (this is built into `CassetteTransport` from P1).

---

## Task 1: Spec Interpreter

**Files:**
- Create `packages/core/src/spec-interpreter/{interpreter,prompts,index}.ts` + `interpreter.test.ts`
- Create `packages/core/test-fixtures/llm-cassettes/spec-interpreter/` with at least one recorded cassette

`prompts.ts`:
```ts
export const SPEC_INTERPRETER_SYSTEM = `You convert a free-form product spec into a structured exploration plan for an automated UX evaluator named Iris.

Read the spec the user provides. Extract:
- goals: concrete user-observable outcomes the product should support (must|should priority).
- focus_areas: areas the spec emphasizes that exploration should weight more heavily.
- hints: useful context the explorer should know (terminology, expected user roles, known constraints).
- target_kind_hint: best guess at "web" | "cli" | "api" | "desktop". Default to "web" if unclear.
- out_of_scope: anything the spec explicitly excludes from evaluation.

Be concise. Goals should be testable as pass/partial/fail by an autonomous user.

Reply with ONLY a JSON object matching this schema:
{
  "v": 1,
  "target_kind_hint": "web"|"cli"|"api"|"desktop",
  "goals": [{"id": "G1", "description": string, "priority": "must"|"should"}],
  "focus_areas": [string],
  "hints": [string],
  "out_of_scope": [string]
}`;

export const SPEC_INTERPRETER_USER_TEMPLATE = (spec: string): string =>
  `Here is the spec:\n\n---\n${spec}\n---\n\nReturn only the JSON object.`;
```

`interpreter.ts`:
```ts
import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import { SPEC_INTERPRETER_SYSTEM, SPEC_INTERPRETER_USER_TEMPLATE } from './prompts.js';

export const InterpretedSpecSchema = z.object({
  v: z.literal(1),
  target_kind_hint: z.enum(['web', 'cli', 'api', 'desktop']),
  goals: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    priority: z.enum(['must', 'should']),
  })),
  focus_areas: z.array(z.string()).default([]),
  hints: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
});
export type InterpretedSpec = z.infer<typeof InterpretedSpecSchema>;

export async function interpretSpec(spec: string, client: LlmClient, model = 'claude-sonnet-4-6'): Promise<InterpretedSpec> {
  const r = await client.call({
    model,
    system: SPEC_INTERPRETER_SYSTEM,
    messages: [{ role: 'user', content: SPEC_INTERPRETER_USER_TEMPLATE(spec) }],
    max_tokens: 2000,
    temperature: 0,
  });
  // Extract JSON from response — model may wrap in code fences.
  const jsonMatch = r.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`spec interpreter returned no JSON object:\n${r.text}`);
  const parsed = JSON.parse(jsonMatch[0]);
  return InterpretedSpecSchema.parse(parsed);
}
```

Test pattern (TDD):
1. Write a small test spec (~5 lines of markdown describing a sign-in flow).
2. Run interpreter with `CassetteTransport` in record mode (`IRIS_RERECORD_CASSETTES=1`) once with real API key to create cassette.
3. Test asserts interpreter returns a parsed `InterpretedSpec` with at least one `goal` mentioning "sign in".

Commit: `feat(core/spec-interpreter): free-form spec → structured exploration plan`

---

## Task 2: Explorer prompts (composable slots) + per-turn shape

**Files:**
- Create `packages/core/src/explorer/{prompts,index}.ts`
- Create `packages/core/src/explorer/prompts.test.ts`

`prompts.ts` — exports:
- `EXPLORER_CORE: string` — the curious-user ethos (§10.1) + heuristics cheat-sheet (§10.7) + tool-category guidance + how to use note_finding/step_done/give_up
- `targetKindSuffix(kind: TargetKind): string` — short guidance per target
- `modeSuffix(mode: Mode): string` — free/grounded/targeted
- `personaSuffix(persona: 'default'): string` — only `default` in P3
- `buildSystemPrompt({core, target_kind, mode, persona}): string` — composes the slots
- `buildUserPrompt({observation_summary, plan_stack, site_map, recent_actions, budget}): string` — per-turn user message

The CORE constant is the longest (~600-1000 words covering ethos + heuristics). Use the prose from spec §10.1 + §10.7 verbatim; no need to invent.

Tests: each function returns expected fragments; CORE contains "curious", "explore", "unfamiliar product"; mode suffix for "free" mentions "discover".

Commit: `feat(core/explorer): composable system prompt slots (core/target/mode/persona)`

---

## Task 3: Explorer meta-tools

**Files:**
- Create `packages/core/src/explorer/meta-tools.ts` + `.test.ts`

Implements (each emits a trace event via the supplied writer):
- `note_finding({title, category, severity_hint, evidence_event_ids, rationale}): emits tentative_finding`
- `note_hypothesis({claim, confidence, evidence_event_ids}): emits hypothesis`
- `mark_surface_seen({surface_id, summary})`
- `note_surface_unexplored({surface_id, where_seen, reason_skipped?})`
- `revisit({event_id})` — Phase 3: emits an action event with kind=revisit; orchestrator handles re-navigation
- `try_weirdness({kind, target?})` — Phase 3 stub: emits a trace event noting the request; actual weirdness execution deferred to Phase 4
- `step_done({goal_id, evidence_event_ids})`
- `push_subgoal({description})`
- `give_up({reason})`
- `done()`

Each is a pure function `(traceWriter, state, args) → result`. State is mutated in place (plan stack, site map). Tests verify each emits the right event kind + payload + updates state correctly.

Commit: `feat(core/explorer): meta-tools (note_finding, step_done, give_up, …)`

---

## Task 4: Site map state

**Files:**
- Create `packages/core/src/explorer/site-map.ts` + `.test.ts`

`class SiteMap`:
- `seen: Surface[]`, `unexplored: Surface[]`, `coverage_estimate: number` (computed: `seen.length / (seen.length + unexplored.length || 1)`)
- `markSeen(id, summary)` — moves id from unexplored→seen if present, else adds to seen
- `noteUnexplored(id, where_seen, reason?)` — adds to unexplored if not already seen
- `serialize()` returns the JSON shape from spec §10.6

Pure unit tests, no LLM.

Commit: `feat(core/explorer): SiteMap state for surface coverage tracking`

---

## Task 5: Loop detection (dom_digest sliding window)

**Files:**
- Create `packages/core/src/explorer/loop-detection.ts` + `.test.ts`

`class LoopDetector`:
- `record(digest: string): 'normal' | 'warning' | 'force_give_up'`
- 3 same digests in a row in last 20 → 'warning'
- 5 same in a row → 'force_give_up'

Pure unit tests.

Commit: `feat(core/explorer): loop detection via dom_digest sliding window`

---

## Task 6: Reflection step (every 10 steps in free/grounded modes)

**Files:**
- Create `packages/core/src/explorer/reflection.ts` + `.test.ts`

`shouldReflect(step, mode, last_reflect_step): boolean`. Cadence: every 10 steps. Skip in `targeted` mode. In `grounded`, only after spec goals satisfied.

`buildReflectionPrompt(state): string` — the §10.8 reflection prompt asking what the agent believes, what's unexplored, broad vs deep, weirdness untried.

Pure unit tests.

Commit: `feat(core/explorer): periodic reflection turn injection`

---

## Task 7: Explorer main loop

**Files:**
- Create `packages/core/src/explorer/explorer.ts` + `.test.ts`

`class Explorer` with `run(): Promise<ExplorerResult>`. Loop:
1. Build observation via `adapter.observe()`, write `observation` trace event, store dom_digest.
2. Loop-detection check (force give_up if needed).
3. Reflection check (inject special turn if cadence hit).
4. Build per-turn user message with current state.
5. Call LLM with system prompt + cached prior context + current observation.
6. Parse tool_use blocks from response; for each, dispatch to adapter (`callTool`/`runProbe`) or meta-tools.
7. Write `step_plan` + `action`/`probe_call` + `action_result`/`probe_result` events.
8. Update state, increment step counter.
9. Check budget (`max_steps`, `max_cost_usd`, `timeout_s`); abort if exceeded.
10. Continue until done/give_up/budget abort.

Cassette-based tests use a fixture site + recorded LLM responses to verify the loop produces the right trace shape.

Commit: `feat(core/explorer): main loop with budget tracking + meta-tool dispatch`

---

## Task 8: Judge — dedup pipeline (pure)

**Files:**
- Create `packages/core/src/judge/dedup.ts` + `.test.ts`

`dedupFindings(tentatives: TentativeFinding[]): FindingGroup[]` — group by `(where.url, where.selector, normalized_title)`. Pure unit tests with crafted inputs.

Commit: `feat(core/judge): dedup pipeline for tentative findings`

---

## Task 9: Judge agent (Opus) + scoring

**Files:**
- Create `packages/core/src/judge/{judge,prompts,index}.ts` + `judge.test.ts`

`prompts.ts`:
- `JUDGE_SYSTEM` — describes role: read trace, dedup tentatives, assign final severities, score against rubric profiles. Output strict JSON: `{findings: [...], scores: {...}, spec_compliance: {...}, coverage_review: {...}, meta: {...}}` per spec §11.5/§11.6.
- `buildJudgeUserPrompt({trace_digest, spec, rubric_profiles, tentative_findings})` — assembles the user message.

`judge.ts`:
- `class Judge` with `run({tracePath, spec?, rubrics, model='claude-opus-4-7'}): Promise<{findings, scores}>`.
- Reads trace via `iristrace.readTraceArray`.
- Builds a digest (one-line per event).
- Single Opus call with `temperature: 0`.
- Parses + zod-validates the JSON output (see schemas in §11.5).
- Returns structured findings + scores.

Cassette-based tests use a golden trace fixture (committed) + recorded Opus response; verify findings have evidence ids citing real trace event ids.

Commit: `feat(core/judge): Opus-driven trace reader producing findings + scores`

---

## Task 10: Add 4 missing rubric profiles

**Files:**
- Create `packages/rubrics/profiles/web/{quality,accessibility,frontend-correctness,coverage}.yaml`
- Create `packages/rubrics/profiles/shared/correctness.yaml`

Each follows the §11.4 shape. Phase 3 ships sensible defaults; Phase 4 tunes weights and dimensions based on benchmark feedback. Use the dimension lists from spec §11.4.

Test by adding `loadBundledRubric` calls in `loader.test.ts` for each new file (assert it parses).

Commit: `feat(rubrics): full v1 rubric set (quality/accessibility/frontend/coverage/correctness)`

---

## Task 11: Report builder — report.json (Otto contract)

**Files:**
- Create `packages/core/src/report/{report-json,index}.ts` + `report-json.test.ts`

Pure function `buildReportJson({run, scores, findings, spec_compliance, coverage_review, meta, evidence_index}): ReportJson`. Output shape per spec §12.1, with `next_actions.for_builder` heuristically derived (sort findings by severity, pick top N).

Commit: `feat(core/report): report.json — Otto-feedback contract`

---

## Task 12: Report builder — report.md (PR-comment format)

**Files:**
- Create `packages/core/src/report/report-md.ts` + `report-md.test.ts`

Pure function `buildReportMd(reportJson): string`. Format per spec §12.2. Snapshot tests.

Commit: `feat(core/report): report.md — PR-comment friendly format`

---

## Task 13: Report builder — report.html

**Files:**
- Create `packages/core/src/report/report-html.ts` + `report-html.test.ts`

Pure function `buildReportHtml(reportJson, evidence_dir): string`. Self-contained HTML, Tailwind via CDN, embeds screenshots as relative paths. Format per spec §12.3 (simpler than the spec's full mockup; v1 is functional).

Snapshot tests.

Commit: `feat(core/report): report.html — rich human view with embedded screenshots`

---

## Task 14: Orchestrator

**Files:**
- Create `packages/core/src/orchestrator/{orchestrator,index}.ts` + `orchestrator.test.ts`

`class Orchestrator` wires the full flow:

```ts
async run(config: RunConfig): Promise<RunResult> {
  // 1. Set up out_dir, write config.json + spec.input.txt
  // 2. Spec interpreter (if grounded mode + spec given)
  // 3. Adapter.start
  // 4. Explorer.run → trace.jsonl
  // 5. Adapter.stop → artifacts
  // 6. Load rubric profiles
  // 7. Judge.run → findings + scores
  // 8. Slice evidence per finding
  // 9. Build report.json + .md + .html
  // 10. Return summary
}
```

Cassette-based end-to-end test against the form fixture.

Commit: `feat(core/orchestrator): full eval lifecycle wiring`

---

## Task 15: CLI eval verb (real impl)

**Files:**
- Modify `packages/cli/src/commands/eval.ts` — replace stub with Orchestrator call

Map flags → `RunConfig`, instantiate `WebTargetAdapter`, instantiate `LlmClient` (from env `ANTHROPIC_API_KEY` or use `CassetteTransport` if `IRIS_CASSETTES_DIR` set), instantiate `Orchestrator`, run, write results, print summary, exit with appropriate code.

Test: smoke test using cassettes.

Commit: `feat(cli): real eval verb wiring orchestrator`

---

## Task 16: CLI judge verb (replay)

**Files:**
- Modify `packages/cli/src/commands/judge.ts`

Loads existing trace + optional spec + rubrics, runs Judge alone, writes new report files into `--out`. No browser, no Explorer.

Commit: `feat(cli): real judge verb (replay against stored trace)`

---

## Task 17: CLI report verb (re-render)

**Files:**
- Modify `packages/cli/src/commands/report.ts`

Loads existing run dir, re-runs report builders against existing findings.json/scores.json. Pure rendering, no LLM, no browser.

Commit: `feat(cli): real report verb (re-render artifacts from existing run)`

---

## Task 18: End-to-end test + repo-wide green + Phase 3 docs update

**Files:**
- Create `packages/cli/src/commands/eval.e2e.test.ts` — full pipeline against fixture (cassetted)
- Update `docs/architecture.md` to mark Phase 3 done
- Update `README.md` to reflect that `iris eval` produces a real report

The e2e test should run `iris eval <fixture-url> --spec <fixture-spec>` (using cassetted LLM) and verify:
- `report.json` is produced and matches schema
- `findings.json` has at least one finding
- `scores.json` has all expected rubric profiles scored
- `trace.jsonl` is well-formed
- Exit code is 0

Manual sanity: `pnpm build && node packages/cli/dist/bin.js eval https://example.com --no-html --no-clips --max-steps 5 --max-cost-usd 1` against real Anthropic API (skip if no key set).

Commit: `feat: end-to-end iris eval producing real report (Phase 3 complete)`

---

## Self-review checklist

Spec coverage:
- §9 spec interpreter → T1 ✅
- §10.1 ethos / §10.2 loop / §10.3 prompt slots / §10.4 per-turn shape → T2, T7 ✅
- §10.5 tools (already from Phase 2) — explorer dispatches ✅ T7
- §10.5 meta tools → T3 ✅
- §10.6 site map → T4 ✅
- §10.8 reflection → T6 ✅
- §10.9 loop detection → T5 ✅
- §10.10–§10.13 budgets/termination/cost/invariants → T7 ✅
- §11 Judge with dedup + scoring → T8, T9 ✅
- §11.4 rubric profiles → T10 ✅
- §12 report builders → T11, T12, T13 ✅
- CLI verbs → T15, T16, T17 ✅
- End-to-end → T18 ✅

Out of scope (Phase 4):
- Persona pool beyond `default`
- ffmpeg clip slicing
- Full known-bug bench
- vision_describe LLM call
- `try_weirdness` actual execution (P3 stubs the recording, P4 implements actions)

Type/name consistency: `RunConfig` (P1) + `RunResult` (P3) drive the orchestrator. `InterpretedSpec` (P3) ↔ Explorer state. `TraceEvent` (P1) is the through-line. Same `Severity`/`Category` enums everywhere.

---

## Phase 3 done — ready for Phase 4

When all 18 tasks merged:
- `iris eval https://example.com --spec spec.md --no-clips` produces a real `report.json` with findings and scores.
- `iris judge --trace path/to/trace.jsonl --spec spec.md` re-runs only the Judge phase.
- `iris report path/to/run-dir` re-renders without re-running anything.
- All cassette-based tests green (no real Anthropic calls in CI).
- One opt-in manual test against real API.

Phase 4 adds: ffmpeg per-finding clip slicing, persona pool (power_user/novice/adversarial/keyboard_only), known-bug bench, full rubric tuning, lighthouse probe, vision_describe LLM call.
