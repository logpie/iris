import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetAdapter } from '@iris/adapter-types';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './codex-app-server-client.js';
import {
  codexModelName,
  normalizeTokenUsageSnapshot,
  parseCodexReasoningEffort,
  runCodexAppServerExplorer,
  runCodexAppServerSingleShot,
} from './codex-app-server-runner.js';

const tempDirs: string[] = [];
const clients: CodexAppServerClient[] = [];

function makeClient(options?: ConstructorParameters<typeof CodexAppServerClient>[0]) {
  const client = new CodexAppServerClient(options);
  clients.push(client);
  return client;
}

function fakeServerPath(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-codex-appserver-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'server.mjs');
  writeFileSync(path, source);
  return path;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodexAppServerClient', () => {
  it('routes server tool-call requests through the registered handler', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      let pendingClientRequestId = null;
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'trigger') {
          pendingClientRequestId = msg.id;
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 900,
            method: 'item/tool/call',
            params: { tool: 'add', arguments: { a: 2, b: 3 } }
          }) + '\\n');
          return;
        }
        if (msg.id === 900) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: pendingClientRequestId,
            result: { echoed: msg.result }
          }) + '\\n');
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    client.setServerRequestHandler((request) => {
      expect(request.method).toBe('item/tool/call');
      expect(request.params).toEqual({ tool: 'add', arguments: { a: 2, b: 3 } });
      return { contentItems: [{ type: 'inputText', text: '5' }], success: true };
    });

    const result = await client.request('trigger');
    expect(result).toEqual({
      echoed: { contentItems: [{ type: 'inputText', text: '5' }], success: true },
    });

    await client.close();
  });

  it('emits notifications and resolves ordinary responses', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          method: 'thread/tokenUsage/updated',
          params: { threadId: 'thread-1' }
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { ok: true }
        }) + '\\n');
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    const notifications: unknown[] = [];
    client.on('notification', (msg) => notifications.push(msg));
    await client.start();

    await expect(client.request('initialize')).resolves.toEqual({ ok: true });
    expect(notifications).toEqual([
      { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1' } },
    ]);

    await client.close();
  });

  it('rejects unknown goal ids without writing goal_status trace noise', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      let evidenceId = '';
      const evidenceIdFrom = (msg) =>
        String(msg.result?.contentItems?.[0]?.text ?? '').match(/(?:outcome_action_result_event_id|post_action_observation_event_id)=([A-Z0-9]+)/)?.[1] ?? '';
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              jsonrpc: '2.0',
              id: 899,
              method: 'item/tool/call',
              params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'screenshot', arguments: {} }
            });
          }, 10);
          return;
        }
        if (msg.id === 899) {
          evidenceId = evidenceIdFrom(msg);
          write({
            jsonrpc: '2.0',
            id: 900,
            method: 'item/tool/call',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                tool: 'goal_status',
                arguments: {
                  id: 'J1',
                  status: 'verified',
                  rationale: 'wrong id prefix',
                  evidence_event_ids: [evidenceId]
                }
              }
            });
          return;
        }
        if (msg.id === 900) {
          write({
            jsonrpc: '2.0',
            id: 901,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tool: 'goal_status',
              arguments: {
                id: 'G1',
                status: 'verified',
                rationale: 'correct id',
                evidence_event_ids: [evidenceId]
              }
            }
          });
          return;
        }
        if (msg.id === 901) {
          write({
            jsonrpc: '2.0',
            id: 902,
            method: 'item/tool/call',
            params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'done', arguments: {} }
          });
          return;
        }
        if (msg.id === 902) {
          write({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const traceEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const fakeAdapter: TargetAdapter = {
      kind: 'web',
      async start() {},
      async stop() {
        return { evidence_dir: '', artifact_files: {} };
      },
      listTools: () => [{ name: 'screenshot', description: '', input_schema: {} }],
      async callTool() {
        return { ok: true, evidence_refs: [] };
      },
      async observe() {
        return { observation_ref: 'OBS', summary: 'initial page' };
      },
      listProbes: () => [],
      async runProbe(name: string) {
        return { ok: false, probe: name, error: 'no probes' };
      },
      async sliceEvidence() {
        return [];
      },
    };

    const result = await runCodexAppServerExplorer({
      client,
      adapter: fakeAdapter,
      traceWriter: {
        append: async (event: { kind: string; payload: Record<string, unknown> }) => {
          traceEvents.push(event);
        },
      } as never,
      systemPrompt: 'Use tools.',
      initialUserPrompt: 'Verify G1.',
      maxSteps: 5,
      timeoutS: 5,
      goals: [{ id: 'G1', description: 'verify one thing' }],
      maxExpansionGoals: 0,
      cwd: tmpdir(),
    });

    expect(result.termination).toBe('done');
    expect(
      traceEvents.some((event) => event.kind === 'goal_status' && event.payload.id === 'J1'),
    ).toBe(false);
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'goal_status',
          payload: expect.objectContaining({ id: 'G1', status: 'verified' }),
        }),
      ]),
    );

    await client.close();
  });
});

