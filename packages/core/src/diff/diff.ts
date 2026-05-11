// Run-to-run delta. Reads two report.json files (prev + curr), classifies
// findings as fixed/new/persistent via finding_hash, and surfaces score and
// coverage deltas. Pure functions — no LLM in the diff path so Otto can
// trust the result.

import type { JudgeFinding } from '../judge/judge.js';
import type { ReportJson } from '../report/report-json.js';
import { findingHash } from '../trace/identity.js';

export interface DiffResult {
  v: 1;
  prev: { run_id: string; target: string; score: number };
  curr: { run_id: string; target: string; score: number };
  score_delta: {
    overall: number;
    by_profile: Record<string, number>;
  };
  findings: {
    fixed: JudgeFinding[];
    new: JudgeFinding[];
    persistent: JudgeFinding[];
  };
  coverage_delta: {
    newly_tested_goals: string[];
    no_longer_tested: string[];
    verification_changes: Array<{ id: string; prev: string; curr: string }>;
  };
}

// A goal status counts as "attempted" if the Explorer actually exercised it
// (or tried to). Untested and skipped don't count.
function isAttempted(status: string): boolean {
  return (
    status === 'verified' ||
    status === 'satisfied' ||
    status === 'partial' ||
    status === 'blocked' ||
    status === 'not_satisfied'
  );
}

// Migrate a finding from a v1 report (which lacks finding_hash) by computing
// it on the fly. Without trace events, the hash uses raw event IDs — which
// is unstable across runs but better than nothing for legacy v1 reports.
function ensureFindingHash(f: JudgeFinding): string {
  if (f.finding_hash) return f.finding_hash;
  return findingHash(
    {
      title: f.title,
      category: f.category,
      severity: f.severity,
      evidence: f.evidence,
    },
    new Map(),
  );
}

export function computeDiff(prev: ReportJson, curr: ReportJson): DiffResult {
  const prevByHash = new Map<string, JudgeFinding>();
  const currByHash = new Map<string, JudgeFinding>();
  for (const f of prev.findings) prevByHash.set(ensureFindingHash(f), f);
  for (const f of curr.findings) currByHash.set(ensureFindingHash(f), f);

  const fixed: JudgeFinding[] = [];
  const persistent: JudgeFinding[] = [];
  for (const [h, f] of prevByHash) {
    if (!currByHash.has(h)) fixed.push(f);
  }
  const newFindings: JudgeFinding[] = [];
  for (const [h, f] of currByHash) {
    if (prevByHash.has(h)) persistent.push(f);
    else newFindings.push(f);
  }

  // Coverage delta — goals attempted in prev but not curr, etc.
  const prevGoals = new Map(prev.spec_compliance.goals.map((g) => [g.id, g.status]));
  const currGoals = new Map(curr.spec_compliance.goals.map((g) => [g.id, g.status]));
  const newly_tested_goals: string[] = [];
  const no_longer_tested: string[] = [];
  const verification_changes: Array<{ id: string; prev: string; curr: string }> = [];

  const allGoalIds = new Set([...prevGoals.keys(), ...currGoals.keys()]);
  for (const id of allGoalIds) {
    const prevS = prevGoals.get(id);
    const currS = currGoals.get(id);
    const prevAttempted = prevS !== undefined && isAttempted(prevS);
    const currAttempted = currS !== undefined && isAttempted(currS);
    if (!prevAttempted && currAttempted) newly_tested_goals.push(id);
    else if (prevAttempted && !currAttempted) no_longer_tested.push(id);
    else if (prevAttempted && currAttempted && prevS !== currS) {
      verification_changes.push({
        id,
        prev: prevS ?? 'unknown',
        curr: currS ?? 'unknown',
      });
    }
  }

  // Score deltas — overall + per profile.
  const prevProfiles = Object.fromEntries(
    Object.entries(prev.scores.profiles).map(([k, v]) => [k, v.score]),
  );
  const currProfiles = Object.fromEntries(
    Object.entries(curr.scores.profiles).map(([k, v]) => [k, v.score]),
  );
  const by_profile: Record<string, number> = {};
  const profileKeys = new Set([...Object.keys(prevProfiles), ...Object.keys(currProfiles)]);
  for (const k of profileKeys) {
    by_profile[k] = (currProfiles[k] ?? 0) - (prevProfiles[k] ?? 0);
  }

  return {
    v: 1,
    prev: {
      run_id: prev.run.id,
      target: prev.run.target.url,
      score: prev.headline.score,
    },
    curr: {
      run_id: curr.run.id,
      target: curr.run.target.url,
      score: curr.headline.score,
    },
    score_delta: {
      overall: curr.headline.score - prev.headline.score,
      by_profile,
    },
    findings: { fixed, new: newFindings, persistent },
    coverage_delta: { newly_tested_goals, no_longer_tested, verification_changes },
  };
}

// Normalize a URL for cross-run target equality: strips trailing slash,
// query, fragment. Returns host+pathname.
export function normalizeTargetUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return u;
  }
}
