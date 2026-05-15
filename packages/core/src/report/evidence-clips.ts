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
    for (const goal of judge.spec_compliance.goals) {
      const eventIds = unique(resolveEvidenceEventIds(goal.evidence, trace, eventIndex));
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

const STORYBOARD_FRAME_DURATION_S = 1.35;
const STORYBOARD_MAX_FRAMES = 6;

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
    const selected = selectTraceStoryboardFrames(ref, frames);
    if (selected.length === 0) continue;
    const clipPath = join(outDir, `story-${safeClipName(ref.finding_id)}.webm`);
    try {
      await spawnFfmpegScreenshotClip(
        selected.map((frame) => frame.path),
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

function selectTraceStoryboardFrames(
  ref: EvidenceRef,
  frames: TraceScreenshotFrame[],
): TraceScreenshotFrame[] {
  const wanted = new Set(ref.event_ids);
  const anchors = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => Array.from(frame.refs).some((alias) => wanted.has(alias)))
    .map(({ index }) => index);
  if (anchors.length === 0) return [];

  const selected = new Set<number>();
  for (const index of anchors) {
    selected.add(index);
    if (selected.size >= STORYBOARD_MAX_FRAMES) break;
  }
  for (let radius = 1; selected.size < STORYBOARD_MAX_FRAMES && radius <= frames.length; radius++) {
    for (const anchor of anchors) {
      const before = anchor - radius;
      const after = anchor + radius;
      if (before >= 0) selected.add(before);
      if (selected.size >= STORYBOARD_MAX_FRAMES) break;
      if (after < frames.length) selected.add(after);
      if (selected.size >= STORYBOARD_MAX_FRAMES) break;
    }
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => frames[index]!)
    .filter((frame, index, arr) => index === 0 || frame.path !== arr[index - 1]?.path);
}

function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

async function spawnFfmpegScreenshotClip(imagePaths: string[], outPath: string): Promise<void> {
  const existing = imagePaths.filter((path) => existsSync(path));
  if (existing.length === 0) throw new Error('no screenshot frames for clip');
  const tmp = mkdtempSync(join(tmpdir(), 'iris-trace-storyboard-'));
  try {
    const listPath = join(tmp, 'frames.txt');
    const lines: string[] = [];
    for (const imagePath of existing) {
      lines.push(`file '${escapeConcatPath(imagePath)}'`);
      lines.push(`duration ${STORYBOARD_FRAME_DURATION_S}`);
    }
    lines.push(`file '${escapeConcatPath(existing[existing.length - 1]!)}'`);
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
