import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../trace/schema.js';
import { validateFindings } from './evidence-validator.js';
import type { JudgeFinding } from './judge.js';

const ev = (
  id: string,
  kind: TraceEvent['kind'],
  payload: Record<string, unknown> = {},
  step = 0,
): TraceEvent => ({
  v: 1,
  id,
  ts: Date.now() / 1000,
  step,
  target_kind: 'web',
  kind,
  actor: 'adapter',
  payload,
});

const finding = (overrides: Partial<JudgeFinding>): JudgeFinding => ({
  id: 'F-1',
  title: 't',
  category: 'bug',
  severity: 'major',
  evidence: [],
  rationale: 'r',
  ...overrides,
});

describe('validateFindings', () => {
  it('discards a finding whose evidence ids do not exist', () => {
    const trace = [ev('E1', 'action')];
    const out = validateFindings([finding({ evidence: ['BOGUS', 'NOPE'] })], trace);
    expect(out.kept).toHaveLength(0);
    expect(out.discarded[0]?.reason).toBe('all_evidence_ids_invalid');
  });

  it('downgrades blocker → major when no backing evidence in window', () => {
    const trace = [ev('E1', 'action', { tool: 'click' })];
    const out = validateFindings([finding({ severity: 'blocker', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.severity).toBe('major');
    expect(out.kept[0]?.unverified_backing).toBe(true);
    expect(out.summary.downgraded).toBe(1);
  });

  it('keeps a major finding backed by a probe_result with axe violations', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click' }),
      ev('E2', 'probe_result', { probe: 'axe', summary: { violations: 3 } }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1', 'E2'] })], trace);
    expect(out.kept[0]?.severity).toBe('major');
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('keeps a finding backed by a failed action_result', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click' }),
      ev('E2', 'action_result', { tool: 'click', ok: false, error: 'no such element' }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E2'] })], trace);
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('keeps a finding backed by an action_result with evidence_refs', () => {
    const trace = [
      ev('E1', 'action_result', { tool: 'screenshot', ok: true, evidence_refs: ['/p/step.png'] }),
    ];
    const out = validateFindings([finding({ severity: 'minor', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('treats tentative_finding events as backing', () => {
    const trace = [ev('E1', 'tentative_finding', { title: 'modal trap', category: 'a11y' })];
    const out = validateFindings(
      [finding({ severity: 'major', category: 'a11y', evidence: ['E1'] })],
      trace,
    );
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('suggestion-severity finding requires no backing', () => {
    const trace = [ev('E1', 'action')];
    const out = validateFindings([finding({ severity: 'suggestion', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.severity).toBe('suggestion');
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('minor → suggestion when unbacked; nit → suggestion', () => {
    const trace = [ev('E1', 'action')];
    const out = validateFindings(
      [
        finding({ id: 'F-A', severity: 'minor', evidence: ['E1'] }),
        finding({ id: 'F-B', severity: 'nit', evidence: ['E1'] }),
      ],
      trace,
    );
    expect(out.kept[0]?.severity).toBe('suggestion');
    expect(out.kept[1]?.severity).toBe('suggestion');
    expect(out.summary.downgraded).toBe(2);
  });

  // Phase 6 F1 ----------------------------------------------------

  it('treats strict-mode-violation action_result as Explorer error, not backing', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click' }),
      ev('E2', 'action_result', {
        tool: 'click',
        ok: false,
        error: "locator.click: Error: strict mode violation: locator('h1') resolved to 2 elements",
      }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E2'] })], trace);
    // Major → downgrade to minor + likely_explorer_error
    expect(out.kept[0]?.severity).toBe('minor');
    expect(out.kept[0]?.unverified_backing).toBe(true);
    expect(out.kept[0]?.likely_explorer_error).toBe(true);
  });

  it('treats "resolved to 0 elements" as Explorer error', () => {
    const trace = [
      ev('E1', 'action_result', {
        tool: 'click',
        ok: false,
        error: "locator('button.nope') resolved to 0 elements",
      }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.likely_explorer_error).toBe(true);
  });

  it('treats adapter-config errors (vision_describe) as Explorer error', () => {
    const trace = [
      ev('E1', 'action_result', {
        tool: 'vision_describe',
        ok: false,
        error: 'vision_describe requires an LlmClient — pass --persona',
      }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.likely_explorer_error).toBe(true);
  });

  it('treats timeout failure as real app evidence (not Explorer error)', () => {
    const trace = [
      ev('E1', 'action_result', {
        tool: 'click',
        ok: false,
        error: 'locator.click: Timeout 5000ms exceeded.',
      }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    // Timeout is genuine backing — element was found but couldn't be clicked.
    expect(out.kept[0]?.severity).toBe('major');
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('cancels backing when same tool succeeded within ±5 events', () => {
    const trace = [
      ev('E1', 'action_result', { tool: 'click', ok: false, error: 'something failed' }),
      ev('E2', 'action_result', { tool: 'click', ok: true, evidence_refs: ['/screenshot.png'] }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    // E1 failure cancelled by E2 success. But E2 itself is in the ±2 window
    // and has evidence_refs → counts as backing.
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  it('marks finding as likely_explorer_error when only selector-miss in window', () => {
    const trace = [
      ev('E0', 'action', { tool: 'click' }),
      ev('E1', 'action_result', {
        tool: 'click',
        ok: false,
        error: 'strict mode violation: resolved to 2 elements',
      }),
      ev('E2', 'action', { tool: 'click' }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.likely_explorer_error).toBe(true);
  });

  it('backing window extends ±2 events around each cited event', () => {
    const trace = [
      ev('E1', 'action'),
      ev('E2', 'observation', { summary: 'a long enough page summary to count as backing' }),
      ev('E3', 'action'),
      ev('E4', 'action'),
    ];
    // E1 cited; E2 (the obs) is at idx 1, within idx 0 ± 2.
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });
});
