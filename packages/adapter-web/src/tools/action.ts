import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';
import { actionWithRetry } from './retry.js';

const SHORT_TIMEOUT_MS = 5000;

// Phase 7 F7-1: convert a retry outcome into a ToolResult, preserving the
// retry metadata so the orchestrator can emit retry_attempt events and the
// validator can downweight retried successes.
function toToolResult(
  outcome: Awaited<ReturnType<typeof actionWithRetry>>,
  evidence_refs: string[] = [],
): ToolResult {
  const retry_meta = {
    retried: outcome.retried,
    retry_count: outcome.retry_count,
    attempts: outcome.attempts,
  };
  if (outcome.ok) return { ok: true, evidence_refs, retry_meta };
  return { ok: false, error: outcome.error ?? 'unknown error', retry_meta };
}

export async function click(page: Page, args: { selector: string }): Promise<ToolResult> {
  const fileActionTool = await classifyFileActionControl(page, args.selector);
  if (fileActionTool) {
    return {
      ok: false,
      error: `This control appears to trigger a file ${fileActionTool === 'click_upload' ? 'upload/chooser' : 'download'}; use ${fileActionTool} with the same selector so Iris can capture file evidence.`,
    };
  }
  const outcome = await actionWithRetry(page, args.selector, (l) =>
    l.click({ timeout: SHORT_TIMEOUT_MS }),
  );
  return toToolResult(outcome);
}

export async function type(
  page: Page,
  args: { selector: string; text: string },
): Promise<ToolResult> {
  // type is destructive — typing into the wrong field is hard to detect
  // post-hoc. Don't auto-retry; let the Explorer try a different selector.
  const outcome = await actionWithRetry(
    page,
    args.selector,
    (l) => l.fill(args.text, { timeout: SHORT_TIMEOUT_MS }),
    { timeoutMs: SHORT_TIMEOUT_MS, allowRetry: false },
  );
  return toToolResult(outcome);
}

export async function selectOption(
  page: Page,
  args: { selector: string; value?: string; label?: string; index?: number },
): Promise<ToolResult> {
  const option =
    args.index !== undefined
      ? { index: args.index }
      : args.label
        ? { label: args.label }
        : args.value
          ? { value: args.value }
          : null;
  if (!option) return { ok: false, error: 'select_option requires value, label, or index' };
  const outcome = await actionWithRetry(
    page,
    args.selector,
    async (l) => {
      await l.selectOption(option, { timeout: SHORT_TIMEOUT_MS });
    },
    { timeoutMs: SHORT_TIMEOUT_MS, allowRetry: false },
  );
  return toToolResult(outcome);
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
  const outcome = await actionWithRetry(page, args.selector, (l) =>
    l.hover({ timeout: SHORT_TIMEOUT_MS }),
  );
  return toToolResult(outcome);
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}

async function classifyFileActionControl(
  page: Page,
  selector: string,
): Promise<'click_upload' | 'click_download' | null> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 1000 });
    const meta = await locator.evaluate((el) => {
      const html = el as HTMLElement;
      const input = el as HTMLInputElement;
      return {
        tag: el.tagName.toLowerCase(),
        type: input.type ?? '',
        label: [
          html.innerText,
          html.getAttribute('aria-label'),
          html.getAttribute('title'),
          html.getAttribute('name'),
          html.id,
        ]
          .filter(Boolean)
          .join(' '),
      };
    });
    const text = `${selector} ${meta.label}`.toLowerCase();
    if (meta.tag === 'input' && meta.type === 'file') return 'click_upload';
    if (/\b(download|download original|save as file)\b/.test(text)) return 'click_download';
    if (
      /\b(upload|upload media|replace media|choose file|select file|insert image|add image|import file)\b/.test(
        text,
      )
    ) {
      return 'click_upload';
    }
    if (
      /\bmedia\b/.test(text) &&
      /\b(button|role=button|\[aria-label=|toolbar|tool)\b/.test(text)
    ) {
      return 'click_upload';
    }
  } catch {
    return null;
  }
  return null;
}
