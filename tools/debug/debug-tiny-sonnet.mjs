#!/usr/bin/env node
// Smallest possible Sonnet single-shot call. If THIS hangs, it's not prompt size.
// If it succeeds in seconds, we know the size-OR-content of the Judge prompt is the trigger.

import { query } from '@anthropic-ai/claude-agent-sdk';

const start = Date.now();
const q = query({
  prompt: 'Reply with the single word "ping".',
  options: {
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a test bot. Reply with one word.',
    tools: [],
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    settingSources: [],
    strictMcpConfig: true,
    debug: true,
    debugFile: '/tmp/iris-tiny-sonnet.debug.log',
  },
});

const msgs = [];
let resultMsg = null;
try {
  for await (const msg of q) {
    msgs.push({ at_s: (Date.now() - start) / 1000, type: msg.type, snippet: JSON.stringify(msg).slice(0, 300) });
    if (msg.type === 'result') {
      resultMsg = msg;
      break;
    }
  }
} catch (err) {
  console.log('errored:', err.message);
}
try { await q.return?.(); } catch {}

console.log('\n=== TINY SONNET RESULT ===');
console.log(`elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
console.log(`result: ${resultMsg ? 'YES' : 'NO'}`);
console.log(`messages received: ${msgs.length}`);
for (const m of msgs) console.log(`  at ${m.at_s.toFixed(1)}s  ${m.type}  ${m.snippet}`);
