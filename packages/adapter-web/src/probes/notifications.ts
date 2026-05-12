// Phase 12: notifications probe. Web apps signal success/failure via
// transient UI elements — toasts, snackbars, banners, aria-live regions.
// Iris's previous strategy was to vision_describe specific regions hoping
// the toast was there. When the agent guessed wrong (e.g. asked about the
// browser download bar), the negative result was taken as confident proof
// of no confirmation, producing fake "X feature gives no feedback" findings
// (Dillinger's Export-as is the recurring case).
//
// This probe sweeps known notification DOM patterns and returns whatever
// text is currently visible. It's cheap (one page.evaluate), it's broad
// coverage (catches whether the app uses role=alert, .toast, aria-live,
// MUI Snackbar, Chakra Toast, etc.), and it's deterministic — no LLM
// inference required.

import type { ProbeResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

export interface NotificationItem {
  selector: string; // selector-ish identifier
  role: string; // aria role or inferred role
  text: string; // current visible text
  source: 'aria_live' | 'role_alert_status' | 'class_pattern' | 'toast_container';
}

export async function runNotificationsProbe(page: Page): Promise<ProbeResult> {
  try {
    const items = await page.evaluate(() => {
      const out: Array<{
        selector: string;
        role: string;
        text: string;
        source: NotificationItem['source'];
      }> = [];

      const isVisible = (el: Element): boolean => {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = window.getComputedStyle(e);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const labelFor = (el: Element): string => {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string'
            ? `.${el.className.split(/\s+/).slice(0, 2).filter(Boolean).join('.')}`
            : '';
        return (el.tagName.toLowerCase() + id + cls).slice(0, 80);
      };

      const addUnique = (item: {
        selector: string;
        role: string;
        text: string;
        source: NotificationItem['source'];
      }) => {
        if (!item.text.trim()) return;
        // Dedupe by text
        if (out.some((o) => o.text === item.text)) return;
        out.push(item);
      };

      // 1. aria-live regions (polite / assertive). These are the *standard*
      // way to announce status changes to assistive tech, used by many
      // toast libraries.
      for (const el of Array.from(document.querySelectorAll('[aria-live]'))) {
        if (!isVisible(el)) continue;
        const text = (el as HTMLElement).innerText?.trim() ?? '';
        addUnique({
          selector: labelFor(el),
          role: el.getAttribute('aria-live') ?? 'polite',
          text: text.slice(0, 400),
          source: 'aria_live',
        });
      }

      // 2. role=alert / role=status — same semantic intent.
      for (const el of Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))) {
        if (!isVisible(el)) continue;
        const text = (el as HTMLElement).innerText?.trim() ?? '';
        addUnique({
          selector: labelFor(el),
          role: el.getAttribute('role') ?? '',
          text: text.slice(0, 400),
          source: 'role_alert_status',
        });
      }

      // 3. Class-based patterns covering popular libraries: MUI Snackbar,
      // Chakra Toast, Ant Design, Tailwind notifications, etc.
      const CLASS_PATTERNS = [
        '.toast',
        '.Toast',
        '.snackbar',
        '.MuiSnackbar-root',
        '.chakra-toast',
        '.ant-notification',
        '.ant-message',
        '.Toastify__toast',
        '.notification',
        '[class*="Toast"]',
        '[class*="Snackbar"]',
        '[class*="notification"]',
        '[class*="banner"]',
      ];
      for (const sel of CLASS_PATTERNS) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVisible(el)) continue;
          const text = (el as HTMLElement).innerText?.trim() ?? '';
          addUnique({
            selector: labelFor(el),
            role: 'inferred-toast',
            text: text.slice(0, 400),
            source: 'class_pattern',
          });
        }
      }

      // 4. Fixed-position bottom or top corner elements with short text —
      // best-effort fallback for sites that don't use any standard pattern
      // but still render a toast (Dillinger's app-level toasts fit here).
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const e = el as HTMLElement;
        if (!e.getBoundingClientRect) continue;
        const style = window.getComputedStyle(e);
        if (style.position !== 'fixed') continue;
        if (!isVisible(el)) continue;
        const r = e.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Only consider corner-anchored small elements
        const inCorner =
          (r.right > vw * 0.6 || r.left < vw * 0.4) && (r.bottom > vh * 0.6 || r.top < vh * 0.4);
        if (!inCorner) continue;
        if (r.width > vw * 0.5 || r.height > vh * 0.4) continue;
        const text = e.innerText?.trim() ?? '';
        if (!text || text.length > 200) continue;
        addUnique({
          selector: labelFor(el),
          role: 'fixed-corner',
          text: text.slice(0, 400),
          source: 'toast_container',
        });
      }

      return out;
    });

    return {
      ok: true,
      probe: 'notifications_visible',
      summary: { count: items.length },
      data: items,
    };
  } catch (err) {
    return {
      ok: false,
      probe: 'notifications_visible',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
