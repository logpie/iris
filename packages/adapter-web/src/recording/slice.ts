import type { EvidenceFile, EvidenceRef } from '@iris/adapter-types';

/**
 * Map of trace event id → absolute path of screenshot captured at that step.
 * Built up during a run by the orchestrator (Phase 3) as steps execute.
 */
export type StepScreenshotIndex = Record<string, string>;

/**
 * Phase 2 implementation: per finding, return ONE EvidenceFile pointing at the first
 * matching screenshot for any of the cited event_ids. Findings with no matching
 * screenshots are skipped.
 *
 * Phase 4 will add ffmpeg-driven .webm clip slicing covering the time window of
 * the cited events. For Phase 2, screenshots are sufficient evidence.
 */
export function sliceEvidenceScreenshots(
  refs: EvidenceRef[],
  index: StepScreenshotIndex,
): EvidenceFile[] {
  const out: EvidenceFile[] = [];
  for (const ref of refs) {
    let path: string | undefined;
    for (const id of ref.event_ids) {
      if (index[id]) {
        path = index[id];
        break;
      }
    }
    if (path) {
      out.push({ finding_id: ref.finding_id, path, kind: 'screenshot' });
    }
  }
  return out;
}
