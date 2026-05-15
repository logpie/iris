import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceFile, EvidenceRef } from '@iris/adapter-types';

export interface ClipWindow {
  finding_id: string;
  start_s: number;
  duration_s: number;
}

export interface FfmpegSliceConfig {
  /** Map of trace event id → wall-clock timestamp (seconds since epoch) */
  event_ts: Record<string, number>;
  /** Wall-clock timestamp (seconds) when the recording started */
  recording_started_ts: number;
  /** Total recording duration in seconds */
  recording_duration_s: number;
  /** Pre-roll seconds before the earliest evidence event */
  pre_roll_s?: number;
  /** Post-roll seconds after the latest evidence event */
  post_roll_s?: number;
  /** Maximum clip length */
  max_clip_s?: number;
  /** Minimum gap between adjacent findings to share a clip (seconds) */
  shared_clip_gap_s?: number;
}

export interface ScreenshotFrame {
  ref: string;
  path: string;
  ts: number;
}

const DEFAULT_PRE_ROLL = 6;
const DEFAULT_POST_ROLL = 2;
const DEFAULT_MAX_CLIP = 16;
const DEFAULT_SHARED_GAP = 5;
const DEFAULT_FRAME_DURATION = 1.2;
const DEFAULT_MAX_SCREENSHOT_FRAMES = 4;

/**
 * Compute clip windows for findings. Adjacent windows within `shared_clip_gap_s` are merged
 * (so two findings get the same clip). Each window is clamped to recording bounds and
 * capped at `max_clip_s`.
 */
export function computeClipWindows(refs: EvidenceRef[], config: FfmpegSliceConfig): ClipWindow[] {
  const pre = config.pre_roll_s ?? DEFAULT_PRE_ROLL;
  const post = config.post_roll_s ?? DEFAULT_POST_ROLL;
  const maxClip = config.max_clip_s ?? DEFAULT_MAX_CLIP;
  const sharedGap = config.shared_clip_gap_s ?? DEFAULT_SHARED_GAP;

  // Compute raw window per finding (start_s/end_s in recording-local seconds).
  type RawWindow = { finding_id: string; start_s: number; end_s: number };
  const raw: RawWindow[] = [];
  for (const ref of refs) {
    const tss: number[] = [];
    for (const eid of ref.event_ids) {
      const t = config.event_ts[eid];
      if (t !== undefined) tss.push(t - config.recording_started_ts);
    }
    if (tss.length === 0) continue;
    const earliest = Math.min(...tss);
    const latest = Math.max(...tss);
    const start = Math.max(0, earliest - pre);
    let end = Math.min(config.recording_duration_s, latest + post);
    if (end - start > maxClip) end = start + maxClip;
    raw.push({ finding_id: ref.finding_id, start_s: start, end_s: end });
  }

  // Sort by start_s. Adjacent windows that start within sharedGap of the previous end share a clip.
  raw.sort((a, b) => a.start_s - b.start_s);
  const out: ClipWindow[] = [];
  let i = 0;
  while (i < raw.length) {
    const first = raw[i];
    if (!first) break;
    const group: RawWindow[] = [first];
    let groupEnd = first.end_s;
    let j = i + 1;
    while (j < raw.length) {
      const next = raw[j];
      if (!next || next.start_s - groupEnd > sharedGap) break;
      group.push(next);
      groupEnd = Math.max(groupEnd, next.end_s);
      // cap merged duration
      if (groupEnd - first.start_s > maxClip) {
        groupEnd = first.start_s + maxClip;
        break;
      }
      j++;
    }
    const sharedStart = first.start_s;
    const sharedEnd = Math.min(groupEnd, sharedStart + maxClip);
    for (const g of group) {
      out.push({
        finding_id: g.finding_id,
        start_s: sharedStart,
        duration_s: sharedEnd - sharedStart,
      });
    }
    i = j;
  }
  return out;
}

export function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

export async function spawnFfmpegClip(
  videoPath: string,
  startS: number,
  durationS: number,
  outPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss',
      String(startS),
      '-i',
      videoPath,
      '-t',
      String(durationS),
      '-an',
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
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    );
  });
}