describe('runCodexAppServerSingleShot', () => {
  it('resolves when App Server emits thread-scoped turn completion', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'ok' }
            });
            write({
              method: 'item/completed',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: { type: 'agentMessage', text: 'ok' }
              }
            });
            write({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'thread-1',
                tokenUsage: {
                  last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 },
                  total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }
                }
              }
            });
            write({ method: 'turn/completed', params: { threadId: 'thread-1' } });
          }, 10);
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const result = await runCodexAppServerSingleShot(client, {
      systemPrompt: 'Answer briefly.',
      userPrompt: 'Say ok.',
      timeoutS: 2,
      cwd: tmpdir(),
    });

    expect(result.text).toBe('ok');
    expect(result.token_usage.last?.non_cached_input_tokens).toBe(6);

    await client.close();
  });

  it('uses the completed turn agent message as the final text', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-1', delta: '{"partial":' }
            });
            write({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: {
                  id: 'turn-1',
                  items: [{ type: 'agentMessage', text: '{"complete":true}' }]
                }
              }
            });
          }, 10);
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const result = await runCodexAppServerSingleShot(client, {
      systemPrompt: 'Answer with JSON.',
      userPrompt: 'Return complete JSON.',
      timeoutS: 2,
      cwd: tmpdir(),
    });

    expect(result.text).toBe('{"complete":true}');

    await client.close();
  });

  it('passes a custom reasoning effort to App Server turns', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              method: 'turn/completed',
              params: {
                threadId: 'thread-1',
                turn: {
                  id: 'turn-1',
                  items: [{ type: 'agentMessage', text: msg.params.effort }]
                }
              }
            });
          }, 10);
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const result = await runCodexAppServerSingleShot(client, {
      systemPrompt: 'Answer briefly.',
      userPrompt: 'Say effort.',
      reasoningEffort: 'high',
      timeoutS: 2,
      cwd: tmpdir(),
    });

    expect(result.text).toBe('high');

    await client.close();
  });
});

