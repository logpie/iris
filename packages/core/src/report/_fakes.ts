import type { JudgeOutput } from '../judge/judge.js';

export function fakeJudge(): JudgeOutput {
  return {
    v: 1,
    findings: [
      {
        id: 'F-001',
        title: 'Login fails',
        category: 'bug',
        severity: 'blocker',
        evidence: ['T2'],
        rationale: 'Pressed submit, nothing happened.',
        where: { url: '/login', selector: '#submit' },
        suggested_fix: { type: 'fix', summary: 'Surface error to user' },
      },
      {
        id: 'F-002',
        title: 'Tooltip too small',
        category: 'ux',
        severity: 'nit',
        evidence: ['T5'],
        rationale: 'Hard to read.',
      },
    ],
    discarded_findings: [],
    scores: {
      overall: { score: 6.5, weighted_from: ['quality', 'usability'] },
      profiles: {
        quality: {
          score: 7.0,
          dimensions: { correctness: { score: 7.0, rationale: 'r', evidence: ['T2'] } },
        },
        usability: {
          score: 6.0,
          dimensions: { clarity: { score: 6.0, rationale: 'r', evidence: ['T2'] } },
        },
      },
    },
    spec_compliance: {
      applicable: true,
      goals: [
        { id: 'G1', description: 'sign in', status: 'satisfied', evidence: ['T2'] },
        {
          id: 'G2',
          description: 'export',
          status: 'not_satisfied',
          evidence: ['T8'],
          notes: 'JSON not CSV',
        },
      ],
      summary: '1/2 satisfied',
    },
    coverage_review: { surfaces_explored: 3, surfaces_unexplored: 1, judgement: 'ok' },
    meta: {
      confidence_overall: 0.8,
      confidence_caveats: ['no mobile tested'],
      would_re_explore_with: ['--persona keyboard_only'],
    },
  };
}

export function fakeRun() {
  return {
    id: '2026-05-09T22-13Z-abc',
    target: { kind: 'web', url: 'https://example.com' },
    mode: 'grounded',
    started_at: '2026-05-09T22:13:00Z',
    ended_at: '2026-05-09T22:20:00Z',
    duration_s: 412,
    cost_usd: 1.84,
    models: { explorer: 'claude-sonnet-4-6', judge: 'claude-opus-4-7' },
    termination: 'goals_complete',
    step_count: 47,
  };
}
