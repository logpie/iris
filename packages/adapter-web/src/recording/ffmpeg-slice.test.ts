import { describe, expect, it } from 'vitest';
import { computeClipWindows, isFfmpegAvailable } from './ffmpeg-slice.js';

describe('computeClipWindows', () => {
  it('returns empty for empty refs', () => {
    expect(
      computeClipWindows([], {
        event_ts: {},
        recording_started_ts: 0,
        recording_duration_s: 60,
      }),
    ).toEqual([]);
  });

  it('skips findings whose evidence has no matching ts', () => {
    const out = computeClipWindows([{ finding_id: 'F1', event_ids: ['T_unknown'] }], {
      event_ts: {},
      recording_started_ts: 0,
      recording_duration_s: 60,
    });
    expect(out).toEqual([]);
  });

  it('produces a window with default pre/post roll around evidence ts', () => {
    const out = computeClipWindows([{ finding_id: 'F1', event_ids: ['T1'] }], {
      event_ts: { T1: 10 },
      recording_started_ts: 0,
      recording_duration_s: 60,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.start_s).toBeCloseTo(8.5);
    expect(out[0]?.duration_s).toBeCloseTo(4.0);
  });

  it('clamps start_s to 0', () => {
    const out = computeClipWindows([{ finding_id: 'F1', event_ids: ['T1'] }], {
      event_ts: { T1: 0.5 },
      recording_started_ts: 0,
      recording_duration_s: 60,
    });
    expect(out[0]?.start_s).toBe(0);
  });

  it('clamps end_s to recording_duration_s', () => {
    const out = computeClipWindows([{ finding_id: 'F1', event_ids: ['T1'] }], {
      event_ts: { T1: 59 },
      recording_started_ts: 0,
      recording_duration_s: 60,
    });
    expect(out[0]!.start_s + out[0]!.duration_s).toBeLessThanOrEqual(60);
  });

  it('caps duration at max_clip_s', () => {
    const out = computeClipWindows([{ finding_id: 'F1', event_ids: ['T1', 'T2'] }], {
      event_ts: { T1: 0, T2: 100 },
      recording_started_ts: 0,
      recording_duration_s: 200,
      max_clip_s: 5,
    });
    expect(out[0]?.duration_s).toBeLessThanOrEqual(5);
  });

  it('adjacent findings within shared_clip_gap_s share a clip', () => {
    const out = computeClipWindows(
      [
        { finding_id: 'F1', event_ids: ['T1'] },
        { finding_id: 'F2', event_ids: ['T2'] },
      ],
      { event_ts: { T1: 10, T2: 12 }, recording_started_ts: 0, recording_duration_s: 60 },
    );
    expect(out).toHaveLength(2);
    // both windows should share the same start
    expect(out[0]?.start_s).toBe(out[1]?.start_s);
  });

  it('non-adjacent findings get separate windows', () => {
    const out = computeClipWindows(
      [
        { finding_id: 'F1', event_ids: ['T1'] },
        { finding_id: 'F2', event_ids: ['T2'] },
      ],
      { event_ts: { T1: 10, T2: 30 }, recording_started_ts: 0, recording_duration_s: 60 },
    );
    expect(out[0]?.start_s).not.toBe(out[1]?.start_s);
  });
});

describe('isFfmpegAvailable', () => {
  it('returns boolean (presence varies by env)', async () => {
    const r = await isFfmpegAvailable();
    expect(typeof r).toBe('boolean');
  });
});
