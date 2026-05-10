import { describe, expect, it } from 'vitest';
import { LoopDetector } from './loop-detection.js';

describe('LoopDetector', () => {
  it('returns normal on first record', () => {
    const d = new LoopDetector();
    expect(d.record('a')).toBe('normal');
  });

  it('returns normal when digests vary', () => {
    const d = new LoopDetector();
    expect(d.record('a')).toBe('normal');
    expect(d.record('b')).toBe('normal');
    expect(d.record('a')).toBe('normal');
  });

  it('returns warning after 3 same digests in a row', () => {
    const d = new LoopDetector();
    expect(d.record('a')).toBe('normal');
    expect(d.record('a')).toBe('normal');
    expect(d.record('a')).toBe('warning');
  });

  it('returns force_give_up after 5 same digests in a row', () => {
    const d = new LoopDetector();
    d.record('a');
    d.record('a');
    d.record('a');
    d.record('a');
    expect(d.record('a')).toBe('force_give_up');
  });

  it('a different digest in between resets the run', () => {
    const d = new LoopDetector();
    d.record('a');
    d.record('a');
    d.record('b');
    expect(d.record('a')).toBe('normal');
  });
});
