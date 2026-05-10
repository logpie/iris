import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_PERSONA,
  DEFAULT_PERSONA,
  KEYBOARD_ONLY_PERSONA,
  NOVICE_PERSONA,
  PERSONAS,
  PERSONA_NAMES,
  POWER_USER_PERSONA,
  type PersonaName,
} from './index.js';

describe('personas', () => {
  it('exports 5 named personas', () => {
    expect(PERSONA_NAMES).toHaveLength(5);
    for (const n of PERSONA_NAMES) expect(PERSONAS[n]).toBeDefined();
  });

  it('default persona mentions sensible / curious', () => {
    expect(DEFAULT_PERSONA).toMatch(/sensible|curious/i);
  });

  it('power_user persona mentions keyboard / shortcuts / efficient', () => {
    expect(POWER_USER_PERSONA).toMatch(/keyboard|shortcut|efficient/i);
  });

  it('novice persona mentions help / hesitate / unclear', () => {
    expect(NOVICE_PERSONA).toMatch(/hesitate|unclear|read every/i);
  });

  it('adversarial persona mentions break / fuzz / weird', () => {
    expect(ADVERSARIAL_PERSONA).toMatch(/break|fuzz|weird|special characters/i);
  });

  it('keyboard_only persona mentions Tab / focus / mouse', () => {
    expect(KEYBOARD_ONLY_PERSONA).toMatch(/Tab|focus|mouse/i);
  });

  it('PERSONAS lookup type-safe', () => {
    const n: PersonaName = 'power_user';
    expect(PERSONAS[n]).toContain('power user');
  });
});
