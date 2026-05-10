# Iris — Design Spec

- **Status:** Draft 1 — pending review
- **Date:** 2026-05-09
- **Author:** Yuxuan
- **Folder name (working):** `prod-critic`
- **Product name (release):** **Iris** — *the eye, the messenger; the critic to Otto's builder.*

---

## 1. Summary

**Iris** is an autonomous evaluator for built software products. Given a target (a web app in v1; CLIs, APIs, and desktop apps in future versions), Iris drives the product like a real user, judges what it observes against a stable rubric, surfaces actionable findings backed by video evidence, and emits a machine-readable report.

Iris ships as a TypeScript CLI distributable via `npx`. It supports three operating modes — **free** (curious exploration with no inputs), **grounded** (spec-anchored verification plus exploration), **targeted** (do exactly these tasks). It is built so the same engine extends from web to CLI/API/desktop by implementing one interface (`TargetAdapter`).

Iris's primary consumer is **Otto**, a separate intent-to-product agent loop. Otto builds; Iris reviews. Iris's `report.json` is the feedback signal that closes Otto's loop. Iris will also be wrapped as a Claude/Codex skill for human-in-the-loop automation.

---

## 2. Goals & non-goals

### In scope (v1)

- Web target evaluation via Playwright + Chromium.
- Three modes: free, grounded, targeted.
- Hybrid driver: DOM-based actions + vision-based actions, both engines toggleable per run.
- Curious-user Explorer agent (Claude Sonnet) producing a structured trace.
- Replay-able Judge agent (Claude Opus) producing scores + findings + cited evidence.
- Two-tier evaluation: fixed rubric profiles for cross-run comparable scores; open-ended findings for actionable insights.
- Output artifacts: `report.json` (machine-readable contract), `report.html` (rich human view with embedded clips), `report.md` (PR-comment-friendly), per-finding `.webm` clips.
- Storage-state-based auth for logged-in apps.
- Anthropic-only LLM stack (Claude 4.7 Opus + Sonnet).
- Stable CLI surface and JSON contract suitable for downstream skill wrappers.

### Out of scope (v1, deliberate)

- CLI / API / desktop target adapters. The `TargetAdapter` interface is defined and stubbed; only `WebTargetAdapter` is implemented.
- Multiple Explorer personas (only `default` ships; persona slot exists in the prompt).
- Specialist Judges per dimension (single Judge in v1).
- Cross-run regression comparison (`iris compare`). Design preserves stable finding identity to enable this later.
- MCP server mode (`iris serve --mcp`). v1 verbs are 1:1 with the future MCP tool set so this is additive.
- User-defined custom rubrics. Built-in rubrics only in v1; YAML override path is reserved.

### Non-goals (forever)

- Replacing deterministic tools (axe-core, Lighthouse, HTML validators). Iris **uses** them as probes.
- Penetration / security testing. Iris is a UX/quality critic, not a vulnerability scanner.
- Pixel-perfect visual regression. Visual diffing is a possible future probe but not the product's purpose.

---

## 3. End-game (informational, shapes v1 choices)

The architecture v1 is a pragmatic first step toward a larger system:

- A **pool of Explorer personas** (power user, novice, adversarial fuzz, keyboard-only, mobile-only) each producing their own trace, exposing different failure modes.
- **Specialist Judges** per dimension, each reading the same trace through a different lens.
- **Synthesis layer** that dedupes findings across judges and resolves disagreements.
- **Cross-run memory** for regression detection, coverage tracking, per-app baselines.
- **Two-way dialogue with the building agent** via MCP — Iris asks clarifying questions back, not just emits reports.
- **Multi-target adapters**: web, CLI, API, desktop, all sharing the same trace and judge core.

v1 ships the load-bearing pieces — the Explorer-and-Judge two-phase design and the trace as a durable, replayable artifact — so every step toward this end-state is additive, not a rewrite.

---

## 4. Architecture overview

### 4.1 The seam: target-agnostic core + `TargetAdapter`

```
                          CLI: iris <verb> [target] [flags]
                                        │
                                        ▼
                        ┌──────────────────────────────┐
                        │     Run Orchestrator         │
                        │   (config, lifecycle, IO)    │
                        └──────────────┬───────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
   ┌──────────────────────────┐            ┌──────────────────────────────────┐
   │   Spec Interpreter       │            │       TargetAdapter              │  ← THE SEAM
   │   (target-agnostic)      │            │  (implements TargetAdapter iface)│
   │   free-form spec ─────►  │            │                                  │
   │   {goals, focus, hints}  │            │  v1: WebTargetAdapter            │
   │                          │            │      (Playwright + Chromium)     │
   │                          │            │  later: CliTargetAdapter (PTY)   │
   │                          │            │         ApiTargetAdapter (HTTP)  │
   │                          │            │         DesktopAdapter (CDP/UIA) │
   └──────────────┬───────────┘            └──────────────┬───────────────────┘
                  │                                       │
                  └─────────────────┬─────────────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │   EXPLORER AGENT (Sonnet)    │  ← target-agnostic
                     │   observe → plan → act →     │
                     │   record loop                │
                     └──────────────┬───────────────┘
                                    │
                                    ▼ append-only
                     ┌──────────────────────────────┐
                     │       TRACE (JSONL)          │  ← target-agnostic schema
                     │   target-tagged events       │     versioned, durable
                     └──────────────┬───────────────┘
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │     JUDGE AGENT (Opus)       │  ← target-agnostic core
                     │   reads trace + spec         │     loads target-aware
                     │   emits findings + scores    │     rubric profiles
                     └──────────────┬───────────────┘
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │      REPORT BUILDER          │  ← target-agnostic
                     │   report.json + html + md    │     adapter slices its own
                     │   evidence/clips/*.webm      │     evidence per target
                     └──────────────────────────────┘
```

### 4.2 Two cross-cutting principles

1. **The trace is the load-bearing artifact.** Agents are interchangeable; the trace is the durable interface. Every other component reads from or writes to the trace.
2. **Replay-friendly judging.** `iris judge --trace ./trace.jsonl --spec spec.md` re-runs only the Judge step against an existing trace. No browser, no exploration cost — just one LLM call. This is the iteration loop that makes prompt-tuning the rubric tractable.

---

## 5. CLI surface

Three verbs in v1: `eval`, `judge`, `report`. Future verbs (`watch`, `compare`, `serve`) follow the same shape.

### 5.1 `iris eval` — full run

