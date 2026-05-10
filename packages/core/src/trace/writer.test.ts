import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceEvent } from './schema.js';
import { TraceWriter } from './writer.js';

describe('TraceWriter', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-trace-'));
    path = join(dir, 'trace.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON line per event and closes cleanly', async () => {
    const w = new TraceWriter(path);
    await w.append(makeEvent('T1', 0, 'run_start', { config: { x: 1 } }));
    await w.append(makeEvent('T2', 1, 'observation', { url: 'https://x' }));
    await w.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const e1 = JSON.parse(lines[0]!) as TraceEvent;
    const e2 = JSON.parse(lines[1]!) as TraceEvent;
    expect(e1.id).toBe('T1');
    expect(e2.id).toBe('T2');
    expect(e2.payload).toEqual({ url: 'https://x' });
  });

  it('rejects events that fail schema validation', async () => {
    const w = new TraceWriter(path);
    const invalid = {
      v: 99,
      id: '',
      ts: 0,
      step: 0,
      target_kind: 'web',
      kind: 'action',
      actor: 'explorer',
      payload: {},
    } as unknown as TraceEvent;
    await expect(w.append(invalid)).rejects.toThrow();
    await w.close();
  });

  it('events written are recoverable in order', async () => {
    const w = new TraceWriter(path);
    for (let i = 0; i < 10; i++) {
      await w.append(makeEvent(`T${i}`, i, 'action', { i }));
    }
    await w.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(JSON.parse(lines[i]!).id).toBe(`T${i}`);
    }
  });
});

function makeEvent(
  id: string,
  step: number,
  kind: TraceEvent['kind'],
  payload: object,
): TraceEvent {
  return {
    v: 1,
    id,
    ts: Date.now() / 1000,
    step,
    target_kind: 'web',
    kind,
    actor: 'system',
    payload: payload as Record<string, unknown>,
  };
}
