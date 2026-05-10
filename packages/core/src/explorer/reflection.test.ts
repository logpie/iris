import { describe, expect, it } from 'vitest';
import { buildReflectionPrompt, shouldReflect } from './reflection.js';

describe('shouldReflect', () => {
  it('returns false in targeted mode', () => {
    expect(
      shouldReflect({
        step: 10,
        mode: 'targeted',
        last_reflection_step: null,
        spec_goals_satisfied: true,
      }),
    ).toBe(false);
  });

  it('returns false in grounded mode before spec goals satisfied', () => {
    expect(
      shouldReflect({
        step: 10,
        mode: 'grounded',
        last_reflection_step: null,
        spec_goals_satisfied: false,
      }),
    ).toBe(false);
  });

  it('returns true in grounded mode after spec goals at cadence', () => {
    expect(
      shouldReflect({
        step: 10,
        mode: 'grounded',
        last_reflection_step: null,
        spec_goals_satisfied: true,
      }),
    ).toBe(true);
  });

  it('returns true in free mode at cadence', () => {
    expect(
      shouldReflect({
        step: 10,
        mode: 'free',
        last_reflection_step: null,
        spec_goals_satisfied: false,
      }),
    ).toBe(true);
  });

  it('returns false at step 0', () => {
    expect(
      shouldReflect({
        step: 0,
        mode: 'free',
        last_reflection_step: null,
        spec_goals_satisfied: false,
      }),
    ).toBe(false);
  });

  it('returns false off-cadence', () => {
    expect(
      shouldReflect({
        step: 7,
        mode: 'free',
        last_reflection_step: null,
        spec_goals_satisfied: false,
      }),
    ).toBe(false);
  });

  it('respects custom cadence', () => {
    expect(
      shouldReflect({
        step: 5,
        mode: 'free',
        last_reflection_step: null,
        spec_goals_satisfied: false,
        cadence: 5,
      }),
    ).toBe(true);
  });
});

describe('buildReflectionPrompt', () => {
  it('includes the four reflection questions', () => {
    const p = buildReflectionPrompt({
      surfaces_seen: 3,
      surfaces_unexplored: 2,
      hypotheses_count: 1,
      weirdness_attempted: ['empty_submit'],
    });
    expect(p).toMatch(/believe this product is/);
    expect(p).toMatch(/not explored/);
    expect(p).toMatch(/broad enough.*stuck deep/);
    expect(p).toMatch(/weirdness/);
    expect(p).toContain('3 seen');
    expect(p).toContain('2 unexplored');
    expect(p).toContain('empty_submit');
  });
});
