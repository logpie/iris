import { describe, expect, it } from 'vitest';
import { loadRubricsByNames } from './load-rubrics.js';

describe('loadRubricsByNames', () => {
  it('loads all web rubrics by default', async () => {
    const rs = await loadRubricsByNames();
    expect(rs.map((r) => r.name).sort()).toEqual([
      'accessibility',
      'coverage',
      'frontend_correctness',
      'quality',
      'usability',
      'ux_baseline',
    ]);
  });

  it('loads only requested rubrics', async () => {
    const rs = await loadRubricsByNames(['usability']);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.name).toBe('usability');
  });
});
