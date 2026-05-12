// Phase 10: discovery pass. Runs after preflight, before Explorer. Takes the
// landed page (URL + observation + screenshot) and asks an LLM to play the
// role of a new user proposing what to try. Returns a spec-shaped object
// that downstream code already knows how to consume.

import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import { DISCOVERY_SYSTEM, DISCOVERY_USER_TEMPLATE } from './prompts.js';

export const DiscoveryGoalSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['must', 'should']),
});
export type DiscoveryGoal = z.infer<typeof DiscoveryGoalSchema>;

export const DiscoveryOutputSchema = z.object({
  v: z.literal(1),
  target_kind_hint: z.enum(['web', 'cli', 'api', 'desktop']).default('web'),
  product_description: z.string().default(''),
  goals: z.array(DiscoveryGoalSchema),
  focus_areas: z.array(z.string()).default([]),
  hints: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
});
export type DiscoveryOutput = z.infer<typeof DiscoveryOutputSchema>;

// Discoverer callback — transport-agnostic, mirrors VisionDescriber from
// adapter-web. Allows SDK transport (subscription, no API key) to plug a
// vision-capable callback instead of constructing an LlmClient.
export type Discoverer = (input: {
  systemPrompt: string;
  userPrompt: string;
  imagePath: string;
  model?: string;
}) => Promise<{ text: string; cost_usd: number }>;

export interface DiscoveryRunInputs {
  url: string;
  observation_summary: string;
  screenshot_path: string;
  // One of these must be provided. `discoverer` is used when set; falls back
  // to `client` otherwise (the api/cli transport path).
  discoverer?: Discoverer;
  client?: LlmClient;
  model?: string;
}

export interface DiscoveryRunResult {
  output: DiscoveryOutput;
  cost_usd: number;
}

/**
 * Run discovery. On parse failure returns null so the caller can fall back to
 * free mode without aborting the whole run.
 */
export async function runDiscovery(inputs: DiscoveryRunInputs): Promise<DiscoveryRunResult | null> {
  const userPrompt = DISCOVERY_USER_TEMPLATE({
    url: inputs.url,
    observation_summary: inputs.observation_summary,
  });
  let text = '';
  let cost = 0;
  if (inputs.discoverer) {
    const r = await inputs.discoverer({
      systemPrompt: DISCOVERY_SYSTEM,
      userPrompt,
      imagePath: inputs.screenshot_path,
      ...(inputs.model ? { model: inputs.model } : {}),
    });
    text = r.text;
    cost = r.cost_usd;
  } else if (inputs.client) {
    // The legacy LlmClient path. Caller is responsible for reading the
    // screenshot and including it as an image content block; we don't have a
    // direct ergonomic for that here. For now, send the prompt text only — the
    // SDK transport (which always uses `discoverer`) is the primary path.
    const r = await inputs.client.call({
      model: inputs.model ?? 'claude-sonnet-4-6',
      system: DISCOVERY_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 2000,
      temperature: 0,
    });
    text = r.text;
    cost = 0;
  } else {
    throw new Error('runDiscovery requires either `discoverer` or `client`');
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const out = DiscoveryOutputSchema.parse(parsed);
    return { output: out, cost_usd: cost };
  } catch {
    return null;
  }
}
