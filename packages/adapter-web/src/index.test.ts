import type { TargetAdapter } from '@iris/adapter-types';
import { describe, expect, it } from 'vitest';
import { WebTargetAdapter } from './index.js';

describe('WebTargetAdapter (Phase 1 stub)', () => {
  it('satisfies the TargetAdapter interface and reports kind=web', () => {
    const adapter: TargetAdapter = new WebTargetAdapter();
    expect(adapter.kind).toBe('web');
  });

  it('every method throws "not implemented in phase 1"', async () => {
    const a = new WebTargetAdapter();
    await expect(a.start({ kind: 'web', target: 'https://x', out_dir: '/tmp' })).rejects.toThrow(/phase 1/);
    await expect(a.stop()).rejects.toThrow(/phase 1/);
    expect(() => a.listTools()).toThrow(/phase 1/);
    await expect(a.callTool('click', {})).rejects.toThrow(/phase 1/);
    await expect(a.observe()).rejects.toThrow(/phase 1/);
    expect(() => a.listProbes()).toThrow(/phase 1/);
    await expect(a.runProbe('axe', {})).rejects.toThrow(/phase 1/);
    await expect(a.sliceEvidence([])).rejects.toThrow(/phase 1/);
  });
});
