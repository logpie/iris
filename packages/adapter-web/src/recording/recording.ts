import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the .webm video file Playwright created in the configured directory.
 * Playwright assigns auto-generated names. Returns the most recent file.
 */
export function findRunVideo(videoDir: string): string | null {
  if (!existsSync(videoDir)) return null;
  const webms = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (webms.length === 0) return null;
  webms.sort();
  // biome-ignore lint/style/noNonNullAssertion: We've checked webms.length > 0 above
  return join(videoDir, webms[webms.length - 1]!);
}
