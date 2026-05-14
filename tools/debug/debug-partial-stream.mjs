#!/usr/bin/env node
// Capture EVERY partial-stream event so we can see what Sonnet is actually doing
// during the "hang". If it's circular/repeating output, we'll see it in the deltas.
//
// `includePartialMessages: true` makes the SDK forward stream_event chunks
// (content_block_start, content_block_delta, content_block_stop, etc.) so we
// see streaming behavior, not just the final aggregated assistant messages.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const OUT_DIR = '/tmp/iris-debug-partial';
mkdirSync(OUT_DIR, { recursive: true });

const events = await iristrace.readTraceArray('/tmp/iris-p19c-tracker-defaults/trace.jsonl');
const digest = judgeMod.buildTraceDigest(events);
const userPrompt = digest.slice(0, 30_000); // 30K — previously got 1 assistant chunk

const start = Date.now();
const debugFile = join(OUT_DIR, 'sdk.debug.log');
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
    includePartialMessages: true, // KEY: get content_block_delta events
    debug: true,
    debugFile,
  },
});

const events_log = [];
const HARD_CAP_MS = 6 * 60 * 1000;
let resultMsg = null;

const iter = (async () => {
  for await (const msg of q) {
    const at_s = ((Date.now() - start) / 1000).toFixed(2);
    // Capture ALL messages — including partials
    let snippet;
    if (msg.type === 'stream_event' || msg.type === 'content_block_delta') {
      // partial-stream event: log content + type
      const ev = msg.event ?? msg;
      snippet = JSON.stringify(ev).slice(0, 400);
    } else {
      snippet = JSON.stringify(msg).slice(0, 400);
    }
    events_log.push({ at_s: parseFloat(at_s), type: msg.type, snippet });
    if (events_log.length <= 200 || events_log.length % 50 === 0) {
      console.log(`[${at_s}s] ${msg.type}: ${snippet.slice(0, 200)}`);
    }
    if (msg.type === 'result') {
      resultMsg = msg;
      break;
    }
  }
})();

const outcome = await Promise.race([
  iter.then(() => 'ok').catch((e) => 'err:' + e.message),
  new Promise((r) => setTimeout(() => r('hung'), HARD_CAP_MS).unref()),
]);
try { await q.return?.(); } catch {}

const elapsed_s = (Date.now() - start) / 1000;
writeFileSync(join(OUT_DIR, 'events.json'), JSON.stringify(events_log, null, 2));
console.log(`\n=== RESULT ===`);
console.log(`outcome: ${outcome}, elapsed ${elapsed_s.toFixed(1)}s, events captured: ${events_log.length}, has_result: ${!!resultMsg}`);

// Analyze for repetition
const deltaTexts = events_log
  .filter((e) => e.type === 'stream_event')
  .map((e) => {
    try {
      const ev = JSON.parse(e.snippet);
      return ev.delta?.text ?? '';
    } catch {
      return '';
    }
  })
  .filter((t) => t);
if (deltaTexts.length > 0) {
  const total = deltaTexts.join('');
  console.log(`Total streamed text length: ${total.length} chars`);
  console.log(`First 500 chars: ${total.slice(0, 500)}`);
  console.log(`Last 500 chars: ${total.slice(-500)}`);
}
