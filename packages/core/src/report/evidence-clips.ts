import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvidenceFile, EvidenceRef, TargetAdapter } from '@iris/adapter-types';
import type { TraceEvent } from '../trace/schema.js';
import type { JudgeOutput } from '../judge/judge.js';
import { buildTaskRuns } from '../task-runs/task-runs.js';

export interface ClaimEvidenceArtifactsResult {
  clips: Record<string, string>;
  files: EvidenceFile[];
  refs: EvidenceRef[];
}

type EvidenceSlicingAdapter = Pick<TargetAdapter, 'injectEventTimestamps' | 'sliceEvidence'>;

export async function collectClaimEvidenceArtifacts(input: {
  adapter: EvidenceSlicingAdapter;
  judge: JudgeOutput;
  trace: TraceEvent[];
  runDir?: string;
  includeGoals?: boolean;
}): Promise<ClaimEvidenceArtifactsResult> {
  if (!input.adapter.injectEventTimestamps || !input.adapter.sliceEvidence) {
    return { clips: {}, files: [], refs: [] };
  }

  const tsMap: Record<string, number> = {};
  for (const event of input.trace) {
    tsMap[event.id] = event.ts;
    const ref = observationRef(event);
    if (ref) tsMap[ref] = event.ts;
  }
  input.adapter.injectEventTimestamps(tsMap);

  const eventIndex = new Map(input.trace.map((event) => [event.id, event]));
  const refs = buildClaimEvidenceRefs(input.judge, input.trace, eventIndex, input.includeGoals ?? true);
  if (refs.length === 0) return { clips: {}, files: [], refs };

  const traceStoryboards = input.runDir
    ? await sliceTraceEvidenceStoryboards(refs, input.trace, input.runDir)
    : [];
  const storyboardIds = new Set(traceStoryboards.map((file) => file.finding_id));
  const remainingRefs = refs.filter((ref) => !storyboardIds.has(ref.finding_id));
  const adapterFiles = remainingRefs.length > 0 ? await input.adapter.sliceEvidence(remainingRefs) : [];
  const files = [...traceStoryboards, ...adapterFiles];
  const clips: Record<string, string> = {};
  for (const file of files) {
    if (file.kind === 'video' || file.kind === 'screenshot') {
      clips[file.finding_id] = file.path;
    }
  }
  return { clips, files, refs };
}

export async function collectTraceEvidenceArtifacts(input: {
  judge: JudgeOutput;
  trace: TraceEvent[];
  runDir: string;
  includeGoals?: boolean;
}): Promise<ClaimEvidenceArtifactsResult> {
  const eventIndex = new Map(input.trace.map((event) => [event.id, event]));
  const refs = buildClaimEvidenceRefs(input.judge, input.trace, eventIndex, input.includeGoals ?? true);
  if (refs.length === 0) return { clips: {}, files: [], refs };
  const files = await sliceTraceEvidenceStoryboards(refs, input.trace, input.runDir);
  const clips: Record<string, string> = {};
  for (const file of files) {
    if (file.kind === 'video' || file.kind === 'screenshot') {
      clips[file.finding_id] = file.path;
    }
  }
  return { clips, files, refs };
}

function buildClaimEvidenceRefs(
  judge: JudgeOutput,
  trace: TraceEvent[],
  eventIndex: Map<string, TraceEvent>,
  includeGoals: boolean,
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const finding of judge.findings) {
    const eventIds = unique(resolveEvidenceEventIds(finding.evidence, trace, eventIndex));
    if (eventIds.length > 0) refs.push({ finding_id: finding.id, event_ids: eventIds });
  }
  if (includeGoals && judge.spec_compliance.applicable) {
    const taskRunByGoalId = new Map(
      buildTaskRuns({ goals: judge.spec_compliance.goals, trace }).map((run) => [
        run.goal_id,
        run,
      ]),
    );
    for (const goal of judge.spec_compliance.goals) {
      const taskRun = taskRunByGoalId.get(goal.id);
      const scenarioObservationIds = taskRun?.observations.map((observation) => observation.event_id) ?? [];
      const eventIds = unique([
        ...scenarioObservationIds,
        ...resolveEvidenceEventIds(goal.evidence, trace, eventIndex),
      ]);
      if (eventIds.length > 0) refs.push({ finding_id: goal.id, event_ids: eventIds });
    }
  }
  return refs;
}

