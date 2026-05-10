import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { type TraceEvent, TraceEventSchema } from './schema.js';

export type TraceItem =
  | { kind: 'event'; event: TraceEvent; line_number: number }
  | { kind: 'malformed'; raw: string; line_number: number; error: string };

export async function* readTrace(path: string): AsyncGenerator<TraceItem> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      const event = TraceEventSchema.parse(parsed);
      yield { kind: 'event', event, line_number: lineNo };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { kind: 'malformed', raw: trimmed, line_number: lineNo, error: message };
    }
  }
}

export async function readTraceArray(path: string): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  for await (const item of readTrace(path)) {
    if (item.kind === 'event') out.push(item.event);
  }
  return out;
}