```
iris eval <target> [options]

Target (positional, required):
  <target>                 URL for web adapter (v1).
                           Future: shell command for cli, OpenAPI URL for api,
                           app name for desktop. v1 errors clearly on non-web.

Mode:
  --mode free|grounded|targeted   Default: inferred from inputs (see §6.2).
  --spec <path>                   Free-form spec file (md/yaml/html/txt/prose).
  --task <text>                   Single targeted task. Repeatable.
  --tasks <path>                  Newline-separated targeted tasks file.

Rubrics & focus:
  --rubrics <list>         Comma-separated profile names. Default: all profiles
                           applying to the target_kind.
                           Example: --rubrics usability,accessibility
  --focus <list>           Tier-3 focus directives. Free text, comma-separated.
                           Example: --focus "checkout flow,mobile viewport"

Engine (web-only flags; ignored by other adapters):
  --engine dom|vision|hybrid   Default: hybrid.
  --auth <path>                Playwright storageState.json (logged-in apps).
  --viewport <WxH>             Default: 1280x800.
  --user-agent <ua>            Default: Chromium default.

Budgets:
  --max-steps <n>          Default: 60. Hard cap on Explorer actions.
  --max-cost-usd <n>       Default: 5.00. Aborts run when exceeded.
  --timeout <s>            Default: 600 (10 min) total wall time.
  --explore-budget <0..1>  Grounded mode only. Fraction of remaining budget
                           spent on free exploration after spec is verified.
                           Default: 0.30.

Models:
  --explorer-model <id>    Default: claude-sonnet-4-6.
  --judge-model <id>       Default: claude-opus-4-7.

Output:
  --out <dir>              Default: ./iris-runs/<iso8601>-<shortid>/.
  --no-html                Skip HTML report (JSON still written).
  --no-clips               Skip per-finding video clips.
  --threshold <n>          Exit non-zero if overall score < n. Default: off.
  --print-summary          Print compact JSON summary line to stdout on exit.

Misc:
  --dry-run                Run spec interpreter only, print plan, exit.
  --verbose                Stream trace events to stderr as they happen.
  --json-logs              Structured logs to stderr (for skill consumers).
```

### 5.2 `iris judge` — replay the Judge against a stored trace

```
iris judge --trace <path> [--spec <path>] [--rubrics <list>]
           [--judge-model <id>] [--out <dir>] [--print-summary]
```

No browser, no Explorer. Re-runs only the Judge step. The iteration loop for tuning rubric prompts.

### 5.3 `iris report` — re-render report.html / clips from an existing run

```
iris report <run-dir> [--no-clips] [--template <path>]
```

Pure rendering — no LLM. Useful when the HTML template improves and you want to regenerate old reports.

### 5.4 Exit codes

| Code | Meaning |
|------|---------|
| 0 | Run completed; score ≥ threshold (or no threshold set) |
| 1 | Run completed; score < threshold |
| 2 | Run aborted by budget (steps / cost / timeout) |
| 3 | Run failed before Judge produced a score (target unreachable, adapter crash) |
| 64 | Usage error (bad flags, unknown verb) |

### 5.5 Run output directory layout

```
./iris-runs/2026-05-09T22-13-44Z-abc123/
├── config.json              ← resolved config (every flag, every default)
├── spec.input.txt           ← copy of spec input as given (verbatim)
├── spec.interpreted.json    ← spec interpreter output
├── trace.jsonl              ← THE durable artifact; replay-able
├── findings.json            ← Judge's deduped findings
├── scores.json              ← Judge's per-dimension scores
├── report.json              ← merged top-level report (Otto-feedback contract)
├── report.html              ← rich human-readable report (omit with --no-html)
├── report.md                ← compact markdown summary
├── evidence/
│   ├── full-recording.webm
│   ├── trace.zip            ← Playwright trace artifact
│   ├── screenshots/step-XXXX.png
│   ├── a11y/step-XXXX.json
│   └── clips/F-XXX.webm
├── logs/
│   ├── orchestrator.jsonl   ← timestamped run lifecycle events
│   ├── llm-calls.jsonl      ← every Anthropic call: model, tokens, $, latency
│   └── browser-console.jsonl ← captured console (web adapter)
└── README.md                ← auto-generated index of what's in this dir
```

All JSON writes carry `_written_at`. Logs are append-only. Retried runs go in `retry-1/`, `retry-2/` subdirs — never overwrite history.

### 5.6 Skill-wrapper invariants

Iris is designed to be wrapped as a Claude/Codex skill. The following are stable contracts:

1. **Verb + flag surface stable.** Once a flag ships, it doesn't get renamed.
2. **`report.json` schema is versioned (`v: 1`).** Adding fields is safe; renaming/removing is a major version bump.
3. **Output paths are deterministic.** `--out` is honored verbatim; internal layout is fixed (§5.5).
4. **`--print-summary`** emits one JSON line to stdout so skills can consume the result without reading files.
5. **`--json-logs`** emits structured progress events to stderr so skills can surface progress to users.
6. **Exit codes** are the gating signal; skills don't parse stdout for pass/fail.

---

## 6. Operating modes

Iris's Explorer is designed to be **as agentic as possible**: a curious user encountering an unfamiliar product. Modes shape *how much* of that agency is constrained by inputs.

### 6.1 The three modes

| Mode | Inputs | Explorer behavior | Typical use case |
|---|---|---|---|
| **`targeted`** | `--task <text>` or `--tasks <file>` | Straight to the tasks. Plan stack = the tasks, in order. No site-map curiosity, no broad exploration, no `try_weirdness` on unrelated surfaces. Reflection step skipped. **Still flags obvious bugs encountered en route** — not exploring is fine, ignoring evidence is not. | Regression / smoke check. "Verify this fix." Validating a single agent-built feature. |
| **`grounded`** | `--spec <path>` (no tasks) | Spec interpreter pre-seeds the plan stack. Explorer verifies spec goals, then spends `--explore-budget` (default 0.30) on free curious exploration. Reflection step on after spec done. | **Otto's primary feedback loop.** Coding agent built from a PRD; verify it matches *and* find what the spec missed. |
| **`free`** | nothing — or `--mode free` overrides any inputs | Plan stack starts empty. Explorer hypothesizes the product, builds a site map, runs curiosity heuristics, full reflection cadence. Maximum agency, maximum surface coverage. | Independent product critique. Auditing something with no documentation. |

### 6.2 Mode inference

```
inputs                              → mode
─────────────────────────────────────────────────
--task / --tasks given              → targeted
--spec given (no tasks)             → grounded
nothing given                       → free

--mode <m> always wins over inference.
```

### 6.3 Mechanistic differences across modes

