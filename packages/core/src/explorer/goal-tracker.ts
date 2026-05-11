// Per-goal budget tracker for the Explorer loop.
//
// Hands out a turn budget per spec goal, plus an optional free-exploration
// tail. The Explorer is expected to call `goal_status` when it has finished
// (or given up on) the current goal. If it never does, an auto-cutover kicks
// in after 1.5x the per-goal budget so a single goal cannot starve the rest.

export type GoalStatus = 'verified' | 'partial' | 'blocked' | 'skipped';

export interface GoalTrackerConfig {
  goals: Array<{ id: string; description: string }>;
  stepsPerGoal: number;
  freeExplorationSteps: number;
}

export interface CurrentPhase {
  phase: 'goal' | 'free' | 'done';
  id: string;
  description: string;
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
  description: string;
  status: GoalStatus | 'pending';
  rationale: string;
  turnsSpent: number;
}

export class GoalTracker {
  private readonly ledger: GoalLedgerEntry[];
  private idx = 0;
  private turnsOnCurrent = 0;
  private freeTurnsLeft: number;

  constructor(private readonly cfg: GoalTrackerConfig) {
    this.ledger = cfg.goals.map((g) => ({
      id: g.id,
      description: g.description,
      status: 'pending',
      rationale: '',
      turnsSpent: 0,
    }));
    this.freeTurnsLeft = cfg.freeExplorationSteps;
  }

  current(): CurrentPhase {
    if (this.idx < this.ledger.length) {
      const entry = this.ledger[this.idx];
      if (!entry) throw new Error('GoalTracker: missing ledger entry');
      return {
        phase: 'goal',
        id: entry.id,
        description: entry.description,
        turnsLeft: Math.max(0, this.cfg.stepsPerGoal - this.turnsOnCurrent),
      };
    }
    if (this.freeTurnsLeft > 0) {
      return {
        phase: 'free',
        id: '__free__',
        description: 'free exploration',
        turnsLeft: this.freeTurnsLeft,
      };
    }
    return { phase: 'done', id: '__done__', description: '', turnsLeft: 0 };
  }

  recordTurn(): void {
    if (this.idx < this.ledger.length) {
      this.turnsOnCurrent++;
      const entry = this.ledger[this.idx];
      if (entry) entry.turnsSpent++;
    } else if (this.freeTurnsLeft > 0) {
      this.freeTurnsLeft--;
    }
  }

  completeCurrent(status: GoalStatus, rationale: string): void {
    if (this.idx >= this.ledger.length) return;
    const entry = this.ledger[this.idx];
    if (!entry) return;
    entry.status = status;
    entry.rationale = rationale;
    this.idx++;
    this.turnsOnCurrent = 0;
  }

  // Force-complete a specific goal by id (used when the Explorer calls
  // goal_status out of order). Returns true if a transition happened.
  completeById(id: string, status: GoalStatus, rationale: string): boolean {
    const target = this.ledger.findIndex((e) => e.id === id);
    if (target < 0 || this.ledger[target]!.status !== 'pending') return false;
    // Skip ahead: any goals between current idx and target are auto-skipped.
    for (let i = this.idx; i < target; i++) {
      const entry = this.ledger[i]!;
      if (entry.status === 'pending') {
        entry.status = 'skipped';
        entry.rationale = 'skipped — explorer moved past without completing';
      }
    }
    const entry = this.ledger[target]!;
    entry.status = status;
    entry.rationale = rationale;
    this.idx = target + 1;
    this.turnsOnCurrent = 0;
    return true;
  }

  checkCutover(): AutoCutover | null {
    if (this.idx >= this.ledger.length) return null;
    const limit = Math.ceil(this.cfg.stepsPerGoal * 1.5);
    if (this.turnsOnCurrent >= limit) {
      const entry = this.ledger[this.idx];
      if (!entry) return null;
      return {
        kind: 'auto_cutover',
        goalId: entry.id,
        status: 'partial',
        rationale: 'budget exceeded without explicit completion',
      };
    }
    return null;
  }

  statuses(): Array<{
    id: string;
    description: string;
    status: GoalStatus | 'untested';
    rationale: string;
    turnsSpent: number;
  }> {
    return this.ledger.map((e) => ({
      id: e.id,
      description: e.description,
      status: e.status === 'pending' ? 'untested' : e.status,
      rationale: e.rationale,
      turnsSpent: e.turnsSpent,
    }));
  }

  exhausted(): boolean {
    return this.current().phase === 'done';
  }

  effectiveMaxSteps(): number {
    return this.cfg.goals.length * this.cfg.stepsPerGoal + this.cfg.freeExplorationSteps;
  }
}
