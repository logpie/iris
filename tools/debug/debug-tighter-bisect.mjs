#!/usr/bin/env node
// Tighter bisection + content vs size control.
// Tiny prompt (50 tokens) works. 30K hangs. Find threshold.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const TRACE_PATH = '/tmp/iris-p19c-tracker-defaults/trace.jsonl';
const OUT_DIR = '/tmp/iris-debug-tight';
const PER_VARIANT_TIMEOUT_MS = 2 * 60 * 1000;
mkdirSync(OUT_DIR, { recursive: true });

const events = await iristrace.readTraceArray(TRACE_PATH);
const traceDigest = judgeMod.buildTraceDigest(events);
console.log(`Full digest: ${traceDigest.length} chars`);

async function runTest(name, prompt) {
  const start = Date.now();
  console.log(`\n=== ${name} (${prompt.length}c) ===`);
  const q = query({
    prompt,
    options: {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a test responder. Briefly summarize what you received in ONE SENTENCE.',
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      settingSources: [],
      strictMcpConfig: true,
    },
  });
  let resultMsg = null;
  const msgCounts = {};
  const iter = (async () => {
    for await (const msg of q) {
      msgCounts[msg.type] = (msgCounts[msg.type] ?? 0) + 1;
      if (msg.type === 'result') {
        resultMsg = msg;
        break;
      }
    }
  })();
  const outcome = await Promise.race([
    iter.then(() => ({ status: 'ok' })).catch((e) => ({ status: 'errored', error: e.message })),
    new Promise((r) => setTimeout(() => r({ status: 'hung' }), PER_VARIANT_TIMEOUT_MS).unref()),
  ]);
  try { await q.return?.(); } catch {}
  const elapsed_s = (Date.now() - start) / 1000;
  const result = { name, prompt_chars: prompt.length, status: outcome.status, elapsed_s, msg_counts: msgCounts, has_result: !!resultMsg };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

// Size bisection with trace-digest content
const tests = [
  ['T1-1k-trace', traceDigest.slice(0, 1_000)],
  ['T2-3k-trace', traceDigest.slice(0, 3_000)],
  ['T3-10k-trace', traceDigest.slice(0, 10_000)],
  ['T4-20k-trace', traceDigest.slice(0, 20_000)],
  // Content control: same size as T4 but random text
  ['T5-20k-lorem', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(360)],
  // Repeat T4 to test consistency
  ['T6-20k-trace-rerun', traceDigest.slice(0, 20_000)],
];

const results = [];
for (const [name, p] of tests) {
  results.push(await runTest(name, p));
}

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`  ${r.name.padEnd(25)} ${r.prompt_chars.toString().padStart(7)}c  ${r.status.padEnd(10)} ${r.elapsed_s.toFixed(1)}s  ${JSON.stringify(r.msg_counts)}`);
}