describe('runCodexAppServerExplorer', () => {
  it('rejects done while assigned goals remain pending and budget remains', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      let evidenceId = '';
      const evidenceIdFrom = (msg) =>
        String(msg.result?.contentItems?.[0]?.text ?? '').match(/(?:outcome_action_result_event_id|post_action_observation_event_id)=([A-Z0-9]+)/)?.[1] ?? '';
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              jsonrpc: '2.0',
              id: 900,
              method: 'item/tool/call',
              params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'done', arguments: {} }
            });
          }, 10);
          return;
        }
        if (msg.id === 900) {
          write({
            jsonrpc: '2.0',
            id: 901,
            method: 'item/tool/call',
            params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'screenshot', arguments: {} }
          });
          return;
        }
        if (msg.id === 901) {
          evidenceId = evidenceIdFrom(msg);
          write({
            jsonrpc: '2.0',
            id: 902,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tool: 'goal_status',
              arguments: {
                id: 'G1',
                status: 'verified',
                rationale: 'observation proves first goal',
                evidence_event_ids: [evidenceId]
              }
            }
          });
          return;
        }
        if (msg.id === 902) {
          write({
            jsonrpc: '2.0',
            id: 903,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tool: 'goal_status',
              arguments: {
                id: 'G2',
                status: 'verified',
                rationale: 'observation proves second goal',
                evidence_event_ids: [evidenceId]
              }
            }
          });
          return;
        }
        if (msg.id === 903) {
          write({
            jsonrpc: '2.0',
            id: 904,
            method: 'item/tool/call',
            params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'done', arguments: {} }
          });
          return;
        }
        if (msg.id === 904) {
          write({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const traceEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const fakeAdapter: TargetAdapter = {
      kind: 'web',
      async start() {},
      async stop() {
        return { evidence_dir: '', artifact_files: {} };
      },
      listTools: () => [{ name: 'screenshot', description: '', input_schema: {} }],
      async callTool() {
        return { ok: true, evidence_refs: [] };
      },
      async observe() {
        return { observation_ref: 'OBS', summary: 'initial page' };
      },
      listProbes: () => [],
      async runProbe(name: string) {
        return { ok: false, probe: name, error: 'no probes' };
      },
      async sliceEvidence() {
        return [];
      },
    };

    const result = await runCodexAppServerExplorer({
      client,
      adapter: fakeAdapter,
      traceWriter: {
        append: async (event: { kind: string; payload: Record<string, unknown> }) => {
          traceEvents.push(event);
        },
      } as never,
      systemPrompt: 'Use tools.',
      initialUserPrompt: 'Verify G1 and G2.',
      maxSteps: 5,
      timeoutS: 5,
      goals: [
        { id: 'G1', description: 'verify first thing' },
        { id: 'G2', description: 'verify second thing' },
      ],
      maxExpansionGoals: 0,
      cwd: tmpdir(),
    });

    expect(result.termination).toBe('done');
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'budget_warn',
          payload: expect.objectContaining({ reason: 'done_rejected' }),
        }),
        expect.objectContaining({
          kind: 'goal_status',
          payload: expect.objectContaining({ id: 'G1', status: 'verified' }),
        }),
        expect.objectContaining({
          kind: 'goal_status',
          payload: expect.objectContaining({ id: 'G2', status: 'verified' }),
        }),
      ]),
    );
    expect(
      traceEvents.some(
        (event) => event.kind === 'goal_status' && event.payload.status === 'untested',
      ),
    ).toBe(false);

    await client.close();
  });

  it('rejects partial or blocked goal statuses without evidence', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      let evidenceId = '';
      const evidenceIdFrom = (msg) =>
        String(msg.result?.contentItems?.[0]?.text ?? '').match(/(?:outcome_action_result_event_id|post_action_observation_event_id)=([A-Z0-9]+)/)?.[1] ?? '';
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              jsonrpc: '2.0',
              id: 900,
              method: 'item/tool/call',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                tool: 'goal_status',
                arguments: { id: 'G1', status: 'blocked', rationale: 'not attempted' }
              }
            });
          }, 10);
          return;
        }
        if (msg.id === 900) {
          write({
            jsonrpc: '2.0',
            id: 901,
            method: 'item/tool/call',
            params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'screenshot', arguments: {} }
          });
          return;
        }
        if (msg.id === 901) {
          evidenceId = evidenceIdFrom(msg);
          write({
            jsonrpc: '2.0',
            id: 902,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tool: 'goal_status',
              arguments: {
                id: 'G1',
                status: 'verified',
                rationale: 'observation proves it',
                evidence_event_ids: [evidenceId]
              }
            }
          });
          return;
        }
        if (msg.id === 902) {
          write({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const traceEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const fakeAdapter: TargetAdapter = {
      kind: 'web',
      async start() {},
      async stop() {
        return { evidence_dir: '', artifact_files: {} };
      },
      listTools: () => [{ name: 'screenshot', description: '', input_schema: {} }],
      async callTool() {
        return { ok: true, evidence_refs: [] };
      },
      async observe() {
        return { observation_ref: 'OBS', summary: 'initial page' };
      },
      listProbes: () => [],
      async runProbe(name: string) {
        return { ok: false, probe: name, error: 'no probes' };
      },
      async sliceEvidence() {
        return [];
      },
    };

    const result = await runCodexAppServerExplorer({
      client,
      adapter: fakeAdapter,
      traceWriter: {
        append: async (event: { kind: string; payload: Record<string, unknown> }) => {
          traceEvents.push(event);
        },
      } as never,
      systemPrompt: 'Use tools.',
      initialUserPrompt: 'Verify G1.',
      maxSteps: 5,
      timeoutS: 5,
      goals: [{ id: 'G1', description: 'verify one thing' }],
      maxExpansionGoals: 0,
      cwd: tmpdir(),
    });

    expect(result.termination).toBe('done');
    expect(
      traceEvents.some(
        (event) => event.kind === 'goal_status' && event.payload.status === 'blocked',
      ),
    ).toBe(false);
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'goal_status',
          payload: expect.objectContaining({ id: 'G1', status: 'verified' }),
        }),
      ]),
    );

    await client.close();
  });

  it('rejects skipped goal statuses that mean unattempted while budget remains', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      let evidenceId = '';
      const evidenceIdFrom = (msg) =>
        String(msg.result?.contentItems?.[0]?.text ?? '').match(/(?:outcome_action_result_event_id|post_action_observation_event_id)=([A-Z0-9]+)/)?.[1] ?? '';
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              jsonrpc: '2.0',
              id: 900,
              method: 'item/tool/call',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                tool: 'goal_status',
                arguments: {
                  id: 'G1',
                  status: 'skipped',
                  rationale: 'Not exercised before budget ran out.'
                }
              }
            });
          }, 10);
          return;
        }
        if (msg.id === 900) {
          write({
            jsonrpc: '2.0',
            id: 901,
            method: 'item/tool/call',
            params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'screenshot', arguments: {} }
          });
          return;
        }
        if (msg.id === 901) {
          evidenceId = evidenceIdFrom(msg);
          write({
            jsonrpc: '2.0',
            id: 902,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tool: 'goal_status',
              arguments: {
                id: 'G1',
                status: 'verified',
                rationale: 'observation proves it',
                evidence_event_ids: [evidenceId]
              }
            }
          });
          return;
        }
        if (msg.id === 902) {
          write({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const traceEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const fakeAdapter: TargetAdapter = {
      kind: 'web',
      async start() {},
      async stop() {
        return { evidence_dir: '', artifact_files: {} };
      },
      listTools: () => [{ name: 'screenshot', description: '', input_schema: {} }],
      async callTool() {
        return { ok: true, evidence_refs: [] };
      },
      async observe() {
        return { observation_ref: 'OBS', summary: 'initial page' };
      },
      listProbes: () => [],
      async runProbe(name: string) {
        return { ok: false, probe: name, error: 'no probes' };
      },
      async sliceEvidence() {
        return [];
      },
    };

    const result = await runCodexAppServerExplorer({
      client,
      adapter: fakeAdapter,
      traceWriter: {
        append: async (event: { kind: string; payload: Record<string, unknown> }) => {
          traceEvents.push(event);
        },
      } as never,
      systemPrompt: 'Use tools.',
      initialUserPrompt: 'Verify G1.',
      maxSteps: 5,
      timeoutS: 5,
      goals: [{ id: 'G1', description: 'verify one thing' }],
      maxExpansionGoals: 0,
      cwd: tmpdir(),
    });

    expect(result.termination).toBe('done');
    expect(
      traceEvents.some(
        (event) => event.kind === 'goal_status' && event.payload.status === 'skipped',
      ),
    ).toBe(false);
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'goal_status',
          payload: expect.objectContaining({ id: 'G1', status: 'verified' }),
        }),
      ]),
    );

    await client.close();
  });

  it('retries partial goals while budget remains before ending', async () => {
    const server = fakeServerPath(`
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
      let evidenceId = '';
      const evidenceIdFrom = (msg) =>
        String(msg.result?.contentItems?.[0]?.text ?? '').match(/(?:outcome_action_result_event_id|post_action_observation_event_id)=([A-Z0-9]+)/)?.[1] ?? '';
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          return;
        }
        if (msg.method === 'thread/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          write({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } });
          setTimeout(() => {
            write({
              jsonrpc: '2.0',
              id: 900,
              method: 'item/tool/call',
              params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'screenshot', arguments: {} }
            });
          }, 10);
          return;
        }
        if (msg.id === 900) {
          evidenceId = evidenceIdFrom(msg);
          write({
            jsonrpc: '2.0',
            id: 901,
            method: 'item/tool/call',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                tool: 'goal_status',
                arguments: {
                  id: 'G1',
                  status: 'partial',
                  rationale: 'not enough proof',
                  evidence_event_ids: [evidenceId]
                }
              }
            });
          return;
        }
        if (msg.id === 901) {
          write({
            jsonrpc: '2.0',
            id: 902,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tool: 'goal_status',
              arguments: {
                id: 'G1',
                status: 'verified',
                rationale: 'observation proves it',
                evidence_event_ids: [evidenceId]
              }
            }
          });
          return;
        }
        if (msg.id === 902) {
          write({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        }
      });
    `);
    const client = makeClient({
      command: process.execPath,
      args: [server],
      requestTimeoutMs: 1_000,
    });
    await client.start();
    await client.initialize();

    const traceEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const fakeAdapter: TargetAdapter = {
      kind: 'web',
      async start() {},
      async stop() {
        return { evidence_dir: '', artifact_files: {} };
      },
      listTools: () => [{ name: 'screenshot', description: '', input_schema: {} }],
      async callTool() {
        return { ok: true, evidence_refs: [] };
      },
      async observe() {
        return { observation_ref: 'OBS', summary: 'initial page' };
      },
      listProbes: () => [],
      async runProbe(name: string) {
        return { ok: false, probe: name, error: 'no probes' };
      },
      async sliceEvidence() {
        return [];
      },
    };

    const result = await runCodexAppServerExplorer({
      client,
      adapter: fakeAdapter,
      traceWriter: {
        append: async (event: { kind: string; payload: Record<string, unknown> }) => {
          traceEvents.push(event);
        },
      } as never,
      systemPrompt: 'Use tools.',
      initialUserPrompt: 'Verify G1.',
      maxSteps: 5,
      timeoutS: 5,
      goals: [{ id: 'G1', description: 'verify one thing' }],
      maxExpansionGoals: 0,
      cwd: tmpdir(),
    });

    expect(result.termination).toBe('done');
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'budget_warn' }),
        expect.objectContaining({
          kind: 'goal_status',
          payload: expect.objectContaining({ id: 'G1', status: 'verified' }),
        }),
      ]),
    );

    await client.close();
  });
});

