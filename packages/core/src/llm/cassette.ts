import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmCallInput, LlmRawResponse, LlmTransport } from './client.js';

export type CassetteMode = 'record' | 'replay';

export interface CassetteOptions {
  cassette_dir: string;
  mode: CassetteMode;
  real_transport: LlmTransport;
}

export class CassetteTransport {
  constructor(private readonly opts: CassetteOptions) {
    if (!existsSync(opts.cassette_dir)) {
      mkdirSync(opts.cassette_dir, { recursive: true });
    }
  }

  call: LlmTransport = async (input: LlmCallInput): Promise<LlmRawResponse> => {
    const hash = hashInput(input);
    const path = join(this.opts.cassette_dir, `${hash}.json`);

    if (this.opts.mode === 'replay') {
      if (!existsSync(path)) {
        throw new Error(
          `cassette not found: ${path}\nIf this is a new LLM call, re-record cassettes with IRIS_RERECORD_CASSETTES=1`,
        );
      }
      return JSON.parse(readFileSync(path, 'utf8')) as LlmRawResponse;
    }

    // record
    const response = await this.opts.real_transport(input);
    writeFileSync(path, `${JSON.stringify(response, null, 2)}\n`);
    return response;
  };
}

function hashInput(input: LlmCallInput): string {
  const normalized = {
    model: input.model,
    system: normalizeText(input.system),
    messages: input.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? normalizeText(m.content) : m.content,
    })),
    tools: input.tools ?? [],
  };
  const json = JSON.stringify(normalized);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function normalizeText(
  s: string | Array<Record<string, unknown>>,
): string | Array<Record<string, unknown>> {
  if (typeof s !== 'string') return s;
  return s.replace(/\s+/g, ' ').trim();
}
