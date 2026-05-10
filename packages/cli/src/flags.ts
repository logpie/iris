import { type Mode, ModeSchema } from '@iris/core';

export interface EvalInputs {
  spec_path?: string;
  tasks?: string[];
  tasks_path?: string;
  explicit_mode?: string;
}

export function inferMode(inputs: EvalInputs): Mode {
  if (inputs.explicit_mode !== undefined) {
    return ModeSchema.parse(inputs.explicit_mode);
  }
  if ((inputs.tasks && inputs.tasks.length > 0) || inputs.tasks_path) return 'targeted';
  if (inputs.spec_path) return 'grounded';
  return 'free';
}
