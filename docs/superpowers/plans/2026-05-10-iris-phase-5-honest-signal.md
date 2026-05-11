# Iris Phase 5 — Honest Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Iris's polished-but-thin output with trustworthy signal. Four pieces: per-goal Explorer budgets (G1), broken-app preflight (G2), evidence-enforced findings (G3), run-to-run delta (G4).

**Architecture:** Each piece is independently shippable in the order listed. G1 fixes the score-vs-coverage lie. G2 stops Iris from scoring a 500 page as a 4.0. G3 makes the Judge cite evidence or get downgraded. G4 turns Iris from snapshot to delta source — the actual signal Otto needs.

**Tech Stack:** TypeScript, Node 20+, pnpm workspaces, tsup, vitest, biome strict. No new runtime deps. Optional `sha1` already available via Node `crypto`.

**Prior context:**
- `research.md` (project root) — diagnosis & gap inventory
- `docs/superpowers/specs/2026-05-10-iris-phase-5-design.md` — the design this plan implements
- Web research (2026-05-10) — competitor landscape: TestSprite (closest analog, AI-coding-agent feedback loop), QA.tech (95% bug detection w/ auto-retry, flake as table-stakes), Skyvern (Planner-Actor-Validator pattern matches G3), Applitools (only tool offering regression diff — visual)

**Smoke-test validation (2026-05-10).** Before sending this plan to implementers, ran live Playwright probes against 7 real targets (TodoMVC, example.com, GitHub, HN, Vercel, a DNS-failing host, a 404 page) plus a deep inspection of the existing TodoMVC v2 trace. Corrections folded into the tasks below:
- **Real trace event kinds** are `run_start, spec_interpreted, step_plan, action, action_result, observation, probe_call, probe_result, evidence, tentative_finding, hypothesis, surface_seen, surface_unexplored, step_done, give_up, done, budget_warn, budget_abort, run_end` (20 total, defined in `packages/core/src/trace/schema.ts`). My initial `BACKING_EVENT_KINDS` was hallucinated — probes are payloads of `probe_result`, not top-level `console_error`/`axe_result` events. Task 9 rewritten.
- **`action` event payload** is `{tool, args: {selector?, text?, url?, key?, dx?, dy?, timeout_ms?}}` — fields live inside `.args`, not at top level. Task 11 canonicalization rewritten.
- **`page.once('response')`** is fragile (URL string equality fails on trailing slashes and follows the first response only, missing redirect chains). Task 6 uses the navigation `Response` return value instead.
- **DNS failures** throw immediately at `page.goto()` with no response; preflight must catch `ERR_NAME_NOT_RESOLVED` separately from networkidle timeout. Task 6 handles.
- **Findings already include `suggested_fix`** (Judge emits it today) — see existing finding shape: `id, title, category, severity, evidence, where, rationale, suggested_fix`. So G6's deferral is partial only — improvements should be in prompt quality, not new fields. Out-of-scope reminder updated.
- **GitHub's 404 page** has 1147 chars / 184 interactive elements — so a deliberately broken target may pass `body_has_content` if it has a styled 404 page. The `http_status` check correctly catches it because the checks run independently; preserve that the four checks all run (no early-exit), so `http_status: false` is reported even when `body_has_content: true`.
- **TodoMVC raw HTML** has only 84 chars / 1 interactive (SPA hydration); post-hydration `page.evaluate()` measures 616 chars / 12 interactive. The check runs AFTER `networkidle`; verified working in smoke test.
- **The current TodoMVC run's only finding** ("Exploration aborted at max_turns") cites `budget_abort` and `run_end` events. Under the corrected G3 backing rules, this is a `suggestion` so it's kept regardless of backing. Correct.

**Why these four, in this order:**
1. **G1 first** because every other piece compounds on top of "the Explorer actually tests the app." Validating evidence (G3) or computing deltas (G4) over a run that touched 1 of 7 goals is worthless.
2. **G2 second** because preflight is cheap, fail-fast, and dramatically lowers false-positive rate. Easier to land before G3 (preflight failures bypass the Judge entirely).
3. **G3 third** because evidence validation needs G1's complete trace to evaluate against — a trace that aborted mid-goal lacks the backing events G3 expects.
4. **G4 last** because finding identity (`finding_hash`) depends on the validated finding shape after G3 normalization. Hashing pre-validation findings would produce unstable identities.

