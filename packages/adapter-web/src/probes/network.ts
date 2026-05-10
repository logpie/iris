import type { ProbeResult } from '@iris/adapter-types';
import type { Page, Response } from 'playwright';

export interface NetworkEntry {
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  ts: number;
}

export class NetworkProbe {
  private buffer: NetworkEntry[] = [];
  private cursor = 0;
  private listener: ((rsp: Response) => void) | null = null;
  private startTimes = new Map<string, number>();
  private requestListener: ((req: import('playwright').Request) => void) | null = null;

  constructor(private readonly page: Page) {}

  attach(): void {
    if (this.listener) return;
    this.requestListener = (req) => {
      this.startTimes.set(req.url(), Date.now());
    };
    this.listener = (rsp: Response) => {
      const url = rsp.url();
      const startedAt = this.startTimes.get(url) ?? Date.now();
      const ms = Date.now() - startedAt;
      this.startTimes.delete(url);
      this.buffer.push({
        url,
        status: rsp.status(),
        ok: rsp.status() >= 200 && rsp.status() < 400,
        ms,
        ts: Date.now() / 1000,
      });
    };
    this.page.on('request', this.requestListener);
    this.page.on('response', this.listener);
  }

  detach(): void {
    if (this.listener) this.page.off('response', this.listener);
    if (this.requestListener) this.page.off('request', this.requestListener);
    this.listener = null;
    this.requestListener = null;
  }

  consume(failuresOnly = false): NetworkEntry[] {
    const slice = this.buffer.slice(this.cursor);
    this.cursor = this.buffer.length;
    return failuresOnly ? slice.filter((e) => !e.ok) : slice;
  }

  async runProbe(name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    if (name === 'network_failures_since') {
      const failures = this.consume(true);
      return {
        ok: true,
        probe: name,
        summary: { failure_count: failures.length },
        data: failures,
      };
    }
    if (name === 'network_all_since') {
      const all = this.consume(false);
      return {
        ok: true,
        probe: name,
        summary: { count: all.length },
        data: all,
      };
    }
    return { ok: false, probe: name, error: `unknown network probe: ${name}` };
  }
}
