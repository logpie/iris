import { describe, expect, it } from 'vitest';
import { type EvalInputs, inferMode } from './flags.js';

describe('inferMode', () => {
  it('returns targeted when --task is given', () => {
    const inp: EvalInputs = { tasks: ['verify checkout'] };
    expect(inferMode(inp)).toBe('targeted');
  });

  it('returns targeted when --tasks file is given', () => {
    expect(inferMode({ tasks_path: '/x.txt' })).toBe('targeted');
  });

  it('returns grounded when only --spec is given', () => {
    expect(inferMode({ spec_path: '/spec.md' })).toBe('grounded');
  });

  it('returns free when nothing is given', () => {
    expect(inferMode({})).toBe('free');
  });

  it('explicit override wins over inference', () => {
    expect(inferMode({ spec_path: '/spec.md', explicit_mode: 'free' })).toBe('free');
    expect(inferMode({ tasks: ['x'], explicit_mode: 'grounded' })).toBe('grounded');
  });

  it('throws when explicit mode is invalid', () => {
    expect(() => inferMode({ explicit_mode: 'explore' })).toThrow();
  });
});
