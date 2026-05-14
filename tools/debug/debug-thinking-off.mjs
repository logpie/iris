#!/usr/bin/env node
// Decisive test: JUDGE_SYS + 20K user, thinking disabled. 5-min cap.
// If <10s: thinking is the trigger; disabling rescues.
// If 100-300s: thinking is a factor but not sole driver.
// If hung: thinking isn't the cause.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const events = await iristrace.readTraceArray('/tmp/iris-p19c-tracker-defaults/trace.jsonl');
const digest = judgeMod.buildTraceDigest(events);
const userPrompt = digest.slice(0, 20_000);

const start = Date.now();
const q = query({
  prompt: userPrompt,
  options: {
    model: 'claude-sonnet-4-6',
    systemPrompt: judgeMod.JUDGE_SYSTEM,
    tools: [],
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    settingSources: [],
    strictMcpConfig: true,
    thinkingConfig: { type: 'disabled' },
  },
});

const HARD_CAP_MS = 5 * 60 * 1000;
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
  iter.then(() => 'ok').catch((e) => 'errored:' + e.message),
  new Promise((r) => setTimeout(() => r('hung'), HARD_CAP_MS).unref()),
]);
try { await q.return?.(); } catch {}
const elapsed_s = (Date.now() - start) / 1000;
console.log(JSON.stringify({ outcome, elapsed_s, msgCounts, result: !!resultMsg, cost: resultMsg?.total_cost_usd }, null, 2));
