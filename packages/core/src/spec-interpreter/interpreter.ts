import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import { SPEC_INTERPRETER_SYSTEM, SPEC_INTERPRETER_USER_TEMPLATE } from './prompts.js';

export const InterpretedSpecSchema = z.object({
  v: z.literal(1),
  target_kind_hint: z.enum(['web', 'cli', 'api', 'desktop']),
  goals: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      priority: z.enum(['must', 'should']),
    }),
  ),
  focus_areas: z.array(z.string()).default([]),
  hints: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
});
export type InterpretedSpec = z.infer<typeof InterpretedSpecSchema>;

export async function interpretSpec(
  spec: string,
  client: LlmClient,
  model = 'claude-sonnet-4-6',
): Promise<InterpretedSpec> {
  const r = await client.call({
    model,
    system: SPEC_INTERPRETER_SYSTEM,
    messages: [{ role: 'user', content: SPEC_INTERPRETER_USER_TEMPLATE(spec) }],
    max_tokens: 2000,
    temperature: 0,
  });
  const jsonMatch = r.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`spec interpreter returned no JSON object:\n${r.text}`);
  const parsed = JSON.parse(jsonMatch[0]);
  return InterpretedSpecSchema.parse(parsed);
}
