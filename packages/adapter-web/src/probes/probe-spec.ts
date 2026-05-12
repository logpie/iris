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
    name: 'notifications_visible',
    description:
      'Sweep the page for toast/snackbar/banner/aria-live notifications currently visible. USE THIS after any action where the app would normally show a success/failure confirmation (form submit, export, delete, save). Cheap and broad — captures MUI, Chakra, Ant, Toastify, custom fixed-corner toasts, and any aria-live region. Returns the visible text of each, so you can confirm "Export succeeded" or similar without relying on vision_describe targeting the right region.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'lighthouse',
    description:
      'Run Lighthouse against the current URL. HEAVY — uses ~10-30s and spawns its own headless Chromium. Returns Performance/Accessibility/Best-Practices/SEO scores. Cached per URL for 10 minutes.',
    input_schema: { type: 'object', properties: {} },
  },
];
