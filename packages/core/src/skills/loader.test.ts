import { describe, expect, it } from 'vitest';
import { loadProjectSkill } from './loader.js';

describe('loadProjectSkill', () => {
  it('loads the provider-neutral skill source before legacy provider folders', () => {
    const skill = loadProjectSkill('evaluating-products-as-real-user');

    expect(skill).toContain('# Evaluating Products as a Real User');
    expect(skill).toContain('## Materiality Rule');
    expect(skill).toContain('Act like a curious first-time user');
  });
});
