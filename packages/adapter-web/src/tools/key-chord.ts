// Phase 9: key_chord — press multiple keys simultaneously (modifier chord).
// Examples: Cmd+Z (undo), Cmd+A (select all), Ctrl+Shift+P (command palette),
// Cmd+Enter (submit). The existing `press` only handles single-key presses;
// the agent had no way to undo, select-all, or trigger most shortcuts.
//
// Uses Playwright's `+`-joined chord notation (e.g. "Meta+z", "Control+Shift+p").
// Auto-detects platform — if the chord uses "Meta" and we're on Linux, falls
// back to "Control". Most apps treat them interchangeably.

import { platform } from 'node:os';
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

export async function keyChord(page: Page, args: { keys: string[] }): Promise<ToolResult> {
  try {
    if (!args.keys || args.keys.length === 0) {
      return { ok: false, error: 'key_chord: keys array is empty' };
    }
    const normalized = args.keys.map(normalizeKey);
    const chord = normalized.join('+');
    await page.keyboard.press(chord);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function normalizeKey(k: string): string {
  // Common aliases the agent might emit.
  const m = k.trim();
  if (/^cmd$/i.test(m)) return 'Meta';
  if (/^command$/i.test(m)) return 'Meta';
  if (/^ctrl$/i.test(m)) return 'Control';
  if (/^opt$/i.test(m) || /^option$/i.test(m)) return 'Alt';
  // CmdOrCtrl is a convenience — pick the platform default.
  if (/^cmd[\s_-]?or[\s_-]?ctrl$/i.test(m)) {
    return platform() === 'darwin' ? 'Meta' : 'Control';
  }
  // Otherwise pass through (Playwright accepts both "Shift" and "shift").
  return m;
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
