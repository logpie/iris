import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '@iris/adapter-types';
import type { llm } from '@iris/core';
import type { Page } from 'playwright';

export async function screenshot(
  page: Page,
  args: { out_dir: string; name: string; full_page?: boolean },
): Promise<ToolResult> {
  try {
    mkdirSync(args.out_dir, { recursive: true });
    const path = join(args.out_dir, `${args.name}.png`);
    await page.screenshot({ path, fullPage: args.full_page ?? false });
    return { ok: true, evidence_refs: [path] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionClick(
  page: Page,
  args: { x: number; y: number; reason?: string },
): Promise<ToolResult> {
  try {
    await page.mouse.click(args.x, args.y);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export interface VisionDescribeOptions {
  out_dir: string;
  name: string;
  llm_client?: llm.LlmClient;
  // Phase 8: optional transport-agnostic callback. When set, used in
  // preference to llm_client. Enables vision in the Agent SDK transport
  // where no LlmClient exists.
  describer?: (input: {
    imagePath: string;
    prompt: string;
    model?: string;
  }) => Promise<{ text: string }>;
  model?: string;
  region?: string;
}

const VISION_DESCRIBE_PROMPT =
  'Describe what is on this screen. Focus on: layout (sections, columns), the primary CTA, anything visually broken or confusing (overlapping elements, illegible text, missing focus indicators, weird empty states). Be concise — 3-5 sentences.';

/**
 * Take a screenshot, send to Claude with an image content block, return the description.
 * If no llm_client is provided, returns ok=false with a clear message.
 */
export async function visionDescribe(
  page: Page,
  args: VisionDescribeOptions,
): Promise<ToolResult & { description?: string }> {
  if (!args.llm_client && !args.describer) {
    return {
      ok: false,
      error:
        'vision_describe requires an LlmClient or describer callback — configure WebTargetAdapterOptions',
    };
  }
  try {
    mkdirSync(args.out_dir, { recursive: true });
    const path = join(args.out_dir, `${args.name}.png`);
    await page.screenshot({ path, fullPage: false });

    const promptText = args.region
      ? `Focus on this region: ${args.region}`
      : 'Describe this screen.';

    // Phase 8: prefer the describer callback (works with SDK transport).
    if (args.describer) {
      const r = await args.describer({
        imagePath: path,
        prompt: `${VISION_DESCRIBE_PROMPT}\n\n${promptText}`,
        ...(args.model ? { model: args.model } : {}),
      });
      return { ok: true, evidence_refs: [path], description: r.text };
    }

    // Legacy LlmClient path for api/cli transports.
    const imageBytes = readFileSync(path);
    const base64 = imageBytes.toString('base64');
    const r = await args.llm_client!.call({
      model: args.model ?? 'claude-sonnet-4-6',
      system: VISION_DESCRIBE_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: base64 },
            },
            { type: 'text', text: promptText },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0,
    });
    return { ok: true, evidence_refs: [path], description: r.text };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
}
