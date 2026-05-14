#!/usr/bin/env node
// Standalone repro for the Sonnet-as-Judge hang investigation.
// Self-contained: just the SDK + the existing trace file + a synthetic judge prompt.
//
// Each variant calls query() and records timing + result.
// We test the call-shape differences between the working Explorer call and the hung Judge call.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { trace as iristrace, judge as judgeMod } from '@iris/core';

// Use P19c's trace — that's the one Sonnet ACTUALLY hung on, so the inputs
// here are bit-for-bit what the real Judge call received.
const TRACE_PATH = '/tmp/iris-p19c-tracker-defaults/trace.jsonl';
const OUT_DIR = '/tmp/iris-debug-sonnet-judge';
const MODEL = 'claude-sonnet-4-6';
const PER_VARIANT_TIMEOUT_MS = 8 * 60 * 1000;

mkdirSync(OUT_DIR, { recursive: true });

const events = await iristrace.readTraceArray(TRACE_PATH);
const traceDigest = judgeMod.buildTraceDigest(events);
const tentativeFindings = events.filter((e) => e.kind === 'tentative_finding').length;
const userPromptFull = judgeMod.buildJudgeUserPrompt({
  trace_digest: traceDigest,
  rubric_profiles: [
    {
      name: 'usability',
      weight_in_overall: 1,
      dimensions: [{ id: 'clarity', weight: 1, anchors: { '0': 'unclear', '5': 'clear' } }],
    },
  ],
  tentative_findings_count: tentativeFindings,
});

console.log(
  `Loaded ${events.length} events; digest ${traceDigest.length} chars (~${Math.round(traceDigest.length / 4)} tok); userPrompt ${userPromptFull.length} chars`,
);

const SYSTEM = judgeMod.JUDGE_SYSTEM;
const userPromptTrimmed = `TRACE DIGEST (TRUNCATED FOR DEBUG):\n${traceDigest.slice(0, 40_000)}\n[truncated]\n\nReturn only the JSON object.`;

async function runVariant(name, options, userPrompt) {
  console.log(`\n=== variant: ${name} (prompt=${userPrompt.length}c) ===`);
  const debugFile = join(OUT_DIR, `${name}.debug.log`);
  const start = Date.now();
  let q;
  try {
    q = query({
      prompt: userPrompt,
      options: {
        ...options,
        model: MODEL,
        permissionMode: 'bypassPermissions',
        // Phase 19 fix: isolate from user's global Claude Code MCP servers.
        // This is THE bug. Without these, the SDK loads ~14 MCP servers from
        // ~/.claude/settings.json with 30s timeouts each on every spawn.
        settingSources: [],
        strictMcpConfig: true,
        debug: true,
        debugFile,
      },
    });
  } catch (err) {
    return {
      variant: name,
      status: 'spawn_failed',
      error: err.message,
      elapsed_s: (Date.now() - start) / 1000,
    };
  }

  let firstMsgAt = null;
  let totalMsgs = 0;
  let text = '';
  let resultMsg = null;
  const msgKinds = {};

  const iteratorPromise = (async () => {
    try {
      for await (const msg of q) {
        totalMsgs++;
        if (firstMsgAt === null) firstMsgAt = Date.now() - start;
        msgKinds[msg.type] = (msgKinds[msg.type] ?? 0) + 1;
        if (msg.type === 'assistant') {
          const c = msg.message?.content ?? [];
          for (const b of c) if (b.type === 'text' && b.text) text += b.text;
        } else if (msg.type === 'result') {
          resultMsg = msg;
          break;
        }
      }
    } catch (err) {
      return { status: 'errored', error: err.message };
    }
    return { status: 'ok' };
  })();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ status: 'hung' }), PER_VARIANT_TIMEOUT_MS).unref(),
  );

  const outcome = await Promise.race([iteratorPromise, timeoutPromise]);
  const elapsedS = (Date.now() - start) / 1000;

  try {
    await q.return?.();
  } catch {}

  const summary = {
    variant: name,
    status: outcome.status,
    elapsed_s: elapsedS,
    first_msg_after_s: firstMsgAt !== null ? firstMsgAt / 1000 : null,
    total_msgs: totalMsgs,
    msg_kinds: msgKinds,
    text_chars: text.length,
    has_result: resultMsg !== null,
    result_cost: resultMsg?.total_cost_usd,
    error: outcome.error,
    debug_file: debugFile,
  };
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT_DIR, `${name}.summary.json`), JSON.stringify(summary, null, 2));
  return summary;
}

// Run sequentially to avoid API rate noise.
// Tests one knob at a time so we can attribute any change.
const summaries = [];
summaries.push(
  await runVariant('1-baseline', { systemPrompt: SYSTEM, tools: [], maxTurns: 1 }, userPromptFull),
);
summaries.push(
  await runVariant('2-sysarray', { systemPrompt: [SYSTEM], tools: [], maxTurns: 1 }, userPromptFull),
);
summaries.push(
  await runVariant('3-maxturns2', { systemPrompt: SYSTEM, tools: [], maxTurns: 2 }, userPromptFull),
);
summaries.push(
  await runVariant('4-trimmed', { systemPrompt: SYSTEM, tools: [], maxTurns: 1 }, userPromptTrimmed),
);

writeFileSync(join(OUT_DIR, 'all-summaries.json'), JSON.stringify(summaries, null, 2));
console.log('\n=== ALL RESULTS ===');
for (const s of summaries) {
  console.log(
    `  ${s.variant.padEnd(15)} ${s.status.padEnd(10)} ${s.elapsed_s.toFixed(0)}s  msgs=${s.total_msgs}  text=${s.text_chars}c`,
  );
}
