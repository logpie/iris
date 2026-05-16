import type { ProbeSpec } from '@iris/adapter-types';

export const WEB_PROBE_SPECS: ProbeSpec[] = [
  {
    name: 'axe',
    description: 'Run axe-core on the current page; returns accessibility violations.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'console_errors_since',
    description: 'Console.error messages since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'console_all_since',
    description: 'All console messages since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'network_failures_since',
    description: '4xx/5xx responses since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'network_all_since',
    description: 'All network responses since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mobile_viewport',
    description:
      'Resize to a representative mobile viewport and report whether the current page has obvious horizontal overflow. Use after the primary flow to make responsive coverage explicit.',
    input_schema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Mobile viewport width; default 390.' },
        height: { type: 'number', description: 'Mobile viewport height; default 844.' },
      },
    },
  },
  {
    name: 'notifications_visible',
    description:
      'Sweep the page for toast/snackbar/banner/aria-live notifications currently visible. USE THIS after any action where the app would normally show a success/failure confirmation (form submit, export, delete, save). Cheap and broad — captures MUI, Chakra, Ant, Toastify, custom fixed-corner toasts, and any aria-live region. Returns the visible text of each, so you can confirm "Export succeeded" or similar without relying on vision_describe targeting the right region.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ui_state',
    description:
      'Deterministically inspect UI state: URL/hash/scroll, active element, and selected elements visibility, bounds, ARIA attributes, checked state, and computed styles. Use after focus-skip, layout, appearance/theme, sidebar, disclosure, or collapse interactions to prove the visible state changed without relying on text observation alone.',
    input_schema: {
      type: 'object',
      properties: {
        selectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'CSS selectors to inspect, such as "#bodyContent" or ".vector-appearance".',
        },
      },
    },
  },
  {
    name: 'state_delta',
    description:
      'Compare two observations, defaulting to the last two, and report deterministic before/after changes: URL, text, active element, element count, and status/object-count lines such as "Image. 1 of 1". Use after edit, duplicate, delete, undo/redo, import/export setup, or other state-change goals to prove the product state actually changed.',
    input_schema: {
      type: 'object',
      properties: {
        from_ref: { type: 'string' },
        to_ref: { type: 'string' },
      },
    },
  },
  {
    name: 'lighthouse',
    description:
      'Run Lighthouse against the current URL. HEAVY — uses ~10-30s and spawns its own headless Chromium. Returns Performance/Accessibility/Best-Practices/SEO scores. Cached per URL for 10 minutes.',
    input_schema: { type: 'object', properties: {} },
  },
];
