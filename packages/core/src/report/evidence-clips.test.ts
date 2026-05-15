import type { TargetAdapter } from '@iris/adapter-types';
import { describe, expect, it } from 'vitest';
import type { JudgeOutput } from '../judge/judge.js';
import type { TraceEvent } from '../trace/schema.js';
import { collectClaimEvidenceArtifacts } from './evidence-clips.js';

describe('collectClaimEvidenceArtifacts', () => {
  it('slices evidence for findings and goal claims, resolving goal_status pointers', async () => {
    const injected: Record<string, number>[] = [];
    let refsSeen: Array<{ finding_id: string; event_ids: string[] }> = [];
    const adapter = {
      injectEventTimestamps(ts: Record<string, number>) {
        injected.push(ts);
      },
      async sliceEvidence(refs: Array<{ finding_id: string; event_ids: string[] }>) {
        refsSeen = refs;
        return refs.map((ref) => ({
          finding_id: ref.finding_id,
          path: `/tmp/${ref.finding_id}.webm`,
          kind: 'video' as const,
        }));
      },
    } as Pick<TargetAdapter, 'injectEventTimestamps' | 'sliceEvidence'>;

    const trace = [
      event('OBS1', 'observation', 10, { ref: 'OBS-000001' }),
      event('PROBE1', 'probe_result', 12, { probe: 'axe' }),
      event('GS1', 'goal_status', 14, { id: 'G1', evidence_event_ids: ['OBS1'] }),
    ];
    const judge = {
      v: 1,
      findings: [
        {
          id: 'F-001',
          title: 'Axe issue',
          category: 'a11y',
          severity: 'major',
          evidence: ['PROBE1'],
          rationale: 'Rule failed.',
        },
      ],
      discarded_findings: [],
      scores: { overall: { score: 8, weighted_from: [] }, profiles: {} },
      spec_compliance: {
        applicable: true,
        goals: [
          {
            id: 'G1',
            description: 'Open article',
            status: 'verified',
            evidence: ['GS1'],
            notes: 'Loaded.',
          },
        ],
        summary: '',
      },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
    } satisfies JudgeOutput;

    const result = await collectClaimEvidenceArtifacts({ adapter, judge, trace });

    expect(injected[0]).toMatchObject({ OBS1: 10, 'OBS-000001': 10, PROBE1: 12, GS1: 14 });
    expect(refsSeen).toEqual([
      { finding_id: 'F-001', event_ids: ['PROBE1', 'OBS-000001'] },
      { finding_id: 'G1', event_ids: ['OBS1', 'OBS-000001'] },
    ]);
    expect(result.clips).toEqual({ 'F-001': '/tmp/F-001.webm', G1: '/tmp/G1.webm' });
  });
});

function event(
  id: string,
  kind: TraceEvent['kind'],
  ts: number,
  payload: Record<string, unknown>,
): TraceEvent {
  return { v: 1, id, ts, step: 1, target_kind: 'web', kind, actor: 'system', payload };
}