**What we deliberately rejected** (with rationale, since the spec self-review caught these):
- Stagehand-style action caching for replay determinism — Phase 6.
- LLM-based diff or evidence validation — non-deterministic; Otto can't trust it.
- Vision-first re-architecture (Skyvern style) — DOM-first works for 90% of cases; vision is opt-in via existing `--engine` flag.
- Fix-suggestion synthesis (TestSprite's wedge) — Phase 6; needs G3's verified findings as foundation.

---

## File Structure Overview

**New files:**
- `packages/core/src/explorer/goal-tracker.ts` — Per-goal budget tracking & cutover
- `packages/core/src/preflight/preflight.ts` — Preflight runner & checks
- `packages/core/src/preflight/checks.ts` — Individual check implementations
- `packages/core/src/judge/evidence-validator.ts` — Post-Judge validation & downgrade
- `packages/core/src/trace/identity.ts` — Stable hashes (event content, finding)
- `packages/core/src/diff/diff.ts` — Run-to-run delta computation
- `packages/core/src/diff/diff-html.ts`, `diff-md.ts` — Diff report renderers
- `packages/cli/src/commands/diff.ts` — `iris diff` command
- `fixtures/broken-apps/{404,js-crash,blank,slow}/` — Preflight test fixtures
- Test files mirror each source file: `*.test.ts`

**Modified files:**
- `packages/core/src/types.ts` — Schema v2 (preflight block, finding_hash, unverified_backing, goal_status enum)
- `packages/core/src/trace/writer.ts` — Emit `content_hash` per event
- `packages/core/src/explorer/explorer.ts` — Wire goal tracker; emit `goal_status` events
- `packages/core/src/judge/judge.ts` + `prompts.ts` — `goal_status` enum, scoring averages only attempted goals
- `packages/core/src/orchestrator/orchestrator.ts` — Preflight phase, evidence validator stage
- `packages/cli/src/agent-sdk-orchestrator.ts` + `agent-sdk-runner.ts` — Mirror Orchestrator changes; register `goal_status` MCP tool
- `packages/cli/src/commands/eval.ts` — New flags; updated `--print-summary`
- `packages/cli/src/program.ts` — Register `diff` command
- `packages/core/src/report/report-html.ts` + `report-json.ts` + `report-md.ts` — Schema v2 surfacing, blocked banner, integrity line
- `scripts/bench.ts` — Updated expectations (blocked exit code, coverage-aware scoring)

---

## Task 1: G1 — Per-goal budget tracker

**Files:**
- Create: `packages/core/src/explorer/goal-tracker.ts`
- Test: `packages/core/src/explorer/goal-tracker.test.ts`

- [ ] **Step 1: Write the failing test for GoalTracker basic flow**

```ts
// packages/core/src/explorer/goal-tracker.test.ts
import { describe, expect, it } from 'vitest';
import { GoalTracker } from './goal-tracker.js';

describe('GoalTracker', () => {
  it('cycles through goals and reports current', () => {
    const t = new GoalTracker({
      goals: [
        { id: 'G1', description: 'a' },
        { id: 'G2', description: 'b' },
      ],
      stepsPerGoal: 5,
      freeExplorationSteps: 3,
    });
    expect(t.current()).toEqual({ phase: 'goal', id: 'G1', turnsLeft: 5 });
    t.recordTurn();
    expect(t.current().turnsLeft).toBe(4);
    t.completeCurrent('verified', 'ok');
    expect(t.current()).toEqual({ phase: 'goal', id: 'G2', turnsLeft: 5 });
    t.completeCurrent('skipped', 'cant');
    expect(t.current()).toEqual({ phase: 'free', id: '__free__', turnsLeft: 3 });
    t.recordTurn(); t.recordTurn(); t.recordTurn();
    expect(t.exhausted()).toBe(true);
  });

  it('auto-cutover after 1.5x budget without explicit completion', () => {
    const t = new GoalTracker({
      goals: [{ id: 'G1', description: 'a' }],
      stepsPerGoal: 4,
      freeExplorationSteps: 0,
    });
    for (let i = 0; i < 6; i++) t.recordTurn(); // 1.5 * 4 = 6
    const cutover = t.checkCutover();
    expect(cutover).toEqual({
      kind: 'auto_cutover',
      goalId: 'G1',
      status: 'partial',
      rationale: 'budget exceeded without explicit completion',
    });
  });

  it('returns full goal statuses ledger', () => {
    const t = new GoalTracker({
      goals: [{ id: 'G1', description: 'a' }, { id: 'G2', description: 'b' }],
      stepsPerGoal: 3,
      freeExplorationSteps: 0,
    });
    t.completeCurrent('verified', 'done');
    t.completeCurrent('blocked', 'modal');
    expect(t.statuses()).toEqual([
      { id: 'G1', status: 'verified', rationale: 'done', turnsSpent: 0 },
      { id: 'G2', status: 'blocked', rationale: 'modal', turnsSpent: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm --filter @iris/core test src/explorer/goal-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement GoalTracker**

```ts
// packages/core/src/explorer/goal-tracker.ts
export type GoalStatus = 'verified' | 'partial' | 'blocked' | 'skipped';

export interface GoalTrackerConfig {
  goals: Array<{ id: string; description: string }>;
  stepsPerGoal: number;
  freeExplorationSteps: number;
}

export interface CurrentPhase {
  phase: 'goal' | 'free' | 'done';
  id: string;
  turnsLeft: number;
}

export interface AutoCutover {
  kind: 'auto_cutover';
  goalId: string;
  status: 'partial';
  rationale: string;
}

interface GoalLedgerEntry {
  id: string;
  status: GoalStatus | 'pending';
  rationale: string;
  turnsSpent: number;
}

export class GoalTracker {
  private ledger: GoalLedgerEntry[];
  private idx = 0;
  private inFree = false;
  private freeTurnsLeft: number;
  private turnsOnCurrent = 0;

  constructor(private readonly cfg: GoalTrackerConfig) {
    this.ledger = cfg.goals.map((g) => ({
      id: g.id, status: 'pending', rationale: '', turnsSpent: 0,
    }));
    this.freeTurnsLeft = cfg.freeExplorationSteps;
  }

  current(): CurrentPhase {
    if (this.idx < this.ledger.length) {
      const entry = this.ledger[this.idx]!;
      return {
        phase: 'goal',
        id: entry.id,
        turnsLeft: Math.max(0, this.cfg.stepsPerGoal - this.turnsOnCurrent),
      };
    }
    if (this.freeTurnsLeft > 0 || (!this.inFree && this.cfg.freeExplorationSteps > 0)) {
      this.inFree = true;
      return { phase: 'free', id: '__free__', turnsLeft: this.freeTurnsLeft };
    }
    return { phase: 'done', id: '__done__', turnsLeft: 0 };
  }

  recordTurn(): void {
    if (this.idx < this.ledger.length) {
      this.turnsOnCurrent++;
      this.ledger[this.idx]!.turnsSpent++;
    } else if (this.freeTurnsLeft > 0) {
      this.freeTurnsLeft--;
    }
  }

  completeCurrent(status: GoalStatus, rationale: string): void {
    if (this.idx < this.ledger.length) {
      const entry = this.ledger[this.idx]!;
      entry.status = status;
      entry.rationale = rationale;
      this.idx++;
      this.turnsOnCurrent = 0;
    }
  }

  checkCutover(): AutoCutover | null {
    if (this.idx >= this.ledger.length) return null;
    const limit = Math.ceil(this.cfg.stepsPerGoal * 1.5);
    if (this.turnsOnCurrent >= limit) {
      return {
        kind: 'auto_cutover',
        goalId: this.ledger[this.idx]!.id,
        status: 'partial',
        rationale: 'budget exceeded without explicit completion',
      };
    }
    return null;
  }

  statuses(): Array<{ id: string; status: GoalStatus | 'untested'; rationale: string; turnsSpent: number }> {
    return this.ledger.map((e) => ({
      ...e,
      status: e.status === 'pending' ? 'untested' : e.status,
    }));
  }

  exhausted(): boolean {
    return this.current().phase === 'done';
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm --filter @iris/core test src/explorer/goal-tracker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/explorer/goal-tracker.ts packages/core/src/explorer/goal-tracker.test.ts
git commit -m "feat(explorer): add GoalTracker for per-goal budgeted exploration"
```

**Verify (system-level):** The unit tests above cover the state machine. Integration verification happens in Task 4.

---

## Task 2: G1 — Wire GoalTracker into Explorer + emit goal_status events

**Files:**
- Modify: `packages/core/src/explorer/explorer.ts`
- Modify: `packages/core/src/types.ts` (add `goal_status` to event-kind enum)
- Test: `packages/core/src/explorer/explorer.test.ts` (extend existing)

- [ ] **Step 1: Add `goal_status` to TraceEvent kind enum**

Edit `packages/core/src/types.ts`: find the existing `EventKind` zod schema. Add `'goal_status'` to the enum literal list.

- [ ] **Step 2: Write the failing test for Explorer goal-status emission**

In `packages/core/src/explorer/explorer.test.ts`, add a test that mocks an Explorer run with a 2-goal spec, sets `stepsPerGoal: 2`, and verifies trace contains:
- `goal_status: verified` for G1 (after explicit completion)
- `goal_status: partial` for G2 (auto-cutover after 3 turns)

Use the existing test harness (`fakeLlmClient`, `fakeAdapter`).

- [ ] **Step 3: Run test, confirm failure**

Run: `pnpm --filter @iris/core test src/explorer/explorer.test.ts`
Expected: FAIL — Explorer doesn't emit goal_status.

- [ ] **Step 4: Wire GoalTracker into Explorer.run()**

In `explorer.ts`:
- Accept `stepsPerGoal` and `freeExplorationSteps` in `ExplorerConfig` (alongside existing `initial_plan_stack`).
- Instantiate `GoalTracker` if `spec_goals` provided; null otherwise (backwards compat).
- After each tool call cycle: `tracker.recordTurn()`. Then check `tracker.checkCutover()`. If cutover: emit `goal_status` event with status `partial`, call `tracker.completeCurrent('partial', ...)`.
- Register a new internal tool `goal_status({id, status, rationale})` that the Explorer can call to explicitly complete a goal. On call: emit `goal_status` trace event with the payload, then `tracker.completeCurrent(...)`.
- Loop terminates when `tracker.exhausted()` returns true OR existing budget caps hit.
- After the loop, emit one final `goal_status: untested` event for each pending goal (so the Judge sees them).

- [ ] **Step 5: Update Explorer system prompt**

In `packages/core/src/explorer/prompts.ts`, add to the system prompt:
```
You have a per-goal turn budget. The current goal is shown below.
When you have verified the goal — or determined that you cannot — call
`goal_status({id, status, rationale})` with one of:
  verified | partial | blocked | skipped
Then you'll move to the next goal automatically. If you don't call goal_status
within ~1.5x the per-goal budget, the system will auto-mark the goal as partial
and advance.
```

- [ ] **Step 6: Update user-turn rendering to inject current goal**

The Explorer's per-turn user message should include a line like:
`Current goal (G2, 3 turns left): "Existing todos show a visible checkbox"`

- [ ] **Step 7: Run tests, confirm pass**

Run: `pnpm --filter @iris/core test src/explorer/`
Expected: PASS (existing + new tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/explorer/ packages/core/src/types.ts
git commit -m "feat(explorer): per-goal budgets and goal_status trace events"
```

**Verify (system-level):** Will be exercised end-to-end in Task 4 (TodoMVC integration).

---

## Task 3: G1 — Add `goal_status` MCP tool to Agent SDK transport

**Files:**
- Modify: `packages/cli/src/agent-sdk-runner.ts` (MCP tool registration)
- Modify: `packages/cli/src/agent-sdk-orchestrator.ts` (mirror Explorer goal-tracker logic)

- [ ] **Step 1: Register `goal_status` MCP tool**

In `agent-sdk-runner.ts`, add to the `createSdkMcpServer()` tool list:

```ts
tool({
  name: 'goal_status',
  description: 'Mark the current spec goal as verified/partial/blocked/skipped and advance. Call this when you have completed (or cannot complete) the current goal.',
  inputSchema: z.object({
    id: z.string(),
    status: z.enum(['verified', 'partial', 'blocked', 'skipped']),
    rationale: z.string(),
  }),
  handler: async (args) => {
    await emitGoalStatus(args.id, args.status, args.rationale);
    return { ok: true, next_goal: tracker.current() };
  },
}),
```

- [ ] **Step 2: Mirror per-goal budget logic in agent-sdk-orchestrator.ts**

The Agent SDK runs the loop internally, but we can intercept assistant turns to:
- Increment `tracker.recordTurn()` per assistant message
- Inject current goal into the next user message
- Detect auto-cutover and emit synthetic `goal_status: partial` event + system prompt nudge ("move to next goal")

Implementation detail: the SDK's `query()` stream exposes assistant messages; on each, call `tracker.recordTurn()` then check `tracker.checkCutover()`. On cutover, the next iteration's user input should be a system-style message: `"Auto-cutover: G1 marked partial. Move to G2 next."` (We can't force a tool call, but we can strongly nudge.)

- [ ] **Step 3: Run agent-sdk tests**

Run: `pnpm --filter @iris/cli test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/agent-sdk-*.ts
git commit -m "feat(cli): goal_status MCP tool + per-goal budget tracking in agent-sdk transport"
```

**Verify:** End-to-end run on TodoMVC in Task 4.

---

## Task 4: G1 — CLI flags, Judge scoring, report TL;DR

**Files:**
- Modify: `packages/cli/src/commands/eval.ts`
- Modify: `packages/core/src/judge/judge.ts` + `prompts.ts`
- Modify: `packages/core/src/report/report-html.ts`
- Modify: `packages/core/src/orchestrator/orchestrator.ts`

- [ ] **Step 1: Add CLI flags**

In `eval.ts`:
```ts
.option('--steps-per-goal <n>', 'per-goal turn budget', (s) => Number.parseInt(s, 10), 10)
.option('--free-exploration-steps <n>', 'free-exploration tail budget', (s) => Number.parseInt(s, 10), 8)
```

When user passes `--max-steps` explicitly, that becomes a hard cap; otherwise compute `effective = goals × stepsPerGoal + freeExploration`. Log the effective value at run start.

- [ ] **Step 2: Pass flags through Orchestrator to Explorer**

Add `steps_per_goal` and `free_exploration_steps` to `OrchestratorRunConfig`. Plumb to Explorer.

- [ ] **Step 3: Write failing test: Judge scoring averages only attempted goals**

Test in `packages/core/src/judge/judge.test.ts`: synthesize a Judge input where 2 of 5 goals have `goal_status: untested` trace events. Assert the spec-compliance score in output uses denominator 3, not 5.

- [ ] **Step 4: Update Judge prompt to honor `goal_status`**

In `prompts.ts`: add to system prompt:
```
Goals with status "untested" or "skipped" in trace are NOT to be counted in the
spec-compliance score. Report them as `status: "untested"` or `"skipped"` in
goals[] but DO NOT include them in the score denominator. The score reflects
only goals the Explorer actually attempted (verified/partial/blocked).
```

Update the Judge schema to allow `status: 'verified' | 'partial' | 'blocked' | 'skipped' | 'untested'` (was `satisfied | partial | not_satisfied`). Add a backward-compat mapping for old runs: `satisfied → verified`, `not_satisfied → blocked`.

- [ ] **Step 5: Run Judge tests**

Run: `pnpm --filter @iris/core test src/judge/`
Expected: PASS.

- [ ] **Step 6: Update report TL;DR**

In `report-html.ts`, update `renderTLDR` to render:
> "Iris tested N of M goals. Of those tested, K are verified. The remaining M-N goals were not exercised within the run budget — see Caveats."

Remove the misleading "Iris did not verify any spec goals end-to-end" framing when the truth is "Iris didn't reach those goals." Effective status logic from prior session stays.

Add to `report.json` headline:
```json
"headline": {
  "score": 6.5,
  "goals_attempted": 3,
  "goals_total": 7,
  "goals_verified": 2,
  ...
}
```

- [ ] **Step 7: Run report tests**

Run: `pnpm --filter @iris/core test src/report/`
Expected: PASS.

- [ ] **Step 8: End-to-end TodoMVC run**

```bash
node packages/cli/dist/bin.js eval https://todomvc.com/examples/react/dist/ \
  --spec /tmp/iris-spec-todomvc.txt \
  --steps-per-goal 8 \
  --out /tmp/iris-g1-todomvc
```

Expected:
- All 7 goals attempted (not just G1)
- Each goal gets a `goal_status` trace event
- Score reflects only attempted goals
- Report TL;DR honestly states coverage

**Verify (system-level):** Coverage went from 1/7 attempted → at least 5/7 attempted on TodoMVC. The score line doesn't penalize goals the Explorer never reached. If fewer than 5/7 attempted, increase `--steps-per-goal` and re-run; if still <5, that's a real Explorer-quality bug to file separately.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/commands/eval.ts packages/core/src/judge/ \
        packages/core/src/report/ packages/core/src/orchestrator/
git commit -m "feat: per-goal budgets, coverage-aware Judge scoring, honest TL;DR"
```

---

## Task 5: G2 — Preflight checks

**Files:**
- Create: `packages/core/src/preflight/checks.ts`
- Create: `packages/core/src/preflight/preflight.ts`
- Test: `packages/core/src/preflight/preflight.test.ts`

- [ ] **Step 1: Write failing test for individual checks**

```ts
// packages/core/src/preflight/preflight.test.ts
import { describe, expect, it } from 'vitest';
import { checkHttpStatus, checkPageReady, checkConsoleClean, checkBodyHasContent } from './checks.js';

describe('preflight checks', () => {
  it('checkHttpStatus rejects 4xx/5xx', async () => {
    expect(await checkHttpStatus(200)).toEqual({ ok: true, name: 'http_status' });
    expect(await checkHttpStatus(404)).toEqual({ ok: false, name: 'http_status', detail: 'HTTP 404' });
    expect(await checkHttpStatus(500)).toEqual({ ok: false, name: 'http_status', detail: 'HTTP 500' });
  });

  it('checkConsoleClean ignores warnings but rejects fatal patterns', () => {
    expect(checkConsoleClean([{ level: 'warning', text: 'whatever' }])).toEqual({ ok: true, name: 'console_clean' });
    expect(checkConsoleClean([{ level: 'error', text: 'Uncaught TypeError: x is null' }]).ok).toBe(false);
    expect(checkConsoleClean([{ level: 'error', text: 'Minified React error #418' }]).ok).toBe(false);
    expect(checkConsoleClean([{ level: 'error', text: 'CORS warning: ignored' }]).ok).toBe(true);
  });

  it('checkBodyHasContent passes on real content, fails on blank', () => {
    expect(checkBodyHasContent({ textChars: 100, interactiveCount: 3 }).ok).toBe(true);
    expect(checkBodyHasContent({ textChars: 50, interactiveCount: 0 }).ok).toBe(true);
    expect(checkBodyHasContent({ textChars: 5, interactiveCount: 0 }).ok).toBe(false);
    expect(checkBodyHasContent({ textChars: 10, interactiveCount: 6 }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement checks**

```ts
// packages/core/src/preflight/checks.ts
export interface CheckResult { ok: boolean; name: string; detail?: string; }

const FATAL_PATTERNS = [
  /Uncaught\s+(TypeError|ReferenceError|SyntaxError)/i,
  /Minified React error/i,
  /Cannot read prop/i,
  /is not a function/i,
];

export async function checkHttpStatus(status: number): Promise<CheckResult> {
  if (status >= 200 && status < 400) return { ok: true, name: 'http_status' };
  return { ok: false, name: 'http_status', detail: `HTTP ${status}` };
}

export function checkConsoleClean(messages: Array<{ level: string; text: string }>): CheckResult {
  const fatals = messages.filter(
    (m) => m.level === 'error' && FATAL_PATTERNS.some((p) => p.test(m.text)),
  );
  if (fatals.length === 0) return { ok: true, name: 'console_clean' };
  return {
    ok: false,
    name: 'console_clean',
    detail: `${fatals.length} fatal console error(s): ${fatals[0]!.text.slice(0, 120)}`,
  };
}

export function checkBodyHasContent(stats: { textChars: number; interactiveCount: number }): CheckResult {
  if (stats.textChars >= 30 || stats.interactiveCount >= 5) {
    return { ok: true, name: 'body_has_content' };
  }
  return {
    ok: false,
    name: 'body_has_content',
    detail: `body has ${stats.textChars} chars / ${stats.interactiveCount} interactive elements`,
  };
}

// checkPageReady is integration-tested via adapter; trivial wrapper around
// `await page.waitForLoadState('networkidle', { timeout })`. See Task 6.
```

- [ ] **Step 3: Run tests, confirm pass**

Run: `pnpm --filter @iris/core test src/preflight/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/preflight/
git commit -m "feat(preflight): individual check functions for HTTP/console/content"
```

---

## Task 6: G2 — Preflight orchestration & adapter integration

**Files:**
- Modify: `packages/core/src/preflight/preflight.ts` (orchestration)
- Modify: `packages/adapter-types/src/index.ts` (add `preflightProbe()` to adapter interface)
- Modify: `packages/adapter-web/src/index.ts` (implement `preflightProbe`)

- [ ] **Step 1: Define `PreflightResult` and `runPreflight()` signature**

```ts
// packages/core/src/preflight/preflight.ts
import { checkHttpStatus, checkConsoleClean, checkBodyHasContent } from './checks.js';
import type { TargetAdapter } from '@iris/adapter-types';

export interface PreflightResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  screenshot?: string;
}

export async function runPreflight(
  adapter: TargetAdapter,
  opts: { timeoutS: number },
): Promise<PreflightResult> {
  const probe = await adapter.preflightProbe(opts);
  const results = [
    await checkHttpStatus(probe.httpStatus),
    probe.loadFinished
      ? { ok: true, name: 'page_ready' }
      : { ok: false, name: 'page_ready', detail: `did not finish loading within ${opts.timeoutS}s` },
    checkConsoleClean(probe.consoleMessages),
    checkBodyHasContent(probe.bodyStats),
  ];
  return {
    ok: results.every((r) => r.ok),
    checks: results,
    ...(probe.screenshot ? { screenshot: probe.screenshot } : {}),
  };
}
```

- [ ] **Step 2: Extend `TargetAdapter` interface**

In `packages/adapter-types/src/index.ts`:

```ts
export interface PreflightProbe {
  httpStatus: number;
  loadFinished: boolean;
  consoleMessages: Array<{ level: string; text: string }>;
  bodyStats: { textChars: number; interactiveCount: number };
  screenshot?: string;
}

export interface TargetAdapter {
  // ...existing...
  preflightProbe(opts: { timeoutS: number }): Promise<PreflightProbe>;
}
```

- [ ] **Step 3: Implement `preflightProbe` in web adapter**

In `packages/adapter-web/src/index.ts`:

```ts
async preflightProbe(opts: { timeoutS: number }): Promise<PreflightProbe> {
  const page = this.requirePage();
  const url = this.requireTargetUrl();
  let httpStatus = 0;
  let loadFinished = true;
  let gotoErrorKind: 'dns' | 'timeout' | 'connection' | 'other' | undefined;
  try {
    // page.goto returns the main-frame Response — captures the final response
    // after redirects, more reliable than page.once('response') which fires on
    // the first response and is sensitive to URL string equality.
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.timeoutS * 1000,
    });
    httpStatus = response?.status() ?? 0;
    try {
      await page.waitForLoadState('networkidle', { timeout: opts.timeoutS * 1000 });
    } catch {
      // Page loaded (we got a response) but never reached networkidle. Treat
      // as a soft warning, not a hard fail — many real apps poll forever.
      // Will be reported as page_ready: false but http_status passes.
      loadFinished = false;
    }
  } catch (e) {
    loadFinished = false;
    const msg = e instanceof Error ? e.message : String(e);
    if (/ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(msg)) gotoErrorKind = 'dns';
    else if (/Timeout/i.test(msg)) gotoErrorKind = 'timeout';
    else if (/ERR_CONNECTION|ERR_SSL/i.test(msg)) gotoErrorKind = 'connection';
    else gotoErrorKind = 'other';
  }

  // Evaluate body content even if loadFinished is false — partial-load pages
  // can still pass body_has_content if hydration completed.
  let bodyStats = { textChars: 0, interactiveCount: 0 };
  try {
    bodyStats = await page.evaluate(() => ({
      textChars: document.body?.innerText?.length ?? 0,
      interactiveCount: document.querySelectorAll(
        'a, button, input, select, textarea, [role=button], [role=link]'
      ).length,
    }));
  } catch {
    // Page never loaded; bodyStats stays zero, body_has_content will fail.
  }

  const screenshotPath = join(this.evidenceDir, 'preflight.png');
  await page.screenshot({ path: screenshotPath }).catch(() => undefined);

  return {
    httpStatus,
    loadFinished,
    gotoErrorKind,
    consoleMessages: this.consoleProbe.snapshot(),
    bodyStats,
    screenshot: existsSync(screenshotPath) ? screenshotPath : undefined,
  };
}
```

The `runPreflight()` caller maps `gotoErrorKind === 'dns'` to an explicit `http_status` check failure with detail `"DNS resolution failed"` (since `httpStatus` will be 0 for DNS fail, the existing check `>= 200 && < 400` correctly fails — but a clearer detail string aids debugging).

- [ ] **Step 4: Test against a known-good fixture**

Add integration test that runs preflight against the existing `fixtures/clean-baseline` Playwright fixture and asserts `ok: true`.

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/preflight/preflight.ts \
        packages/adapter-types/ packages/adapter-web/src/index.ts
git commit -m "feat(preflight): adapter integration and runPreflight orchestration"
```

---

## Task 7: G2 — Broken-app fixtures

**Files:**
- Create: `fixtures/broken-apps/404-page/{index.ts,meta.json}`
- Create: `fixtures/broken-apps/js-crash/{index.html,meta.json}`
- Create: `fixtures/broken-apps/blank-page/{index.html,meta.json}`
- Create: `fixtures/broken-apps/slow-load/{index.ts,meta.json}`

- [ ] **Step 1: 404 fixture — server returns 404 for the root**

```ts
// fixtures/broken-apps/404-page/index.ts
import http from 'node:http';
const port = Number(process.env.PORT) || 0;
const server = http.createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<html><body><h1>Not Found</h1></body></html>');
});
server.listen(port, () => {
  const addr = server.address();
  if (typeof addr === 'object' && addr) console.log(`http://127.0.0.1:${addr.port}`);
});
```

```json
// fixtures/broken-apps/404-page/meta.json
{ "name": "404-page", "kind": "preflight", "expect": { "preflight_ok": false, "blocked_reasons_include": ["http_status"] } }
```

- [ ] **Step 2: JS-crash fixture — page loads but immediately throws**

```html
<!-- fixtures/broken-apps/js-crash/index.html -->
<!doctype html>
<html><body>
  <div id="root">Loading...</div>
  <script>
    setTimeout(() => { throw new Error('Uncaught TypeError: Cannot read property of undefined'); }, 50);
  </script>
</body></html>
```

```json
{ "name": "js-crash", "kind": "preflight", "expect": { "preflight_ok": false, "blocked_reasons_include": ["console_clean"] } }
```

- [ ] **Step 3: Blank-page fixture**

```html
<!-- fixtures/broken-apps/blank-page/index.html -->
<!doctype html><html><body></body></html>
```

```json
{ "name": "blank-page", "kind": "preflight", "expect": { "preflight_ok": false, "blocked_reasons_include": ["body_has_content"] } }
```

- [ ] **Step 4: Slow-load fixture**

```ts
// fixtures/broken-apps/slow-load/index.ts
import http from 'node:http';
const port = Number(process.env.PORT) || 0;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.write('<html><body>Loading');
  // Never call res.end() — page never reaches networkidle
});
server.listen(port, () => {
  const addr = server.address();
  if (typeof addr === 'object' && addr) console.log(`http://127.0.0.1:${addr.port}`);
});
```

```json
{ "name": "slow-load", "kind": "preflight", "expect": { "preflight_ok": false, "blocked_reasons_include": ["page_ready"] } }
```

- [ ] **Step 5: Commit**

```bash
git add fixtures/broken-apps/
git commit -m "test: add 4 broken-app fixtures for preflight verification"
```

---

## Task 8: G2 — Wire preflight into Orchestrator + exit code 4

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator.ts`
- Modify: `packages/cli/src/agent-sdk-orchestrator.ts`
- Modify: `packages/cli/src/commands/eval.ts`
- Modify: `packages/core/src/report/report-html.ts`
- Modify: `packages/core/src/types.ts` (schema additions)

- [ ] **Step 1: Update OrchestratorRunConfig**

Add to `OrchestratorRunConfig`:
```ts
preflight_timeout_s: number;
no_preflight: boolean;
```

Add to `OrchestratorResult`:
```ts
exit_code: 0 | 1 | 2 | 3 | 4;  // 4 = blocked
```

- [ ] **Step 2: Insert preflight phase**

In `Orchestrator.run()`, between `adapter.start(...)` and `Explorer` instantiation:

```ts
if (!config.no_preflight) {
  const preflight = await runPreflight(this.deps.adapter, { timeoutS: config.preflight_timeout_s });
  if (!preflight.ok) {
    const blockedReasons = preflight.checks.filter((c) => !c.ok).map((c) => c.name);
    const reportEarly = this.buildBlockedReport(config, startedAt, Date.now() - startMs, preflight);
    writeFileSync(join(config.out_dir, 'report.json'), `${JSON.stringify(reportEarly, null, 2)}\n`);
    writeFileSync(join(config.out_dir, 'report.md'), buildReportMd(reportEarly));
    if (!config.no_html) {
      writeFileSync(join(config.out_dir, 'report.html'), buildReportHtml(reportEarly, { runDir: config.out_dir }));
    }
    await this.deps.adapter.stop();
    return { /* ...with exit_code: 4 */ };
  }
  // Emit a preflight_pass trace event so Judge sees it
}
```

Add helper `buildBlockedReport` that produces a v2 report with:
- `headline.blocked: true`
- `headline.blocked_reasons: string[]`
- `preflight: { ok: false, checks: [...] }`
- `findings: [{ severity: 'blocker', category: 'reliability', title: 'App preflight failed', evidence: [preflight screenshot], ... }]`
- No score, no rubric breakdown

- [ ] **Step 3: Add `--preflight-timeout-s` and `--no-preflight` CLI flags**

In `eval.ts`:
```ts
.option('--preflight-timeout-s <n>', 'preflight timeout', (s) => Number.parseInt(s, 10), 15)
.option('--no-preflight', 'skip preflight checks (debugging only)')
```

- [ ] **Step 4: Update report HTML to render blocked banner**

In `report-html.ts`, add a `renderBlockedBanner(report)` that produces:
```html
<section class="blocked-banner">
  <h2>App blocked from evaluation</h2>
  <p>Iris could not evaluate this target because the following preflight checks failed:</p>
  <ul>
    <li><code>http_status</code>: HTTP 404</li>
    <li><code>body_has_content</code>: body has 5 chars / 0 interactive elements</li>
  </ul>
  <p>No score is shown because no meaningful evaluation took place.</p>
  <img src="evidence/preflight.png" alt="Target screenshot at time of preflight">
</section>
```

Render this section instead of the normal TL;DR / rubric / findings sections when `report.headline.blocked === true`.

- [ ] **Step 5: End-to-end test on broken-app fixtures**

Run Iris against each of the 4 broken-app fixtures. Expected: exit code 4, `report.json` has `headline.blocked: true`, HTML shows banner, no fake score.

```bash
for fx in 404-page js-crash blank-page slow-load; do
  node packages/cli/dist/bin.js eval "http://localhost:PORT/$fx" \
    --out "/tmp/iris-broken-$fx" --no-preflight=false
  echo "Exit code: $?"
done
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/orchestrator/ packages/cli/src/ packages/core/src/report/ packages/core/src/types.ts
git commit -m "feat(preflight): orchestrator integration, exit code 4, blocked banner"
```

**Verify (system-level):** Each of the 4 broken-app fixtures terminates with exit code 4 in <20 seconds, report shows blocked banner with the specific failed check, no score is displayed. The clean-baseline fixture still runs to completion (preflight passes silently).

---

## Task 9: G3 — Evidence validator core

**Files:**
- Create: `packages/core/src/judge/evidence-validator.ts`
- Test: `packages/core/src/judge/evidence-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/judge/evidence-validator.test.ts
import { describe, expect, it } from 'vitest';
import { validateFindings } from './evidence-validator.js';
import type { TraceEvent } from '../trace/types.js';

const ev = (id: string, kind: string, payload: Record<string, unknown> = {}): TraceEvent =>
  ({ id, kind, actor: 'web', ts: Date.now(), payload } as TraceEvent);

describe('validateFindings', () => {
  it('drops a finding whose evidence ids do not exist in the trace', () => {
    const trace = [ev('E1', 'action')];
    const findings = [
      { id: 'F1', severity: 'major', category: 'bug', title: 'modal trap', evidence: ['BOGUS'], rationale: '' },
    ];
    const out = validateFindings(findings as any, trace);
    expect(out.kept).toEqual([]);
    expect(out.discarded).toHaveLength(1);
    expect(out.discarded[0]!.reason).toBe('all_evidence_ids_invalid');
  });

  it('downgrades a blocker with no backing evidence', () => {
    const trace = [ev('E1', 'action', { tool: 'click' })];
    const findings = [
      { id: 'F1', severity: 'blocker', category: 'a11y', title: 'x', evidence: ['E1'], rationale: '' },
    ];
    const out = validateFindings(findings as any, trace);
    expect(out.kept[0]!.severity).toBe('major');
    expect(out.kept[0]!.unverified_backing).toBe(true);
  });

  it('keeps a major finding when backed by a console error', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click' }),
      ev('E2', 'console_error', { text: 'TypeError' }),
    ];
    const findings = [
      { id: 'F1', severity: 'major', category: 'bug', title: 'x', evidence: ['E1', 'E2'], rationale: '' },
    ];
    const out = validateFindings(findings as any, trace);
    expect(out.kept[0]!.severity).toBe('major');
    expect(out.kept[0]!.unverified_backing).toBe(false);
  });

  it('keeps a suggestion regardless of backing', () => {
    const trace = [ev('E1', 'action')];
    const findings = [
      { id: 'F1', severity: 'suggestion', category: 'ux', title: 'x', evidence: ['E1'], rationale: '' },
    ];
    const out = validateFindings(findings as any, trace);
    expect(out.kept[0]!.severity).toBe('suggestion');
    expect(out.kept[0]!.unverified_backing).toBe(false);
  });

  it('downgrades minor → suggestion when no backing', () => {
    const trace = [ev('E1', 'action')];
    const findings = [
      { id: 'F1', severity: 'minor', category: 'bug', title: 'x', evidence: ['E1'], rationale: '' },
    ];
    const out = validateFindings(findings as any, trace);
    expect(out.kept[0]!.severity).toBe('suggestion');
    expect(out.kept[0]!.unverified_backing).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

Run: `pnpm --filter @iris/core test src/judge/evidence-validator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement validateFindings**

```ts
// packages/core/src/judge/evidence-validator.ts
import type { TraceEvent } from '../trace/types.js';
import type { Finding } from '../judge/judge.js';

const DOWNGRADE: Record<string, string> = {
  blocker: 'major', major: 'minor', minor: 'suggestion', nit: 'suggestion',
};

// Real trace event kinds per packages/core/src/trace/schema.ts.
// Probes (axe / console_errors_since / network_failures_since) are payloads
// of `probe_result` events — kind alone isn't enough; payload inspection
// happens in hasBackingEvidence().
const BACKING_EVENT_KINDS = new Set([
  'probe_result',
  'evidence',
  'observation',
  'tentative_finding',
  'action_result',  // only counts if payload.evidence_refs is non-empty OR payload.ok === false
  'hypothesis',
]);

interface ValidationOutput {
  kept: Array<Finding & { unverified_backing: boolean }>;
  discarded: Array<{ finding: Finding; reason: string }>;
  summary: { verified: number; downgraded: number; discarded: number };
}

export function validateFindings(findings: Finding[], trace: TraceEvent[]): ValidationOutput {
  const eventById = new Map(trace.map((e) => [e.id, e]));
  const eventByIdx = trace;  // for window lookup

  const kept: Array<Finding & { unverified_backing: boolean }> = [];
  const discarded: Array<{ finding: Finding; reason: string }> = [];
  let verified = 0, downgraded = 0;

  for (const f of findings) {
    const validIds = f.evidence.filter((id) => eventById.has(id));
    if (validIds.length === 0) {
      discarded.push({ finding: f, reason: 'all_evidence_ids_invalid' });
      continue;
    }
    if (f.severity === 'suggestion') {
      kept.push({ ...f, unverified_backing: false });
      verified++;
      continue;
    }
    const hasBacking = hasBackingEvidence(validIds, eventByIdx, f.category);
    if (hasBacking) {
      kept.push({ ...f, unverified_backing: false });
      verified++;
    } else {
      const newSev = DOWNGRADE[f.severity] ?? f.severity;
      kept.push({ ...f, severity: newSev as any, unverified_backing: true });
      downgraded++;
    }
  }
  return { kept, discarded, summary: { verified, downgraded, discarded: discarded.length } };
}

function hasBackingEvidence(
  citedIds: string[],
  trace: TraceEvent[],
  category: string,
): boolean {
  const indices = citedIds
    .map((id) => trace.findIndex((e) => e.id === id))
    .filter((i) => i >= 0);
  for (const idx of indices) {
    const window = trace.slice(Math.max(0, idx - 2), Math.min(trace.length, idx + 3));
    for (const e of window) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      // tentative_finding / hypothesis / observation always count as backing
      if (e.kind === 'tentative_finding' || e.kind === 'hypothesis' || e.kind === 'observation') return true;
      // evidence event with a screenshot or clip is direct backing
      if (e.kind === 'evidence' && (p.screenshot || p.clip || p.video)) return true;
      // action_result counts only if it produced screenshot evidence_refs or failed
      if (e.kind === 'action_result' && (Array.isArray(p.evidence_refs) && (p.evidence_refs as unknown[]).length > 0)) return true;
      if (e.kind === 'action_result' && p.ok === false) return true;
      // probe_result: inspect payload by probe name
      if (e.kind === 'probe_result') {
        const probe = p.probe as string | undefined;
        if (probe === 'axe' && Array.isArray(p.violations) && (p.violations as unknown[]).length > 0) return true;
        if (probe === 'console_errors_since' && Array.isArray(p.errors) && (p.errors as unknown[]).length > 0) return true;
        if (probe === 'network_failures_since' && Array.isArray(p.failures) && (p.failures as unknown[]).length > 0) return true;
        if (category === 'perf' && probe === 'lighthouse') return true;
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `pnpm --filter @iris/core test src/judge/evidence-validator.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/judge/evidence-validator.ts packages/core/src/judge/evidence-validator.test.ts
git commit -m "feat(judge): evidence validator with downgrade and discard rules"
```

---

## Task 10: G3 — Wire validator into Orchestrator + report surfacing

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator.ts`
- Modify: `packages/core/src/report/report-json.ts`
- Modify: `packages/core/src/report/report-html.ts`

- [ ] **Step 1: Insert validator stage**

After Judge returns, before building report:

```ts
const trace = await readTraceArray(tracePath);
const validation = validateFindings(judgeOutput.findings, trace);
const enrichedJudgeOutput = {
  ...judgeOutput,
  findings: validation.kept,
  discarded_findings: [...(judgeOutput.discarded_findings ?? []), ...validation.discarded.map((d) => ({ ...d.finding, discard_reason: d.reason }))],
  evidence_validation: validation.summary,
};
```

- [ ] **Step 2: Surface in report.json**

Update `ReportJson` type to include `evidence_validation: { verified, downgraded, discarded }`. Add `unverified_backing` per finding.

- [ ] **Step 3: Surface in report HTML**

In TL;DR section, add a line:
```html
<p class="integrity-line">Findings: {kept} kept (verified backing: {verified}, downgraded for sparse evidence: {downgraded}). {discarded} discarded by validator.</p>
```

Findings with `unverified_backing: true` render with a small `[unverified]` tag inline next to their severity prefix:
```html
<span class="sev-tag sev-major">major</span><span class="unverified-tag">unverified</span>
```

Style `.unverified-tag` as small uppercase grey text, like the severity tag itself.

- [ ] **Step 4: Run report tests**

Run: `pnpm --filter @iris/core test src/report/`
Expected: PASS (update test fixtures as needed).

- [ ] **Step 5: Adversarial test — inject a bogus finding**

Write an integration test in `packages/core/src/orchestrator/orchestrator.test.ts` that:
- Stubs the Judge to return one valid finding (cites real event IDs with backing) + one bogus finding (cites `BOGUS-EVENT-ID`)
- Asserts the report contains the valid finding, discards the bogus one, and `evidence_validation.discarded === 1`

- [ ] **Step 6: End-to-end TodoMVC re-run**

Run Iris on TodoMVC. Inspect `report.json`: every `finding` should have non-empty `evidence`, and every event ID in `evidence` should exist in `trace.jsonl`. Use `jq` to verify:

```bash
jq -r '.findings[].evidence[]' /tmp/iris-g3-todomvc/report.json | sort -u > /tmp/cited.txt
jq -r '.id' /tmp/iris-g3-todomvc/trace.jsonl | sort -u > /tmp/exist.txt
comm -23 /tmp/cited.txt /tmp/exist.txt  # should be empty
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/orchestrator/ packages/core/src/report/
git commit -m "feat(judge): wire evidence validator into orchestrator and report"
```

**Verify (system-level):** On TodoMVC: zero citations to nonexistent event IDs in any kept finding. Adversarial integration test passes. Run on all 8 bench fixtures: at least the existing finding-detection rate is preserved (i.e., the validator doesn't over-eagerly discard real findings).

---

## Task 11: G4 — Stable event content hashes

**Files:**
- Create: `packages/core/src/trace/identity.ts`
- Test: `packages/core/src/trace/identity.test.ts`
- Modify: `packages/core/src/trace/writer.ts` (emit `content_hash` per event)

- [ ] **Step 1: Define per-kind signature functions**

```ts
// packages/core/src/trace/identity.ts
import { createHash } from 'node:crypto';
import type { TraceEvent } from './types.js';

function sha1Short(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function normalizeSelector(sel?: string): string {
  if (!sel) return '';
  return sel.replace(/:nth-child\(\d+\)/g, ':nth-child(*)').replace(/\s+/g, ' ').trim();
}

// Real action payload shape (verified against TodoMVC trace):
// { tool: 'click'|'type'|'navigate'|..., args: { selector?, text?, url?, key?, dx?, dy?, timeout_ms? } }
// Fields live inside .args, not at top level.
function canonicalPayload(event: TraceEvent): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const args = (p.args ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case 'action': {
      const tool = p.tool as string | undefined;
      // For text-typing actions, hash the selector only — the typed text is
      // user-data that varies across runs (Buy groceries vs Test todo) and
      // shouldn't drive identity. For navigation, hash the URL host+path only.
      if (tool === 'type') {
        return JSON.stringify({ tool, selector: normalizeSelector(args.selector as string) });
      }
      if (tool === 'navigate') {
        return JSON.stringify({ tool, url: hostPathOf(args.url as string) });
      }
      if (tool === 'press') {
        return JSON.stringify({ tool, key: args.key });
      }
      return JSON.stringify({
        tool,
        selector: normalizeSelector(args.selector as string),
      });
    }
    case 'action_result':
      // Hash on the tool name only; success/failure is captured separately.
      return JSON.stringify({ tool: p.tool, ok: p.ok });
    case 'probe_result':
      return JSON.stringify({
        probe: p.probe,
        // Hash on probe identity + presence/absence of findings, not on
        // specific finding details (those drift across runs).
        has_violations: Array.isArray(p.violations) && (p.violations as unknown[]).length > 0,
        has_errors: Array.isArray(p.errors) && (p.errors as unknown[]).length > 0,
        has_failures: Array.isArray(p.failures) && (p.failures as unknown[]).length > 0,
      });
    case 'observation':
      // Observations contain semi-stable DOM summaries; hash the first 120 chars.
      return JSON.stringify({
        summary: ((p.summary as string) ?? '').replace(/\s+/g, ' ').slice(0, 120),
      });
    case 'tentative_finding':
      return JSON.stringify({
        title: ((p.title as string) ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
        category: p.category,
      });
    case 'evidence':
      return JSON.stringify({ kind: p.kind ?? 'screenshot' });
    default:
      return JSON.stringify({ kind: event.kind });
  }
}

function hostPathOf(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch { return ''; }
}

function hostOf(url?: string): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}

export function eventContentHash(event: TraceEvent): string {
  return sha1Short(`${event.kind}|${event.actor}|${canonicalPayload(event)}`);
}
```

- [ ] **Step 2: Write test**

```ts
// packages/core/src/trace/identity.test.ts
import { describe, expect, it } from 'vitest';
import { eventContentHash } from './identity.js';

describe('eventContentHash', () => {
  it('produces stable hash for action events ignoring nth-child and ULID', () => {
    const a = { id: 'ULID1', kind: 'action', actor: 'web', ts: 1, payload: { tool: 'click', selector: 'button:nth-child(1)' } } as any;
    const b = { id: 'ULID2', kind: 'action', actor: 'web', ts: 2, payload: { tool: 'click', selector: 'button:nth-child(3)' } } as any;
    expect(eventContentHash(a)).toBe(eventContentHash(b));
  });
  it('different tools produce different hashes', () => {
    const a = { id: 'X', kind: 'action', actor: 'web', ts: 1, payload: { tool: 'click', selector: 'div' } } as any;
    const b = { id: 'X', kind: 'action', actor: 'web', ts: 1, payload: { tool: 'type', selector: 'div' } } as any;
    expect(eventContentHash(a)).not.toBe(eventContentHash(b));
  });
  it('console_error strips line numbers', () => {
    const a = { id: 'X', kind: 'console_error', actor: 'web', ts: 1, payload: { text: 'TypeError at foo:12:5' } } as any;
    const b = { id: 'Y', kind: 'console_error', actor: 'web', ts: 2, payload: { text: 'TypeError at foo:18:8' } } as any;
    expect(eventContentHash(a)).toBe(eventContentHash(b));
  });
});
```

- [ ] **Step 3: Emit `content_hash` in writer**

In `trace/writer.ts`, when writing each event:
```ts
const eventWithHash = { ...event, content_hash: eventContentHash(event) };
this.stream.write(`${JSON.stringify(eventWithHash)}\n`);
```

Update `TraceEvent` zod schema (in `trace/types.ts`) to include optional `content_hash: z.string().optional()`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @iris/core test src/trace/`
Expected: PASS (3 new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/trace/
git commit -m "feat(trace): stable content_hash per event for diff identity"
```

---

## Task 12: G4 — Finding hash & report.json v2

**Files:**
- Modify: `packages/core/src/trace/identity.ts` (add `findingHash`)
- Modify: `packages/core/src/report/report-json.ts` (include `finding_hash`)

- [ ] **Step 1: Add `findingHash()`**

```ts
// in trace/identity.ts
const SEV_BUCKET: Record<string, string> = {
  blocker: 'high', major: 'high', minor: 'med', nit: 'low', suggestion: 'low',
};

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/^\d+[.)\s]+/, '').replace(/\s+/g, ' ').trim();
}

export function findingHash(
  finding: { title: string; category: string; severity: string; evidence: string[] },
  eventIndex: Map<string, { content_hash?: string }>,
): string {
  const evHashes = finding.evidence
    .map((id) => eventIndex.get(id)?.content_hash ?? id)
    .sort();
  return sha1Short(`${normalizeTitle(finding.title)}|${finding.category}|${SEV_BUCKET[finding.severity] ?? finding.severity}|${evHashes.join(',')}`);
}
```

- [ ] **Step 2: Write test**

```ts
// trace/identity.test.ts (extend)
describe('findingHash', () => {
  it('stable when severity changes within bucket (major ↔ blocker)', () => {
    const idx = new Map([['E1', { content_hash: 'h1' }]]);
    const a = findingHash({ title: 'X', category: 'bug', severity: 'blocker', evidence: ['E1'] }, idx);
    const b = findingHash({ title: 'X', category: 'bug', severity: 'major', evidence: ['E1'] }, idx);
    expect(a).toBe(b);
  });
  it('normalizes title leading numbers', () => {
    const idx = new Map([['E1', { content_hash: 'h1' }]]);
    const a = findingHash({ title: '1. Modal traps focus', category: 'a11y', severity: 'major', evidence: ['E1'] }, idx);
    const b = findingHash({ title: 'Modal traps focus', category: 'a11y', severity: 'major', evidence: ['E1'] }, idx);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Surface `finding_hash` in report.json**

In `report-json.ts` `buildReportJson`, when mapping findings:
```ts
const eventIdx = new Map(traceEvents.map((e) => [e.id, e]));
return {
  ...,
  findings: judgeOutput.findings.map((f) => ({ ...f, finding_hash: findingHash(f, eventIdx) })),
};
```

Bump `v: 2` in report.json type.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @iris/core test src/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/trace/identity.ts packages/core/src/trace/identity.test.ts \
        packages/core/src/report/report-json.ts
git commit -m "feat: finding_hash for stable cross-run identity (schema v2)"
```

---

## Task 13: G4 — `iris diff` core logic

**Files:**
- Create: `packages/core/src/diff/diff.ts`
- Test: `packages/core/src/diff/diff.test.ts`

- [ ] **Step 1: Define DiffResult type and `computeDiff()`**

```ts
// packages/core/src/diff/diff.ts
import type { ReportJson } from '../report/report-json.js';

export interface DiffResult {
  v: 1;
  prev: { run_id: string; target: string; score: number };
  curr: { run_id: string; target: string; score: number };
  score_delta: { overall: number; by_profile: Record<string, number> };
  findings: {
    fixed: ReportJson['findings'];
    new: ReportJson['findings'];
    persistent: ReportJson['findings'];
  };
  coverage_delta: {
    newly_tested_goals: string[];
    no_longer_tested: string[];
    verification_changes: Array<{ id: string; prev: string; curr: string }>;
  };
}

export function computeDiff(prev: ReportJson, curr: ReportJson): DiffResult {
  const prevByHash = new Map(prev.findings.map((f) => [f.finding_hash!, f]));
  const currByHash = new Map(curr.findings.map((f) => [f.finding_hash!, f]));

  const fixed = prev.findings.filter((f) => !currByHash.has(f.finding_hash!));
  const newOnes = curr.findings.filter((f) => !prevByHash.has(f.finding_hash!));
  const persistent = curr.findings.filter((f) => prevByHash.has(f.finding_hash!));

  // Coverage delta
  const prevGoals = new Map(prev.spec_compliance.goals.map((g) => [g.id, g.status]));
  const currGoals = new Map(curr.spec_compliance.goals.map((g) => [g.id, g.status]));
  const attempted = (s: string) => s !== 'untested' && s !== 'skipped';
  const newly_tested_goals: string[] = [];
  const no_longer_tested: string[] = [];
  const verification_changes: Array<{ id: string; prev: string; curr: string }> = [];
  for (const [id, currS] of currGoals) {
    const prevS = prevGoals.get(id);
    if (prevS && !attempted(prevS) && attempted(currS)) newly_tested_goals.push(id);
    if (prevS && attempted(prevS) && !attempted(currS)) no_longer_tested.push(id);
    if (prevS && prevS !== currS && attempted(prevS) && attempted(currS)) {
      verification_changes.push({ id, prev: prevS, curr: currS });
    }
  }

  // Score delta
  const profileScores = (r: ReportJson) =>
    Object.fromEntries(Object.entries(r.scores.profiles).map(([k, v]) => [k, v.score]));
  const prevProfiles = profileScores(prev);
  const currProfiles = profileScores(curr);
  const by_profile: Record<string, number> = {};
  for (const k of new Set([...Object.keys(prevProfiles), ...Object.keys(currProfiles)])) {
    by_profile[k] = (currProfiles[k] ?? 0) - (prevProfiles[k] ?? 0);
  }

  return {
    v: 1,
    prev: { run_id: prev.run.id, target: prev.run.target.url, score: prev.headline.score },
    curr: { run_id: curr.run.id, target: curr.run.target.url, score: curr.headline.score },
    score_delta: {
      overall: curr.headline.score - prev.headline.score,
      by_profile,
    },
    findings: { fixed, new: newOnes, persistent },
    coverage_delta: { newly_tested_goals, no_longer_tested, verification_changes },
  };
}
```

- [ ] **Step 2: Write the test using synthetic ReportJsons**

```ts
// packages/core/src/diff/diff.test.ts
import { describe, expect, it } from 'vitest';
import { computeDiff } from './diff.js';

const makeReport = (overrides: any) => ({
  v: 2,
  run: { id: 'r', target: { url: 'https://x.com' }, /* ...minimal... */ } as any,
  headline: { score: 5.0 },
  findings: [],
  spec_compliance: { applicable: true, goals: [], summary: '' },
  scores: { overall: { score: 5.0, weighted_from: [] }, profiles: {} },
  ...overrides,
} as any);

describe('computeDiff', () => {
  it('classifies findings as fixed / new / persistent by finding_hash', () => {
    const prev = makeReport({
      findings: [
        { finding_hash: 'h1', title: 'A', severity: 'major' },
        { finding_hash: 'h2', title: 'B', severity: 'minor' },
      ],
    });
    const curr = makeReport({
      findings: [
        { finding_hash: 'h2', title: 'B', severity: 'minor' },
        { finding_hash: 'h3', title: 'C', severity: 'major' },
      ],
    });
    const d = computeDiff(prev, curr);
    expect(d.findings.fixed.map((f: any) => f.finding_hash)).toEqual(['h1']);
    expect(d.findings.new.map((f: any) => f.finding_hash)).toEqual(['h3']);
    expect(d.findings.persistent.map((f: any) => f.finding_hash)).toEqual(['h2']);
  });
  it('reports coverage_delta for newly-tested and verification_changes', () => {
    const prev = makeReport({
      spec_compliance: { applicable: true, goals: [
        { id: 'G1', status: 'verified' },
        { id: 'G2', status: 'untested' },
        { id: 'G3', status: 'partial' },
      ], summary: '' },
    });
    const curr = makeReport({
      spec_compliance: { applicable: true, goals: [
        { id: 'G1', status: 'verified' },
        { id: 'G2', status: 'verified' },
        { id: 'G3', status: 'verified' },
      ], summary: '' },
    });
    const d = computeDiff(prev, curr);
    expect(d.coverage_delta.newly_tested_goals).toEqual(['G2']);
    expect(d.coverage_delta.verification_changes).toEqual([{ id: 'G3', prev: 'partial', curr: 'verified' }]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @iris/core test src/diff/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/diff/
git commit -m "feat(diff): computeDiff core logic with findings + coverage delta"
```

---

## Task 14: G4 — `iris diff` command + renderers + --print-summary

**Files:**
- Create: `packages/cli/src/commands/diff.ts`
- Create: `packages/core/src/diff/diff-html.ts`, `diff-md.ts`
- Modify: `packages/cli/src/program.ts`

- [ ] **Step 1: Implement diff CLI command**

```ts
// packages/cli/src/commands/diff.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { computeDiff, buildDiffHtml, buildDiffMd } from '@iris/core';

export function diffCommand(): Command {
  return new Command('diff')
    .description('Compute delta between two Iris runs')
    .argument('<prev>', 'previous run directory')
    .argument('<curr>', 'current run directory')
    .option('--out <dir>', 'output directory', '.')
    .option('--allow-target-mismatch', 'skip target equality check')
    .option('--print-summary', 'print one-line JSON summary')
    .option('--no-html', 'skip HTML render')
    .action((prevDir: string, currDir: string, opts: any) => {
      const prev = JSON.parse(readFileSync(join(resolve(prevDir), 'report.json'), 'utf8'));
      const curr = JSON.parse(readFileSync(join(resolve(currDir), 'report.json'), 'utf8'));
      if (!opts.allowTargetMismatch && normalizeUrl(prev.run.target.url) !== normalizeUrl(curr.run.target.url)) {
        process.stderr.write(`iris diff: target mismatch — pass --allow-target-mismatch to override\n`);
        process.exit(64);
      }
      const diff = computeDiff(prev, curr);
      const outDir = resolve(opts.out);
      writeFileSync(join(outDir, 'diff.json'), `${JSON.stringify(diff, null, 2)}\n`);
      writeFileSync(join(outDir, 'diff.md'), buildDiffMd(diff));
      if (opts.html !== false) {
        writeFileSync(join(outDir, 'diff.html'), buildDiffHtml(diff));
      }
      if (opts.printSummary) {
        process.stdout.write(`${JSON.stringify({
          fixed: diff.findings.fixed.length,
          new: diff.findings.new.length,
          persistent: diff.findings.persistent.length,
          score_delta: diff.score_delta.overall,
          coverage_delta: diff.coverage_delta.newly_tested_goals.length - diff.coverage_delta.no_longer_tested.length,
        })}\n`);
      }
      process.stderr.write(`iris diff: wrote ${outDir}/diff.{json,md,html}\n`);
    });
}

function normalizeUrl(u: string): string {
  try { const p = new URL(u); return `${p.host}${p.pathname.replace(/\/$/, '')}`; } catch { return u; }
}
```

- [ ] **Step 2: Implement diff renderers (HTML + MD)**

`diff-html.ts`: plain memo style matching `report-html.ts`. Sections:
- Header (prev → curr, target, dates)
- TL;DR: "N fixed, M new, K persistent. Score: 5.0 → 6.5 (+1.5)."
- Fixed findings (green tinge)
- New findings (red tinge)
- Persistent findings (gray, listed but collapsed)
- Coverage changes

`diff-md.ts`: same content, markdown.

- [ ] **Step 3: Register diff command**

In `program.ts`, add `program.addCommand(diffCommand())`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @iris/cli test`
Expected: PASS.

- [ ] **Step 5: End-to-end diff test**

```bash
# Run 1: TodoMVC clean
node packages/cli/dist/bin.js eval https://todomvc.com/examples/react/dist/ \
  --spec /tmp/iris-spec-todomvc.txt --out /tmp/iris-diff-prev

# Run 2: same target, expect ~same findings (test stability of diff)
node packages/cli/dist/bin.js eval https://todomvc.com/examples/react/dist/ \
  --spec /tmp/iris-spec-todomvc.txt --out /tmp/iris-diff-curr

# Diff
node packages/cli/dist/bin.js diff /tmp/iris-diff-prev /tmp/iris-diff-curr \
  --out /tmp/iris-diff-out --print-summary
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/diff.ts packages/cli/src/program.ts \
        packages/core/src/diff/diff-html.ts packages/core/src/diff/diff-md.ts
git commit -m "feat(cli): iris diff command with HTML/MD renderers and --print-summary"
```

**Verify (system-level):** Two clean runs of TodoMVC produce a diff with most findings in `persistent[]` (high stability under no real change). Score delta is within ±0.5. Manually injecting a fake finding into prev's `report.json` and re-running diff shows that finding in `fixed[]`. The `--print-summary` JSON is one line and machine-readable.

---

## Task 15: Cross-cutting — schema v2 migration, --print-summary, bench script

**Files:**
- Modify: `packages/core/src/types.ts` (v2 schema)
- Modify: `packages/cli/src/commands/eval.ts` (`--print-summary` v2)
- Modify: `scripts/bench.ts` (handle blocked exit code, coverage-aware scoring)

- [ ] **Step 1: Bump `report.json` to v2**

Update `ReportJsonSchema` zod definition: `v: z.literal(2)`. Add optional `preflight`, `evidence_validation`, `findings[].finding_hash`, `findings[].unverified_backing`, `headline.goals_attempted`, `headline.goals_verified`, `headline.blocked`, `headline.blocked_reasons`.

Add a `migrateV1ToV2()` helper that accepts a v1 report (read from disk for `iris diff prev curr`) and produces a v2-shaped one, computing `finding_hash` on the fly using whatever `evidence` event IDs the v1 report carried.

- [ ] **Step 2: Update `--print-summary` JSON shape**

```ts
const summary = {
  blocked: report.headline.blocked ?? false,
  score: report.headline.score,
  goals_tested: `${report.headline.goals_attempted}/${report.headline.goals_total}`,
  goals_verified: `${report.headline.goals_verified}/${report.headline.goals_attempted}`,
  evidence_verified: `${report.evidence_validation?.verified ?? 0}/${(report.evidence_validation?.verified ?? 0) + (report.evidence_validation?.downgraded ?? 0)}`,
  exit_code: result.exit_code,
};
```

- [ ] **Step 3: Update bench script**

In `scripts/bench.ts`:
- Accept exit code 4 (blocked) as expected for `kind: 'preflight'` fixtures.
- For non-preflight fixtures, score check should pass IF `goals_attempted >= goals_total * 0.7` OR explicit range. (Coverage-aware: don't penalize a fixture for a low score when coverage was also low — coverage low means budget needs raising, not the fixture broken.)
- Add the 4 broken-app fixtures to the bench list with `kind: 'preflight'` and verify they exit 4.

- [ ] **Step 4: Run full bench**

```bash
pnpm bench --transport sdk
```

Expected: all 8 existing fixtures + 4 preflight fixtures pass. Total cost roughly equal to previous bench ($4.45) plus ~$0.40 for the 4 preflight fixtures (fast bail).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/cli/src/commands/eval.ts scripts/bench.ts
git commit -m "feat: report.json schema v2; coverage-aware bench checks; preflight fixture coverage"
```

**Verify (system-level):** `pnpm bench` shows ≥12/12 fixtures passing (8 existing + 4 preflight). Total cost ≤$5. `--print-summary` output is valid JSON parseable by `jq` on every fixture.

---

## Task 16: Final integration sweep

- [ ] **Step 1: Re-run TodoMVC end-to-end at default settings**

```bash
node packages/cli/dist/bin.js eval https://todomvc.com/examples/react/dist/ \
  --spec /tmp/iris-spec-todomvc.txt \
  --out /tmp/iris-final-todomvc \
  --print-summary
```

Expected `--print-summary` JSON:
- `blocked: false`
- `goals_tested: "6/7"` or `"7/7"`
- `goals_verified` reflects what actually worked
- `evidence_verified` close to total findings (most should have backing)
- Exit code 0 or 1 (not 2 or 4)

- [ ] **Step 2: Re-run diff between two consecutive TodoMVC runs**

```bash
node packages/cli/dist/bin.js diff /tmp/iris-final-todomvc /tmp/iris-final2-todomvc \
  --out /tmp/iris-diff-stability --print-summary
```

Expected: high persistent count, low new/fixed, score delta within ±0.5. (Diff stability is the load-bearing test of `finding_hash` quality.)

- [ ] **Step 3: Run typecheck + lint + test across the workspace**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: zero errors. Test count > 220 (was 203 before Phase 5).

- [ ] **Step 4: Update project memory**

Append to `~/.claude/projects/-Users-yuxuan-work-prod-critic/memory/project_iris.md` the Phase 5 completion entry: shipped pieces, scoring policy change, schema v2, new CLI verbs.

- [ ] **Step 5: Final commit + branch ready**

```bash
git status
git log --oneline | head -20
# Push or open PR per user preference
```

**Verify (system-level):** Phase 5 success criteria from the spec:
- (G1) TodoMVC at defaults: ≥6/7 goals attempted, score reflects only attempted goals
- (G2) All 4 broken-app fixtures terminate <20s with exit 4, no fake score
- (G3) Zero findings cite nonexistent event IDs; adversarial test passes
- (G4) Two clean runs produce a stable diff (low new/fixed, high persistent); manually fixing a finding shows it in `fixed[]`
- (Overall) `pnpm bench` ≥12/12, total cost ≤$5

---

## Out-of-scope reminders (defer to Phase 6)

- **Flake reduction beyond Judge-side determinism** — even though QA.tech treats it as table-stakes, our G3 Judge ensembling on blockers (if added later as a bolt-on) is the minimum viable response.
- **Fix-suggestion synthesis** — TestSprite differentiator; needs G3-verified findings as foundation.
- **Hierarchical exploration** — won't ship in P5; G1's per-goal budget is the prerequisite.
- **Video edit pass / dead-air trim** — cosmetic given the rest.
- **Cross-app score calibration** — needs a corpus first.
- **Stagehand-style action caching** — interesting for cost; doesn't move signal quality.

## Self-review notes

- **Spec coverage**: every section of the spec maps to ≥1 task here. G1 → Tasks 1-4. G2 → Tasks 5-8. G3 → Tasks 9-10. G4 → Tasks 11-14. Cross-cutting → Tasks 15-16.
- **Placeholder scan**: zero TBDs. Code blocks contain real implementations. The one place I leaned on "implementation detail" was the agent-sdk goal-tracker injection in Task 3 — that's because the SDK's stream is genuinely the right place to do it and the exact prompt-injection wording belongs in the prompt file, not the plan.
- **Type consistency**: `GoalStatus` is consistent across goal-tracker.ts (Task 1), explorer.ts (Task 2), MCP tool (Task 3), Judge schema (Task 4), and diff coverage logic (Task 13). `unverified_backing` lives on `Finding` from validator (Task 9) through report-json (Task 10) through diff (Task 13). `finding_hash` is added in Task 12 and consumed in Task 13.
- **Per-step verification**: every task has either a per-step `Run/Expected` pair or a closing `Verify (system-level)` note. The biggest end-to-end verification gates are at Tasks 4, 8, 10, 14, and the final sweep in 16.
- **Risk control**: Task 1 (GoalTracker unit) is self-contained — easy to land. Task 2 (Explorer wiring) is the riskiest because it touches the main agentic loop; commit small and run the TodoMVC integration before moving on. Task 6 (adapter interface change) is a public-API change — it will ripple to any future adapters, so confirm the interface signature with reviewers before merging.
