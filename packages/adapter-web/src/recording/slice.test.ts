import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type StepScreenshotIndex, sliceEvidenceScreenshots } from './slice.js';

describe('sliceEvidenceScreenshots', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-slice-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns one EvidenceFile per finding pointing at the step screenshot', () => {
    const screenshots = join(dir, 'screenshots');
    mkdirSync(screenshots, { recursive: true });
    writeFileSync(join(screenshots, 'step-0017.png'), 'fake');

    const index: StepScreenshotIndex = {
      T000139: join(screenshots, 'step-0017.png'),
      T000142: join(screenshots, 'step-0017.png'),
    };

    const out = sliceEvidenceScreenshots(
      [{ finding_id: 'F-001', event_ids: ['T000139', 'T000142'] }],
      index,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.finding_id).toBe('F-001');
    expect(out[0]?.kind).toBe('screenshot');
    expect(out[0]?.path).toBe(join(screenshots, 'step-0017.png'));
  });

  it('skips findings whose evidence has no matching screenshots', () => {
    const out = sliceEvidenceScreenshots([{ finding_id: 'F-002', event_ids: ['T999'] }], {});
    expect(out).toHaveLength(0);
  });
});
