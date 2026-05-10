import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const SHORT_TIMEOUT_MS = 5000;

export async function click(page: Page, args: { selector: string }): Promise<ToolResult> {
  try {
    await page.locator(args.selector).click({ timeout: SHORT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function type(
  page: Page,
  args: { selector: string; text: string },
): Promise<ToolResult> {
  try {
    await page.locator(args.selector).fill(args.text, { timeout: SHORT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function press(page: Page, args: { key: string }): Promise<ToolResult> {
  try {
    await page.keyboard.press(args.key);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function hover(page: Page, args: { selector: string }): Promise<ToolResult> {
  try {
    await page.locator(args.selector).hover({ timeout: SHORT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
