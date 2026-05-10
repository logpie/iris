import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CassetteTransport } from './cassette.js';
import type { LlmCallInput, LlmRawResponse } from './client.js';

describe('CassetteTransport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-cassette-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('record mode calls real transport and writes cassette file', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'recorded'));
    const t = new CassetteTransport({ cassette_dir: dir, mode: 'record', real_transport: real });

    const r = await t.call({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(real).toHaveBeenCalledTimes(1);
    expect(r.content[0]).toEqual({ type: 'text', text: 'recorded' });
  });

  it('replay mode returns cassette without calling real transport', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'first'));

    // First, record one cassette
    const recorder = new CassetteTransport({ cassette_dir: dir, mode: 'record', real_transport: real });
    const input: LlmCallInput = {
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    };
    await recorder.call(input);

    // Now replay; real transport must NOT be called again
    const realB = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'WRONG'));
    const player = new CassetteTransport({ cassette_dir: dir, mode: 'replay', real_transport: realB });
    const r = await player.call(input);

    expect(realB).not.toHaveBeenCalled();
    expect(r.content[0]).toEqual({ type: 'text', text: 'first' });
  });

  it('replay mode throws helpful error when cassette is missing', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'x'));
    const player = new CassetteTransport({ cassette_dir: dir, mode: 'replay', real_transport: real });
    await expect(
      player.call({
        model: 'claude-sonnet-4-6',
        system: 'unrecorded',
        messages: [{ role: 'user', content: 'unrecorded' }],
      }),
    ).rejects.toThrow(/cassette not found/i);
    expect(real).not.toHaveBeenCalled();
  });

  it('hash is stable across volatile fields like extra whitespace in system', async () => {
    const real = vi.fn(async (input: LlmCallInput): Promise<LlmRawResponse> => fakeRsp(input.model, 'A'));
    const recorder = new CassetteTransport({ cassette_dir: dir, mode: 'record', real_transport: real });
    await recorder.call({
      model: 'claude-sonnet-4-6',
      system: 'hello   world',
      messages: [{ role: 'user', content: 'x' }],
    });

    const player = new CassetteTransport({ cassette_dir: dir, mode: 'replay', real_transport: real });
    // Same call but different incidental whitespace in system; should still hit cassette
    const r = await player.call({
      model: 'claude-sonnet-4-6',
      system: 'hello world',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(r.content[0]).toEqual({ type: 'text', text: 'A' });
  });
});

function fakeRsp(model: string, text: string): LlmRawResponse {
  return {
    id: `msg_${text}`,
    model,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
