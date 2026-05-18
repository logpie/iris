import type { TraceEvent } from '../trace/schema.js';
import type { JudgeOutput } from './judge.js';

type Goal = JudgeOutput['spec_compliance']['goals'][number];
type GoalStatus = Goal['status'];

export interface GoalStatusReconciliationSummary {
  corrected: number;
  reasons: string[];
}

export interface ExpectedJudgeGoal {
  id: string;
  description: string;
}

export function reconcileJudgeGoalStatusesWithTrace(input: {
  judge: JudgeOutput;
  trace: TraceEvent[];
  expected_goals?: ExpectedJudgeGoal[];
}): { judge: JudgeOutput; summary: GoalStatusReconciliationSummary } {
  const latestAll = latestGoalStatusById(input.trace);
  const expectedGoals = expectedGoalsById(input.trace, input.expected_goals);
  const latest =
    expectedGoals.size > 0 ? filterLatestGoalStatuses(latestAll, expectedGoals) : latestAll;
  if (!input.judge.spec_compliance.applicable && expectedGoals.size === 0) {
    return { judge: input.judge, summary: emptySummary() };
  }

  const reasons: string[] = [];
  const seenGoalIds = new Set<string>();
  const goals: Goal[] = [];
  for (const goal of input.judge.spec_compliance.goals) {
    if (expectedGoals.size > 0 && !expectedGoals.has(goal.id)) {
      reasons.push(
        `${goal.id}: removed unexpected Judge goal not present in discovery/proposed goals`,
      );
      continue;
    }
    seenGoalIds.add(goal.id);
    const status = latest.get(goal.id);
    if (!status) {
      goals.push(goal);
      continue;
    }
    if (status.status === 'verified' && hasGoalClaimValidatorVeto(goal)) {
      goals.push(goal);
      continue;
    }

    const statusChanged = goal.status !== status.status;
    const evidenceChanged = !sameStringArray(goal.evidence, status.evidence);
    const shouldReplaceNotes =
      statusChanged || !goal.notes?.trim() || hasContradictoryGoalStatusNote(goal.notes, status);
    if (!statusChanged && !evidenceChanged && !shouldReplaceNotes) {
      goals.push(goal);
      continue;
    }

    const changes: string[] = [];
    if (statusChanged) changes.push(`status ${goal.status} -> ${status.status}`);
    if (evidenceChanged) changes.push('evidence copied from latest goal_status');
    if (shouldReplaceNotes && status.rationale)
      changes.push('notes copied from latest goal_status');
    reasons.push(`${goal.id}: ${changes.join('; ')}`);

    goals.push({
      ...goal,
      status: status.status,
      evidence: status.evidence,
      notes: shouldReplaceNotes && status.rationale ? status.rationale : goal.notes,
    });
  }
  for (const [goalId, expected] of expectedGoals) {
    if (seenGoalIds.has(goalId)) continue;
    const status = latest.get(goalId);
    reasons.push(`${goalId}: added missing goal from trace`);
    goals.push({
      id: goalId,
      description: expected.description || goalId,
      status: status?.status ?? 'untested',
      evidence: status?.evidence ?? [],
      notes: status?.rationale || 'Goal was reconstructed from trace because Judge omitted it.',
    });
  }

  if (reasons.length === 0) return { judge: input.judge, summary: emptySummary() };

  const summary = {
    corrected: reasons.length,
    reasons,
  };

  return {
    judge: {
      ...input.judge,
      spec_compliance: {
        ...input.judge.spec_compliance,
        applicable: true,
        goals,
        summary: summarizeGoalStatuses(goals),
        goal_status_reconciliation: summary,
      },
    },
    summary,
  };
}

function hasGoalClaimValidatorVeto(goal: Goal): boolean {
  return goal.status === 'partial' && /\[goal-claim validator:/.test(goal.notes ?? '');
}

function expectedGoalsById(
  trace: TraceEvent[],
  explicitGoals: ExpectedJudgeGoal[] | undefined,
): Map<string, { description: string }> {
  const out = new Map<string, { description: string }>();
  for (const goal of explicitGoals ?? []) {
    const id = goal.id.trim();
    if (!id) continue;
    out.set(id, { description: goal.description || id });
  }
  if (out.size === 0) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const event = trace[i];
      if (!event || event.kind !== 'discovery') continue;
      const payload = (event.payload ?? {}) as { goals?: unknown };
      if (!Array.isArray(payload.goals)) break;
      for (const goal of payload.goals) {
        if (!goal || typeof goal !== 'object') continue;
        const g = goal as { id?: unknown; description?: unknown };
        const id = typeof g.id === 'string' ? g.id.trim() : '';
        if (!id) continue;
        out.set(id, {
          description: typeof g.description === 'string' ? g.description : id,
        });
      }
      break;
    }
  }
  for (const event of trace) {
    if (event.kind !== 'goal_proposed') continue;
    const payload = (event.payload ?? {}) as { id?: unknown; description?: unknown };
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!id) continue;
    out.set(id, {
      description: typeof payload.description === 'string' ? payload.description : id,
    });
  }
  return out;
}

