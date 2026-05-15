import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type JsonRpcServerRequest = JsonRpcRequest;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
}

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = '';
  private serverRequestHandler:
    | ((request: JsonRpcServerRequest) => Promise<unknown> | unknown)
    | null = null;

  constructor(private readonly opts: CodexAppServerClientOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const command = this.opts.command ?? 'codex';
    const args = this.opts.args ?? ['app-server', '--listen', 'stdio://'];
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
      this.emit('stderr', chunk.toString());
    });
    proc.once('error', (err) => {
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
    });
    proc.once('exit', (code, signal) => {
      this.proc = null;
      if (this.pending.size > 0) {
        this.rejectAll(
          new Error(
            `codex app-server exited before responding (code=${code}, signal=${signal}): ${this.stderr.slice(-1000)}`,
          ),
        );
      }
      this.emit('exit', { code, signal });
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed);
    });
  }

  async initialize(): Promise<unknown> {
    return this.request('initialize', {
      clientInfo: { name: 'iris', title: 'Iris', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
  }

  setServerRequestHandler(
    handler: ((request: JsonRpcServerRequest) => Promise<unknown> | unknown) | null,
  ): void {
    this.serverRequestHandler = handler;
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.proc) throw new Error('codex app-server is not running');
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, ms);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.proc?.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  respond(id: number, result: unknown): void {
    if (!this.proc) throw new Error('codex app-server is not running');
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  respondError(id: number, message: string, code = -32000): void {
    if (!this.proc) throw new Error('codex app-server is not running');
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.emit('protocolError', new Error(`failed to parse app-server JSON: ${line}`));
      return;
    }

    const maybe = msg as {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
      params?: unknown;
    };

    if (typeof maybe.id === 'number' && (Object.hasOwn(maybe, 'result') || maybe.error)) {
      const pending = this.pending.get(maybe.id);
      if (!pending) return;
      this.pending.delete(maybe.id);
      clearTimeout(pending.timer);
      if (maybe.error) {
        pending.reject(
          new Error(
            `codex app-server ${pending.method} failed: ${maybe.error.message ?? JSON.stringify(maybe.error)}`,
          ),
        );
      } else {
        pending.resolve(maybe.result);
      }
      return;
    }

    if (typeof maybe.id === 'number' && typeof maybe.method === 'string') {
      void this.handleServerRequest(maybe as JsonRpcServerRequest);
      return;
    }

    if (typeof maybe.method === 'string') {
      this.emit('notification', maybe as JsonRpcNotification);
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    try {
      if (!this.serverRequestHandler) {
        this.respondError(request.id, `unhandled app-server request: ${request.method}`);
        return;
      }
      const result = await this.serverRequestHandler(request);
      this.respond(request.id, result);
    } catch (err) {
      this.respondError(request.id, err instanceof Error ? err.message : String(err));
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}
