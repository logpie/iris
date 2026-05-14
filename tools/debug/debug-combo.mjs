#!/usr/bin/env node
// Test JUDGE_SYSTEM + increasing user-prompt sizes.
// JUDGE_SYS alone took 12s. Does adding user content cause super-linear slowdown?

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const TRACE_PATH = '/tmp/iris-p19c-tracker-defaults/trace.jsonl';
const OUT_DIR = '/tmp/iris-debug-combo';
const PER_VARIANT_TIMEOUT_MS = 3 * 60 * 1000;
mkdirSync(OUT_DIR, { recursive: true });

const events = await iristrace.readTraceArray(TRACE_PATH);
const traceDigest = judgeMod.buildTraceDigest(events);
const JUDGE_SYS = judgeMod.JUDGE_SYSTEM;

async function runTest(name, userPrompt) {
  const start = Date.now();
  console.log(`\n=== ${name}  user=${userPrompt.length}c ===`);
  const q = query({
    prompt: userPrompt,
    options: {
      model: 'claude-sonnet-4-6',
      systemPrompt: JUDGE_SYS,
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      settingSources: [],
      strictMcpConfig: true,
    },
  });
  const msgCounts = {};
  let resultMsg = null;
  const iter = (async () => {
    for await (const msg of q) {
      msgCounts[msg.type] = (msgCounts[msg.type] ?? 0) + 1;
      if (msg.type === 'result') { resultMsg = msg; break; }
    }
  })();
  const outcome = await Promise.race([
    iter.then(() => ({ status: 'ok' })).catch((e) => ({ status: 'errored', error: e.message })),
    new Promise((r) => setTimeout(() => r({ status: 'hung' }), PER_VARIANT_TIMEOUT_MS).unref()),
  ]);
  try { await q.return?.(); } catch {}
  const elapsed_s = (Date.now() - start) / 1000;
  const result = { name, user_chars: userPrompt.length, status: outcome.status, elapsed_s, msg_counts: msgCounts };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

const results = [];
results.push(await runTest('C1-tiny-user', 'Briefly classify this app.'));
results.push(await runTest('C2-5k-user', traceDigest.slice(0, 5_000)));
results.push(await runTest('C3-10k-user', traceDigest.slice(0, 10_000)));
results.push(await runTest('C4-20k-user', traceDigest.slice(0, 20_000)));
results.push(await runTest('C5-30k-user', traceDigest.slice(0, 30_000)));

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`  ${r.name.padEnd(22)} user=${r.user_chars.toString().padStart(6)}c  ${r.status.padEnd(10)} ${r.elapsed_s.toFixed(1)}s  msgs=${JSON.stringify(r.msg_counts)}`);
}
