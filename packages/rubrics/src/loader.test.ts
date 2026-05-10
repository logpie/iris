import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundledRubric, loadRubricFile } from './loader.js';

describe('rubric loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-rubric-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the bundled web/usability profile', async () => {
    const r = await loadBundledRubric('web', 'usability');
    expect(r.name).toBe('usability');
    expect(r.applies_to_targets).toContain('web');
    expect(r.dimensions.length).toBeGreaterThan(0);
    const clarity = r.dimensions.find((d) => d.id === 'clarity');
    expect(clarity).toBeDefined();
    expect(clarity?.weight).toBe(1.0);
  });

  it('rejects YAML missing required fields', async () => {
    const path = join(dir, 'broken.yaml');
    writeFileSync(path, 'name: x\n'); // missing dimensions, applies_to_*, weight
    await expect(loadRubricFile(path)).rejects.toThrow();
  });

  it('rejects YAML with bad applies_to_targets value', async () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `name: x
applies_to_targets: [moon]
applies_to_modes: [free]
weight_in_overall: 1
dimensions:
  - id: d
    weight: 1
    description: test
`,
    );
    await expect(loadRubricFile(path)).rejects.toThrow();
  });

  it('loads bundled web/quality profile', async () => {
    const r = await loadBundledRubric('web', 'quality');
    expect(r.name).toBe('quality');
    expect(r.dimensions.find((d) => d.id === 'correctness')).toBeDefined();
  });

  it('loads bundled web/accessibility profile', async () => {
    const r = await loadBundledRubric('web', 'accessibility');
    expect(r.name).toBe('accessibility');
    expect(r.dimensions.length).toBeGreaterThanOrEqual(5);
  });

  it('loads bundled web/frontend-correctness profile', async () => {
    const r = await loadBundledRubric('web', 'frontend-correctness');
    expect(r.name).toBe('frontend_correctness');
    expect(r.dimensions.find((d) => d.id === 'console_clean')).toBeDefined();
  });

  it('loads bundled web/coverage profile', async () => {
    const r = await loadBundledRubric('web', 'coverage');
    expect(r.name).toBe('coverage');
    expect(r.dimensions.find((d) => d.id === 'breadth')).toBeDefined();
  });

  it('loads bundled shared/correctness profile', async () => {
    const r = await loadBundledRubric('shared', 'correctness');
    expect(r.name).toBe('shared_correctness');
    expect(r.dimensions.find((d) => d.id === 'error_recovery')).toBeDefined();
  });
});