describe('codexModelName', () => {
  it('defaults Claude model aliases to a Codex model', () => {
    expect(codexModelName()).toBe('gpt-5.4-mini');
    expect(codexModelName('claude-opus-4-6')).toBe('gpt-5.4-mini');
    expect(codexModelName('gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('parseCodexReasoningEffort', () => {
  it('accepts known App Server effort labels and rejects invalid values', () => {
    expect(parseCodexReasoningEffort('high')).toBe('high');
    expect(parseCodexReasoningEffort('xhigh')).toBe('xhigh');
    expect(() => parseCodexReasoningEffort('max')).toThrow(/invalid Codex reasoning effort/);
  });
});

describe('normalizeTokenUsageSnapshot', () => {
  it('preserves last and total usage while adding non-cached input', () => {
    expect(
      normalizeTokenUsageSnapshot({
        last: {
          totalTokens: 110,
          inputTokens: 100,
          cachedInputTokens: 70,
          outputTokens: 10,
          reasoningOutputTokens: 4,
        },
        total: {
          totalTokens: 230,
          inputTokens: 200,
          cachedInputTokens: 150,
          outputTokens: 30,
          reasoningOutputTokens: 12,
        },
      }),
    ).toEqual({
      last: {
        total_tokens: 110,
        input_tokens: 100,
        cached_input_tokens: 70,
        non_cached_input_tokens: 30,
        output_tokens: 10,
        reasoning_output_tokens: 4,
      },
      total: {
        total_tokens: 230,
        input_tokens: 200,
        cached_input_tokens: 150,
        non_cached_input_tokens: 50,
        output_tokens: 30,
        reasoning_output_tokens: 12,
      },
    });
  });
});
