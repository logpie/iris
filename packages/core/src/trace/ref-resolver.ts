import type { TraceEvent } from './schema.js';

export function buildTraceIndexById(trace: TraceEvent[]): Map<string, number> {
  return new Map(trace.map((event, index) => [event.id, index]));
}

export function resolveTraceRefTypo(
  ref: string,
  trace: TraceEvent[],
  traceIndexById: Map<string, number> = buildTraceIndexById(trace),
  opts: { maxIdx?: number | undefined } = {},
): string | undefined {
  if (traceIndexById.has(ref)) return ref;
  if (!looksLikeTraceId(ref)) return undefined;
  const candidates = trace.filter((event, idx) => {
    if (opts.maxIdx !== undefined && idx > opts.maxIdx) return false;
    if (event.id.slice(0, 18) === ref.slice(0, 18) && Math.abs(event.id.length - ref.length) <= 2) {
      return true;
    }
    return event.id.slice(0, 6) === ref.slice(0, 6) && editDistanceAtMostOne(event.id, ref);
  });
  return candidates.length === 1 ? candidates[0]?.id : undefined;
}

function looksLikeTraceId(ref: string): boolean {
  return /^01[0-9A-HJKMNP-TV-Z]{20,28}$/i.test(ref);
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let mismatches = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) mismatches++;
      if (mismatches > 1) return false;
    }
    return true;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}
