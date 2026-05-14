#!/usr/bin/env node
// Localize the Sonnet judge hang to a SPECIFIC option difference.
//
// Fact: Sonnet Explorer call works (thousands of times). Sonnet Judge call hangs.
// Same SDK, same model. The bug must be in the option set we pass differently.
//
// What differs between Explorer and Judge calls:
//   (a) systemPrompt:   Explorer = [string, BOUNDARY, ''] (array)   Judge = string
//   (b) mcpServers:     Explorer = { iris: ... }                    Judge = (omitted)
//   (c) allowedTools:   Explorer = [tool names...]                  Judge = (omitted)
//   (d) maxTurns:       Explorer = 500                              Judge = 1
//   (e) user prompt:    Explorer = small per turn                   Judge = huge single
//
// We can't change (e) without changing the test entirely. We CAN change a/b/c/d.
//
// Variants (sequential, each with 5-min hard cap):
//   V1  baseline-judge — current Judge wiring (expect: hang)
//   V2  array-system   — V1 + systemPrompt as [str] array
//   V3  maxturns-2     — V1 + maxTurns: 2
//   V4  empty-mcp      — V1 + mcpServers: {} (force the SDK MCP path even though empty)
//   V5  explorer-shape — V2 + V3 + V4 combined (closest to Explorer wiring)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const TRACE_PATH = '/tmp/iris-p19c-tracker-defaults/trace.jsonl';
const OUT_DIR = '/tmp/iris-debug-wiring';
const MODEL = 'claude-sonnet-4-6';
const PER_VARIANT_TIMEOUT_MS = 5 * 60 * 1000;
mkdirSync(OUT_DIR, { recursive: true });

const events = await iristrace.readTraceArray(TRACE_PATH);
const traceDigest = judgeMod.buildTraceDigest(events);
const userPrompt = judgeMod.buildJudgeUserPrompt({
  trace_digest: traceDigest,
  rubric_profiles: [
    {
      name: 'usability',
      weight_in_overall: 1,
      dimensions: [{ id: 'clarity', weight: 1, anchors: { '0': 'unclear', '5': 'clear' } }],
    },
  ],
  tentative_findings_count: events.filter((e) => e.kind === 'tentative_finding').length,
});
const SYSTEM = judgeMod.JUDGE_SYSTEM;
console.log(`Trace ${events.length} ev, prompt ${userPrompt.length}c`);

async function runVariant(name, options) {
  const debugFile = join(OUT_DIR, `${name}.debug.log`);
  console.log(`\n=== ${name} ===`);
  const start = Date.now();
  let q;
  try {
    q = query({
      prompt: userPrompt,
      options: {
        model: MODEL,
        permissionMode: 'bypassPermissions',
        settingSources: [],
        strictMcpConfig: true,
        debug: true,
        debugFile,
        ...options,
      },
    });
  } catch (err) {
    return { name, status: 'spawn_failed', elapsed_s: 0, error: err.message };
  }

  let firstMsgAt = null;
  let resultMsg = null;
  const msgKinds = {};

  const iter = (async () => {
    try {
      for await (const msg of q) {
        if (firstMsgAt === null) firstMsgAt = Date.now() - start;
        msgKinds[msg.type] = (msgKinds[msg.type] ?? 0) + 1;
        if (msg.type === 'result') {
          resultMsg = msg;
          break;
        }
      }
      return { status: 'ok' };
    } catch (err) {
      return { status: 'errored', error: err.message };
    }
  })();

  const outcome = await Promise.race([
    iter,
    new Promise((r) => setTimeout(() => r({ status: 'hung' }), PER_VARIANT_TIMEOUT_MS).unref()),
  ]);

  const elapsed_s = (Date.now() - start) / 1000;
  try {
    await q.return?.();
  } catch {}

  const result = {
    name,
    status: outcome.status,
    elapsed_s,
    first_msg_after_s: firstMsgAt ? firstMsgAt / 1000 : null,
    msg_kinds: msgKinds,
    has_result: !!resultMsg,
    error: outcome.error,
  };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

const results = [];
results.push(
  await runVariant('V1-baseline-judge', {
    systemPrompt: SYSTEM,
    tools: [],
    maxTurns: 1,
  }),
);
results.push(
  await runVariant('V2-array-system', {
    systemPrompt: [SYSTEM],
    tools: [],
    maxTurns: 1,
  }),
);
results.push(
  await runVariant('V3-maxturns-2', {
    systemPrompt: SYSTEM,
    tools: [],
    maxTurns: 2,
  }),
);
results.push(
  await runVariant('V4-empty-mcp', {
    systemPrompt: SYSTEM,
    tools: [],
    maxTurns: 1,
    mcpServers: {},
    allowedTools: [],
  }),
);
results.push(
  await runVariant('V5-explorer-shape', {
    systemPrompt: [SYSTEM],
    tools: [],
    maxTurns: 2,
    mcpServers: {},
    allowedTools: [],
  }),
);

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(20)} ${r.status.padEnd(10)} ${r.elapsed_s.toFixed(0)}s  first_msg=${r.first_msg_after_s ?? 'never'}s`,
  );
}
