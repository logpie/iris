import { describe, expect, it } from 'vitest';
import { resolveTraceRefTypo } from './ref-resolver.js';
import type { TraceEvent } from './schema.js';

const ev = (
  id: string,
  kind: TraceEvent['kind'],
  payload: Record<string, unknown> = {},
): TraceEvent => ({
  v: 1,
  id,
  ts: 0,
  step: 0,
  target_kind: 'web',
  kind,
  actor: 'adapter',
  payload,
});

describe('resolveTraceRefTypo', () => {
  it('resolves observation refs to canonical trace event ids', () => {
    const trace = [
      ev('A', 'observation', { ref: 'OBS-000001' }),
      ev('B', 'observation', { ref: 'OBS-000002' }),
    ];

    expect(resolveTraceRefTypo('OBS-000002', trace)).toBe('B');
  });

  it('does not resolve ambiguous observation refs', () => {
    const trace = [
      ev('A', 'observation', { ref: 'OBS-000001' }),
      ev('B', 'observation', { ref: 'OBS-000001' }),
    ];

    expect(resolveTraceRefTypo('OBS-000001', trace)).toBeUndefined();
  });
});
