const PRICE_PER_MTOK: Record<
  string,
  { input: number; output: number; cache_write: number; cache_read: number }
> = {
  'claude-opus-4-7': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
};

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface LlmCallInput {
  model: string;
  system: string | Array<Record<string, unknown>>;
  messages: LlmMessage[];
  tools?: Array<Record<string, unknown>>;
  max_tokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface LlmRawResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: Array<Record<string, unknown>>;
  usage: LlmUsage;
}

export interface LlmCallResult {
  raw: LlmRawResponse;
  text: string;
  usage: LlmUsage;
  cost_usd: number;
  latency_ms: number;
}

export type LlmTransport = (input: LlmCallInput) => Promise<LlmRawResponse>;

export interface LlmClientOptions {
  transport: LlmTransport;
  max_retries?: number;
  retry_initial_ms?: number;
}

export class LlmClient {
  private readonly transport: LlmTransport;
  private readonly max_retries: number;
  private readonly retry_initial_ms: number;
  private _calls = 0;
  private _cost = 0;
  private _input_tokens = 0;
  private _output_tokens = 0;

  constructor(opts: LlmClientOptions) {
    this.transport = opts.transport;
    this.max_retries = opts.max_retries ?? 4;
    this.retry_initial_ms = opts.retry_initial_ms ?? 500;
  }

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const start = Date.now();
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt <= this.max_retries) {
      try {
        const raw = await this.transport(input);
        const cost = computeCost(raw.model, raw.usage);
        this._calls++;
        this._cost += cost;
        this._input_tokens += raw.usage.input_tokens;
        this._output_tokens += raw.usage.output_tokens;
        const text = raw.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        return {
          raw,
          text,
          usage: raw.usage,
          cost_usd: cost,
          latency_ms: Date.now() - start,
        };
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        const retriable = status === 429 || status === 529 || status === 500 || status === 503;
        if (!retriable || attempt >= this.max_retries) throw err;
        const delay = this.retry_initial_ms * 2 ** attempt;
        await sleep(delay);
        attempt++;
      }
    }
    throw lastErr ?? new Error('LlmClient: exhausted retries');
  }

  totals(): { calls: number; cost_usd: number; input_tokens: number; output_tokens: number } {
    return {
      calls: this._calls,
      cost_usd: this._cost,
      input_tokens: this._input_tokens,
      output_tokens: this._output_tokens,
    };
  }
}

function computeCost(model: string, usage: LlmUsage): number {
  const p = PRICE_PER_MTOK[model] ?? { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cache_write +
      usage.cache_read_input_tokens * p.cache_read) /
    1_000_000
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
