import { describe, expect, it } from 'vitest';
import { type TraceEvent, TraceEventSchema } from './schema.js';

describe('TraceEvent envelope', () => {
  it('validates a minimal action event', () => {
    const e: TraceEvent = {
      v: 1,
      id: 'T000001',
      ts: 1747432424.812,
      step: 1,
      target_kind: 'web',
      kind: 'action',
      actor: 'explorer',
      payload: { tool: 'click', args: { selector: 'button' } },
    };
    expect(TraceEventSchema.parse(e)).toEqual(e);
  });

  it('rejects unknown actor', () => {
    expect(() =>
      TraceEventSchema.parse({
        v: 1,
        id: 'T000001',
        ts: 1.0,
        step: 0,
        target_kind: 'web',
        kind: 'action',
        actor: 'mystery',
        payload: {},
      }),
    ).toThrow();
  });

  it('rejects v != 1', () => {
    expect(() =>
      TraceEventSchema.parse({
        v: 2,
        id: 'T000001',
        ts: 1.0,
        step: 0,
        target_kind: 'web',
        kind: 'action',
        actor: 'system',
        payload: {},
      }),
    ).toThrow();
  });

  it('accepts all defined kinds', () => {
    const kinds = [
      'run_start',
      'spec_interpreted',
      'step_plan',
      'action',
      'action_result',
      'observation',
      'probe_call',
      'probe_result',
      'evidence',
      'tentative_finding',
      'hypothesis',
      'surface_seen',
      'surface_unexplored',
      'step_done',
      'give_up',
      'done',
      'budget_warn',
      'budget_abort',
      'run_end',
    ] as const;
    for (const kind of kinds) {
      const e = {
        v: 1 as const,
        id: 'T000001',
        ts: 1.0,
        step: 0,
        target_kind: 'web' as const,
        kind,
        actor: 'system' as const,
        payload: {},
      };
      expect(TraceEventSchema.parse(e).kind).toBe(kind);
    }
  });
});
