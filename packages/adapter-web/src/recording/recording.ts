import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the best .webm video file Playwright created in the configured directory.
 * Playwright records one file per page and assigns auto-generated names, so
 * lexicographic order is not meaningful. Prefer the largest file because it is
 * usually the primary page recording; break ties by mtime.
 */
export function findRunVideo(videoDir: string): string | null {
  if (!existsSync(videoDir)) return null;
  const webms = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (webms.length === 0) return null;
  webms.sort((a, b) => {
    const aStat = statSync(join(videoDir, a));
    const bStat = statSync(join(videoDir, b));
    if (aStat.size !== bStat.size) return bStat.size - aStat.size;
    return bStat.mtimeMs - aStat.mtimeMs;
  });
  return join(videoDir, webms[0]!);
}
