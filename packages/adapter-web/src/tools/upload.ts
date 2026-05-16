// Phase 9: upload — set a file on an <input type=file>. Real users upload
// files; the agent had no way to test upload flows.
//
// If no `file_path` is provided, we generate a synthetic fixture (tiny PNG)
// and upload that. This lets the agent test upload UIs without needing
// pre-staged fixtures on the host filesystem.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const SHORT_TIMEOUT_MS = 5000;

// 1x1 transparent PNG. Smallest valid file we can hand to a file input.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function upload(
  page: Page,
  args: { selector: string; file_path?: string; mime?: string },
): Promise<ToolResult> {
  try {
    const loc = page.locator(args.selector).first();
    await loc.waitFor({ state: 'attached', timeout: SHORT_TIMEOUT_MS });
    const path = args.file_path ?? syntheticFixturePath();
    await loc.setInputFiles(path);
    return { ok: true, evidence_refs: [path] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export function syntheticFixturePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-upload-'));
  const p = join(dir, 'fixture.png');
  writeFileSync(p, Buffer.from(TINY_PNG_BASE64, 'base64'));
  return p;
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
