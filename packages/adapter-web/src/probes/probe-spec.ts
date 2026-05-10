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
];
