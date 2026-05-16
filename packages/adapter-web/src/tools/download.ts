import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, parse } from 'node:path';
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';
import { actionWithRetry } from './retry.js';

const SHORT_TIMEOUT_MS = 5000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10000;

export async function clickDownload(
  page: Page,
  args: { selector: string; timeout_ms?: number; save_as?: string },
  outDir: string,
): Promise<ToolResult> {
  mkdirSync(outDir, { recursive: true });
  const timeoutMs = boundedTimeout(args.timeout_ms);
  let savedPath = '';
  const outcome = await actionWithRetry(
    page,
    args.selector,
    async (locator) => {
      const downloadPromise = page
        .waitForEvent('download', { timeout: timeoutMs })
        .catch((err) => err);
      try {
        await locator.click({ timeout: SHORT_TIMEOUT_MS });
      } catch (err) {
        downloadPromise.catch(() => undefined);
        throw err;
      }
      const downloadOrErr = await downloadPromise;
      if (downloadOrErr instanceof Error) {
        throw new Error(`no download event after click within ${timeoutMs}ms`);
      }
      const suggestedName = args.save_as || downloadOrErr.suggestedFilename() || 'download.bin';
      savedPath = uniqueDownloadPath(outDir, safeFilename(suggestedName));
      await downloadOrErr.saveAs(savedPath);
    },
    { timeoutMs: Math.max(timeoutMs, SHORT_TIMEOUT_MS), allowRetry: true },
  );
  const retry_meta = {
    retried: outcome.retried,
    retry_count: outcome.retry_count,
    attempts: outcome.attempts,
  };
  if (!outcome.ok) return { ok: false, error: outcome.error ?? 'download failed', retry_meta };
  return { ok: true, evidence_refs: [savedPath], retry_meta };
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return Math.max(1000, Math.min(30000, Math.floor(timeoutMs as number)));
}

function safeFilename(name: string): string {
  const base = basename(name)
    .replace(/[^\w. ()-]+/g, '_')
    .replace(/^\.+/, '');
  return base || 'download.bin';
}

function uniqueDownloadPath(outDir: string, filename: string): string {
  const parsed = parse(filename);
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? '' : `-${i}`;
    const candidate = join(outDir, `${Date.now()}-${parsed.name}${suffix}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(outDir, `${Date.now()}-${filename}`);
}
