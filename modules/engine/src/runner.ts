import { executeStep } from './stepExecutor';
import type { ExecutionContext, ExecutionResult, Flow, Modules, StepResult } from './types';

export async function runFlow(
  flow: Flow,
  initialContext: ExecutionContext,
  modules: Modules,
): Promise<ExecutionResult> {
  const context: ExecutionContext = { ...initialContext };
  const steps: StepResult[] = [];

  for (const step of flow.steps) {
    // Evaluate condition — false means skip, not fail
    if (step.condition !== undefined && !step.condition(context)) {
      steps.push({ id: step.id, status: 'skipped' });
      continue;
    }

    const { result, output } = await executeStep(step, context, modules);
    steps.push(result);

    // Fail-fast: stop the flow and surface the error
    if (result.status === 'failed') {
      return { ok: false, failedStep: step.id, error: result.error, context, steps };
    }

    // Propagate output into unified outputs map, keyed by step id
    context.outputs ??= {};
    context.outputs[step.id] = output;
  }

  return { ok: true, context, steps };
}
