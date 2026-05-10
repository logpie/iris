import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTrace, readTraceArray } from './reader.js';
import type { TraceEvent } from './schema.js';

describe('TraceReader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-reader-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads back a written trace', async () => {
    const path = join(dir, 'trace.jsonl');
    const events: TraceEvent[] = [
      mk('T1', 0, 'run_start'),
      mk('T2', 1, 'observation'),
      mk('T3', 2, 'action'),
    ];
    writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const collected = await readTraceArray(path);
    expect(collected).toEqual(events);
  });

  it('tolerates a missing trailing newline', async () => {
    const path = join(dir, 'trace.jsonl');
    const e = mk('T1', 0, 'run_start');
    writeFileSync(path, JSON.stringify(e));

    const collected = await readTraceArray(path);
    expect(collected).toEqual([e]);
  });

  it('skips a partial last line and reports the count of skipped lines', async () => {
    const path = join(dir, 'trace.jsonl');
    const valid = mk('T1', 0, 'run_start');
    writeFileSync(path, `${JSON.stringify(valid)}\n{"v":1,"id":"T2",`);

    const out: TraceEvent[] = [];
    let skipped = 0;
    for await (const item of readTrace(path)) {
      if (item.kind === 'event') out.push(item.event);
      else skipped++;
    }
    expect(out).toEqual([valid]);
    expect(skipped).toBe(1);
  });
});

function mk(id: string, step: number, kind: TraceEvent['kind']): TraceEvent {
  return {
    v: 1,
    id,
    ts: 1.0,
    step,
    target_kind: 'web',
    kind,
    actor: 'system',
    payload: {},
  };
}
