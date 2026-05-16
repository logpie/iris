import { describe, expect, it } from 'vitest';
import { JUDGE_SYSTEM } from './prompts.js';

describe('JUDGE_SYSTEM', () => {
  it('instructs the Judge to preserve goal scope boundaries', () => {
    expect(JUDGE_SYSTEM).toContain('Preserve the exact claim boundary in goal notes');
    expect(JUDGE_SYSTEM).toContain('it must NOT say or imply "user logged in"');
    expect(JUDGE_SYSTEM).toContain('verified means the stated scope was verified');
  });

  it('instructs the Judge not to score failed Iris probes as product results', () => {
    expect(JUDGE_SYSTEM).toContain(
      'Do not penalize the product for Iris/tooling instrumentation errors',
    );
    expect(JUDGE_SYSTEM).toContain('If the axe probe itself failed or was blocked by CSP/tooling');
    expect(JUDGE_SYSTEM).toContain('do not claim axe passed');
  });

  it('instructs the Judge to score real-use depth from scenario acceptance criteria', () => {
    expect(JUDGE_SYSTEM).toContain('product_use_contract');
    expect(JUDGE_SYSTEM).toContain('primary journey');
    expect(JUDGE_SYSTEM).toContain('weak_evidence');
    expect(JUDGE_SYSTEM).toContain('Separate surface coverage from real-use depth');
    expect(JUDGE_SYSTEM).toContain('Separate product quality from evaluator uncertainty');
    expect(JUDGE_SYSTEM).toContain('not automatically a product defect');
  });

  it('instructs the Judge not to treat disabled destructive controls as product defects', () => {
    expect(JUDGE_SYSTEM).toContain('First verify the trace established the action precondition');
    expect(JUDGE_SYSTEM).toContain('the relevant control was enabled');
    expect(JUDGE_SYSTEM).toContain('treat it as an Iris execution/proof gap');
  });
});
