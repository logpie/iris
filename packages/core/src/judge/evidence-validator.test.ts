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

  it('discards machine-only axe findings with no visible user impact', () => {
    const trace = [ev('E1', 'probe_result', { probe: 'axe', summary: { violations: 1 } })];
    const out = validateFindings(
      [
        finding({
          category: 'a11y',
          severity: 'major',
          title: 'Language select lacks accessible name',
          evidence: ['E1'],
          rationale: 'Axe reported a critical select-name issue on the homepage.',
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
    expect(out.discarded[0]?.reason).toBe('machine_only_probe_no_user_visible_impact');
  });

  it('discards machine-only console findings with no visible user impact', () => {
    const trace = [
      ev('E1', 'probe_result', {
        probe: 'console_errors_since',
        summary: { error_count: 1, app_error_count: 1 },
      }),
    ];
    const out = validateFindings(
      [
        finding({
          category: 'bug',
          severity: 'minor',
          title: 'One console error appeared during normal use',
          evidence: ['E1'],
          rationale: 'The run reported one browser console error, so the flow was not fully clean.',
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
    expect(out.discarded[0]?.reason).toBe('machine_only_probe_no_user_visible_impact');
  });

  it('keeps major accessibility severity when cited evidence includes visible user impact', () => {
    const trace = [
      ev('E1', 'probe_result', { probe: 'axe', summary: { violations: 1 } }),
      ev('E2', 'observation', {
        summary: 'The checkout form shows an error and cannot proceed after keyboard submit.',
      }),
    ];
    const out = validateFindings(
      [
        finding({
          category: 'a11y',
          severity: 'major',
          title: 'Keyboard users cannot complete checkout',
          evidence: ['E1', 'E2'],
          rationale: 'The trace shows the checkout form cannot be completed from the keyboard.',
        }),
      ],
      trace,
    );
    expect(out.kept[0]?.severity).toBe('major');
    expect(out.kept[0]?.severity_calibrated).toBeUndefined();
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

  it('discards persistent banner findings contradicted by a cited post-close observation', () => {
    const trace = [
      ev('A1', 'action', { tool: 'click', args: { selector: 'button:has-text("Close")' } }),
      ev('A2', 'action_result', { tool: 'click', ok: true }),
      ev('O1', 'observation', {
        summary:
          'Wikipedia homepage. Search Wikipedia. Footer includes support our work with a donation and app download links.',
      }),
    ];
    const out = validateFindings(
      [
        finding({
          severity: 'minor',
          category: 'ux',
          title: 'Donation banner close is not sticky',
          rationale: 'Closing the banner did not keep it dismissed and it still dominated the page.',
          evidence: ['O1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
    expect(out.discarded[0]?.reason).toBe(
      'dismissal_finding_contradicted_by_post_close_observation',
    );
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

  // Phase 7 F7-1 ----------------------------------------------------

  it('treats retried-success action_result as Explorer error, not backing', () => {
    const trace = [
      ev('E1', 'action_result', {
        tool: 'click',
        ok: true,
        retried: true,
        retry_count: 1,
      }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    // Major → downgraded to minor + likely_explorer_error.
    expect(out.kept[0]?.severity).toBe('minor');
    expect(out.kept[0]?.likely_explorer_error).toBe(true);
  });

  it('keeps a major finding when action_result succeeded WITHOUT retry', () => {
    const trace = [
      ev('E1', 'action_result', {
        tool: 'click',
        ok: true,
        evidence_refs: ['/p/step.png'],
      }),
    ];
    const out = validateFindings([finding({ severity: 'major', evidence: ['E1'] })], trace);
    expect(out.kept[0]?.severity).toBe('major');
    expect(out.kept[0]?.unverified_backing).toBe(false);
  });

  // Phase 7 F7-3 ----------------------------------------------------

  it('strips code_pointer with a selector not present in any action event', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click', args: { selector: '.real-button' } }),
      ev('E2', 'action_result', { tool: 'click', ok: true, evidence_refs: ['/x.png'] }),
    ];
    const out = validateFindings(
      [
        finding({
          severity: 'major',
          evidence: ['E1', 'E2'],
          suggested_fix: {
            type: 'a11y',
            summary: 'Add aria-label',
            code_pointer: {
              selector: '.fabricated-selector',
              attribute: 'aria-label',
              suggested_value: 'Submit',
            },
            patch_hint: 'Set aria-label on the submit button',
          },
        }),
      ],
      trace,
    );
    expect(out.kept[0]?.suggested_fix?.code_pointer).toBeUndefined();
    expect(out.kept[0]?.suggested_fix?.patch_hint).toBe('Set aria-label on the submit button');
    expect(out.kept[0]?.suggested_fix?.summary).toBe('Add aria-label');
  });

  it('keeps code_pointer when selector matches a real trace action', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click', args: { selector: '.real-button' } }),
      ev('E2', 'action_result', { tool: 'click', ok: true, evidence_refs: ['/x.png'] }),
    ];
    const out = validateFindings(
      [
        finding({
          severity: 'major',
          evidence: ['E1', 'E2'],
          suggested_fix: {
            type: 'a11y',
            summary: 'Add aria-label',
            code_pointer: {
              selector: '.real-button',
              attribute: 'aria-label',
              suggested_value: 'Submit',
            },
          },
        }),
      ],
      trace,
    );
    expect(out.kept[0]?.suggested_fix?.code_pointer?.selector).toBe('.real-button');
  });

  // Phase 11: agent-perspective title scan — discards fabricated findings that
  // blame the product for the agent's selector/click strategy choices.
  it('discards a finding with "not reachable via selectors" title and only action evidence', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click', args: { selector: '.foo' } }),
      ev('E2', 'action_result', { tool: 'click', ok: false, error: 'Timeout 5000ms exceeded' }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'CodeMirror editor not reachable via standard selectors',
          severity: 'major',
          evidence: ['E1', 'E2'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
    expect(out.discarded[0]?.reason).toBe('agent_perspective_title_no_user_visible_failure');
  });

  // Phase 12: "no confirmation" finding is overruled by a successful
  // notifications_visible probe with non-empty data. Dillinger 2026-05-11
  // had this exact failure: probe captured "Preparing HTML... Exported as
  // HTML" but the Judge claimed "no confirmation."
  it('discards "Export shows no visible confirmation" when notifications probe captured a toast', () => {
    const trace = [
      ev('E1', 'action_result', { tool: 'click', ok: true }),
      ev('E2', 'probe_result', {
        probe: 'notifications_visible',
        ok: true,
        summary: { count: 1 },
        data: [{ source: 'aria_live', text: 'Exported as HTML' }],
      }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'Export shows no visible confirmation after click',
          severity: 'major',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
    expect(out.discarded[0]?.reason).toBe(
      'no_confirmation_finding_contradicted_by_notifications_probe',
    );
  });

  it('keeps "no confirmation" findings when notifications_visible was NOT called', () => {
    const trace = [ev('E1', 'action_result', { tool: 'click', ok: true })];
    const out = validateFindings(
      [
        finding({
          title: 'Submit shows no visible feedback to the user',
          severity: 'minor',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    // No probe ran — finding stands (but normal backing check applies).
    expect(out.kept).toHaveLength(1);
  });

  it('discards "not focusable/typable via standard selectors" (Phase-12 slash-alternative)', () => {
    const trace = [
      ev('E1', 'action_result', { tool: 'click', ok: false, error: 'Timeout 5000ms' }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'CodeMirror editor not focusable/typable via standard selectors',
          severity: 'minor',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
  });

  it('discards "poor selector targeting / accessible name" findings', () => {
    const trace = [ev('E1', 'action_result', { tool: 'click', ok: false, error: 'Timeout' })];
    const out = validateFindings(
      [
        finding({
          title: "'Export as' top-bar button has poor selector targeting / accessible name",
          severity: 'minor',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
  });

  it('discards "Toggle checkbox click via ARIA selector times out" (TodoMVC-style)', () => {
    const trace = [
      ev('E1', 'action_result', { tool: 'click', ok: false, error: 'Timeout 5000ms' }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'Toggle checkbox click via ARIA selector times out',
          severity: 'minor',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
  });

  it('discards "not focusable via" findings (Dillinger-style agent failure phrasing)', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click', args: { selector: 'role=textbox' } }),
      ev('E2', 'action_result', { tool: 'click', ok: false, error: 'Timeout 5000ms' }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'Editor textarea/CodeMirror not focusable via standard selectors',
          severity: 'major',
          evidence: ['E1', 'E2'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
  });

  it('discards "lacks proper accessible textbox role" findings without user-visible evidence', () => {
    const trace = [ev('E1', 'action_result', { tool: 'click', ok: false, error: 'Timeout' })];
    const out = validateFindings(
      [
        finding({
          title: 'Editor lacks proper accessible textbox role',
          severity: 'major',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
  });

  it('discards "could not be focused" findings without user-visible failure evidence', () => {
    const trace = [
      ev('E1', 'action', { tool: 'click', args: { selector: 'input.edit' } }),
      ev('E2', 'action_result', { tool: 'click', ok: false, error: 'Timeout 5000ms' }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'Edit input could not be focused',
          severity: 'major',
          evidence: ['E1', 'E2'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(0);
  });

  it('KEEPS an agent-phrased finding if there is real user-visible failure evidence', () => {
    // A finding whose title looks agent-phrased but the cited evidence
    // includes a console error or a probe failure should still be kept —
    // the agent's wording is awkward but the underlying defect is real.
    const trace = [
      ev('E1', 'observation', {
        summary: 'Page shows "An error occurred — could not load editor" message at top',
      }),
    ];
    const out = validateFindings(
      [
        finding({
          title: 'Editor could not be focused after page load',
          severity: 'major',
          evidence: ['E1'],
        }),
      ],
      trace,
    );
    expect(out.kept).toHaveLength(1);
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
