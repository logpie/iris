import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const DEFAULT_TIMEOUT_MS = 10_000;

export async function navigate(
  page: Page,
  args: { url: string; timeout_ms?: number },
): Promise<ToolResult> {
  try {
    await page.goto(args.url, {
      timeout: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      waitUntil: 'load',
    });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function back(page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  try {
    await page.goBack({ timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function forward(page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  try {
    await page.goForward({ timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function reload(page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  try {
    await page.reload({ timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function scroll(page: Page, args: { dx: number; dy: number }): Promise<ToolResult> {
  try {
    await page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx: args.dx, dy: args.dy });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function waitFor(
  page: Page,
  args: { selector?: string; network_idle?: boolean; timeout_ms?: number },
): Promise<ToolResult> {
  try {
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (args.selector) {
      await page.locator(args.selector).waitFor({ timeout });
    } else if (args.network_idle) {
      await page.waitForLoadState('networkidle', { timeout });
    } else {
      throw new Error('waitFor requires selector or network_idle=true');
    }
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
