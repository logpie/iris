import { spawn } from 'node:child_process';
import type { llm } from '@iris/core';

/**
 * LlmTransport that shells out to the Claude Code CLI (`claude -p ...`) so the local
 * subscription is used instead of an Anthropic API key.
 *
 * The Anthropic SDK's `messages.create` returns content blocks including `tool_use`.
 * `claude -p` returns a free-form text response. To bridge: we render system+messages+tools
 * as a single text prompt that asks the model to reply in a strict JSON envelope, and
 * we parse that envelope back into `content` blocks.
 *
 * Envelope shape we ask the model to produce:
 *   { "thinking": string, "tool_calls": [{"id": string, "name": string, "input": object}] }
 *
 * Limitations vs raw API:
 *   - One synchronous turn per call (no streaming)
 *   - Slower (`claude -p` adds wrapper overhead)
 *   - Token counts come from the wrapper, mapped to our LlmUsage shape
 *   - Image content blocks are unsupported in this transport (text + tool definitions only)
 */

const TOOL_USE_INSTRUCTIONS = `When calling tools, respond with a JSON object on its own (no surrounding prose) matching exactly:
{
  "thinking": "<one short sentence about what you're about to do>",
  "tool_calls": [
    { "id": "<short unique id>", "name": "<tool name from the list>", "input": { ... } }
  ]
}
Use as many tool_calls as needed in one turn (usually 1, occasionally 2-3). If you do not need any tool, return an empty tool_calls array. Do NOT wrap the JSON in markdown code fences.`;

interface ParsedEnvelope {
  thinking?: string;
  tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

function renderToolList(tools?: Array<Record<string, unknown>>): string {
  if (!tools || tools.length === 0) return '';
  const lines = tools.map((t) => {
    const schema = JSON.stringify(t.input_schema ?? {});
    return `- ${t.name}: ${t.description ?? ''}\n  input_schema: ${schema}`;
  });
  return `\n\nAvailable tools:\n${lines.join('\n')}\n\n${TOOL_USE_INSTRUCTIONS}`;
}

function renderMessages(messages: llm.LlmMessage[]): string {
  return messages
    .map((m) => {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => {
                const block = b as { type?: string; text?: string };
                if (block.type === 'text' && block.text) return block.text;
                return `[${block.type ?? 'unknown'}-block]`;
              })
              .join('\n');
      return `[${m.role}]\n${content}`;
    })
    .join('\n\n');
}

function renderSystem(system: llm.LlmCallInput['system']): string {
  if (typeof system === 'string') return system;
  return system
    .map((b) => {
      const block = b as { type?: string; text?: string };
      return block.type === 'text' && block.text ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function spawnClaudeCli(
  prompt: string,
  model?: string,
): Promise<{ result: string; cost_usd: number; usage_in: number; usage_out: number }> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (model && model !== 'claude-opus-4-7') {
      args.push('--model', model);
    }
    const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const wrapper = JSON.parse(stdout) as {
          result?: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          is_error?: boolean;
          subtype?: string;
        };
        if (wrapper.is_error) {
          reject(new Error(`claude -p returned is_error=true: ${stdout.slice(0, 500)}`));
          return;
        }
        resolve({
          result: wrapper.result ?? '',
          cost_usd: wrapper.total_cost_usd ?? 0,
          usage_in: wrapper.usage?.input_tokens ?? 0,
          usage_out: wrapper.usage?.output_tokens ?? 0,
        });
      } catch (err) {
        reject(
          new Error(
            `failed to parse claude -p output: ${(err as Error).message}\nstdout: ${stdout.slice(0, 300)}`,
          ),
        );
      }
    });
  });
}

function tryParseEnvelope(text: string): ParsedEnvelope | null {
  // Strip code fences if present
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) cleaned = fenceMatch[1].trim();
  // Find first '{' and try parse from there
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace < 0) return null;
  // Find matching closing brace by depth tracking
  let depth = 0;
  let end = -1;
  for (let i = firstBrace; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, end)) as ParsedEnvelope;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export const claudeCliTransport: llm.LlmTransport = async (input) => {
  const sysText = renderSystem(input.system);
  const msgText = renderMessages(input.messages);
  const toolText = renderToolList(input.tools);
  const fullPrompt = `${sysText}${toolText}\n\n--- CONVERSATION ---\n\n${msgText}`;

  const {
    result,
    cost_usd: _cost,
    usage_in,
    usage_out,
  } = await spawnClaudeCli(fullPrompt, input.model);

  // Build content blocks. If we asked for tool use, try to parse the JSON envelope.
  const content: Array<Record<string, unknown>> = [];
  const envelope = input.tools && input.tools.length > 0 ? tryParseEnvelope(result) : null;
  if (envelope) {
    if (envelope.thinking) content.push({ type: 'text', text: envelope.thinking });
    if (Array.isArray(envelope.tool_calls)) {
      for (const tc of envelope.tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
    }
  } else {
    // No tools (or parse failed) — return as plain text
    content.push({ type: 'text', text: result });
  }

  return {
    id: `cli_${Date.now()}`,
    model: input.model,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    content,
    usage: {
      input_tokens: usage_in,
      output_tokens: usage_out,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
};

export async function buildClaudeCliClient(): Promise<llm.LlmClient> {
  const core = await import('@iris/core');
  return new core.llm.LlmClient({ transport: claudeCliTransport });
}
