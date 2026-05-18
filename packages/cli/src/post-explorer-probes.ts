import type { ProbeResult, TargetAdapter } from '@iris/adapter-types';
import { trace as iristrace } from '@iris/core';
import { ulid } from 'ulid';

type TraceWriter = InstanceType<typeof iristrace.TraceWriter>;

export interface PostExplorerProbeSpec {
  name: string;
  args: Record<string, unknown>;
}

export const POST_EXPLORER_PROBES: readonly PostExplorerProbeSpec[] = [
  { name: 'axe', args: {} },
  { name: 'console_errors_since', args: {} },
  { name: 'network_all_since', args: {} },
  { name: 'mobile_viewport', args: { width: 390, height: 844 } },
] as const;

export async function runMissingPostExplorerProbes(input: {
  adapter: TargetAdapter;
  traceWriter: TraceWriter;
  tracePath: string;
  log?: (message: string) => void;
  probes?: readonly PostExplorerProbeSpec[];
}): Promise<void> {
  const probes = input.probes ?? POST_EXPLORER_PROBES;
  const supported = new Set(input.adapter.listProbes().map((probe) => probe.name));
  const events = await iristrace.readTraceArray(input.tracePath);
  const lastExplorerPhaseMarker = findLastExplorerPhaseMarkerIndex(events);

  for (const probe of probes) {
    if (hasMatchingPostExplorerProbeResult(events, lastExplorerPhaseMarker, probe)) continue;
    if (!supported.has(probe.name)) {
      input.log?.(`iris: skipping unsupported post-Explorer probe ${probe.name}\n`);
      continue;
    }
    input.log?.(`iris: auto-running ${probe.name} (post-Explorer)\n`);
    const result = await input.adapter.runProbe(probe.name, probe.args).catch((err) => ({
      ok: false as const,
      probe: probe.name,
      error: err instanceof Error ? err.message : String(err),
    }));
    await appendProbeResult(input.traceWriter, result, probe.args);
  }
}

async function appendProbeResult(
  traceWriter: TraceWriter,
  result: ProbeResult,
  args: Record<string, unknown>,
): Promise<void> {
  await traceWriter.append({
    v: 1,
    id: ulid(),
    ts: Date.now() / 1000,
    step: 0,
    target_kind: 'web',
    kind: 'probe_result',
    actor: 'system',
    payload: result.ok
      ? { ...successfulProbePayload(result), phase: 'post-explorer', args }
      : { probe: result.probe, error: result.error, ok: false, phase: 'post-explorer', args },
  });
}

function findLastExplorerPhaseMarkerIndex(
  events: Awaited<ReturnType<typeof iristrace.readTraceArray>>,
): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event) continue;
    if (event.kind === 'probe_result' && isAutoPostExplorerProbePayload(event.payload)) continue;
    if (
      event.kind === 'action' ||
      event.kind === 'action_result' ||
      event.kind === 'probe_result'
    ) {
      return index;
    }
  }
  return -1;
}

function hasMatchingPostExplorerProbeResult(
  events: Awaited<ReturnType<typeof iristrace.readTraceArray>>,
  afterIndex: number,
  probe: PostExplorerProbeSpec,
): boolean {
  const expectedArgs = stableJson(probe.args);
  return events.slice(afterIndex + 1).some((event) => {
    if (event.kind !== 'probe_result') return false;
    const payload = event.payload as Record<string, unknown>;
    return (
      payload.probe === probe.name &&
      payload.ok === true &&
      payload.phase === 'post-explorer' &&
      stableJson(plainObject(payload.args) ? payload.args : {}) === expectedArgs
    );
  });
}

function isAutoPostExplorerProbePayload(payload: Record<string, unknown>): boolean {
  return payload.phase === 'post-explorer';
}

function successfulProbePayload(
  result: Extract<ProbeResult, { ok: true }>,
): Record<string, unknown> {
  const viewport = viewportFromValue(result.summary) ?? viewportFromValue(result.data);
  return {
    probe: result.probe,
    summary: result.summary,
    data: result.data,
    ok: true,
    ...(viewport ? { viewport } : {}),
  };
}

function viewportFromValue(value: unknown): { width: number; height?: number } | undefined {
  if (!plainObject(value)) return undefined;
  const raw = plainObject(value.viewport) ? value.viewport : undefined;
  if (!raw) return undefined;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width)) return undefined;
  return { width, ...(Number.isFinite(height) ? { height } : {}) };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