export function expectedJudgeGoalsFromDescriptions(
  goals: Array<{ id?: string; description: string }> | undefined,
): ExpectedJudgeGoal[] | undefined {
  if (!goals || goals.length === 0) return undefined;
  const out: ExpectedJudgeGoal[] = [];
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i];
    if (!goal) continue;
    const id = typeof goal.id === 'string' && goal.id.trim() ? goal.id.trim() : `G${i + 1}`;
    const description = goal.description.trim();
    if (!description) continue;
    out.push({ id, description });
  }
  return out.length > 0 ? out : undefined;
}

export function expectedJudgeGoalsWithSequentialIds(
  goals: Array<{ description: string }> | undefined,
): ExpectedJudgeGoal[] | undefined {
  if (!goals || goals.length === 0) return undefined;
  const out: ExpectedJudgeGoal[] = [];
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i];
    const description = goal?.description.trim() ?? '';
    if (!description) continue;
    out.push({ id: `G${i + 1}`, description });
  }
  return out.length > 0 ? out : undefined;
}

function filterLatestGoalStatuses(
  latest: Map<string, { status: GoalStatus; evidence: string[]; rationale: string }>,
  expectedGoals: Map<string, { description: string }>,
): Map<string, { status: GoalStatus; evidence: string[]; rationale: string }> {
  const out = new Map<string, { status: GoalStatus; evidence: string[]; rationale: string }>();
  for (const [id, status] of latest) {
    if (expectedGoals.has(id)) out.set(id, status);
  }
  return out;
}

function latestGoalStatusById(trace: TraceEvent[]): Map<
  string,
  {
    status: GoalStatus;
    evidence: string[];
    rationale: string;
  }
> {
  const out = new Map<string, { status: GoalStatus; evidence: string[]; rationale: string }>();
  for (const event of trace) {
    if (event.kind !== 'goal_status') continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const status = normalizeGoalStatus(payload.status);
    if (!id || !status) continue;
    const evidence = Array.isArray(payload.evidence_event_ids)
      ? payload.evidence_event_ids
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
      : [];
    out.set(id, {
      status,
      evidence,
      rationale: typeof payload.rationale === 'string' ? payload.rationale.trim() : '',
    });
  }
  return out;
}

function normalizeGoalStatus(value: unknown): GoalStatus | undefined {
  const status = typeof value === 'string' ? value.trim() : '';
  if (status === 'satisfied') return 'verified';
  if (status === 'not_satisfied') return 'partial';
  if (
    status === 'verified' ||
    status === 'partial' ||
    status === 'blocked' ||
    status === 'skipped' ||
    status === 'untested'
  ) {
    return status;
  }
  return undefined;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function hasContradictoryGoalStatusNote(
  notes: string | undefined,
  status: { status: GoalStatus; evidence: string[]; rationale: string },
): boolean {
  const text = (notes ?? '').toLowerCase();
  if (!text) return false;
  if (status.status === 'verified') {
    return /\b(does not|did not|missing|incomplete|partial|not visibly|not visible|not shown|not prove)\b/.test(
      text,
    );
  }
  if (status.status === 'partial') {
    return /\b(fully verified|complete|succeeded|satisfies all|all required)\b/.test(text);
  }
  return false;
}

function summarizeGoalStatuses(goals: Goal[]): string {
  const attempted = goals.filter((goal) =>
    ['verified', 'partial', 'blocked'].includes(goal.status),
  ).length;
  const verified = goals.filter((goal) => goal.status === 'verified').length;
  const partial = goals.filter((goal) => goal.status === 'partial').length;
  const blocked = goals.filter((goal) => goal.status === 'blocked').length;
  const skippedOrUntested = goals.length - attempted;
  const parts = [
    `${verified} of ${attempted} attempted goal(s) verified from latest goal_status events`,
  ];
  if (partial > 0) parts.push(`${partial} partial`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (skippedOrUntested > 0) parts.push(`${skippedOrUntested} skipped/untested`);
  return `${parts.join('; ')}.`;
}

function emptySummary(): GoalStatusReconciliationSummary {
  return { corrected: 0, reasons: [] };
}
