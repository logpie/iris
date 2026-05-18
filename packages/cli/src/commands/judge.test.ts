import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveJudgeReplayThreshold } from './judge.js';

describe('resolveJudgeReplayThreshold', () => {
  it('prefers explicit threshold over source run config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-judge-threshold-'));
    try {
      writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ threshold: 9.5 })}\n`);
      expect(
        resolveJudgeReplayThreshold({
          tracePath: join(dir, 'trace.jsonl'),
          explicitThreshold: 7.25,
        }),
      ).toBe(7.25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses stored source-run threshold when replaying a trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-judge-threshold-'));
    try {
      writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ threshold: 9.5 })}\n`);
      expect(resolveJudgeReplayThreshold({ tracePath: join(dir, 'trace.jsonl') })).toBe(9.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
