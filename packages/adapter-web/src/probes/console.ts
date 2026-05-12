import type { ProbeResult } from '@iris/adapter-types';
import type { ConsoleMessage, Page } from 'playwright';

export interface ConsoleEntry {
  type: string;
  text: string;
  ts: number;
  // Phase 12: distinguish JavaScript-level errors (real bugs) from network
  // resource-load failures (mostly noise — blocked trackers, third-party CDN
  // hiccups, ad-blocker interference). Chrome auto-logs failed resource
  // fetches at console level even though no app code called console.error.
  // Lumping them together caused Iris to report "15 console errors during
  // normal use" on Dillinger when the app worked fine.
  category?: 'app_error' | 'resource_error';
}

const RESOURCE_ERROR_PATTERNS: RegExp[] = [
  /^Failed to load resource/i,
  /\bnet::ERR_[A-Z_]+/,
  /\b(GET|POST|PUT|DELETE|HEAD|OPTIONS)\s+https?:\/\/.+\b\d{3}\s/i, // HTTP method + URL + status
];

function categorize(type: string, text: string): 'app_error' | 'resource_error' {
  if (type === 'error') {
    for (const p of RESOURCE_ERROR_PATTERNS) if (p.test(text)) return 'resource_error';
  }
  return 'app_error';
}

export class ConsoleProbe {
  private buffer: ConsoleEntry[] = [];
  private cursor = 0;
  private listener: ((msg: ConsoleMessage) => void) | null = null;

  constructor(private readonly page: Page) {}

  attach(): void {
    if (this.listener) return;
    this.listener = (msg: ConsoleMessage) => {
      const type = msg.type();
      const text = msg.text();
      this.buffer.push({ type, text, ts: Date.now() / 1000, category: categorize(type, text) });
    };
    this.page.on('console', this.listener);
  }

  detach(): void {
    if (!this.listener) return;
    this.page.off('console', this.listener);
    this.listener = null;
  }

  consume(filterType?: string): ConsoleEntry[] {
    const slice = this.buffer.slice(this.cursor);
    this.cursor = this.buffer.length;
    return filterType ? slice.filter((e) => e.type === filterType) : slice;
  }

  // Non-destructive read (does not advance the cursor). Used by preflight,
  // which inspects console state without consuming it.
  snapshot(): ConsoleEntry[] {
    return [...this.buffer];
  }

  // Manual push — used by preflight to also record `pageerror` events
  // (uncaught exceptions) which Playwright fires on a different listener.
  pushExternal(type: string, text: string): void {
    this.buffer.push({ type, text, ts: Date.now() / 1000, category: categorize(type, text) });
  }

  async runProbe(name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    if (name === 'console_errors_since') {
      const errs = this.consume('error');
      // Phase 12: split app errors from resource-load errors. The Judge
      // should treat them differently: app errors are bugs, resource errors
      // are mostly third-party / ad-blocker noise.
      const appErrors = errs.filter((e) => e.category === 'app_error');
      const resourceErrors = errs.filter((e) => e.category === 'resource_error');
      return {
        ok: true,
        probe: name,
        summary: {
          // Backwards-compatible total count (legacy consumers).
          error_count: appErrors.length,
          // New: explicit breakdown.
          app_error_count: appErrors.length,
          resource_error_count: resourceErrors.length,
        },
        data: { app_errors: appErrors, resource_errors: resourceErrors },
      };
    }
    if (name === 'console_all_since') {
      const all = this.consume();
      return {
        ok: true,
        probe: name,
        summary: { count: all.length },
        data: all,
      };
    }
    return { ok: false, probe: name, error: `unknown console probe: ${name}` };
  }
}