export async function sliceEvidenceClips(
  refs: EvidenceRef[],
  videoPath: string,
  windows: ClipWindow[],
  outDir: string,
): Promise<EvidenceFile[]> {
  if (!existsSync(videoPath)) return [];
  if (!(await isFfmpegAvailable())) return [];
  mkdirSync(outDir, { recursive: true });
  const out: EvidenceFile[] = [];
  // Group windows by (start_s, duration_s) so shared clips are produced once
  const byClip = new Map<string, { start: number; duration: number; findings: string[] }>();
  for (const w of windows) {
    const key = `${w.start_s.toFixed(3)}-${w.duration_s.toFixed(3)}`;
    const existing = byClip.get(key);
    if (existing) existing.findings.push(w.finding_id);
    else byClip.set(key, { start: w.start_s, duration: w.duration_s, findings: [w.finding_id] });
  }
  let idx = 0;
  for (const [, clip] of byClip) {
    idx++;
    const clipPath = join(outDir, `clip-${String(idx).padStart(3, '0')}.webm`);
    try {
      await spawnFfmpegClip(videoPath, clip.start, clip.duration, clipPath);
      for (const fid of clip.findings) {
        out.push({ finding_id: fid, path: clipPath, kind: 'video' });
      }
    } catch {
      // skip this clip; keep going
    }
  }
  // Drop refs that weren't matched at all
  return out;
}

export function selectScreenshotFrames(
  ref: EvidenceRef,
  timeline: ScreenshotFrame[],
  maxFrames = DEFAULT_MAX_SCREENSHOT_FRAMES,
): ScreenshotFrame[] {
  const ordered = timeline
    .filter((frame) => existsSync(frame.path))
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => a.frame.ts - b.frame.ts || a.index - b.index);
  if (ordered.length === 0) return [];

  const anchors = ref.event_ids
    .map((id) => ordered.findIndex((entry) => entry.frame.ref === id))
    .filter((index) => index >= 0);
  const anchor = anchors[0];
  if (anchor === undefined) return [];

  const selected = new Set<number>();
  selected.add(anchor);
  for (let offset = 1; selected.size < maxFrames && offset <= ordered.length; offset++) {
    const before = anchor - offset;
    const after = anchor + offset;
    if (before >= 0) selected.add(before);
    if (selected.size >= maxFrames) break;
    if (after < ordered.length) selected.add(after);
  }

  return Array.from(selected)
    .sort((a, b) => a - b)
    .slice(0, maxFrames)
    .map((index) => ordered[index]!.frame);
}

export async function sliceEvidenceScreenshotClips(
  refs: EvidenceRef[],
  timeline: ScreenshotFrame[],
  outDir: string,
): Promise<EvidenceFile[]> {
  if (!(await isFfmpegAvailable())) return [];
  mkdirSync(outDir, { recursive: true });
  const out: EvidenceFile[] = [];
  for (const ref of refs) {
    const frames = selectScreenshotFrames(ref, timeline);
    if (frames.length === 0) continue;
    const clipPath = join(outDir, `claim-${safeClipName(ref.finding_id)}.webm`);
    try {
      await spawnFfmpegScreenshotClip(
        frames.map((frame) => frame.path),
        clipPath,
      );
      out.push({ finding_id: ref.finding_id, path: clipPath, kind: 'video' });
    } catch {
      // Keep the claim visible through screenshot fallback in the caller.
    }
  }
  return out;
}

export async function spawnFfmpegScreenshotClip(
  imagePaths: string[],
  outPath: string,
): Promise<void> {
  const existing = imagePaths.filter((path) => existsSync(path));
  if (existing.length === 0) throw new Error('no screenshot frames for clip');
  const tmp = mkdtempSync(join(tmpdir(), 'iris-claim-clip-'));
  try {
    const listPath = join(tmp, 'frames.txt');
    const lines: string[] = [];
    for (const imagePath of existing) {
      lines.push(`file '${escapeConcatPath(imagePath)}'`);
      lines.push(`duration ${DEFAULT_FRAME_DURATION}`);
    }
    lines.push(`file '${escapeConcatPath(existing[existing.length - 1]!)}'`);
    writeFileSync(listPath, `${lines.join('\n')}\n`);
    await new Promise<void>((resolve, reject) => {
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
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
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
