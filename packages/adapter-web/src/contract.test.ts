import { describe, expect, it } from 'vitest';
import { WEB_INTERACTION_KIT, collectWebOutcomeEvidence } from './contract.js';

function ev(id: string, kind: string, payload: Record<string, unknown> = {}) {
  return { id, kind, payload };
}

describe('WEB_INTERACTION_KIT', () => {
  it('declares the new Phase 9 primitives', () => {
    const names = WEB_INTERACTION_KIT.primitives.map((p) => p.name);
    expect(names).toContain('drag');
    expect(names).toContain('vision_drag');
    expect(names).toContain('key_chord');
    expect(names).toContain('select_option');
    expect(names).toContain('paste');
    expect(names).toContain('right_click');
    expect(names).toContain('double_click');
    expect(names).toContain('hover_wait');
    expect(names).toContain('upload');
    expect(names).toContain('click_upload');
    expect(names).toContain('click_download');
  });

  it('marks vision_drag with the canvas coverage note', () => {
    const p = WEB_INTERACTION_KIT.primitives.find((p) => p.name === 'vision_drag');
    expect(p?.coverage_note).toMatch(/canvas/i);
  });
});

describe('collectWebOutcomeEvidence', () => {
  it('returns empty when no interaction happened in the goal window', () => {
    const events = [
      ev('A', 'observation', { screenshot_ref: 's-before.png' }),
      ev('B', 'action', { tool: 'vision_describe' }),
      ev('C', 'action_result', { tool: 'vision_describe', ok: true }),
    ];
    expect(collectWebOutcomeEvidence(events)).toEqual([]);
  });

  it('returns post-interaction screenshots after the last successful interaction', () => {
    const events = [
      ev('A', 'observation', { screenshot_ref: 's-before.png' }), // before — excluded
      ev('B', 'action', { tool: 'vision_drag' }),
      ev('C', 'action_result', { tool: 'vision_drag', ok: true }), // last interaction
      ev('D', 'observation', { screenshot_ref: 's-after.png' }), // after — included
    ];
    const arts = collectWebOutcomeEvidence(events);
    const refs = arts.map((a) => a.ref);
    expect(refs).toContain('s-after.png');
    expect(refs).toContain('D');
    expect(refs).not.toContain('s-before.png');
    expect(refs).not.toContain('A');
  });

  it('does not treat vision_describe / screenshot as interactions', () => {
    // Goal window with only passive observation — should yield no outcome.
    const events = [
      ev('A', 'action', { tool: 'screenshot' }),
      ev('B', 'action_result', { tool: 'screenshot', ok: true, evidence_refs: ['s.png'] }),
      ev('C', 'action', { tool: 'vision_describe' }),
      ev('D', 'action_result', { tool: 'vision_describe', ok: true }),
    ];
    expect(collectWebOutcomeEvidence(events)).toEqual([]);
  });

  it('includes explicit screenshot action_results taken after an interaction', () => {
    const events = [
      ev('A', 'action', { tool: 'click' }),
      ev('B', 'action_result', { tool: 'click', ok: true }), // interaction
      ev('C', 'action', { tool: 'screenshot' }),
      ev('D', 'action_result', {
        tool: 'screenshot',
        ok: true,
        evidence_refs: ['after.png'],
      }),
    ];
    const arts = collectWebOutcomeEvidence(events);
    expect(arts.map((a) => a.ref)).toContain('after.png');
    expect(arts.map((a) => a.ref)).toContain('D');
  });

  it('includes post-interaction vision_describe action_results (with description)', () => {
    // After a drag, a vision_describe with a description naming the artifact
    // is the strongest outcome citation available.
    const events = [
      ev('A', 'action', { tool: 'vision_drag' }),
      ev('B', 'action_result', { tool: 'vision_drag', ok: true }),
      ev('C', 'action', { tool: 'vision_describe' }),
      ev('D', 'action_result', {
        tool: 'vision_describe',
        ok: true,
        description: 'Rounded rectangle on canvas at center',
      }),
    ];
    const arts = collectWebOutcomeEvidence(events);
    expect(arts.map((a) => a.ref)).toContain('D');
    expect(arts.map((a) => a.ref)).toContain('C');
  });

  it('includes post-interaction ui_state probes that prove navigation state', () => {
    const events = [
      ev('A', 'action', { tool: 'click', selector: "a[href='#Services']" }),
      ev('B', 'action_result', { tool: 'click', ok: true }),
      ev('C', 'probe_result', {
        ok: true,
        probe: 'ui_state',
        summary: {
          hash: '#Services',
          scroll: { x: 0, y: 9490 },
          selectors_found: 1,
          selectors_total: 1,
        },
      }),
    ];
    const arts = collectWebOutcomeEvidence(events);
    expect(arts.map((a) => a.ref)).toContain('C');
    expect(arts.find((a) => a.ref === 'C')?.note).toContain('hash=#Services');
  });

  it('includes post-interaction state_delta probes that prove product state changed', () => {
    const events = [
      ev('A', 'action', { tool: 'key_chord', keys: ['CmdOrCtrl', 'd'] }),
      ev('B', 'action_result', { tool: 'key_chord', ok: true }),
      ev('C', 'probe_result', {
        ok: true,
        probe: 'state_delta',
        summary: {
          changed: true,
          text_changed: true,
          element_count_before: 5,
          element_count_after: 6,
        },
      }),
    ];
    const arts = collectWebOutcomeEvidence(events);
    expect(arts.map((a) => a.ref)).toContain('C');
    expect(arts.find((a) => a.ref === 'C')?.note).toContain('state_delta');
  });

  it('does not include unchanged state_delta probes as outcome evidence', () => {
    const events = [
      ev('A', 'action', { tool: 'click' }),
      ev('B', 'action_result', { tool: 'click', ok: true }),
      ev('C', 'probe_result', { ok: true, probe: 'state_delta', summary: { changed: false } }),
    ];
    expect(collectWebOutcomeEvidence(events).map((a) => a.ref)).not.toContain('C');
  });

  it('includes downloaded files as outcome evidence', () => {
    const events = [
      ev('A', 'action', { tool: 'click_download', selector: 'button:has-text("Download")' }),
      ev('B', 'action_result', {
        tool: 'click_download',
        ok: true,
        evidence_refs: ['evidence/downloads/export.tldr'],
      }),
    ];
    const arts = collectWebOutcomeEvidence(events);
    expect(arts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file_download',
          ref: 'evidence/downloads/export.tldr',
        }),
        expect.objectContaining({ kind: 'file_download', ref: 'B' }),
      ]),
    );
  });
});
