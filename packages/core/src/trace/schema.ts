import { z } from 'zod';
import { TargetKindSchema } from '../types.js';

export const TraceEventKindSchema = z.enum([
  'run_start',
  'spec_interpreted',
  'step_plan',
  'action',
  'action_result',
  'observation',
  'probe_call',
  'probe_result',
  'evidence',
  'tentative_finding',
  'hypothesis',
  'surface_seen',
  'surface_unexplored',
  'step_done',
  'goal_status',
  'preflight',
  'retry_attempt',
  'give_up',
  'done',
  'budget_warn',
  'budget_abort',
  'run_end',
]);
export type TraceEventKind = z.infer<typeof TraceEventKindSchema>;

export const ActorSchema = z.enum(['explorer', 'adapter', 'probe', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

export const TraceEventSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.number(),
  step: z.number().int().nonnegative(),
  target_kind: TargetKindSchema,
  kind: TraceEventKindSchema,
  actor: ActorSchema,
  payload: z.record(z.unknown()),
  content_hash: z.string().optional(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;
