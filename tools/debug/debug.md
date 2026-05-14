# Sonnet Judge Hang — Debugging

## Symptom
Sonnet 4.6 used as Judge (`runAgentSdkSingleShot`) hangs reliably at 6-8 min: 0% CPU on
`claude` subprocess, no bytes streamed to stdout, subprocess alive but idle. SDK never
returns. Opus 4.7 with identical orchestrator path completes in ~5 min.

## Evidence audited
- **5/5 Sonnet judge hangs**: P18, P19, P19b, P19c, P19d — all hung at same signature
- **40+ Opus judge runs**: virtually all completed (one P18 transient hang, recovered)
- **Sonnet Explorer works fine**: thousands of multi-turn calls across all runs
- **First Sonnet hang (P18, 04:36) on fresh quota** — rules out rate-limit accumulation
- **P19e Opus succeeded on a LARGER merged trace** (113K-char lines) than P19d Sonnet
  (57K) — rules out "trace too big for Sonnet"

## Material differences: Judge call vs Explorer call (both Sonnet, only Judge hangs)
| Aspect | Judge (Sonnet hangs) | Explorer (Sonnet works) |
|---|---|---|
| `systemPrompt` | plain string | array `[static, BOUNDARY, dyn]` (cacheable split) |
| `mcpServers` | not set | `{ iris: irisToolServer }` |
| `allowedTools` | not set | full MCP tools list |
| `tools` | `[]` | `[]` |
| `maxTurns` | 1 | 500 (many turns actually used) |
| user prompt | ~140K tokens single block | ~few K per turn |
| permissionMode | bypassPermissions | bypassPermissions |

## Hypotheses (ranked by prior)

**H1 — Sonnet + huge user prompt + single-turn + no-tools triggers server-side issue**
Sonnet's inference path for this specific call shape may have a bug that doesn't
affect multi-turn-with-tools (Explorer) or different models (Opus).
*Test:* Call singleshot with Sonnet, same trace, but `maxTurns: 2`. If it works,
maxTurns=1 is the trigger.

**H2 — Plain-string systemPrompt triggers different SDK path that's Sonnet-incompatible**
Explorer uses `[string, BOUNDARY, '']` array form (enables prompt caching headers).
Judge uses plain string. The SDK may send different cache_control on requests, and
Sonnet's API may handle one path differently.
*Test:* Call singleshot with Sonnet, same trace, with `systemPrompt: [opts.systemPrompt]`
(array form, no boundary). If it works, the format is the trigger.

**H3 — SDK stream-json parser waits for events Sonnet doesn't emit in this mode**
Specifically when `tools: []` and `maxTurns: 1`, the SDK may expect a tool_use_result
or session_state_changed event that Sonnet skips because it has no tools.
*Test:* Enable SDK `debug: true` + `debugFile`, see what events arrive (or don't).

**H4 — Sonnet has a content-specific issue with this JUDGE_SYSTEM prompt or trace**
Some token sequence in the merged trace triggers a pathological generation path
on Sonnet but not Opus.
*Test:* Same trace, Sonnet, but trim the user prompt to first 50K tokens. If it
works, content size or specific content is the trigger.

## Ruled out
- **Rate limiting / API queueing** — first attempt on fresh quota also hung; Opus on same
  account in same hour succeeded
- **Content too big** — Opus handled bigger merged trace fine
- **High-effort thinking running long** — would still emit thinking chunks; we see ZERO
  stream bytes. The model hasn't generated anything yet.
- **maxTokens silently dropped** — true bug, but P17 worked with same bug

## Attempted "fixes" rejected
- ~~`effort: 'low'`~~ — would degrade quality and doesn't match the 0%-CPU signature
- ~~Default Judge to Opus~~ — workaround, not root cause

## Next experiment
Write standalone repro script that calls singleshot on existing P19e merged trace with
**only Sonnet model varying call-shape**. Test H1, H2 in same run since each takes ~5 min.
