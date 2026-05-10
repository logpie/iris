import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RubricProfileSchema, type RubricProfile } from './schema.js';

const PROFILES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'profiles');

export async function loadRubricFile(path: string): Promise<RubricProfile> {
  const text = await readFile(path, 'utf8');
  const data = parseYaml(text);
  return RubricProfileSchema.parse(data);
}

export async function loadBundledRubric(
  target: 'web' | 'cli' | 'api' | 'desktop' | 'shared',
  name: string,
): Promise<RubricProfile> {
  const path = join(PROFILES_ROOT, target, `${name}.yaml`);
  return loadRubricFile(path);
}
