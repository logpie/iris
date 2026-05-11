// Phase 7 F7-1 — Selector retry helper. When an action tool fails with a
// selector-related Playwright error, automatically try 1-2 alternate selector
// strategies before returning failure to the Explorer. Reduces noise from
// Explorer selector misses without hiding genuine app failures.

import type { Locator, Page } from 'playwright';

// Errors that mean "selector matched ambiguously" — Playwright's strict mode
// rejects these. The right fix is usually `.first()`.
const STRICT_MODE_RE = /strict mode violation|resolved to \d+ elements/i;

// Errors that mean "selector matched nothing" — could be a real bug or just
// a wrong selector. Worth trying role-based alternates.
const NO_MATCH_RE = /no element found|resolved to 0 elements|element is not attached/i;

export interface RetryOutcome {
  ok: boolean;
  error?: string;
  retried: boolean;
  retry_count: number;
  // What we did, for trace transparency. Each entry is a strategy that was
  // tried (and may have succeeded or failed).
  attempts: Array<{ strategy: string; ok: boolean; error?: string }>;
}

export type ActionFn = (locator: Locator) => Promise<void>;

/**
 * Try an action against the original selector. If it fails with a selector
 * error, retry with up to 2 alternate strategies. Returns a structured outcome
 * for the caller to convert into a ToolResult and emit trace events.
 */
export async function actionWithRetry(
  page: Page,
  originalSelector: string,
  action: ActionFn,
  opts: { timeoutMs: number; allowRetry: boolean } = { timeoutMs: 5000, allowRetry: true },
): Promise<RetryOutcome> {
  const attempts: RetryOutcome['attempts'] = [];

  // Attempt 1: original selector.
  try {
    await action(page.locator(originalSelector));
    return {
      ok: true,
      retried: false,
      retry_count: 0,
      attempts: [{ strategy: 'original', ok: true }],
    };
  } catch (err) {
    const msg = errString(err);
    attempts.push({ strategy: 'original', ok: false, error: msg });
    if (!opts.allowRetry) {
      return { ok: false, error: msg, retried: false, retry_count: 0, attempts };
    }

    // Strategy 1: .first() for strict-mode-violation. Cheap and usually right.
    if (STRICT_MODE_RE.test(msg)) {
      try {
        await action(page.locator(originalSelector).first());
        attempts.push({ strategy: 'first', ok: true });
        return { ok: true, retried: true, retry_count: 1, attempts };
      } catch (e2) {
        attempts.push({ strategy: 'first', ok: false, error: errString(e2) });
      }
    }

    // Strategy 2: role-based retry for selectors that look like text-matchers
    // or contain a button/link descriptor.
    if (STRICT_MODE_RE.test(msg) || NO_MATCH_RE.test(msg)) {
      const roleLocator = guessRoleLocator(page, originalSelector);
      if (roleLocator) {
        try {
          await action(roleLocator);
          attempts.push({ strategy: 'role', ok: true });
          return { ok: true, retried: true, retry_count: 2, attempts };
        } catch (e3) {
          attempts.push({ strategy: 'role', ok: false, error: errString(e3) });
        }
      }
    }

    // No retries succeeded. Return original error (the one the user cares about).
    return { ok: false, error: msg, retried: true, retry_count: attempts.length - 1, attempts };
  }
}

// Best-effort: extract a role + name from a CSS selector that looks like
// `button:has-text("Sign in")`, `text=Sign in`, `a[href*="signup"]`, etc.
// Returns null if no plausible role/name extraction.
function guessRoleLocator(page: Page, selector: string): Locator | null {
  // text= or :has-text("X") or :text("X")
  const textMatch =
    /text="?([^"]+?)"?$/i.exec(selector) || /:(has-text|text)\(['"]([^'"]+)['"]\)/i.exec(selector);
  const text = textMatch ? (textMatch[2] ?? textMatch[1]) : null;

  // Common role hints in the selector itself
  let role: 'button' | 'link' | 'textbox' | null = null;
  if (/^button|button\[/.test(selector)) role = 'button';
  else if (/^a\[|^a:|link\b/i.test(selector)) role = 'link';
  else if (/^input|textarea|textbox/i.test(selector)) role = 'textbox';

  if (text && role) return page.getByRole(role, { name: text });
  if (text) return page.getByText(text);
  if (role && /name="([^"]+)"/.exec(selector)) {
    const m = /name="([^"]+)"/.exec(selector);
    if (m?.[1]) return page.getByRole(role, { name: m[1] });
  }
  return null;
}

function errString(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split('\n')[0] ?? err.message;
  }
  return String(err);
}