| Behavior | targeted | grounded | free |
|---|---|---|---|
| Plan stack seed | tasks (ordered, must-complete) | spec goals | empty |
| Reflection cadence | off | every 10 steps after spec done | every 10 steps |
| Curiosity heuristics in prompt | omitted | included as "after spec is done" | included as primary |
| `try_weirdness` encouraged | only on task-relevant surfaces | yes, on all explored surfaces | yes, on all explored surfaces |
| Coverage soft-termination | off | off until spec done; on after | on |
| Budget split (default) | 100% directed | 70% spec / 30% explore (`--explore-budget`) | 100% explore |
| Done condition | all tasks `step_done` | spec goals done + explore budget consumed | Explorer calls `done` or coverage saturates |
| Default rubric profiles | `correctness`, `error-handling` only | all profiles applying to target | all profiles |

---

## 7. `TargetAdapter` interface (the contract)

Every adapter — web, CLI, API, desktop — implements the same shape. v1 only ships `WebTargetAdapter`, but the interface is fixed now.

```ts
interface TargetAdapter {
  // identity
  readonly kind: 'web' | 'cli' | 'api' | 'desktop';

  // lifecycle
  start(config: AdapterConfig): Promise<void>;
  stop(): Promise<AdapterArtifacts>;        // returns video.webm | asciinema.cast | har.json | …

  // tools the Explorer can call. Each adapter chooses which to expose.
  // Each tool returns ToolResult { ok, observation, evidence_refs[] }.
  listTools(): ToolSpec[];                  // declared to the LLM as Anthropic tools
  callTool(name: string, args: object): Promise<ToolResult>;

  // the universal observe primitive — adapter decides what "current state" means.
  // web:     DOM snapshot + a11y tree + screenshot ref
  // cli:     last N lines of stdout/stderr + cursor + exit code (if exited)
  // api:     last response body + status + headers + schema-diff
  // desktop: a11y tree + screenshot ref
  observe(): Promise<Observation>;

  // probes are deterministic, non-LLM checks the Explorer can request
  // web:     run_axe, run_lighthouse, console_errors_since
  // cli:     help_present, exit_code_semantics
  // api:     openapi_diff, status_code_distribution
  // desktop: a11y_violations, focus_traps
  listProbes(): ProbeSpec[];
  runProbe(name: string, args: object): Promise<ProbeResult>;

  // evidence rendering — adapter knows how to slice its own recording
  sliceEvidence(refs: EvidenceRef[]): Promise<EvidenceFile[]>;
  // web:     slice video into per-finding .webm clips
  // cli:     slice asciinema cast into per-finding .cast clips
  // api:     extract HAR entries into per-finding request/response JSON
  // desktop: slice screen recording into per-finding clips
}
```

What this buys:

- **Trace events are target-tagged.** Same JSONL schema everywhere. Judge uses `event.target_kind` to interpret payloads.
- **Explorer prompt is mostly target-agnostic.** It receives the adapter's tool list at runtime — no hardcoded "click" or "type." Per-target system prompt suffix injects the few target-specific behavioral hints.
- **Rubric library is profile-based and target-aware.** Each profile declares which `target_kind`s it applies to.
- **Report builder asks the adapter to render evidence.** HTML template is shared and adapter-agnostic.
- **Replay still works for every target.** `iris judge --trace ...` is target-agnostic.

---

## 8. Trace event schema

`trace.jsonl` — one JSON object per line, append-only. Target-agnostic envelope; target-specific `payload`.

### 8.1 Common envelope

```json
{
  "v": 1,
  "id": "T000142",
  "ts": 1747432424.812,
  "step": 17,
  "target_kind": "web",
  "kind": "<event-kind>",
  "actor": "explorer" | "adapter" | "probe" | "system",
  "payload": { ... }
}
```

- `v` — schema version. Bumped on breaking changes; older traces remain readable.
- `id` — monotonic ULID-like; used by Judge to cite evidence.
- `step` — Explorer step counter; multiple events can share a step.
- `actor` — who emitted the event.

### 8.2 Event kinds (target-agnostic)

| `kind` | Actor | Purpose |
|---|---|---|
| `run_start` | system | Run config snapshot |
| `spec_interpreted` | system | Output of spec interpreter |
| `step_plan` | explorer | Reasoning + planned next action |
| `action` | explorer | Action requested (delegated to adapter) |
| `action_result` | adapter | Result of action (ok/error, observation diff) |
| `observation` | adapter | Full state snapshot (DOM/screenshot/stdout/etc.) |
| `probe_call` | explorer | Explorer requested a deterministic probe |
| `probe_result` | adapter | Probe output (axe violations, lighthouse, etc.) |
| `evidence` | adapter | Pointer to a media file (screenshot/clip/HAR) |
| `tentative_finding` | explorer | Explorer flagged something while exploring |
| `hypothesis` | explorer | Explorer's belief about the product |
| `surface_seen` | explorer | A surface marked as explored (coverage map) |
| `surface_unexplored` | explorer | A surface noticed but not yet visited |
| `step_done` | explorer | Planned goal/task marked complete |
| `give_up` | explorer | Stopped early (with reason) |
| `done` | explorer | Stopped normally |
| `budget_warn` / `budget_abort` | system | Cost / step / time signals |
| `run_end` | system | Final stats: steps, cost, wall time |

### 8.3 Target-specific payload examples (web v1)

```jsonc
// web action — DOM engine
{ "kind": "action", "payload": {
    "tool": "click",
    "args": { "selector": "button[name='Sign in']" },
    "engine": "dom"
}}

// web action — vision engine
{ "kind": "action", "payload": {
    "tool": "vision_click",
    "args": { "x": 612, "y": 244, "reason": "the blue 'Continue' button" },
    "engine": "vision"
}}

// web observation
{ "kind": "observation", "payload": {
    "url": "https://app.example.com/checkout",
    "title": "Checkout — Step 2",
    "viewport": { "w": 1280, "h": 800 },
    "dom_digest": "sha256:…",
    "a11y_tree_ref": "evidence/a11y/step-17.json",
    "screenshot_ref": "evidence/screenshots/step-17.png",
    "console_since_last": [ ... ],
    "network_since_last": [ { "url": "...", "status": 500, "ms": 812 } ]
}}

// web probe result
{ "kind": "probe_result", "payload": {
    "probe": "axe-core",
    "violations": [ { "id":"color-contrast", "nodes":[…], "impact":"serious" } ],
    "summary": { "violations": 7, "passes": 142 }
}}

// universal — tentative_finding
{ "kind": "tentative_finding", "payload": {
    "title": "Login form submits with empty password and shows no error",
    "category": "bug" | "a11y" | "ux" | "perf" | "copy" | "suggestion",
    "severity_hint": "blocker" | "major" | "minor" | "nit",
    "evidence_event_ids": ["T000139", "T000142"],
    "rationale": "Submitted with empty fields; UI changed to spinner then back, no message."
}}
```

