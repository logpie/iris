// Phase 9: right_click, double_click, hover_wait — variants on click/hover.
// These are real user actions the agent had no way to perform before.
//
// right_click opens context menus (common in file managers, IDEs, kanban
// boards). double_click triggers edit-in-place (text rename in Excalidraw,
// open in file lists). hover_wait reveals tooltips/popovers gated by a hover
// duration.

import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';
import { actionWithRetry } from './retry.js';

const SHORT_TIMEOUT_MS = 5000;

function toToolResult(outcome: Awaited<ReturnType<typeof actionWithRetry>>): ToolResult {
  const retry_meta = {
    retried: outcome.retried,
    retry_count: outcome.retry_count,
    attempts: outcome.attempts,
  };
  if (outcome.ok) return { ok: true, evidence_refs: [], retry_meta };
  return { ok: false, error: outcome.error ?? 'unknown error', retry_meta };
}

export async function rightClick(page: Page, args: { selector: string }): Promise<ToolResult> {
  const outcome = await actionWithRetry(page, args.selector, (l) =>
    l.click({ button: 'right', timeout: SHORT_TIMEOUT_MS }),
  );
  return toToolResult(outcome);
}

export async function visionRightClick(
  page: Page,
  args: { x: number; y: number; reason?: string },
): Promise<ToolResult> {
  try {
    await page.mouse.click(args.x, args.y, { button: 'right' });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function doubleClick(page: Page, args: { selector: string }): Promise<ToolResult> {
  const outcome = await actionWithRetry(page, args.selector, (l) =>
    l.dblclick({ timeout: SHORT_TIMEOUT_MS }),
  );
  return toToolResult(outcome);
}

export async function visionDoubleClick(
  page: Page,
  args: { x: number; y: number; reason?: string },
): Promise<ToolResult> {
  try {
    await page.mouse.dblclick(args.x, args.y);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function hoverWait(
  page: Page,
  args: { selector: string; wait_ms?: number },
): Promise<ToolResult> {
  const waitMs = Math.min(Math.max(args.wait_ms ?? 500, 0), 10_000);
  const outcome = await actionWithRetry(page, args.selector, (l) =>
    l.hover({ timeout: SHORT_TIMEOUT_MS }),
  );
  if (!outcome.ok) return toToolResult(outcome);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  return toToolResult(outcome);
}

export async function visionHoverWait(
  page: Page,
  args: { x: number; y: number; wait_ms?: number },
): Promise<ToolResult> {
  const waitMs = Math.min(Math.max(args.wait_ms ?? 500, 0), 10_000);
  try {
    await page.mouse.move(args.x, args.y);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
