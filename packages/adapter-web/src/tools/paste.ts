// Phase 9: paste — fires a real `paste` ClipboardEvent on the target. Editors
// like Notion, ProseMirror, CodeMirror handle paste differently from a sequence
// of keypresses (paste preserves formatting, runs single transaction). The
// agent's previous `type` tool simulated keystrokes which some rich-text
// editors mishandle.
//
// Selector form pastes into the focused element after focusing the selector.
// Vision form pastes at the focused element after clicking the coordinate.

import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const SHORT_TIMEOUT_MS = 5000;

export async function paste(
  page: Page,
  args: { selector: string; text: string },
): Promise<ToolResult> {
  try {
    const loc = page.locator(args.selector).first();
    await loc.focus({ timeout: SHORT_TIMEOUT_MS });
    await dispatchPaste(page, args.text);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionPaste(
  page: Page,
  args: { x: number; y: number; text: string },
): Promise<ToolResult> {
  try {
    await page.mouse.click(args.x, args.y);
    await dispatchPaste(page, args.text);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

// Fires a synthetic paste ClipboardEvent on the active element. For inputs
// and textareas, we also splice the text in so the value reflects the paste —
// some apps listen only for the event and handle insertion themselves, others
// rely on the browser's default insertion behavior.
async function dispatchPaste(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => {
    const target = document.activeElement as HTMLElement | null;
    if (!target) throw new Error('paste: no active element');
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    const accepted = target.dispatchEvent(ev);
    // If the event wasn't cancelled, fall back to inserting text directly so
    // plain inputs and textareas get the paste content.
    if (accepted && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.value = target.value.slice(0, start) + text + target.value.slice(end);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, text);
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
