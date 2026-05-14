#!/usr/bin/env node
// Test JUDGE_SYSTEM WITHOUT the 15.6K-char SKILL_PREFIX.
// If shorter system fixes the cliff, total-tokens-on-Sonnet was the cause.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const events = await iristrace.readTraceArray('/tmp/iris-p19c-tracker-defaults/trace.jsonl');
const digest = judgeMod.buildTraceDigest(events);

// Strip the SKILL_PREFIX from JUDGE_SYSTEM
const fullSys = judgeMod.JUDGE_SYSTEM;
const idx = fullSys.indexOf('You are Iris');
const slimSys = fullSys.slice(idx);
console.log(`slimSys ${slimSys.length}c (was ${fullSys.length}c)`);

async function run(name, user) {
  console.log(`\n=== ${name}  sys=${slimSys.length}c  user=${user.length}c ===`);
  const start = Date.now();
  const q = query({
    prompt: user,
    options: {
      model: 'claude-sonnet-4-6',
      systemPrompt: slimSys,
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      settingSources: [],
      strictMcpConfig: true,
    },
  });
  const HARD = 5 * 60 * 1000;
  const counts = {};
  let result;
  const iter = (async () => {
    for await (const msg of q) {
      counts[msg.type] = (counts[msg.type] ?? 0) + 1;
      if (msg.type === 'result') { result = msg; break; }
    }
  })();
  const outcome = await Promise.race([
    iter.then(() => 'ok').catch((e) => 'err:' + e.message),
    new Promise((r) => setTimeout(() => r('hung'), HARD).unref()),
  ]);
  try { await q.return?.(); } catch {}
  console.log(`  result: ${outcome} in ${((Date.now() - start) / 1000).toFixed(1)}s  counts=${JSON.stringify(counts)}  cost=${result?.total_cost_usd}`);
  return { name, outcome, elapsed_s: (Date.now() - start) / 1000, counts, has_result: !!result };
}

const tests = [
  ['N1-20k', digest.slice(0, 20_000)],
  ['N2-30k', digest.slice(0, 30_000)],
  ['N3-full', digest],
];

for (const [n, u] of tests) await run(n, u);
