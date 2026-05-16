import { describe, expect, it } from 'vitest';
import {
  EXPLORER_CORE,
  buildSystemPrompt,
  buildUserPrompt,
  modeSuffix,
  personaSuffix,
  targetKindSuffix,
} from './prompts.js';

describe('EXPLORER_CORE', () => {
  it('contains "curious"', () => {
    expect(EXPLORER_CORE).toContain('curious');
  });

  it('contains "explore"', () => {
    expect(EXPLORER_CORE).toContain('explore');
  });

  it('contains "unfamiliar product"', () => {
    expect(EXPLORER_CORE).toContain('unfamiliar product');
  });

  it('requires outcome evidence ids for verified goals', () => {
    expect(EXPLORER_CORE).toContain('evidence_event_ids');
    expect(EXPLORER_CORE).toContain('post-action observation');
  });

  it('requires scenario acceptance criteria to drive real product use', () => {
    expect(EXPLORER_CORE).toContain('scenario acceptance criteria');
    expect(EXPLORER_CORE).toContain('primary journey');
    expect(EXPLORER_CORE).toContain('weak proof');
    expect(EXPLORER_CORE).toContain('create or modify a durable artifact/state');
    expect(EXPLORER_CORE).toContain('minimally meaningful');
    expect(EXPLORER_CORE).toContain('draw/place plus label/type plus style/move/resize');
    expect(EXPLORER_CORE).toContain('before/after state delta');
    expect(EXPLORER_CORE).toContain('selected toolbar value alone is weak proof');
  });

  it('routes file-picker and download flows through first-class tools', () => {
    expect(EXPLORER_CORE).toContain('click_upload');
    expect(EXPLORER_CORE).toContain('click_download');
    expect(EXPLORER_CORE).toContain('downloaded file path is first-class outcome evidence');
  });

  it('keeps setup and peripheral surfaces out of dynamic goal expansion', () => {
    expect(EXPLORER_CORE).toContain('material product outcome');
    expect(EXPLORER_CORE).toContain('Inventory modals, banners, footer links');
    expect(EXPLORER_CORE).toContain('do not promote them to goals');
  });
});

describe('targetKindSuffix', () => {
  it('web suffix contains "browser"', () => {
    expect(targetKindSuffix('web')).toContain('browser');
  });

  it('cli returns a string', () => {
    expect(typeof targetKindSuffix('cli')).toBe('string');
  });

  it('api returns a string', () => {
    expect(typeof targetKindSuffix('api')).toBe('string');
  });

  it('desktop returns a string', () => {
    expect(typeof targetKindSuffix('desktop')).toBe('string');
  });
});

describe('modeSuffix', () => {
  it('free contains "discover"', () => {
    expect(modeSuffix('free')).toContain('discover');
  });

  it('grounded returns a string', () => {
    expect(typeof modeSuffix('grounded')).toBe('string');
  });

  it('targeted returns a string', () => {
    expect(typeof modeSuffix('targeted')).toBe('string');
  });
});

describe('personaSuffix', () => {
  it('default contains "sensible"', () => {
    expect(personaSuffix('default')).toContain('sensible');
  });
});

describe('buildSystemPrompt', () => {
  it('composes all four slots with separators', () => {
    const result = buildSystemPrompt({
      core: EXPLORER_CORE,
      target_kind: 'web',
      mode: 'free',
      persona: 'default',
    });

    // All four pieces present
    expect(result).toContain(EXPLORER_CORE);
    expect(result).toContain(targetKindSuffix('web'));
    expect(result).toContain(modeSuffix('free'));
    expect(result).toContain(personaSuffix('default'));

    // Separators present
    expect(result).toContain('---');
  });
});

describe('buildUserPrompt', () => {
  const baseArgs = {
    observation_summary: 'page shows X',
    plan_stack: ['verify checkout'],
    site_map: { seen: 3, unexplored: 2, coverage: 0.6 },
    recent_actions: ['click #foo'],
    budget: { steps: 50, usd: 4.2, seconds: 500 },
  };

  it('includes observation_summary', () => {
    expect(buildUserPrompt(baseArgs)).toContain('page shows X');
  });

  it('includes plan_stack item', () => {
    expect(buildUserPrompt(baseArgs)).toContain('verify checkout');
  });

  it('includes site_map fields', () => {
    const result = buildUserPrompt(baseArgs);
    expect(result).toContain('3');
    expect(result).toContain('2');
    expect(result).toContain('0.6');
  });

  it('includes recent_actions item', () => {
    expect(buildUserPrompt(baseArgs)).toContain('click #foo');
  });

  it('includes budget fields', () => {
    const result = buildUserPrompt(baseArgs);
    expect(result).toContain('50');
    expect(result).toContain('4.2');
    expect(result).toContain('500');
  });

  it('includes section headers', () => {
    const result = buildUserPrompt(baseArgs);
    expect(result).toContain('current_observation');
    expect(result).toContain('plan_stack');
    expect(result).toContain('site_map');
    expect(result).toContain('recent_actions');
    expect(result).toContain('budget_left');
  });
});
