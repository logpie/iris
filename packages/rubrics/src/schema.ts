import { z } from 'zod';

export const RubricDimensionSchema = z.object({
  id: z.string().min(1),
  weight: z.number().nonnegative(),
  description: z.string().min(1),
  scoring_anchors: z.record(z.string()).optional(),
  evidence_required: z.string().optional(),
  common_signals: z
    .object({
      positive: z.array(z.string()).optional(),
      negative: z.array(z.string()).optional(),
    })
    .optional(),
});
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const RubricProfileSchema = z.object({
  name: z.string().min(1),
  applies_to_targets: z.array(z.enum(['web', 'cli', 'api', 'desktop'])).min(1),
  applies_to_modes: z.array(z.enum(['free', 'grounded', 'targeted'])).min(1),
  weight_in_overall: z.number().nonnegative(),
  dimensions: z.array(RubricDimensionSchema).min(1),
});
export type RubricProfile = z.infer<typeof RubricProfileSchema>;
