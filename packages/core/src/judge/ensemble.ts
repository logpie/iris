// Phase 6 F2 — Judge ensembling.
//
// Two Judge runs in parallel on the same trace. Intersect by finding_hash
// for blocker/major findings (high-stakes ship-blockers should agree on
// both passes). Union for minor/nit/suggestion (doubling cost just to dedupe
// nits is poor ROI).
//
// Phase 5 dogfood showed clean TodoMVC runs producing ±0.6 score variance.
// Ensembling targets the high-severity findings driving that variance.

import { findingHash } from '../trace/identity.js';
import type { TraceEvent } from '../trace/schema.js';
import type { Judge, JudgeFinding, JudgeOutput, JudgeRunInputs } from './judge.js';

export interface EnsembleMetadata {
  enabled: true;
  agreed_critical: number; // count of blocker/major findings in both passes
  disagreed_critical: number; // count emitted by only one pass
  // For diagnostics: which finding_hashes were emitted by which pass.
  pass1_only_hashes: string[];
  pass2_only_hashes: string[];
}

export interface EnsembleResult {
  output: JudgeOutput;
  metadata: EnsembleMetadata;
}

const CRITICAL_SEVERITIES = new Set(['blocker', 'major']);

function isCritical(f: JudgeFinding): boolean {
  return CRITICAL_SEVERITIES.has(f.severity);
}

// Compute a stable hash for the Judge's pre-validator finding. Uses the same
// identity rules as Phase 5 G4 so two runs of the same Judge over the same
// trace will hash the same finding identically. Caller must supply trace so
// we can map evidence event IDs → content hashes for stability across the
// trivial differences the Judge sometimes introduces in cited evidence.
function hashFinding(f: JudgeFinding, eventIndex: Map<string, { content_hash?: string }>): string {
  return findingHash(
    {
      title: f.title,
      category: f.category,
      severity: f.severity,
      evidence: f.evidence,
    },
    eventIndex,
  );
}

export async function judgeWithEnsemble(
  judge: Judge,
  inputs: JudgeRunInputs,
  trace: TraceEvent[],
): Promise<EnsembleResult> {
  // Two parallel Judge calls. Same prompt; temperature is set inside Judge.run
  // and is 0 — but on borderline calls the two passes still sometimes diverge.
  const [pass1, pass2] = await Promise.all([judge.run(inputs), judge.run(inputs)]);
  return mergeJudgePasses(pass1, pass2, trace);
}

// Pure merge function — pulled out so transports that don't use Judge.run()
// (e.g., the Agent-SDK single-shot path) can still ensemble. Takes two
// raw Judge outputs + the trace events (for stable finding_hash).
export function mergeJudgePasses(
  pass1: JudgeOutput,
  pass2: JudgeOutput,
  trace: TraceEvent[],
): EnsembleResult {
  const eventIndex = new Map<string, { content_hash?: string }>();
  for (const e of trace) {
    eventIndex.set(e.id, e.content_hash ? { content_hash: e.content_hash } : {});
  }

  const pass1Crit = new Map<string, JudgeFinding>();
  const pass2Crit = new Map<string, JudgeFinding>();
  for (const f of pass1.findings) if (isCritical(f)) pass1Crit.set(hashFinding(f, eventIndex), f);
  for (const f of pass2.findings) if (isCritical(f)) pass2Crit.set(hashFinding(f, eventIndex), f);

  // Critical: intersect.
  const agreedCritical: JudgeFinding[] = [];
  for (const [h, f] of pass1Crit) {
    if (pass2Crit.has(h)) agreedCritical.push(f);
  }

  const pass1Only: string[] = [];
  const pass2Only: string[] = [];
  for (const h of pass1Crit.keys()) if (!pass2Crit.has(h)) pass1Only.push(h);
  for (const h of pass2Crit.keys()) if (!pass1Crit.has(h)) pass2Only.push(h);

  // Non-critical: take pass1's set. Doing union would inflate finding counts
  // for nits/suggestions where the Judge often paraphrases the same thing
  // two different ways.
  const nonCritical = pass1.findings.filter((f) => !isCritical(f));

  // Discarded: pass1's discards, plus the disagreement-driven discards.
  const disagreementDiscards = [
    ...pass1Only.map((h) => ({
      tentative_event_id: `pass1:${h}`,
      reason: 'ensemble_disagreement_pass1_only',
    })),
    ...pass2Only.map((h) => ({
      tentative_event_id: `pass2:${h}`,
      reason: 'ensemble_disagreement_pass2_only',
    })),
  ];

  // Average the two pass scores per profile and overall. This isn't perfect
  // but it's the right direction: when the two passes disagree, the user
  // gets the midpoint instead of one pass's idiosyncratic call.
  const avgScores = averageScores(pass1.scores, pass2.scores);

  const merged: JudgeOutput = {
    ...pass1,
    findings: [...agreedCritical, ...nonCritical],
    discarded_findings: [...(pass1.discarded_findings ?? []), ...disagreementDiscards],
    scores: avgScores,
    meta: {
      ...pass1.meta,
      confidence_caveats: [
        ...pass1.meta.confidence_caveats,
        ...(pass1Only.length + pass2Only.length > 0
          ? [
              `Judge ensemble disagreement: ${pass1Only.length} critical finding(s) emitted only by pass 1, ${pass2Only.length} only by pass 2.`,
            ]
          : []),
      ],
    },
  };

  return {
    output: merged,
    metadata: {
      enabled: true,
      agreed_critical: agreedCritical.length,
      disagreed_critical: pass1Only.length + pass2Only.length,
      pass1_only_hashes: pass1Only,
      pass2_only_hashes: pass2Only,
    },
  };
}

function averageScores(a: JudgeOutput['scores'], b: JudgeOutput['scores']): JudgeOutput['scores'] {
  const avg = (x: number, y: number) => Math.round((x + y) * 50) / 100; // 1 decimal
  const profiles: JudgeOutput['scores']['profiles'] = {};
  const allProfileNames = new Set([...Object.keys(a.profiles), ...Object.keys(b.profiles)]);
  for (const name of allProfileNames) {
    const pa = a.profiles[name];
    const pb = b.profiles[name];
    if (pa && pb) {
      profiles[name] = {
        score: avg(pa.score, pb.score),
        // Take pass1's dimension breakdown. Averaging dimensions adds noise
        // without clear benefit.
        dimensions: pa.dimensions,
      };
    } else if (pa) {
      profiles[name] = pa;
    } else if (pb) {
      profiles[name] = pb;
    }
  }
  return {
    overall: {
      score: avg(a.overall.score, b.overall.score),
      weighted_from: a.overall.weighted_from,
    },
    profiles,
  };
}
