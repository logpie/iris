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
  const perceptionChanges = compactPerceptionChanges(beforeState, afterState);
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
      beforeElements.length !== afterElements.length ||
      perceptionChanges.changed,
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
    perception_changed: perceptionChanges.changed,
    perception_change_reason: perceptionChanges.reason,
    perception_fields_changed: perceptionChanges.fields,
    element_changes: perceptionChanges.elementChanges,
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

function compactPerceptionChanges(
  beforeState: PerceptionState | undefined,
  afterState: PerceptionState | undefined,
): {
  changed: boolean;
  reason: string;
  fields: string[];
  elementChanges: Array<{
    id: string;
    label: string;
    fields: string[];
  }>;
} {
  if (!beforeState || !afterState) {
    return { changed: false, reason: 'missing_perception_state', fields: [], elementChanges: [] };
  }
  const beforeComparable = comparablePerceptionState(beforeState);
  const afterComparable = comparablePerceptionState(afterState);
  const size = JSON.stringify(beforeComparable).length + JSON.stringify(afterComparable).length;
  if (size > 24_000) {
    return { changed: false, reason: 'perception_state_too_large', fields: [], elementChanges: [] };
  }

  const fields = [
    ...fieldChanges(beforeComparable.page, afterComparable.page),
    ...fieldChanges(beforeComparable.active, afterComparable.active).map(
      (field) => `active.${field}`,
    ),
  ];
  const beforeByKey = new Map(beforeComparable.elements.map((element) => [element.key, element]));
  const afterByKey = new Map(afterComparable.elements.map((element) => [element.key, element]));
  const elementChanges: Array<{ id: string; label: string; fields: string[] }> = [];

  for (const [key, beforeElement] of beforeByKey) {
    const afterElement = afterByKey.get(key);
    if (!afterElement) continue;
    const changedFields = fieldChanges(beforeElement.data, afterElement.data);
    if (changedFields.length === 0) continue;
    elementChanges.push({
      id: key,
      label: beforeElement.label || afterElement.label,
      fields: changedFields,
    });
    for (const field of changedFields) fields.push(`element.${field}`);
    if (elementChanges.length >= 12) break;
  }

  const uniqueFields = Array.from(new Set(fields)).slice(0, 40);
  return {
    changed: uniqueFields.length > 0,
    reason:
      uniqueFields.length > 0 ? 'compact_perception_state_fields_changed' : 'no_field_changes',
    fields: uniqueFields,
    elementChanges,
  };
}

function comparablePerceptionState(state: PerceptionState) {
  return {
    page: {
      url: state.url,
      title: state.title,
      viewport: state.viewport,
      scroll: state.scroll,
    },
    active: state.active_element ? comparableElement(state.active_element).data : {},
    elements: state.elements.slice(0, 200).map((element) => {
      const comparable = comparableElement(element);
      return {
        key: elementKey(element),
        label: comparable.label,
        data: comparable.data,
      };
    }),
  };
}

function comparableElement(element: PerceptionState['elements'][number]) {
  const label = [element.role, element.tag, element.name, element.text]
    .filter(Boolean)
    .join(':')
    .slice(0, 240);
  return {
    label,
    data: {
      tag: shortString(element.tag),
      role: shortString(element.role),
      name: shortString(element.name),
      text: shortString(element.text),
      href: shortString(element.href),
      type: shortString(element.type),
      value: shortString(element.value),
      checked: element.checked,
      disabled: element.disabled,
      expanded: element.expanded,
      visible: element.visible,
    },
  };
}

function elementKey(element: PerceptionState['elements'][number]): string {
  return element.id || element.stable_hash;
}

function shortString(value: unknown): unknown {
  return typeof value === 'string' ? value.slice(0, 240) : value;
}

function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const field of fields) {
    const beforeValue = before[field];
    const afterValue = after[field];
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) changed.push(field);
  }
  return changed;
}
