import type { ToolSpec } from '@iris/adapter-types';

export const WEB_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'click',
    description:
      'Click an element. Prefer accessible-name selectors like role=button[name="Sign in"].',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Fill an input or textarea with text.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'press',
    description: 'Press a single keyboard key (Enter, Tab, Escape, ArrowDown, etc.).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element to reveal tooltips or hover-only menus.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'back',
    description: 'Browser back.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'forward',
    description: 'Browser forward.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reload',
    description: 'Reload the current page.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'scroll',
    description: 'Scroll the viewport by dx,dy pixels.',
    input_schema: {
      type: 'object',
      properties: { dx: { type: 'number' }, dy: { type: 'number' } },
      required: ['dx', 'dy'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for a selector to appear or for network idle. Bounded by timeout_ms.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        network_idle: { type: 'boolean' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a viewport or full-page screenshot.',
    input_schema: {
      type: 'object',
      properties: { full_page: { type: 'boolean' } },
    },
  },
  {
    name: 'vision_click',
    description: 'Click at viewport coordinates (vision engine).',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'vision_describe',
    description: 'Ask the vision model to describe the current screen (PHASE 3+).',
    input_schema: {
      type: 'object',
      properties: { region: { type: 'string' } },
    },
  },
];
