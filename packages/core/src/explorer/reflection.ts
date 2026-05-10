import type { Mode } from '../types.js';

export interface ReflectionContext {
  step: number;
  mode: Mode;
  last_reflection_step: number | null;
  spec_goals_satisfied: boolean;
  cadence?: number;
}

export function shouldReflect(ctx: ReflectionContext): boolean {
  const cadence = ctx.cadence ?? 10;
  if (ctx.mode === 'targeted') return false;
  if (ctx.mode === 'grounded' && !ctx.spec_goals_satisfied) return false;
  if (ctx.step === 0) return false;
  if (ctx.step % cadence !== 0) return false;
  if (ctx.last_reflection_step === ctx.step) return false;
  return true;
}

export function buildReflectionPrompt(state: {
  surfaces_seen: number;
  surfaces_unexplored: number;
  hypotheses_count: number;
  weirdness_attempted: string[];
}): string {
  return `Pause exploration. Look at your site map and plan stack. Answer:
(a) What do you now believe this product is, and who is it for? (revise hypotheses if needed — you have ${state.hypotheses_count} so far)
(b) What surfaces have you not explored that look interesting? (currently ${state.surfaces_seen} seen, ${state.surfaces_unexplored} unexplored)
(c) Are you going broad enough, or stuck deep in one flow?
(d) What weirdness have you not tried yet on what you have explored? (so far attempted: ${state.weirdness_attempted.join(', ') || 'none'})
Then push the most valuable next 1-3 items onto your plan stack and continue.`;
}
