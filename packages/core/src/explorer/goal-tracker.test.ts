import { describe, expect, it } from 'vitest';
import { GoalTracker } from './goal-tracker.js';

describe('GoalTracker', () => {
  it('cycles through goals and falls into free phase, then done', () => {
    const t = new GoalTracker({
      goals: [
        { id: 'G1', description: 'a' },
        { id: 'G2', description: 'b' },
      ],
      stepsPerGoal: 5,
      freeExplorationSteps: 3,
    });
    expect(t.current()).toMatchObject({ phase: 'goal', id: 'G1', turnsLeft: 5 });
    t.recordTurn();
    expect(t.current().turnsLeft).toBe(4);
    t.completeCurrent('verified', 'ok');
    expect(t.current()).toMatchObject({ phase: 'goal', id: 'G2', turnsLeft: 5 });
    t.completeCurrent('skipped', 'cant');
    expect(t.current()).toMatchObject({ phase: 'free', id: '__free__', turnsLeft: 3 });
    t.recordTurn();
    t.recordTurn();
    t.recordTurn();
    expect(t.exhausted()).toBe(true);
  });

  it('auto-cutover triggers after 1.5x budget without explicit completion', () => {
    const t = new GoalTracker({
      goals: [{ id: 'G1', description: 'a' }],
      stepsPerGoal: 4,
      freeExplorationSteps: 0,
    });
    for (let i = 0; i < 6; i++) t.recordTurn();
    const cutover = t.checkCutover();
    expect(cutover).toEqual({
      kind: 'auto_cutover',
      goalId: 'G1',
      status: 'partial',
      rationale: 'budget exceeded without explicit completion',
    });
  });

  it('does not trigger cutover before threshold', () => {
    const t = new GoalTracker({
      goals: [{ id: 'G1', description: 'a' }],
      stepsPerGoal: 4,
      freeExplorationSteps: 0,
    });
    for (let i = 0; i < 5; i++) t.recordTurn();
    expect(t.checkCutover()).toBeNull();
  });

  it('completeById can skip ahead and marks intervening goals as skipped', () => {
    const t = new GoalTracker({
      goals: [
        { id: 'G1', description: 'a' },
        { id: 'G2', description: 'b' },
        { id: 'G3', description: 'c' },
      ],
      stepsPerGoal: 3,
      freeExplorationSteps: 0,
    });
    const ok = t.completeById('G3', 'verified', 'done');
    expect(ok).toBe(true);
    const statuses = t.statuses();
    expect(statuses.map((s) => s.status)).toEqual(['skipped', 'skipped', 'verified']);
    expect(t.exhausted()).toBe(true);
  });

  it('returns full statuses ledger with rationale and turnsSpent', () => {
    const t = new GoalTracker({
      goals: [
        { id: 'G1', description: 'a' },
        { id: 'G2', description: 'b' },
      ],
      stepsPerGoal: 3,
      freeExplorationSteps: 0,
    });
    t.recordTurn();
    t.recordTurn();
    t.completeCurrent('verified', 'done');
    t.recordTurn();
    t.completeCurrent('blocked', 'modal');
    expect(t.statuses()).toEqual([
      { id: 'G1', description: 'a', status: 'verified', rationale: 'done', turnsSpent: 2 },
      { id: 'G2', description: 'b', status: 'blocked', rationale: 'modal', turnsSpent: 1 },
    ]);
  });

  it('effectiveMaxSteps = goals * stepsPerGoal + freeExploration', () => {
    const t = new GoalTracker({
      goals: [
        { id: 'G1', description: 'a' },
        { id: 'G2', description: 'b' },
        { id: 'G3', description: 'c' },
      ],
      stepsPerGoal: 8,
      freeExplorationSteps: 5,
    });
    expect(t.effectiveMaxSteps()).toBe(29);
  });

  it('untested goals remain untested if never reached', () => {
    const t = new GoalTracker({
      goals: [
        { id: 'G1', description: 'a' },
        { id: 'G2', description: 'b' },
      ],
      stepsPerGoal: 3,
      freeExplorationSteps: 0,
    });
    t.completeCurrent('verified', 'done');
    const statuses = t.statuses();
    expect(statuses.map((s) => s.status)).toEqual(['verified', 'untested']);
  });
});