### 8.4 Future adapter payload examples (illustrative, not v1)

```jsonc
// cli adapter
{ "kind": "action", "target_kind": "cli", "payload": {
    "tool": "stdin_send", "args": { "text": "git push origin main\n" } }}
{ "kind": "observation", "target_kind": "cli", "payload": {
    "stdout_since_last": "Counting objects: 12, done.\n…",
    "stderr_since_last": "",
    "process_state": "running"
}}
```

### 8.5 Schema invariants

- Append-only. No event is ever rewritten.
- Versioned (`v`). Future schema bumps preserve readability of older traces.
- Every meaningful event has an `id`; findings cite `evidence` by event ids.
- `dom_digest` (or equivalent per-adapter) enables loop detection and cross-event diffs.

---

## 9. Spec interpreter

A single Claude Sonnet call that runs once at the start of grounded mode (and optionally annotates targeted mode).

**Input:** the verbatim spec file (any format — md/yaml/html/prose).

**Output (`spec.interpreted.json`):**

```json
{
  "v": 1,
  "_written_at": "2026-05-09T22:13:50Z",
  "target_kind_hint": "web",
  "goals": [
    { "id": "G1", "description": "User can sign up with email", "priority": "must" },
    { "id": "G2", "description": "User can export data as CSV", "priority": "must" },
    { "id": "G3", "description": "Empty state explains how to start", "priority": "should" }
  ],
  "focus_areas": ["checkout flow", "onboarding"],
  "hints": [
    "App is multi-tenant; expect a workspace switcher",
    "Spec mentions 'invoice' once — likely billing-adjacent"
  ],
  "out_of_scope": ["admin dashboard", "API docs page"]
}
```

This becomes the Explorer's plan-stack seed (one item per goal) and feeds the Judge's `spec_compliance` evaluation.

---

## 10. Explorer agent

### 10.1 The exploration ethos (top of the system prompt)

> *You are a curious, observant new user encountering an unfamiliar product for the first time. You don't have a manual. Nobody told you what it does or who it's for. Your job is to figure that out, exercise the product the way a real user would, and form an honest opinion of what works and what doesn't.*
>
> *Be aggressive about exploration. A real user opens menus, clicks secondary buttons, scrolls to the footer, tries the search bar with weird queries, fills forms with realistic data, hits Enter on empty inputs, clicks the same thing twice, refreshes mid-flow. Do all of that. The interesting bugs and the interesting design hide in the corners that a goal-driven test would never visit.*
>
> *Form hypotheses early and revise them. Note them. Test them. Update them.*
>
> *Breadth before depth in the first half of your budget. Depth and weird-cases in the second half. Always know what you haven't seen yet.*

### 10.2 The loop

```
       ┌────────────────────────────────────────────────┐
       │             initialize plan from               │
       │     spec_interpreted.json + persona prompt     │
       └────────────────────────┬───────────────────────┘
                                ▼
            ┌──────────────────────────────────────┐
            │                OBSERVE               │
            │  adapter.observe()                   │
            └──────────────────┬───────────────────┘
                               ▼
            ┌──────────────────────────────────────┐
            │                 PLAN                 │
            │  Claude call w/ tools enabled.       │
            │  → step_plan event + tool call       │
            └──────────────────┬───────────────────┘
                               ▼
            ┌──────────────────────────────────────┐
            │                  ACT                 │
            │  adapter.callTool / probe / meta     │
            │  → action_result event               │
            └──────────────────┬───────────────────┘
                               ▼
            ┌──────────────────────────────────────┐
            │                RECORD                │
            │  Update plan stack, site map.        │
            │  Loop-detection check. Budget check. │
            └──────────────────┬───────────────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │   continue?      │── no ──▶ run_end
                    └────────┬─────────┘
                            yes
                             ▼
                       (back to OBSERVE)
```

### 10.3 System prompt structure (composable slots)

```
[CORE]            target-agnostic Explorer rules. Always present.
                  - role + loop + tool categories
                  - exploration ethos (§10.1)
                  - exploration heuristics cheat-sheet (§10.7)
                  - how to use note_finding, step_done, give_up

[TARGET_KIND]     short suffix per adapter kind (web / cli / api / desktop).

[MODE]            free | grounded | targeted (§6).

[PERSONA]         v1: 'default' (sensible new user).
                  Slot for v1.x: power_user, novice, adversarial,
                  keyboard_only, mobile_only.

[INPUTS]          spec_interpreted.json + focus directives + tasks.
                  Cached separately with prompt cache.
```

### 10.4 Per-turn message shape

```
system: [CORE] + [TARGET_KIND] + [MODE] + [PERSONA]   ← cached (stable)
system: [INPUTS]                                       ← cached per-run
user:   "current_observation: { url, title, dom_digest, a11y_outline,
                                screenshot:<image_id>, console_delta,
                                network_delta }
         plan_stack:           ['verify checkout', 'explore settings tab']
         site_map:             { surfaces_seen: 4, surfaces_unexplored: 3 }
         recent_actions:       <last 5 actions, one line each>
         budget_left:          { steps: 43, usd: 4.21, seconds: 387 }"

assistant: short reasoning  → tool_use(name, args)
```

Recent-actions summary is rolling: only the last ~5 in detail, older compressed. Per-turn input is bounded regardless of run length.

### 10.5 Tools

**Adapter-provided (web v1):**

| Tool | Args | Purpose |
|---|---|---|
| `dom_snapshot` | — | Compact a11y-prioritized DOM outline. |
| `screenshot` | `full_page?` | Captures viewport / full page. |
| `click` | `selector` | Accessible-name selector preferred. |
| `type` | `selector, text` | Types into input. |
| `press` | `key` | Single key. |
| `hover` | `selector` | Hover-reveal triggers. |
| `navigate` | `url` | Same-origin by default. |
| `back` / `forward` / `reload` | — | History nav. |
| `scroll` | `dx, dy \| selector` | |
| `wait_for` | `selector \| network_idle \| ms` | Bounded waits only. |
| `vision_click` | `x, y, reason` | Vision-engine click. |
| `vision_describe` | `region?` | Vision model describes screen content. |

**Probes (web v1):**

| Probe | Purpose |
|---|---|
| `axe` | Run axe-core on current page. |
| `lighthouse` | Performance snapshot (cached 10 min). |
| `console_errors_since` | Errors since last call. |
| `network_failures_since` | 4xx/5xx and aborted requests. |
| `a11y_tree` | Full accessibility tree. |

