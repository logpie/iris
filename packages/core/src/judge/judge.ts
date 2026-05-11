import type { RubricProfile } from '@iris/rubrics';
import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import { readTraceArray } from '../trace/reader.js';
import { JUDGE_SYSTEM, buildJudgeUserPrompt, buildTraceDigest } from './prompts.js';

export const JudgeFindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion']),
  severity: z.enum(['blocker', 'major', 'minor', 'nit', 'suggestion']),
  evidence: z.array(z.string()),
  where: z.object({ url: z.string().optional(), selector: z.string().optional() }).optional(),
  rationale: z.string(),
  suggested_fix: z.object({ type: z.string(), summary: z.string() }).optional(),
  // Phase 5 additions, set by validator/identity stages (not the Judge LLM).
  unverified_backing: z.boolean().optional(),
  finding_hash: z.string().optional(),
});
export type JudgeFinding = z.infer<typeof JudgeFindingSchema>;

export const JudgeOutputSchema = z.object({
  v: z.literal(1),
  findings: z.array(JudgeFindingSchema),
  discarded_findings: z
    .array(z.object({ tentative_event_id: z.string(), reason: z.string() }))
    .default([]),
  scores: z.object({
    overall: z.object({ score: z.number(), weighted_from: z.array(z.string()) }),
    profiles: z.record(
      z.object({
        score: z.number(),
        dimensions: z.record(
          z.object({
            score: z.number(),
            rationale: z.string(),
            evidence: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
  spec_compliance: z.object({
    applicable: z.boolean(),
    goals: z
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          // Phase 5: extended enum. Old values map forward:
          //   satisfied → verified
          //   not_satisfied → blocked (when evidence cited) or untested (when only budget_abort)
          // The Judge prompt is updated to emit the new values directly.
          status: z.enum([
            'verified',
            'partial',
            'blocked',
            'skipped',
            'untested',
            // Legacy — Judge may still emit during the transition.
            'satisfied',
            'not_satisfied',
          ]),
          evidence: z.array(z.string()),
          notes: z.string().optional(),
        }),
      )
      .default([]),
    summary: z.string(),
  }),
  coverage_review: z.object({
    surfaces_explored: z.number(),
    surfaces_unexplored: z.number(),
    judgement: z.string(),
  }),
  meta: z.object({
    confidence_overall: z.number(),
    confidence_caveats: z.array(z.string()).default([]),
    would_re_explore_with: z.array(z.string()).default([]),
  }),
  // Phase 5: populated by the post-Judge evidence validator. Optional so the
  // schema accepts both v1 raw Judge output and v2 post-validation reports.
  evidence_validation: z
    .object({
      verified: z.number().int().nonnegative(),
      downgraded: z.number().int().nonnegative(),
      discarded: z.number().int().nonnegative(),
    })
    .optional(),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface JudgeRunInputs {
  trace_path: string;
  spec_text?: string;
  spec_goals?: Array<{ id: string; description: string; priority: string }>;
  rubric_profiles: RubricProfile[];
  model?: string;
}

export class Judge {
  constructor(private readonly llmClient: LlmClient) {}

  async run(inputs: JudgeRunInputs): Promise<JudgeOutput> {
    const events = await readTraceArray(inputs.trace_path);
    const tentativeCount = events.filter((e) => e.kind === 'tentative_finding').length;
    const digest = buildTraceDigest(events);
    const userPrompt = buildJudgeUserPrompt({
      trace_digest: digest,
      ...(inputs.spec_text !== undefined ? { spec_text: inputs.spec_text } : {}),
      ...(inputs.spec_goals !== undefined ? { spec_goals: inputs.spec_goals } : {}),
      rubric_profiles: inputs.rubric_profiles,
      tentative_findings_count: tentativeCount,
    });

    const response = await this.llmClient.call({
      model: inputs.model ?? 'claude-opus-4-7',
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 8000,
      temperature: 0,
    });

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      throw new Error(`Judge returned no JSON object:\n${response.text.slice(0, 500)}`);
    const parsed = JSON.parse(jsonMatch[0]);
    return JudgeOutputSchema.parse(parsed);
  }
}
