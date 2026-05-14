#!/usr/bin/env node
// Head-to-head: SAME prompt, SAME function, two models in sequence.
// Diagnostic: does Opus succeed in this script (matching P19e success)?
//
// - Opus succeeds, Sonnet hangs → bug is model+prompt specific at Anthropic side
// - Both succeed             → my prior debug-sonnet-judge.mjs was broken somehow
// - Both hang                → something about standalone script differs from production
// - Opus hangs, Sonnet OK    → impossible per audit data
//
// Uses the PRODUCTION runAgentSdkSingleShot (so we get the settingSources:[] fix).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { trace as iristrace, judge as judgeMod } from '@iris/core';
import { runAgentSdkSingleShot } from './dist/chunk-BCOG6DXK.js';

const TRACE_PATH = '/tmp/iris-p19c-tracker-defaults/trace.jsonl';
const OUT_DIR = '/tmp/iris-debug-head2head';
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
console.log(`Trace ${events.length} events, digest ${traceDigest.length}c, userPrompt ${userPrompt.length}c`);

async function tryModel(model) {
  const start = Date.now();
  const HARD_TIMEOUT_MS = 7 * 60 * 1000;
  let outcome;
  try {
    outcome = await Promise.race([
      runAgentSdkSingleShot({
        systemPrompt: judgeMod.JUDGE_SYSTEM,
        userPrompt,
        model,
      }).then((r) => ({ status: 'ok', text_chars: r.text.length, cost: r.cost_usd, usage: r.usage })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: 'hung' }), HARD_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (err) {
    outcome = { status: 'errored', error: err.message };
  }
  const elapsed_s = (Date.now() - start) / 1000;
  return { model, elapsed_s, ...outcome };
}

console.log('\n=== Sonnet 4.6 ===');
const sonnet = await tryModel('claude-sonnet-4-6');
console.log(JSON.stringify(sonnet, null, 2));
writeFileSync(join(OUT_DIR, 'sonnet.json'), JSON.stringify(sonnet, null, 2));

console.log('\n=== Opus 4.7 ===');
const opus = await tryModel('claude-opus-4-7');
console.log(JSON.stringify(opus, null, 2));
writeFileSync(join(OUT_DIR, 'opus.json'), JSON.stringify(opus, null, 2));

console.log('\n=== SUMMARY ===');
console.log(`Sonnet: ${sonnet.status} in ${sonnet.elapsed_s.toFixed(0)}s`);
console.log(`Opus:   ${opus.status} in ${opus.elapsed_s.toFixed(0)}s`);
