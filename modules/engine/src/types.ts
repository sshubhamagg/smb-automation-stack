import type { ModuleResult } from 'shared-types';

/** A single module's execute function, normalised to a common signature. */
export type ModuleExecutor = (input: unknown) => Promise<ModuleResult<unknown>>;

/** Map of module executors passed into runFlow. Only include what the flow uses. */
export type Modules = Partial<Record<'intelligence' | 'storage' | 'communication', ModuleExecutor>>;

export type ExecutionContext = {
  event?: any;
  outputs?: Record<string, unknown>;  // keyed by step id, regardless of step type
  state?: Record<string, any>;
};

export type StepResult =
  | { id: string; status: 'ok'; output: unknown }
  | { id: string; status: 'skipped' }
  | { id: string; status: 'failed'; error: string };

export type FlowStep = {
  id: string;
  type: 'intelligence' | 'storage' | 'communication';
  input?: (context: ExecutionContext) => unknown;    // optional — defaults to {} if omitted
  condition?: (context: ExecutionContext) => boolean; // if returns false, step is skipped
};

export type Flow = {
  id: string;
  steps: FlowStep[];
};

export type ExecutionResult =
  | { ok: true; context: ExecutionContext; steps: StepResult[] }
  | { ok: false; failedStep: string; error: string; context: ExecutionContext; steps: StepResult[] };
