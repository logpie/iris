// Phase 9: declared interaction surface per adapter. The kit makes explicit
// what user-action primitives an adapter can perform. Published into the
// trace at run start (interaction_kit event) so the Judge sees what was
// possible and the goal-claim validator can flag goals that needed a
// primitive the adapter cannot perform.
//
// Same shape across web/CLI/API. Modality-specific specifics live in
// `user_action` strings the adapter chooses (e.g. "drag", "key-chord",
// "stdin-write", "signal-SIGTERM", "http-multipart-upload").

import { z } from 'zod';
import { TargetKindSchema } from '../types.js';

export const InteractionPrimitiveSchema = z.object({
  name: z.string().min(1),
  user_action: z.string().min(1),
  coverage_note: z.string().optional(),
});
export type InteractionPrimitive = z.infer<typeof InteractionPrimitiveSchema>;

export const InteractionKitSchema = z.object({
  kind: TargetKindSchema,
  primitives: z.array(InteractionPrimitiveSchema),
});
export type InteractionKit = z.infer<typeof InteractionKitSchema>;
