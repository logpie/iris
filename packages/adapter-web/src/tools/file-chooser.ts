import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';
import { actionWithRetry } from './retry.js';
import { syntheticFixturePath } from './upload.js';

const SHORT_TIMEOUT_MS = 5000;
const DEFAULT_FILE_CHOOSER_TIMEOUT_MS = 10000;

export async function clickUpload(
  page: Page,
  args: { selector: string; file_path?: string; timeout_ms?: number; mime?: string },
): Promise<ToolResult> {
  const timeoutMs = boundedTimeout(args.timeout_ms);
  const path = args.file_path ?? syntheticFixturePath();
  const outcome = await actionWithRetry(
    page,
    args.selector,
    async (locator) => {
      const chooserPromise = page
        .waitForEvent('filechooser', { timeout: timeoutMs })
        .catch((err) => err);
      try {
        await locator.click({ timeout: SHORT_TIMEOUT_MS });
      } catch (err) {
        chooserPromise.catch(() => undefined);
        throw err;
      }
      const chooserOrErr = await chooserPromise;
      if (chooserOrErr instanceof Error) {
        throw new Error(`no file chooser after click within ${timeoutMs}ms`);
      }
      await chooserOrErr.setFiles(path);
    },
    { timeoutMs: Math.max(timeoutMs, SHORT_TIMEOUT_MS), allowRetry: true },
  );
  const retry_meta = {
    retried: outcome.retried,
    retry_count: outcome.retry_count,
    attempts: outcome.attempts,
  };
  if (!outcome.ok) return { ok: false, error: outcome.error ?? 'upload failed', retry_meta };
  return { ok: true, evidence_refs: [path], retry_meta };
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_FILE_CHOOSER_TIMEOUT_MS;
  return Math.max(1000, Math.min(30000, Math.floor(timeoutMs as number)));
}
