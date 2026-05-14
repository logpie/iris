#!/usr/bin/env node
// Test whether the LARGE JUDGE_SYSTEM (28K chars) is the trigger.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { judge as judgeMod } from '@iris/core';

const OUT_DIR = '/tmp/iris-debug-sys';
const PER_VARIANT_TIMEOUT_MS = 2 * 60 * 1000;
mkdirSync(OUT_DIR, { recursive: true });

async function runTest(name, systemPrompt, userPrompt) {
  const start = Date.now();
  console.log(`\n=== ${name}  sys=${systemPrompt.length}c  user=${userPrompt.length}c ===`);
  const q = query({
    prompt: userPrompt,
    options: {
      model: 'claude-sonnet-4-6',
      systemPrompt,
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
  const result = { name, sys_chars: systemPrompt.length, user_chars: userPrompt.length, status: outcome.status, elapsed_s, msg_counts: msgCounts };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

const TINY_SYS = 'Briefly summarize the input in one sentence.';
const TINY_USER = 'The trace shows a user signing up and creating one issue.';
const JUDGE_SYS = judgeMod.JUDGE_SYSTEM;
// Same size as JUDGE_SYS but with lorem ipsum content
const LOREM_SYS = 'You are a test responder. Reply with one word. '
  + 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(500); // ~28K

const results = [];
// Establish baseline: tiny on both ends works
results.push(await runTest('S1-tiny-sys-tiny-user', TINY_SYS, TINY_USER));
// Big system prompt, tiny user: does JUDGE_SYSTEM alone trigger the hang?
results.push(await runTest('S2-judge-sys-tiny-user', JUDGE_SYS, TINY_USER));
// Same size system but lorem content: is it the SIZE or CONTENT of JUDGE_SYSTEM?
results.push(await runTest('S3-lorem-sys-tiny-user', LOREM_SYS, TINY_USER));

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`  ${r.name.padEnd(25)} sys=${r.sys_chars.toString().padStart(6)}  user=${r.user_chars.toString().padStart(6)}  ${r.status.padEnd(10)} ${r.elapsed_s.toFixed(1)}s  msgs=${JSON.stringify(r.msg_counts)}`);
}
