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
  // Phase 9 — new interaction primitives.
  {
    name: 'drag',
    description:
      'Click-drag from the center of an element by (dx,dy) pixels. Use for sliders, drag handles, range pickers. For canvas drawing prefer vision_drag with explicit from/to coords.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        hold_ms: { type: 'number' },
      },
      required: ['selector', 'dx', 'dy'],
    },
  },
  {
    name: 'vision_drag',
    description:
      'Click-drag from {from.x,from.y} to {to.x,to.y} (viewport coords). REQUIRED for drawing shapes on canvas — a single click does NOT draw a shape. Use this whenever the goal needs to "draw", "create a box/rectangle/line/arrow", or "resize by dragging".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        hold_ms: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'key_chord',
    description:
      'Press multiple keys simultaneously (modifier chord). Examples: ["Meta","z"] for undo, ["Meta","a"] for select-all, ["Control","Shift","p"] for command palette. Use "CmdOrCtrl" for cross-platform.',
    input_schema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' } } },
      required: ['keys'],
    },
  },
  {
    name: 'paste',
    description:
      'Fire a paste event with the given text into the focused selector. Use for rich-text editors (Notion, ProseMirror) where keystroke-by-keystroke type() misbehaves.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'vision_paste',
    description: 'Paste text at viewport coordinates (clicks first to focus).',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['x', 'y', 'text'],
    },
  },
  {
    name: 'right_click',
    description: 'Right-click an element to open its context menu.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'vision_right_click',
    description: 'Right-click at viewport coordinates.',
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
    name: 'double_click',
    description:
      'Double-click an element. Use for rename-in-place, open-in-list, text-tool-edit affordances.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'vision_double_click',
    description: 'Double-click at viewport coordinates.',
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
    name: 'hover_wait',
    description:
      'Hover an element and wait `wait_ms` to let hover-gated UI appear (tooltips, popovers, hover menus). Default wait 500ms, max 10000.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, wait_ms: { type: 'number' } },
      required: ['selector'],
    },
  },
  {
    name: 'vision_hover_wait',
    description: 'Hover at viewport coordinates and wait `wait_ms`.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        wait_ms: { type: 'number' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'upload',
    description:
      'Upload a file into a file <input>. If `file_path` is omitted, a synthetic 1x1 PNG fixture is generated.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        file_path: { type: 'string' },
        mime: { type: 'string' },
      },
      required: ['selector'],
    },
  },
];
