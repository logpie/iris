import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

export async function screenshot(
  page: Page,
  args: { out_dir: string; name: string; full_page?: boolean },
): Promise<ToolResult> {
  try {
    mkdirSync(args.out_dir, { recursive: true });
    const path = join(args.out_dir, `${args.name}.png`);
    await page.screenshot({ path, fullPage: args.full_page ?? false });
    return { ok: true, evidence_refs: [path] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionClick(
  page: Page,
  args: { x: number; y: number; reason?: string },
): Promise<ToolResult> {
  try {
    await page.mouse.click(args.x, args.y);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionDescribe(
  _page: Page,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  return {
    ok: false,
    error: 'vision_describe not implemented in phase 2 — wire in phase 3 with an LLM call',
  };
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
