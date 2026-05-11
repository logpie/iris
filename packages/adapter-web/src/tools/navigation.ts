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
  const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (args.selector) {
    // Phase 7 F7-1: waitFor on an ambiguous selector hits strict-mode-violation
    // the same way click does. Use the same retry helper.
    const { actionWithRetry } = await import('./retry.js');
    const outcome = await actionWithRetry(page, args.selector, (l) => l.waitFor({ timeout }), {
      timeoutMs: timeout,
      allowRetry: true,
    });
    const retry_meta = {
      retried: outcome.retried,
      retry_count: outcome.retry_count,
      attempts: outcome.attempts,
    };
    if (outcome.ok) return { ok: true, evidence_refs: [], retry_meta };
    return { ok: false, error: outcome.error ?? 'unknown error', retry_meta };
  }
  try {
    if (args.network_idle) {
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