function resolveEvidenceEventIds(
  evidenceIds: string[],
  trace: TraceEvent[],
  eventIndex: Map<string, TraceEvent>,
): string[] {
  const out: string[] = [];
  for (const id of evidenceIds) {
    const event = eventIndex.get(id);
    if (event?.kind === 'goal_status') {
      const payload = event.payload as Record<string, unknown>;
      const nested = Array.isArray(payload.evidence_event_ids)
        ? payload.evidence_event_ids.filter((value): value is string => typeof value === 'string')
        : [];
      out.push(...resolveEvidenceEventIds(nested, trace, eventIndex));
    } else {
      out.push(id);
      const visualRef = visualEvidenceRefForEvent(id, trace, eventIndex);
      if (visualRef) out.push(visualRef);
    }
  }
  return out;
}

function visualEvidenceRefForEvent(
  id: string,
  trace: TraceEvent[],
  eventIndex: Map<string, TraceEvent>,
): string | null {
  const event = eventIndex.get(id);
  const directRef = event ? observationRef(event) : null;
  if (directRef) return directRef;

  const index = trace.findIndex((candidate) => candidate.id === id);
  if (index < 0) return null;
  for (let offset = 1; offset < trace.length; offset++) {
    const before = trace[index - offset];
    const beforeRef = before ? observationRef(before) : null;
    if (beforeRef) return beforeRef;
    const after = trace[index + offset];
    const afterRef = after ? observationRef(after) : null;
    if (afterRef) return afterRef;
  }
  return null;
}

function observationRef(event: TraceEvent): string | null {
  if (event.kind !== 'observation') return null;
  const ref = (event.payload as Record<string, unknown>).ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

interface TraceScreenshotFrame {
  refs: Set<string>;
  path: string;
  ts: number;
}

interface EvidenceReelFrame {
  frame: TraceScreenshotFrame;
  role: 'before' | 'action' | 'result' | 'proof';
  duration_s: number;
}

const EVIDENCE_REEL_MAX_FRAMES = 10;
const EVIDENCE_REEL_ROLE_DURATION_S: Record<EvidenceReelFrame['role'], number> = {
  before: 0.8,
  action: 0.65,
  result: 1.05,
  proof: 1.25,
};

async function sliceTraceEvidenceStoryboards(
  refs: EvidenceRef[],
  trace: TraceEvent[],
  runDir: string,
): Promise<EvidenceFile[]> {
  if (!(await isFfmpegAvailable())) return [];
  const frames = buildTraceScreenshotFrames(trace, runDir);
  if (frames.length === 0) return [];
  const outDir = join(runDir, 'evidence', 'clips');
  mkdirSync(outDir, { recursive: true });

  const out: EvidenceFile[] = [];
  for (const ref of refs) {
    const selected = selectTraceEvidenceReelFrames(ref, frames);
    if (selected.length === 0) continue;
    const clipPath = join(outDir, `story-${safeClipName(ref.finding_id)}.webm`);
    try {
      await spawnFfmpegScreenshotClip(
        selected,
        clipPath,
      );
    } catch {
      continue;
    }
    out.push({ finding_id: ref.finding_id, path: clipPath, kind: 'video' });
  }
  return out;
}

function buildTraceScreenshotFrames(trace: TraceEvent[], runDir: string): TraceScreenshotFrame[] {
  const frames: TraceScreenshotFrame[] = [];
  const byPath = new Map<string, TraceScreenshotFrame>();
  for (const event of trace) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const screenshotPaths = screenshotPathsForEvent(payload, runDir);
    for (const path of screenshotPaths) {
      let frame = byPath.get(path);
      if (!frame) {
        frame = { refs: new Set<string>(), path, ts: event.ts };
        byPath.set(path, frame);
        frames.push(frame);
      }
      frame.refs.add(event.id);
      const ref = payload.ref;
      if (typeof ref === 'string' && ref.length > 0) frame.refs.add(ref);
    }
  }
  return frames.sort((a, b) => a.ts - b.ts);
}

