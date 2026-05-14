#!/usr/bin/env node
// Focused test based on Codex's review:
//   1. Capture FULL content of rate_limit_event (what limit was hit)
//   2. Prompt-size bisection: 30K, 60K, 90K, 120K chars
//   3. Test thinking:disabled at the full prompt size
//
// Hypothesis: Sonnet hits an ITPM rate limit on the 140K-token Judge call.
// API streams rate_limit_event then queues request indefinitely.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

const TRACE_PATH = '/tmp/iris-p19c-tracker-defaults/trace.jsonl';
const OUT_DIR = '/tmp/iris-debug-bisect';
const MODEL = 'claude-sonnet-4-6';
const PER_VARIANT_TIMEOUT_MS = 3 * 60 * 1000; // 3 min — these should EITHER succeed quick OR hang
mkdirSync(OUT_DIR, { recursive: true });

const events = await iristrace.readTraceArray(TRACE_PATH);
const traceDigest = judgeMod.buildTraceDigest(events);
const tentativeFindings = events.filter((e) => e.kind === 'tentative_finding').length;

function buildPrompt(digestSlice) {
  return judgeMod.buildJudgeUserPrompt({
    trace_digest: digestSlice,
    rubric_profiles: [
      {
        name: 'usability',
        weight_in_overall: 1,
        dimensions: [{ id: 'clarity', weight: 1, anchors: { '0': 'unclear', '5': 'clear' } }],
      },
    ],
    tentative_findings_count: tentativeFindings,
  });
}

console.log(`Trace ${events.length} ev, full digest ${traceDigest.length}c`);

async function runVariant(name, options, userPrompt, captureContent) {
  console.log(`\n=== ${name} (prompt=${userPrompt.length}c) ===`);
  const start = Date.now();
  const debugFile = join(OUT_DIR, `${name}.debug.log`);
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
    return { name, status: 'spawn_failed', error: err.message };
  }

  const capturedMsgs = [];
  let resultMsg = null;
  let firstMsgAt = null;

  const iter = (async () => {
    try {
      for await (const msg of q) {
        if (firstMsgAt === null) firstMsgAt = (Date.now() - start) / 1000;
        if (captureContent || msg.type === 'rate_limit_event' || msg.type === 'system') {
          // Truncate big assistant content but log anything that looks important
          const snippet = JSON.stringify(msg).slice(0, 1500);
          capturedMsgs.push({ at_s: (Date.now() - start) / 1000, type: msg.type, snippet });
        }
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

  try {
    await q.return?.();
  } catch {}

  const result = {
    name,
    status: outcome.status,
    elapsed_s: (Date.now() - start) / 1000,
    first_msg_after_s: firstMsgAt,
    captured_msgs: capturedMsgs,
    has_result: !!resultMsg,
    result_cost_usd: resultMsg?.total_cost_usd,
    result_usage: resultMsg?.usage,
    error: outcome.error,
  };
  console.log(JSON.stringify({ name, status: result.status, elapsed_s: result.elapsed_s, msgs: capturedMsgs.length }, null, 2));
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

// 1. Confirm baseline hangs AND capture the rate_limit_event content
// 2. Prompt-size bisection
// 3. Same baseline but with thinking:disabled (per Codex)
const SYSTEM = judgeMod.JUDGE_SYSTEM;
const sizes = [
  { name: 'A-30k', digest: traceDigest.slice(0, 30_000) },
  { name: 'B-60k', digest: traceDigest.slice(0, 60_000) },
  { name: 'C-90k', digest: traceDigest.slice(0, 90_000) },
  { name: 'D-full', digest: traceDigest },
];

const results = [];
for (const { name, digest } of sizes) {
  results.push(
    await runVariant(
      name,
      { systemPrompt: SYSTEM, tools: [], maxTurns: 1 },
      buildPrompt(digest),
      true, // capture content for all messages
    ),
  );
}

// Codex's top suggestion: full prompt + thinking disabled
results.push(
  await runVariant(
    'E-full-no-thinking',
    {
      systemPrompt: SYSTEM,
      tools: [],
      maxTurns: 1,
      thinkingConfig: { type: 'disabled' },
    },
    buildPrompt(traceDigest),
    true,
  ),
);

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`  ${r.name.padEnd(22)} ${r.status.padEnd(10)} ${r.elapsed_s.toFixed(0)}s  msgs=${r.captured_msgs?.length ?? 0}  result=${r.has_result}`);
}
