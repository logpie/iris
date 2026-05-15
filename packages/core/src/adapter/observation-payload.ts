import type { Observation } from '@iris/adapter-types';

export function observationTracePayload(
  observation: Observation,
  summaryLimit = 4000,
): Record<string, unknown> {
  const perceptionState = compactPerceptionState(observation.payload?.perception_state);
  return {
    ref: observation.observation_ref,
    summary: observation.summary.slice(0, summaryLimit),
    ...(perceptionState ? { perception_state: perceptionState } : {}),
  };
}

function compactPerceptionState(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Record<string, unknown>;
  const elements = Array.isArray(state.elements)
    ? state.elements.map(compactElement).filter(Boolean).slice(0, 80)
    : [];
  return {
    v: 1,
    ...(typeof state.url === 'string' ? { url: state.url } : {}),
    ...(typeof state.title === 'string' ? { title: state.title } : {}),
    ...(typeof state.screenshot_ref === 'string' ? { screenshot_ref: state.screenshot_ref } : {}),
    ...(plainObject(state.viewport) ? { viewport: state.viewport } : {}),
    ...(plainObject(state.scroll) ? { scroll: state.scroll } : {}),
    ...(plainObject(state.active_element)
      ? { active_element: compactElement(state.active_element) }
      : {}),
    elements,
  };
}

function compactElement(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const el = value as Record<string, unknown>;
  return {
    ...(typeof el.id === 'string' ? { id: el.id } : {}),
    ...(typeof el.stable_hash === 'string' ? { stable_hash: el.stable_hash } : {}),
    ...(typeof el.tag === 'string' ? { tag: el.tag } : {}),
    ...(typeof el.role === 'string' ? { role: el.role } : {}),
    ...(typeof el.name === 'string' ? { name: el.name } : {}),
    ...(typeof el.text === 'string' ? { text: el.text } : {}),
    ...(typeof el.href === 'string' ? { href: el.href } : {}),
    ...(typeof el.type === 'string' ? { type: el.type } : {}),
    ...(typeof el.checked === 'boolean' ? { checked: el.checked } : {}),
    ...(typeof el.disabled === 'boolean' ? { disabled: el.disabled } : {}),
    ...(typeof el.expanded === 'boolean' ? { expanded: el.expanded } : {}),
    ...(typeof el.visible === 'boolean' ? { visible: el.visible } : {}),
    ...(plainObject(el.bounds) ? { bounds: el.bounds } : {}),
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
