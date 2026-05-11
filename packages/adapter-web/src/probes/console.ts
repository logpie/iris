import type { ProbeResult } from '@iris/adapter-types';
import type { ConsoleMessage, Page } from 'playwright';

export interface ConsoleEntry {
  type: string;
  text: string;
  ts: number;
}

export class ConsoleProbe {
  private buffer: ConsoleEntry[] = [];
  private cursor = 0;
  private listener: ((msg: ConsoleMessage) => void) | null = null;

  constructor(private readonly page: Page) {}

  attach(): void {
    if (this.listener) return;
    this.listener = (msg: ConsoleMessage) => {
      this.buffer.push({ type: msg.type(), text: msg.text(), ts: Date.now() / 1000 });
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
    this.buffer.push({ type, text, ts: Date.now() / 1000 });
  }

  async runProbe(name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    if (name === 'console_errors_since') {
      const errs = this.consume('error');
      return {
        ok: true,
        probe: name,
        summary: { error_count: errs.length },
        data: errs,
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
