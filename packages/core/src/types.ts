import { z } from 'zod';

export const ModeSchema = z.enum(['free', 'grounded', 'targeted']);
export type Mode = z.infer<typeof ModeSchema>;

export const TargetKindSchema = z.enum(['web', 'cli', 'api', 'desktop']);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export const SeveritySchema = z.enum(['blocker', 'major', 'minor', 'nit', 'suggestion']);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum(['bug', 'a11y', 'ux', 'perf', 'copy', 'suggestion']);
export type Category = z.infer<typeof CategorySchema>;

export const EngineSchema = z.enum(['dom', 'vision', 'hybrid']);
export type Engine = z.infer<typeof EngineSchema>;

export const TargetSchema = z.object({
  kind: TargetKindSchema,
  value: z.string().min(1),
});
export type Target = z.infer<typeof TargetSchema>;

export const RunConfigSchema = z.object({
  verb: z.enum(['eval', 'judge', 'report']),
  target: TargetSchema,
  mode: ModeSchema,
  spec_path: z.string().optional(),
  tasks: z.array(z.string()).optional(),
  rubrics: z.array(z.string()).optional(),
  focus: z.array(z.string()).optional(),
  out_dir: z.string().min(1),
  max_steps: z.number().int().nonnegative(),
  max_cost_usd: z.number().nonnegative(),
  timeout_s: z.number().int().positive(),
  explore_budget: z.number().min(0).max(1).optional(),
  explorer_model: z.string().min(1),
  judge_model: z.string().min(1),
  engine: EngineSchema,
  auth_path: z.string().optional(),
  viewport: z.string().optional(),
  user_agent: z.string().optional(),
  threshold: z.number().optional(),
  no_html: z.boolean(),
  no_clips: z.boolean(),
  print_summary: z.boolean(),
  verbose: z.boolean(),
  json_logs: z.boolean(),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;
