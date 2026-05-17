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
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

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

  it('builds variable-length evidence reels from the scenario trace window', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-trace-reel-variable-'));
    const screenshotsDir = join(runDir, 'evidence', 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const screenshots = Array.from({ length: 6 }, (_, index) =>
      join(screenshotsDir, `step-${String(index + 1).padStart(4, '0')}.png`),
    );
    for (const screenshot of screenshots) writeTinyPng(screenshot);
    const trace = screenshots.map((screenshot, index) =>
      event(`OBS${index + 1}`, 'observation', 10 + index, {
        ref: `OBS-${String(index + 1).padStart(6, '0')}`,
        perception_state: { screenshot_ref: screenshot },
      }),
    );
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
            description: 'Confirm final state',
            status: 'verified',
            evidence: ['OBS3'],
          },
          {
            id: 'G2',
            description: 'Complete a multi-step edit',
            status: 'verified',
            evidence: ['OBS2', 'OBS5'],
          },
        ],
        summary: '',
      },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
    } satisfies JudgeOutput;

    const result = await collectTraceEvidenceArtifacts({ judge, trace, runDir });

    if (!expectStoryboardOutput(result.files) || !hasFfprobe) return;
    const shortDuration = videoDurationSeconds(result.clips.G1 ?? '');
    const longerDuration = videoDurationSeconds(result.clips.G2 ?? '');
    expect(shortDuration).toBeGreaterThan(0.5);
    expect(longerDuration).toBeGreaterThan(shortDuration + 0.5);
  });

  it('caps long scenario reels without hanging during frame thinning', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iris-trace-reel-long-'));
    const screenshotsDir = join(runDir, 'evidence', 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const trace = Array.from({ length: 25 }, (_, index) => {
      const screenshot = join(screenshotsDir, `step-${String(index + 1).padStart(4, '0')}.png`);
      writeTinyPng(screenshot);
      return event(`OBS${index + 1}`, 'observation', 10 + index, {
        ref: `OBS-${String(index + 1).padStart(6, '0')}`,
        perception_state: { screenshot_ref: screenshot },
      });
    });
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
            description: 'Complete a long multi-step scenario',
            status: 'verified',
            evidence: ['OBS25'],
          },
        ],
        summary: '',
      },
      coverage_review: { surfaces_explored: 1, surfaces_unexplored: 0, judgement: '' },
      meta: { confidence_overall: 1, confidence_caveats: [], would_re_explore_with: [] },
    } satisfies JudgeOutput;

    const result = await collectTraceEvidenceArtifacts({ judge, trace, runDir });

    if (!expectStoryboardOutput(result.files) || !hasFfprobe) return;
    expect(videoDurationSeconds(result.clips.G1 ?? '')).toBeLessThan(12);
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

function videoDurationSeconds(path: string): number {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return Number.parseFloat(result.stdout.trim());
}
