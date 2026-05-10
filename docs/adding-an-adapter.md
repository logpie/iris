# Adding a TargetAdapter

To add support for a new target kind (CLI, API, desktop, etc.), implement the `TargetAdapter` interface from `@iris/adapter-types`.

## Steps

1. Create a new package under `packages/adapter-<kind>/`.
2. Add `@iris/adapter-types` as a workspace dependency.
3. Implement the `TargetAdapter` interface. Every method must be callable; throw clear errors for unsupported tools.
4. Define your tool list (`listTools()`) — these become Anthropic tool definitions seen by the Explorer.
5. Define your probe list (`listProbes()`) — deterministic non-LLM checks the Explorer can request.
6. Implement `observe()` — return a target-specific snapshot. Web returns DOM + screenshot ref; CLI returns stdout/stderr/cursor; etc.
7. Implement `sliceEvidence()` — given finding evidence refs, slice your run-recording into per-finding artifacts.
8. Add rubric profiles under `packages/rubrics/profiles/<kind>/` that apply to your target.
9. (Phase 4+) opt into the conformance suite from `@iris/adapter-types/conformance`.

## Trace events

All adapters write to the same `trace.jsonl`. The envelope is target-agnostic; the `payload` is target-specific. Use `target_kind: '<your-kind>'` so the Judge can interpret payloads.

## Rubric profiles

Each profile YAML declares `applies_to_targets`. Profiles with `applies_to_targets: [web]` won't be loaded for a CLI run.
