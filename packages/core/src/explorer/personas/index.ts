import { ADVERSARIAL_PERSONA } from './adversarial.js';
import { DEFAULT_PERSONA } from './default.js';
import { KEYBOARD_ONLY_PERSONA } from './keyboard-only.js';
import { NOVICE_PERSONA } from './novice.js';
import { POWER_USER_PERSONA } from './power-user.js';

export type PersonaName = 'default' | 'power_user' | 'novice' | 'adversarial' | 'keyboard_only';

export const PERSONAS: Record<PersonaName, string> = {
  default: DEFAULT_PERSONA,
  power_user: POWER_USER_PERSONA,
  novice: NOVICE_PERSONA,
  adversarial: ADVERSARIAL_PERSONA,
  keyboard_only: KEYBOARD_ONLY_PERSONA,
};

export const PERSONA_NAMES: PersonaName[] = [
  'default',
  'power_user',
  'novice',
  'adversarial',
  'keyboard_only',
];

export {
  DEFAULT_PERSONA,
  POWER_USER_PERSONA,
  NOVICE_PERSONA,
  ADVERSARIAL_PERSONA,
  KEYBOARD_ONLY_PERSONA,
};
