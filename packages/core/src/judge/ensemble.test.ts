import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../trace/schema.js';
import { judgeWithEnsemble } from './ensemble.js';
import type { Judge, JudgeOutput } from './judge.js';

function emptyJudgeOutput(): JudgeOutput {
  return {
    v: 1,
    findings: [],
    discarded_findings: [],
    scores: { overall: { score: 7.0, weighted_from: [] }, profiles: {} },
    spec_compliance: { applicable: false, goals: [], summary: '' },
    coverage_review: { surfaces_explored: 0, surfaces_unexplored: 0, judgement: '' },
    meta: { confidence_overall: 0.8, confidence_caveats: [], would_re_explore_with: [] },
  };
}

function finding(
  overrides: Partial<JudgeOutput['findings'][number]>,
): JudgeOutput['findings'][number] {
  return {
    id: overrides.id ?? 'F-1',
    title: overrides.title ?? 'X',
    category: overrides.category ?? 'bug',
    severity: overrides.severity ?? 'minor',
    evidence: overrides.evidence ?? ['E1'],
    rationale: overrides.rationale ?? 'r',
    ...overrides,
  };
}

function fakeJudge(outputs: JudgeOutput[]): Judge {
  let i = 0;
  return {
    // biome-ignore lint/suspicious/noExplicitAny: stub interface
    run: async () => {
      const out = outputs[i] ?? outputs[outputs.length - 1]!;
      i++;
      return out;
    },
  } as unknown as Judge;
}

const trace: TraceEvent[] = [
  {
    v: 1,
    id: 'E1',
    ts: 0,
    step: 0,
    target_kind: 'web',
    kind: 'action',
    actor: 'explorer',
    payload: {},
    content_hash: 'h-E1',
  },
  {
    v: 1,
    id: 'E2',
    ts: 0,
    step: 0,
    target_kind: 'web',
    kind: 'action',
    actor: 'explorer',
    payload: {},
    content_hash: 'h-E2',
  },
];

describe('judgeWithEnsemble', () => {
  it('intersects critical findings by finding_hash', async () => {
    const pass1 = emptyJudgeOutput();
    pass1.findings = [
      finding({ id: 'F-A', severity: 'major', title: 'Same bug', evidence: ['E1'] }),
      finding({ id: 'F-B', severity: 'major', title: 'Pass1 only', evidence: ['E2'] }),
    ];
    const pass2 = emptyJudgeOutput();
    pass2.findings = [
      finding({ id: 'F-A2', severity: 'major', title: 'Same bug', evidence: ['E1'] }),
      finding({ id: 'F-C', severity: 'major', title: 'Pass2 only', evidence: ['E2'] }),
    ];

    const r = await judgeWithEnsemble(
      fakeJudge([pass1, pass2]),
      { trace_path: '/tmp/x', rubric_profiles: [] },
      trace,
    );

    // Same bug agreed; Pass1-only + Pass2-only differ on title so different hashes.
    expect(r.output.findings.map((f) => f.title)).toEqual(['Same bug']);
    expect(r.metadata.agreed_critical).toBe(1);
    expect(r.metadata.disagreed_critical).toBe(2);
  });

  it('takes union of non-critical findings from pass1', async () => {
    const pass1 = emptyJudgeOutput();
    pass1.findings = [
      finding({ id: 'F-A', severity: 'minor', title: 'Pass1 minor', evidence: ['E1'] }),
      finding({ id: 'F-B', severity: 'suggestion', title: 'Pass1 suggestion', evidence: ['E1'] }),
    ];
    const pass2 = emptyJudgeOutput();
    pass2.findings = [
      finding({ id: 'F-C', severity: 'minor', title: 'Pass2 minor', evidence: ['E1'] }),
    ];

    const r = await judgeWithEnsemble(
      fakeJudge([pass1, pass2]),
      { trace_path: '/tmp/x', rubric_profiles: [] },
      trace,
    );

    // Non-critical findings from pass1 are kept.
    expect(r.output.findings.map((f) => f.title)).toEqual(['Pass1 minor', 'Pass1 suggestion']);
  });

  it('averages scores when two passes disagree', async () => {
    const pass1 = emptyJudgeOutput();
    pass1.scores = {
      overall: { score: 8.0, weighted_from: [] },
      profiles: { usability: { score: 7.0, dimensions: {} } },
    };
    const pass2 = emptyJudgeOutput();
    pass2.scores = {
      overall: { score: 6.0, weighted_from: [] },
      profiles: { usability: { score: 9.0, dimensions: {} } },
    };

    const r = await judgeWithEnsemble(
      fakeJudge([pass1, pass2]),
      { trace_path: '/tmp/x', rubric_profiles: [] },
      trace,
    );
    expect(r.output.scores.overall.score).toBe(7.0);
    expect(r.output.scores.profiles.usability?.score).toBe(8.0);
  });

  it('adds confidence caveat when passes disagree on critical findings', async () => {
    const pass1 = emptyJudgeOutput();
    pass1.findings = [finding({ severity: 'major', title: 'A', evidence: ['E1'] })];
    const pass2 = emptyJudgeOutput();
    pass2.findings = [finding({ severity: 'major', title: 'B', evidence: ['E1'] })];

    const r = await judgeWithEnsemble(
      fakeJudge([pass1, pass2]),
      { trace_path: '/tmp/x', rubric_profiles: [] },
      trace,
    );
    expect(r.output.meta.confidence_caveats.some((c) => c.includes('ensemble disagreement'))).toBe(
      true,
    );
  });

  it('zero disagreement → no caveat added', async () => {
    const pass1 = emptyJudgeOutput();
    pass1.findings = [finding({ severity: 'major', title: 'X', evidence: ['E1'] })];
    const pass2 = emptyJudgeOutput();
    pass2.findings = [finding({ severity: 'major', title: 'X', evidence: ['E1'] })];

    const r = await judgeWithEnsemble(
      fakeJudge([pass1, pass2]),
      { trace_path: '/tmp/x', rubric_profiles: [] },
      trace,
    );
    expect(r.metadata.agreed_critical).toBe(1);
    expect(r.metadata.disagreed_critical).toBe(0);
    expect(r.output.meta.confidence_caveats.some((c) => c.includes('ensemble disagreement'))).toBe(
      false,
    );
  });
});