function screenshotPathsForEvent(payload: Record<string, unknown>, runDir: string): string[] {
  const raw: string[] = [];
  const perception = payload.perception_state as Record<string, unknown> | undefined;
  const screenshotRef = perception?.screenshot_ref;
  if (typeof screenshotRef === 'string') raw.push(screenshotRef);
  const screenshot = payload.screenshot;
  if (typeof screenshot === 'string') raw.push(screenshot);
  const evidenceRefs = payload.evidence_refs;
  if (Array.isArray(evidenceRefs)) {
    for (const value of evidenceRefs) {
      if (typeof value === 'string' && /\.(png|jpe?g|webp)$/i.test(value)) raw.push(value);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const resolved = resolveRunArtifactPath(value, runDir);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function resolveRunArtifactPath(value: string, runDir: string): string | undefined {
  const candidates: string[] = [];
  if (isAbsolute(value)) candidates.push(value);
  candidates.push(join(runDir, value));
  candidates.push(resolve(value));
  const runBase = basename(runDir);
  const runIdx = value.indexOf(`${runBase}/`);
  if (runIdx >= 0) {
    candidates.push(join(runDir, value.slice(runIdx + runBase.length + 1)));
  }
  return candidates.find((path) => existsSync(path));
}

function selectTraceEvidenceReelFrames(
  ref: EvidenceRef,
  frames: TraceScreenshotFrame[],
): EvidenceReelFrame[] {
  const wanted = new Set<string>(ref.event_ids);
  const anchors = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => Array.from(frame.refs).some((alias) => wanted.has(alias)))
    .map(({ index }) => index);
  if (anchors.length === 0) return [];

  const selected = new Set<number>();
  const firstAnchor = Math.min(...anchors);
  const lastAnchor = Math.max(...anchors);
  const before = nearestDistinctFrameIndex(frames, firstAnchor, -1);
  const after = nearestDistinctFrameIndex(frames, lastAnchor, 1);
  if (before !== undefined) selected.add(before);
  for (const index of anchors) selected.add(index);
  const spanLength = lastAnchor - firstAnchor + 1;
  if (spanLength > 2) {
    selected.add(Math.floor((firstAnchor + lastAnchor) / 2));
  }
  if (after !== undefined) selected.add(after);

  for (const anchor of anchors) {
    if (selected.size >= EVIDENCE_REEL_MAX_FRAMES) break;
    const prev = nearestDistinctFrameIndex(frames, anchor, -1);
    if (prev !== undefined) selected.add(prev);
    if (selected.size >= EVIDENCE_REEL_MAX_FRAMES) break;
    const next = nearestDistinctFrameIndex(frames, anchor, 1);
    if (next !== undefined) selected.add(next);
  }

  const deduped = Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => frames[index]!)
    .filter((frame, index, arr) => index === 0 || frame.path !== arr[index - 1]?.path);
  const bounded = thinFrames(deduped, EVIDENCE_REEL_MAX_FRAMES);
  return bounded.map((frame) => {
    const frameIndex = frames.indexOf(frame);
    const role = evidenceFrameRole(frameIndex, firstAnchor, lastAnchor, wanted, frame);
    return {
      frame,
      role,
      duration_s: EVIDENCE_REEL_ROLE_DURATION_S[role],
    };
  });
}

function nearestDistinctFrameIndex(
  frames: TraceScreenshotFrame[],
  anchor: number,
  direction: -1 | 1,
): number | undefined {
  const anchorPath = frames[anchor]?.path;
  for (let index = anchor + direction; index >= 0 && index < frames.length; index += direction) {
    if (frames[index]?.path !== anchorPath) return index;
  }
  return undefined;
}

function thinFrames<T>(frames: T[], maxFrames: number): T[] {
  if (frames.length <= maxFrames) return frames;
  if (maxFrames <= 0) return [];
  if (maxFrames === 1) return [frames[frames.length - 1]!];
  const keep: number[] = [];
  let last = -1;
  for (let slot = 0; slot < maxFrames; slot += 1) {
    const index = Math.round((slot * (frames.length - 1)) / (maxFrames - 1));
    if (index === last) continue;
    keep.push(index);
    last = index;
  }
  return keep.map((index) => frames[index]!);
}

function evidenceFrameRole(
  frameIndex: number,
  firstAnchor: number,
  lastAnchor: number,
  wanted: Set<string>,
  frame: TraceScreenshotFrame,
): EvidenceReelFrame['role'] {
  const isAnchor = Array.from(frame.refs).some((alias) => wanted.has(alias));
  if (isAnchor && frameIndex === lastAnchor) return 'proof';
  if (frameIndex < firstAnchor) return 'before';
  if (frameIndex > lastAnchor) return 'result';
  return isAnchor ? 'result' : 'action';
}

function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

async function spawnFfmpegScreenshotClip(frames: EvidenceReelFrame[], outPath: string): Promise<void> {
  const existing = frames.filter((frame) => existsSync(frame.frame.path));
  if (existing.length === 0) throw new Error('no screenshot frames for clip');
  const tmp = mkdtempSync(join(tmpdir(), 'iris-trace-storyboard-'));
  try {
    const listPath = join(tmp, 'frames.txt');
    const lines: string[] = [];
    for (const item of existing) {
      lines.push(`file '${escapeConcatPath(item.frame.path)}'`);
      lines.push(`duration ${item.duration_s}`);
    }
    lines.push(`file '${escapeConcatPath(existing[existing.length - 1]!.frame.path)}'`);
    writeFileSync(listPath, `${lines.join('\n')}\n`);
    await new Promise<void>((resolvePromise, reject) => {
      const args = [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-vf',
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '0',
        '-crf',
        '34',
        outPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('exit', (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`ffmpeg exited ${code}`)),
      );
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

function safeClipName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'claim';
}
