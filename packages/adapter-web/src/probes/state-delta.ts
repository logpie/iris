import type { Observation, PerceptionState, ProbeResult } from '@iris/adapter-types';

export function runStateDelta(
  history: Observation[],
  args: { from_ref?: string; to_ref?: string } = {},
): ProbeResult {
  const { before, after } = selectObservationPair(history, args);
  if (!before || !after) {
    return {
      ok: false,
      probe: 'state_delta',
      error: 'state_delta requires at least two observations or valid from_ref/to_ref',
    };
  }

  const beforePayload = before.payload ?? {};
  const afterPayload = after.payload ?? {};
  const beforeText = textForDiff(before);
  const afterText = textForDiff(after);
  const beforeState = beforePayload.perception_state as PerceptionState | undefined;
  const afterState = afterPayload.perception_state as PerceptionState | undefined;
  const beforeElements = beforeState?.elements ?? [];
  const afterElements = afterState?.elements ?? [];
  const beforeStatus = statusLines(beforeText);
  const afterStatus = statusLines(afterText);
  const addedText = diffLines(afterText, beforeText).slice(0, 12);
  const removedText = diffLines(beforeText, afterText).slice(0, 12);
  const activeBefore = elementLabel(beforeState?.active_element);
  const activeAfter = elementLabel(afterState?.active_element);

  const summary = {
    from_ref: before.observation_ref,
    to_ref: after.observation_ref,
    changed:
      beforeText !== afterText ||
      beforePayload.url !== afterPayload.url ||
      activeBefore !== activeAfter ||
      beforeElements.length !== afterElements.length,
    url_before: String(beforePayload.url ?? ''),
    url_after: String(afterPayload.url ?? ''),
    text_changed: beforeText !== afterText,
    active_before: activeBefore,
    active_after: activeAfter,
    element_count_before: beforeElements.length,
    element_count_after: afterElements.length,
    status_before: beforeStatus,
    status_after: afterStatus,
    added_text: addedText,
    removed_text: removedText,
  };

  return {
    ok: true,
    probe: 'state_delta',
    summary,
    data: {
      before: before.payload,
      after: after.payload,
    },
  };
}

function selectObservationPair(
  history: Observation[],
  args: { from_ref?: string; to_ref?: string },
): { before: Observation | undefined; after: Observation | undefined } {
  const after = args.to_ref
    ? history.find((obs) => obs.observation_ref === args.to_ref)
    : history.at(-1);
  const before = args.from_ref
    ? history.find((obs) => obs.observation_ref === args.from_ref)
    : after
      ? history[history.indexOf(after) - 1]
      : undefined;
  return { before, after };
}

function textForDiff(obs: Observation): string {
  const payload = obs.payload ?? {};
  const parts = [
    String(payload.url ?? ''),
    String(payload.title ?? ''),
    String(payload.body_text ?? ''),
    obs.summary,
  ];
  return normalizeLines(parts.join('\n'));
}

function normalizeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function diffLines(candidate: string, baseline: string): string[] {
  const base = new Set(baseline.split('\n'));
  return candidate.split('\n').filter((line) => line && !base.has(line));
}

function statusLines(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z ]{1,40}\.\s+\d+\s+of\s+\d+\b/g)) {
    out.add(match[0]);
  }
  return Array.from(out).slice(0, 20);
}

function elementLabel(element: PerceptionState['active_element'] | undefined): string {
  if (!element) return '';
  return [element.role, element.tag, element.name, element.text].filter(Boolean).join(':');
}
