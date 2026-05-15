import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import { describe, expect, it } from 'vitest';
import type { JudgeOutput } from '../judge/judge.js';
import type { TraceEvent } from '../trace/schema.js';
import { collectClaimEvidenceArtifacts, collectTraceEvidenceArtifacts } from './evidence-clips.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

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

  it('builds trace storyboard clips from observation screenshots before adapter raw-video slicing', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-trace-storyboard-'));
    const screenshotsDir = join(runDir, 'evidence', 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const before = join(screenshotsDir, 'step-0001.png');
    const after = join(screenshotsDir, 'step-0002.png');
    writeTinyPng(before);
    writeTinyPng(after);

    let adapterRefs: Array<{ finding_id: string; event_ids: string[] }> = [];
    const adapter = {
      injectEventTimestamps() {},
      async sliceEvidence(refs: Array<{ finding_id: string; event_ids: string[] }>) {
        adapterRefs = refs;
        return refs.map((ref) => ({
          finding_id: ref.finding_id,
          path: join(runDir, 'evidence', 'clips', `raw-${ref.finding_id}.webm`),
          kind: 'video' as const,
        }));
      },
    } as Pick<TargetAdapter, 'injectEventTimestamps' | 'sliceEvidence'>;

    const trace = [
      event('OBS1', 'observation', 10, {
        ref: 'OBS-000001',
        perception_state: { screenshot_ref: before },
      }),
      event('OBS2', 'observation', 12, {
        ref: 'OBS-000002',
        perception_state: { screenshot_ref: after },
      }),
    ];
    const judge = {
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: { overall: { score: 9, weighted_from: [] }, profiles: {} },
      spec_compliance: {
        applicable: true,
        goals: [
          {
            id: 'G1',
            description: 'Draw an object',
            status: 'verified',
            evidence: ['OBS2'],
            notes: 'The object is visible.',
          },
        ],
        summary: '',
      },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
    } satisfies JudgeOutput;

    const result = await collectClaimEvidenceArtifacts({ adapter, judge, trace, runDir });

    if (!expectStoryboardOutput(result.files)) return;
    expect(adapterRefs).toEqual([]);
    expect(result.clips.G1).toMatch(/story-G1\.webm$/);
    expect(existsSync(result.clips.G1 ?? '')).toBe(true);
  });

  it('can rebuild claim storyboards from a stored trace without a live adapter', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-trace-storyboard-report-'));
    const screenshotsDir = join(runDir, 'evidence', 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const screenshot = join(screenshotsDir, 'step-0001.png');
    writeTinyPng(screenshot);
    const trace = [
      event('OBS1', 'observation', 10, {
        ref: 'OBS-000001',
        perception_state: { screenshot_ref: screenshot },
      }),
    ];
    const judge = {
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: { overall: { score: 9, weighted_from: [] }, profiles: {} },
      spec_compliance: {
        applicable: true,
        goals: [
          {
            id: 'G1',
            description: 'Draw an object',
            status: 'verified',
            evidence: ['OBS1'],
          },
        ],
        summary: '',
      },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
    } satisfies JudgeOutput;

    const result = await collectTraceEvidenceArtifacts({ judge, trace, runDir });

    if (!expectStoryboardOutput(result.files)) return;
    expect(result.clips.G1).toMatch(/story-G1\.webm$/);
    expect(existsSync(result.clips.G1 ?? '')).toBe(true);
  });

  it('writes a distinct storyboard file for each claim even when frame windows overlap', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-trace-storyboard-distinct-'));
    const screenshotsDir = join(runDir, 'evidence', 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const screenshot = join(screenshotsDir, 'step-0001.png');
    writeTinyPng(screenshot);
    const trace = [
      event('OBS1', 'observation', 10, {
        ref: 'OBS-000001',
        perception_state: { screenshot_ref: screenshot },
      }),
    ];
    const judge = {
      v: 1,
      findings: [],
      discarded_findings: [],
      scores: { overall: { score: 9, weighted_from: [] }, profiles: {} },
      spec_compliance: {
        applicable: true,
        goals: [
          {
            id: 'G1',
            description: 'Open one panel',
            status: 'verified',
            evidence: ['OBS1'],
          },
          {
            id: 'G2',
            description: 'Open another panel',
            status: 'verified',
            evidence: ['OBS1'],
          },
        ],
        summary: '',
      },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
    } satisfies JudgeOutput;

    const result = await collectTraceEvidenceArtifacts({ judge, trace, runDir });

    if (!expectStoryboardOutput(result.files)) return;
    expect(result.clips.G1).toMatch(/story-G1\.webm$/);
    expect(result.clips.G2).toMatch(/story-G2\.webm$/);
    expect(result.clips.G1).not.toBe(result.clips.G2);
    expect(existsSync(result.clips.G1 ?? '')).toBe(true);
    expect(existsSync(result.clips.G2 ?? '')).toBe(true);
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

function writeTinyPng(path: string): void {
  writeFileSync(
    path,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
}

function expectStoryboardOutput(files: unknown[]): boolean {
  if (!hasFfmpeg) {
    expect(files).toEqual([]);
    return false;
  }
  expect(files.length).toBeGreaterThan(0);
  return true;
}
