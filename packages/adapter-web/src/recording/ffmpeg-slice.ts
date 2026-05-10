import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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

const DEFAULT_PRE_ROLL = 1.5;
const DEFAULT_POST_ROLL = 2.5;
const DEFAULT_MAX_CLIP = 30;
const DEFAULT_SHARED_GAP = 5;

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
    const group: RawWindow[] = [raw[i]!];
    let groupEnd = raw[i]!.end_s;
    let j = i + 1;
    while (j < raw.length && raw[j]!.start_s - groupEnd <= sharedGap) {
      group.push(raw[j]!);
      groupEnd = Math.max(groupEnd, raw[j]!.end_s);
      // cap merged duration
      if (groupEnd - group[0]!.start_s > maxClip) {
        groupEnd = group[0]!.start_s + maxClip;
        break;
      }
      j++;
    }
    const sharedStart = group[0]!.start_s;
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
      '-c',
      'copy',
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
