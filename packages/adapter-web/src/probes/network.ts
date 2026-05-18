import type { ProbeResult } from '@iris/adapter-types';
import type { Page, Request, Response } from 'playwright';

export interface NetworkEntry {
  url: string;
  method: string;
  resource_type: string;
  status: number;
  ok: boolean;
  ms: number;
  ts: number;
  first_party: boolean;
  api_like: boolean;
  failure_kind?: 'http_status' | 'requestfailed';
  failure_text?: string;
}

export class NetworkProbe {
  private buffer: NetworkEntry[] = [];
  private cursor = 0;
  private listener: ((rsp: Response) => void) | null = null;
  private requestContexts = new Map<Request, { startedAt: number; pageUrl: string }>();
  private requestListener: ((req: Request) => void) | null = null;
  private requestFailedListener: ((req: Request) => void) | null = null;

  constructor(private readonly page: Page) {}

  attach(): void {
    if (this.listener) return;
    this.requestListener = (req) => {
      this.requestContexts.set(req, { startedAt: Date.now(), pageUrl: this.page.url() });
    };
    this.listener = (rsp: Response) => {
      const req = rsp.request();
      const url = rsp.url();
      const context = this.requestContexts.get(req);
      const startedAt = context?.startedAt ?? Date.now();
      const ms = Date.now() - startedAt;
      this.requestContexts.delete(req);
      const status = rsp.status();
      const entry = this.entryForRequest(
        req,
        {
          url,
          status,
          ok: status >= 200 && status < 400,
          ms,
          ts: Date.now() / 1000,
        },
        context?.pageUrl,
      );
      if (!entry.ok) entry.failure_kind = 'http_status';
      this.buffer.push(entry);
    };
    this.requestFailedListener = (req: Request) => {
      const context = this.requestContexts.get(req);
      const startedAt = context?.startedAt ?? Date.now();
      this.requestContexts.delete(req);
      this.buffer.push(
        this.entryForRequest(
          req,
          {
            url: req.url(),
            status: 0,
            ok: false,
            ms: Date.now() - startedAt,
            ts: Date.now() / 1000,
            failure_kind: 'requestfailed',
            failure_text: req.failure()?.errorText ?? 'request failed',
          },
          context?.pageUrl,
        ),
      );
    };
    this.page.on('request', this.requestListener);
    this.page.on('response', this.listener);
    this.page.on('requestfailed', this.requestFailedListener);
  }

  detach(): void {
    if (this.listener) this.page.off('response', this.listener);
    if (this.requestListener) this.page.off('request', this.requestListener);
    if (this.requestFailedListener) this.page.off('requestfailed', this.requestFailedListener);
    this.listener = null;
    this.requestListener = null;
    this.requestFailedListener = null;
    this.requestContexts.clear();
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
        summary: networkSummary(failures),
        data: failures,
      };
    }
    if (name === 'network_all_since') {
      const all = this.consume(false);
      const failures = all.filter((e) => !e.ok);
      return {
        ok: true,
        probe: name,
        summary: { count: all.length, ...networkSummary(failures) },
        data: all,
      };
    }
    return { ok: false, probe: name, error: `unknown network probe: ${name}` };
  }

  private entryForRequest(
    req: Request,
    base: Pick<NetworkEntry, 'url' | 'status' | 'ok' | 'ms' | 'ts'> &
      Partial<Pick<NetworkEntry, 'failure_kind' | 'failure_text'>>,
    pageUrl = this.page.url(),
  ): NetworkEntry {
    const url = base.url || req.url();
    return {
      ...base,
      url,
      method: req.method(),
      resource_type: req.resourceType(),
      first_party: isFirstParty(pageUrl, url),
      api_like: isApiLike(req),
    };
  }
}

function isFirstParty(pageUrl: string, requestUrl: string): boolean {
  try {
    return new URL(pageUrl).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

function isApiLike(req: Request): boolean {
  const resourceType = req.resourceType();
  if (resourceType === 'fetch' || resourceType === 'xhr') return true;
  try {
    const url = new URL(req.url());
    if (/\/api(?:\/|$)|\/graphql(?:\/|$)|\/rpc(?:\/|$)/i.test(url.pathname)) return true;
  } catch {}
  const headers = req.headers();
  const accept = headers.accept ?? '';
  const contentType = headers['content-type'] ?? '';
  const requestedWith = headers['x-requested-with'] ?? '';
  return (
    /\bapplication\/json\b/i.test(accept) ||
    /\bapplication\/json\b/i.test(contentType) ||
    /^XMLHttpRequest$/i.test(requestedWith)
  );
}

function networkSummary(failures: NetworkEntry[]): Record<string, number> {
  const firstPartyFailures = failures.filter((entry) => entry.first_party);
  const apiFailures = failures.filter((entry) => entry.api_like);
  return {
    failure_count: failures.length,
    first_party_failure_count: firstPartyFailures.length,
    api_failure_count: apiFailures.length,
    first_party_api_failure_count: failures.filter((entry) => entry.first_party && entry.api_like)
      .length,
  };
}