**Meta tools (orchestrator-provided, target-agnostic):**

| Tool | Args | Purpose |
|---|---|---|
| `note_finding` | `title, category, severity_hint, evidence_event_ids[], rationale` | Tentative finding (signal, not certainty). |
| `note_hypothesis` | `claim, confidence(0..1), evidence_event_ids[]` | Belief about the product. |
| `mark_surface_seen` | `surface_id, summary` | Update coverage map. |
| `note_surface_unexplored` | `surface_id, where_seen, reason_skipped?` | Flag noticed-but-skipped. |
| `revisit` | `event_id` | Return to an earlier observed state. |
| `try_weirdness` | `kind, target?` | Built-in "try a weird thing" prompt: empty submit, very long string, special chars, double-click, rapid clicks, browser back mid-flow, refresh during loading. |
| `step_done` | `goal_id, evidence_event_ids[]` | Mark planned goal complete. |
| `push_subgoal` | `description` | Add exploratory subgoal. |
| `give_up` | `reason` | Stop early. |
| `done` | — | Stop normally. |

### 10.6 Site map (orchestrator-managed, fed back to Explorer)

```json
{
  "surfaces_seen": [
    {"id": "home",      "url": "/",           "summary": "marketing landing, sign-in CTA top-right"},
    {"id": "dashboard", "url": "/app",        "summary": "after login: 4 widgets, sidebar 7 items"},
    {"id": "settings",  "url": "/app/settings","summary": "tabs: profile, billing, integrations, danger"}
  ],
  "surfaces_unexplored": [
    {"id": "billing-tab",  "where_seen": "settings sidebar"},
    {"id": "danger-zone",  "where_seen": "settings sidebar", "reason_skipped": "destructive, save for last"},
    {"id": "help-popover", "where_seen": "footer ? icon"}
  ],
  "coverage_estimate": 0.42
}
```

### 10.7 Exploration heuristics cheat-sheet (in `[CORE]`)

The Explorer is told to opportunistically run through:

