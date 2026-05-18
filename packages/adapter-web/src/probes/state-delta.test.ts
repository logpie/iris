import type { Observation, PerceptionState } from '@iris/adapter-types';
import { describe, expect, it } from 'vitest';
import { runStateDelta } from './state-delta.js';

describe('runStateDelta', () => {
  it('detects compact perception_state field changes even when text and counts are unchanged', () => {
    const beforeState = stateWithElement({ checked: false, value: 'off' });
    const afterState = stateWithElement({ checked: true, value: 'on' });

    const r = runStateDelta([obs('before', beforeState), obs('after', afterState)]);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.changed).toBe(true);
    expect(r.summary.text_changed).toBe(false);
    expect(r.summary.element_count_before).toBe(1);
    expect(r.summary.element_count_after).toBe(1);
    expect(r.summary.perception_changed).toBe(true);
    expect(r.summary.perception_fields_changed).toEqual(
      expect.arrayContaining(['element.checked', 'element.value']),
    );
    expect(r.summary.element_changes).toEqual([
      expect.objectContaining({
        id: 'E001',
        fields: expect.arrayContaining(['checked', 'value']),
      }),
    ]);
  });

  it('still compares compact element fields when page text samples are large', () => {
    const beforeState = stateWithElement({ checked: false });
    const afterState = stateWithElement({ checked: true });
    beforeState.text_sample = 'a'.repeat(13_000);
    afterState.text_sample = 'a'.repeat(13_000);

    const r = runStateDelta([obs('before', beforeState), obs('after', afterState)]);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.changed).toBe(true);
    expect(r.summary.perception_changed).toBe(true);
    expect(r.summary.perception_fields_changed).toEqual(
      expect.arrayContaining(['element.checked']),
    );
  });
});

function obs(ref: string, perceptionState: PerceptionState): Observation {
  return {
    observation_ref: ref,
    summary: 'same visible text',
    payload: {
      url: 'http://example.test/',
      title: 'Example',
      body_text: 'same visible text',
      perception_state: perceptionState,
    },
  };
}

function stateWithElement(fields: Partial<PerceptionState['elements'][number]>): PerceptionState {
  return {
    v: 1,
    url: 'http://example.test/',
    title: 'Example',
    captured_at: '2026-05-18T00:00:00.000Z',
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0 },
    elements: [
      {
        id: 'E001',
        stable_hash: 'stable-toggle',
        tag: 'input',
        role: 'checkbox',
        name: 'Email alerts',
        type: 'checkbox',
        visible: true,
        ...fields,
      },
    ],
    text_sample: 'same visible text',
    outline_sample: '[input[type=checkbox]] "Email alerts"',
  };
}
