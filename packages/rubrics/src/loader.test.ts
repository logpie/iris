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
});