- Open every top-level navigation item at least once.
- Open every menu, dropdown, and popover visible.
- Try the search bar (if any) with: a real-looking query, an empty query, a query with special characters.
- Submit each major form (a) correctly, (b) empty, (c) with a clearly invalid value.
- Look at empty states — visit a section before creating any data.
- Trigger destructive-action confirms (don't confirm) to read the warning.
- Use keyboard nav for one full flow (Tab/Enter/Esc only).
- Resize to 375px width once and check the same flow.
- Hit browser Back mid-flow once.
- Open the same page in two tabs and act in one — observe the other.

### 10.8 Reflection step (every N=10 steps in free/grounded modes)

Orchestrator injects a special turn:

> *Pause exploration. Look at your site map and plan stack. Answer:*
> *(a) What do you now believe this product is, and who is it for? (revise hypotheses)*
> *(b) What surfaces have you not explored that look interesting?*
> *(c) Are you going broad enough, or stuck deep in one flow?*
> *(d) What weirdness have you not tried yet on what you have explored?*
> *Then push the most valuable next 1–3 items onto your plan stack.*

This is the single biggest lever against tunnel vision.

### 10.9 Loop detection

After every observation, compute `dom_digest` (SHA over normalized DOM — strip ads, timestamps, nonces, animation-only changes). Sliding window of last 20 digests:

- Same digest 3× in a row with intervening actions → orchestrator injects `loop_warning`.
- Same digest 5× → orchestrator forces `give_up:loop_detected`.

### 10.10 Budgets and termination

| Termination cause | Trace event | Exit code |
|---|---|---|
| All goals/tasks done + Explorer called `done` | `run_end:goals_complete` | 0 |
| `--max-steps` reached | `budget_abort:steps` | 2 |
| `--max-cost-usd` reached | `budget_abort:cost` | 2 |
| `--timeout` reached | `budget_abort:timeout` | 2 |
| Explorer called `give_up` | `give_up` | 0 (Judge still runs) |
| `loop_detected` forced | `give_up:loop_detected` | 0 |
| Adapter crash / target unreachable | `run_end:adapter_error` | 3 |

Budget aborts proceed to Judge — partial runs are useful.

### 10.11 Coverage soft-termination

If `coverage_estimate ≥ 0.85` **and** all `surfaces_unexplored` are visited or explicitly deferred-with-reason, orchestrator nudges: *"you appear to have broad coverage. Consider whether to call `done`, or to deepen exploration on the most user-critical surface."* Explorer decides.

### 10.12 Cost discipline

- **Prompt caching** on `[CORE]+[TARGET_KIND]+[MODE]+[PERSONA]` and `[INPUTS]`.
- **Screenshots opt-in per turn** — DOM outline is text and cheap; screenshots are expensive.
- **Vision engine opt-in per action** — `--engine dom` never sends screenshots.
- **Observation deltas not snapshots** — `console_since_last`, `network_since_last`, recent-actions-summary.

### 10.13 Explorer invariants

- Never assigns final severity (only `severity_hint`).
- Never produces a score.
- Never writes the report.
- Never reads or modifies prior trace events.
- Never deletes evidence files.

---

## 11. Judge agent

A single Claude Opus session that runs after the Explorer is done. Reads the trace; emits findings and scores. Never touches the browser.

### 11.1 Inputs

```
1. spec.input.txt              ← original spec, verbatim (if any)
2. spec.interpreted.json       ← interpreter's structured plan (if any)
3. config.json                 ← run config
4. trace.jsonl                 ← full trace, every event
5. site_map.json               ← coverage map
6. probe_results/              ← raw axe / lighthouse outputs
7. evidence index              ← list of screenshots, video timestamps, HAR refs
8. rubric profiles             ← target_kind-filtered, mode-filtered, user-filtered
```

### 11.2 The Judge call

Single Claude Opus call with the trace as a structured input plus tool access to **read** evidence on demand:

```
read_event(id)                  → full event payload
read_screenshot(id)             → image content block
read_probe(name, step?)         → axe/lighthouse output
diff_observations(id_a, id_b)   → DOM/console/network deltas
list_findings_so_far()          → Judge's own emitted findings
```

The Judge gets a digest of the trace by default (one-line per event with refs); uses tools to fetch full payloads only when needed. Bounded prompt size for long runs; Opus zooms in on what matters.

### 11.3 Two-tier rubric model (recap)

- **Tier 1 — Rubric (the score).** Fixed library of dimensions, fixed weights, always evaluated. Comparable across runs.
- **Tier 2 — Findings (the qualitative output).** Open-ended, severity-tagged, evidence-cited. Most actionable for Otto.
- **Tier 3 — Focus directives.** Steer *where* the Explorer goes and *which* findings get prioritized; do not introduce new score dimensions.

### 11.4 Rubric profiles (v1, web target)

YAML files shipped with the tool. Each tagged with `applies_to_targets` and `applies_to_modes`.

| Profile | Dimensions | Notes |
|---|---|---|
| `quality` | correctness, completeness, polish | Always-on. Generic baseline. |
| `usability` | clarity, discoverability, error_recovery, feedback_responsiveness | Web + desktop. |
| `accessibility` | keyboard_nav, screen_reader_semantics, color_contrast, focus_management, axe_violations | Web + desktop. Pulls heavily from `axe`. |
| `frontend_correctness` | console_clean, network_clean, layout_stability, responsive_behavior | Web. |
| `coverage` | breadth, depth, weirdness_attempted, persona_balance | Always-on. Mostly graded from site_map + trace stats. |

**Targeted-mode default subset:** `quality` (correctness, completeness only) + `frontend_correctness` (console_clean, network_clean only). Other dimensions skipped to avoid penalizing scores for things the run wasn't asked to test.

Example rubric YAML:

```yaml
# packages/rubrics/web/usability.yaml
name: usability
applies_to_targets: [web, desktop]
applies_to_modes:   [free, grounded, targeted]
weight_in_overall:  1.0

dimensions:
  - id: clarity
    weight: 1.0
    description: |
      Can a new user tell what the product does and what to do next on each
      screen? Are labels, headers, and CTAs unambiguous?
    scoring_anchors:
      0: "Confusing — unclear what the product is or what to do next."
      3: "Mostly clear, with several rough spots."
      5: "Immediately clear; copy and structure carry the user."
    evidence_required: at_least_one_observation_id
    common_signals:
      positive: ["one obvious primary CTA per screen", "labels match user vocabulary"]
      negative: ["jargon without explanation", "two competing CTAs", "ambiguous icon-only buttons"]
```

### 11.5 Scoring contract (`scores.json`)

```json
{
  "v": 1,
  "_written_at": "2026-05-09T22:21:08Z",
  "overall": {
    "score": 7.4,
    "weighted_from": ["quality", "usability", "accessibility", "frontend_correctness", "coverage"]
  },
  "profiles": {
    "usability": {
      "score": 8.2,
      "dimensions": {
        "clarity": {
          "score": 8.5,
          "rationale": "Primary CTAs labeled with action verbs, matched page intent on every observed screen. Two minor exceptions: 'Workspaces' switcher icon-only (T000087); /reports empty-state has no instructive copy (T000214).",
          "evidence": ["T000087", "T000214", "T000301"]
        }
      }
    }
  },
  "spec_compliance": {
    "applicable": true,
    "goals": [
      {"id": "G1", "description": "User can sign up with email", "status": "satisfied", "evidence": ["T000045"]},
      {"id": "G2", "description": "User can export data as CSV", "status": "not_satisfied", "evidence": ["T000182"], "notes": "Export produces JSON not CSV"},
      {"id": "G3", "description": "Empty state explains how to start", "status": "partial", "evidence": ["T000214"]}
    ],
    "summary": "5/7 goals satisfied, 1 partial, 1 not satisfied."
  },
  "coverage_review": {
    "surfaces_explored": 8,
    "surfaces_unexplored": 2,
    "weirdness_run": ["empty_submit", "long_string"],
    "weirdness_skipped": ["keyboard_only_flow", "375px_viewport"],
    "judgement": "Good breadth. Missed mobile viewport and keyboard-only flow — recommend re-running with those personas."
  },
  "meta": {
    "confidence_overall": 0.78,
    "confidence_caveats": [
      "Coverage was 60% — settings and admin not explored.",
      "No mobile viewport tested.",
      "axe-core probe failed on /reports — accessibility score there is incomplete."
    ],
    "would_re_explore_with": ["--persona keyboard_only", "--viewport 375x812"]
  }
}
```

**Invariants for Otto's loop:**

1. Every score has cited evidence (no floating numbers).
2. `spec_compliance.goals` is structured with `satisfied | partial | not_satisfied` plus evidence — the most actionable single piece of output.
3. `meta.confidence_overall` and `would_re_explore_with` are honesty hardware — Otto should weight by confidence and act on re-exploration suggestions.

### 11.6 Findings contract (`findings.json`)

```json
{
  "v": 1,
  "_written_at": "2026-05-09T22:21:08Z",
  "findings": [
    {
      "id": "F-001",
      "title": "Login form submits with empty password and shows no error",
      "category": "bug",
      "severity": "blocker",
      "evidence": ["T000139", "T000142"],
      "where": { "url": "/sign-in", "selector": "form[name='signin']" },
      "rationale": "Pressed submit with empty password. Form serialized and POST'd; UI changed to spinner then back, no message. Console: 400 from /api/auth.",
      "suggested_fix": {
        "type": "client_validation_or_error_surface",
        "summary": "Surface the 400 response, or block submission when password is empty."
      },
      "related_findings": []
    }
  ],
  "discarded_findings": [
    {
      "tentative_event_id": "T000180",
      "reason": "Likely a third-party widget loading state; not a product issue."
    }
  ]
}
```

### 11.7 Severity calibration (Judge prompt)

| Severity | Meaning | Example |
|---|---|---|
| `blocker` | Core flow broken or data-loss / security-flavored | Sign-in fails for valid creds; double-charge on submit |
| `major` | Important feature degraded; affects many users | Modal traps focus; primary CTA hidden on mobile |
| `minor` | Visible defect with workaround | Confusing copy; overlapping elements at edges |
| `nit` | Polish | Typo; spacing inconsistency |
| `suggestion` | Improvement idea, not a defect | "Consider an inline tip on first empty-state" |

The Judge is told: **calibrate by user impact, not technical interest.** A typo in the legal footer is `nit`; a typo in a confirm-purchase dialog is `minor` or `major`.

### 11.8 Dedup pipeline

1. **Group by `where`** — same selector, same URL, similar title.
2. **Group by symptom signature** — title embeddings or phrase-hash; close ones merged.
3. **Promote / demote / discard** — Judge can adopt, merge, discard (with reason in `discarded_findings`), or add findings the Explorer missed.

`discarded_findings` is preserved so we can later analyze "what does the Explorer flag that the Judge consistently throws out?" — feedback for tuning Explorer prompts.

### 11.9 Replay loop

```bash
# First run
iris eval https://app.example.com --spec spec.md --out ./run-1
# 8 minutes, $1.84

# Tweak rubric YAML
$EDITOR packages/rubrics/web/usability.yaml

# Re-judge against the SAME trace — no browser, no Explorer
iris judge --trace ./run-1/trace.jsonl --spec ./run-1/spec.input.txt --out ./run-1-rejudge
# 25 seconds, $0.18
```

### 11.10 Determinism

- `temperature: 0`, `top_p: 1`.
- Trace is fixed → re-running Judge on same trace + same prompt gives very similar (not bit-identical) output.
- Stability matters for the feedback loop.

### 11.11 Judge invariants

- Never re-orders or edits trace events.
- Never claims findings without `evidence` ids.
- Never invents new rubric dimensions (Tier-1 stability).
- Discarded findings are logged with reasons.

---

## 12. Report builder

Pure assembly. No LLM. Deterministic from inputs.

### 12.1 `report.json` — Otto-feedback contract

```json
{
  "v": 1,
  "_written_at": "2026-05-09T22:21:08Z",
  "tool": { "name": "iris", "version": "0.1.0" },

  "run": {
    "id": "2026-05-09T22-13-44Z-abc123",
    "target": { "kind": "web", "url": "https://app.example.com" },
    "mode": "grounded",
    "started_at": "2026-05-09T22:13:44Z",
    "ended_at":   "2026-05-09T22:20:36Z",
    "duration_s": 412,
    "cost_usd":   1.84,
    "models": { "explorer": "claude-sonnet-4-6", "judge": "claude-opus-4-7" },
    "termination": "goals_complete",
    "step_count": 47,
    "spec_input_path": "./spec.input.txt"
  },

  "headline": {
    "score": 7.4,
    "threshold_passed": true,
    "blockers": 1, "majors": 4, "minors": 12, "nits": 3, "suggestions": 15
  },

  "scores":          { "...": "full scores object" },
  "spec_compliance": { "...": "full spec_compliance object" },
  "findings":        [ "...": "full findings array" ],
  "coverage_review": { "...": "..." },
  "meta":            { "...": "confidence + caveats + would_re_explore_with" },

  "artifacts": {
    "report_html": "./report.html",
    "report_md":   "./report.md",
    "trace":       "./trace.jsonl",
    "trace_zip":   "./evidence/trace.zip",
    "video":       "./evidence/full-recording.webm",
    "clips":       { "F-001": "./evidence/clips/F-001.webm" }
  },

  "next_actions": {
    "for_builder": [
      { "finding_id": "F-001", "fix_priority": 1, "summary": "Fix empty-password submit on /sign-in" },
      { "finding_id": "F-007", "fix_priority": 2, "summary": "Add Esc-to-close on confirmation modal" }
    ],
    "for_re_evaluation": [
      "--persona keyboard_only",
      "--viewport 375x812"
    ]
  }
}
```

`next_actions.for_builder` is the prioritized fix list — synthesized by the Report builder (heuristic, not LLM) from findings sorted by severity and fix-impact-per-effort. Otto's loop becomes:

```
loop:
  Otto builds → iris eval → report.json
  if headline.threshold_passed:   ship / commit
  else:                            address next_actions.for_builder, repeat
```

### 12.2 `report.md` — PR-comment friendly

Compact, scannable, no images. Generated deterministically from `report.json` — no LLM. Designed to fit in a GitHub PR comment without scrolling.

### 12.3 `report.html` — rich human view

Single self-contained file. Tailwind via CDN, evidence assets referenced relative to run dir. Layout includes: headline + scores card; spec compliance row; finding cards (each with inline `<video>` clip); coverage review; trace timeline SVG.

### 12.4 Per-finding clip slicing (adapter does the work)

Adapter's `sliceEvidence(refs)` per finding:

1. Look up wall-clock timestamps for the finding's evidence event ids.
2. Compute clip window: `[earliest_ts - 1.5s, latest_ts + 2.5s]`, clamped.
3. Cut a `.webm` segment via ffmpeg (`-c copy` for stream-copy where possible).
4. Generate a poster frame at the midpoint.
5. Return file refs to Report builder.

Smart defaults:

- Adjacent findings within 5s share a clip.
- Max clip length 30s; longer findings sliced into chunks.
- `--no-clips` skips clipping entirely.
- ffmpeg missing → log warning, skip clipping, embed screenshots only. Doesn't fail the run.

### 12.5 `--print-summary` stdout line

```
{"v":1,"score":7.4,"threshold_passed":true,"findings":{"blocker":1,"major":4,"minor":12,"nit":3,"suggestion":15},"run_dir":"./iris-runs/2026-05-09T22-13-44Z-abc123","duration_s":412,"cost_usd":1.84,"caveats":3}
```

Single line, valid JSON, newline-terminated. Lets `iris eval … --print-summary | jq` work; lets a skill consume the result without reading files.

### 12.6 Determinism

`iris report <run-dir>` re-renders the report from existing artifacts, no LLM. Useful when the HTML template improves or ffmpeg was missing during the original run.

### 12.7 Cross-run forward-compat

Stable finding ids — derived from `(category, title-hash, where)` rather than ephemeral run-local — so a future `iris compare` can match findings across runs (regressed, fixed, new) without design changes.

---

## 13. Project layout & dependencies

### 13.1 Monorepo (pnpm workspaces)

```
iris/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── README.md
│
├── packages/
│   ├── core/                     ← target-agnostic engine
│   │   └── src/{orchestrator,spec-interpreter,explorer,trace,judge,report,llm,types}
│   ├── adapter-types/            ← published interface package
│   ├── adapter-web/              ← v1's only adapter (Playwright + axe + lighthouse)
│   ├── rubrics/                  ← built-in rubric YAML + loader
│   ├── cli/                      ← the `iris` binary
│   └── report-template/          ← HTML template + CSS for report.html
│
├── fixtures/
│   ├── known-bugs/               ← static HTML apps with seeded bugs (§14.3)
│   ├── golden-traces/            ← committed trace.jsonl files for replay tests
│   └── llm-cassettes/            ← recorded Anthropic responses
│
└── docs/
    ├── superpowers/specs/        ← this document
    ├── architecture.md
    ├── adding-an-adapter.md
    └── rubric-authoring.md
```

### 13.2 Runtime dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/sdk` | LLM (prompt caching, image content blocks, tool use, streaming) |
| `playwright` | Browser (video, trace, storageState) |
| `axe-core` | a11y probe (run inside page via `page.evaluate`) |
| `lighthouse` | Perf probe (heavy; opt-in via flag) |
| `zod` | Schema validation (trace events, rubric YAML, config) |
| `yaml` | Rubric YAML parsing |
| `commander` | CLI parsing |
| `ulid` | Trace event ids (sortable, monotonic) |
| `sharp` | Poster frame extraction (optional) |
| `picocolors` | TTY colors |

`ffmpeg` is a system binary, not an npm dep. Missing → warn, skip clip slicing, embed screenshots.

### 13.3 Build/test tooling

- `tsup` — bundles each package (ESM + CJS + types).
- `vitest` — unit + integration tests; snapshot support.
- `biome` — lint + format in one tool.
- TypeScript strict mode everywhere.

### 13.4 Distribution

- Published as `iris-critic` on npm (assuming `iris` is taken). Binary name in `bin` field is `iris`.
- `npx iris-critic eval <url>` or `pnpm dlx iris-critic eval <url>`.
- Optional global install: `npm i -g iris-critic`.

### 13.5 Runtime targets

- Node 20+ (LTS at v1 ship time).
- ESM-first packages; CJS-compatible builds for downstream.

---

## 14. Testing strategy

Three layers, separating deterministic logic from LLM behavior.

### 14.1 Layer 1 — Pure unit tests (~80% of test surface, < 5s)

- Trace event schema validation.
- `dom_digest` normalization (input HTML → expected SHA).
- Finding dedup logic (N tentatives → M finals).
- Rubric YAML loader (valid + invalid fixtures).
- Report builder (input scores+findings → expected JSON).
- HTML template rendering (input JSON → HTML snapshot).
- CLI flag parsing, mode inference, exit-code mapping.
- Clip slicer math (event timestamps → ffmpeg cut windows).

No LLM, no browser. Run on every commit.

### 14.2 Layer 2 — Replay & cassette tests

A thin Anthropic SDK wrapper with two modes:

- **Replay (default in tests):** every `.messages.create()` call hashed by normalized `(model, system, messages, tools)`. Look up in `fixtures/llm-cassettes/<test>/<hash>.json`. Found → return; not found → fail with "re-record with `IRIS_RERECORD_CASSETTES=1`."
- **Record (env var set):** make real call, write cassette, return.

Cassettes are committed to git. Cassette diffs in PR review are how we notice prompt drift causing behavior changes.

Tests at this layer:

- **Judge-replay:** golden `trace.jsonl` → Judge → snapshot of `report.json`.
- **Explorer-replay:** fixture app + recorded LLM responses → expected trace shape.
- **Spec-interpreter:** free-form spec → cassette → structured plan.

### 14.3 Layer 3 — Known-bug-bench (live LLM, nightly + release)

5–8 small static HTML apps in `fixtures/known-bugs/`, each with a `meta.json` declaring expected findings + score ranges:

```
fixtures/known-bugs/
├── 01-empty-form-submit/
├── 02-focus-trap-modal/
├── 03-broken-export/
├── 04-console-noise/
├── 05-bad-empty-state/
├── 06-keyboard-inaccessible/
├── 07-clean-baseline/         ← no bugs; assert score ≥ 8.5
└── 08-many-small-issues/      ← 12 nits; assert no over-severity
```

Per-fixture meta:

```json
{
  "spec": "User can sign in with email and password.",
  "mode": "grounded",
  "expected_findings": [
    { "match": { "category": "bug", "severity": ["blocker", "major"], "title_contains": ["empty", "password"] }, "must_find": true }
  ],
  "expected_score_range": { "overall": [4, 6], "usability": [3, 6] },
  "expected_to_NOT_find": [{ "category": "a11y", "severity": "blocker" }]
}
```

Tests assert:

- All `must_find` findings appear (recall).
- Scores within expected ranges (calibration).
- Nothing in `expected_to_NOT_find` appears (precision / no hallucination).
- Per-fixture cost under budget.

This is the suite that catches **behavioral** regressions — prompt changes that "feel fine" but drop a category of finding. Cost: ~$5–15 per full bench run. Nightly + release-branch only.

### 14.4 Adapter conformance tests

`packages/adapter-types/` ships `runAdapterConformance(adapter)` — a generic suite asserting interface contract:

- `start()` and `stop()` idempotent in valid orderings.
- `listTools()` returns valid `ToolSpec`s.
- Every advertised tool callable at least once.
- `observe()` returns valid `Observation`.
- Trace events match envelope schema.

`adapter-web` runs this. Future adapters opt in for free.

### 14.5 What we explicitly DON'T test

- Live behavior of arbitrary public web apps.
- Token-exact LLM outputs (we assert structure + semantic content, not literal strings).
- Pixel-snapshots of `report.html`.

---

## 15. Glossary

- **Iris** — this product. Critic to Otto's builder.
- **Otto** — separate intent-to-product agent loop. Iris's primary consumer.
- **Target** — the thing being evaluated (URL for web; future: shell command, OpenAPI, app name).
- **Adapter** — implementation of `TargetAdapter` for a specific kind of target.
- **Mode** — free / grounded / targeted (§6).
- **Engine** — DOM / vision / hybrid (web-only flag).
- **Persona** — Explorer behavioral preset (v1: only `default`).
- **Trace** — append-only JSONL record of everything that happened during a run.
- **Tier 1 / 2 / 3** — rubric (score) / findings / focus directives (§11.3).
- **Finding** — open-ended observation, severity-tagged, evidence-cited.
- **Tentative finding** — Explorer-emitted; Judge dedupes/promotes/discards.
- **Replay** — re-running the Judge against a stored trace, no browser.
- **Cassette** — recorded LLM response committed to git for deterministic tests.
- **Probe** — deterministic non-LLM check (axe-core, Lighthouse, etc.).
- **Site map** — Explorer-maintained coverage record of surfaces seen/unseen.

---

## 16. Open questions / deferred decisions

These don't block v1 but should be revisited as we go:

1. **`coverage_estimate` heuristic.** v1 uses surfaces-seen / (surfaces-seen + surfaces-unexplored). Probably too coarse. Better metrics (per-route weight, depth bonus) deferred until we see real runs.
2. **Cassette stability under prompt changes.** Trivial whitespace edits shouldn't invalidate cassettes; semantic edits should. Normalization rules need empirical tuning once tests exist.
3. **Lighthouse-on-every-run vs Lighthouse-once-per-route.** Performance probe is expensive; default cadence TBD after first benchmarking pass.
4. **Vision-engine fallback policy.** When a DOM action fails, do we automatically retry under vision? v1 default: no, Explorer must explicitly switch. Revisit after observing real failure modes.
5. **Multi-tab support.** Heuristics include "open in two tabs"; v1 adapter doesn't cleanly support this yet. Either implement minimal multi-page support in v1 or drop that heuristic for now.
6. **Persona-balance dimension in `coverage` rubric.** Scores `0` in v1 (only one persona exists). Either remove the dimension in v1 or carry it as zero with a note. Decide before shipping.

---
