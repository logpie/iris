// Phase 9: drag primitive. Click-drag is required for canvas drawing,
// range pickers, sliders, drag-and-drop reordering. Iris had no way to do
// this before; `vision_click({reason: "Start of rectangle drag"})` was a
// single click and the agent silently faked success.
//
// Two forms:
//   drag({selector, dx, dy}) — selector-bound, drags from the element's
//     center by the delta (px). Useful for sliders and drag handles.
//   vision_drag({from, to, hold_ms?}) — viewport coordinates, vision-engine
//     equivalent. Useful for canvas drawing where there's no selector.

import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const SHORT_TIMEOUT_MS = 5000;

export async function drag(
  page: Page,
  args: { selector: string; dx: number; dy: number; hold_ms?: number },
): Promise<ToolResult> {
  try {
    const box = await page.locator(args.selector).boundingBox({ timeout: SHORT_TIMEOUT_MS });
    if (!box) return { ok: false, error: 'drag: element has no bounding box' };
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    if (args.hold_ms && args.hold_ms > 0) await page.waitForTimeout(args.hold_ms);
    // Walk in small steps so mousemove events fire continuously (some apps
    // only redraw on move events, not on the final mouseup).
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = fromX + (args.dx * i) / steps;
      const y = fromY + (args.dy * i) / steps;
      await page.mouse.move(x, y);
    }
    await page.mouse.up();
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionDrag(
  page: Page,
  args: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    hold_ms?: number;
    reason?: string;
  },
): Promise<ToolResult> {
  try {
    await page.mouse.move(args.from.x, args.from.y);
    await page.mouse.down();
    if (args.hold_ms && args.hold_ms > 0) await page.waitForTimeout(args.hold_ms);
    const steps = 12;
    const dx = args.to.x - args.from.x;
    const dy = args.to.y - args.from.y;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(args.from.x + (dx * i) / steps, args.from.y + (dy * i) / steps);
    }
    await page.mouse.up();
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
