import type { ExecutionContext, FlowStep, Modules, StepResult } from './types';

export async function executeStep(
  step: FlowStep,
  context: ExecutionContext,
  modules: Modules,
): Promise<{ result: StepResult; output: unknown }> {
  const rawInput = step.input ? step.input(context) : {};

  const executor = modules[step.type];
  if (!executor) {
    return {
      result: { id: step.id, status: 'failed', error: `No module provided for step type: ${step.type}` },
      output: undefined,
    };
  }

  try {
    const res = await executor(rawInput);
    if (!res.ok) {
      return { result: { id: step.id, status: 'failed', error: res.error }, output: undefined };
    }
    return { result: { id: step.id, status: 'ok', output: res.output }, output: res.output };
  } catch (err) {
    return {
      result: {
        id: step.id,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      },
      output: undefined,
    };
  }
}
