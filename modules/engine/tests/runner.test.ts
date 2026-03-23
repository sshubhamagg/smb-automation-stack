import { runFlow } from '../src/runner';
import type { Flow, ExecutionContext, Modules } from '../src/types';

// Helpers — build mock executor functions
function mockOk(output: unknown) {
  return jest.fn().mockResolvedValue({ ok: true, output });
}

function mockFail(error: string) {
  return jest.fn().mockResolvedValue({ ok: false, error });
}

function mockThrow(message: string) {
  return jest.fn().mockRejectedValue(new Error(message));
}

describe('runFlow()', () => {
  it('executes steps sequentially and accumulates outputs', async () => {
    const storedRows = [['Alice', '100']];
    const classification = { label: 'urgent', confidence: 0.9 };

    const storageExecutor = mockOk(storedRows);
    const aiExecutor = mockOk(classification);

    const modules: Modules = {
      storage: storageExecutor,
      intelligence: aiExecutor,
    };

    const flow: Flow = {
      id: 'test-flow',
      steps: [
        {
          id: 'fetch-data',
          type: 'storage',
          input: () => ({ provider: 'sheets', operation: 'read', resource: 'sheet1' }),
        },
        {
          id: 'classify',
          type: 'intelligence',
          input: (ctx) => ({
            provider: 'openai',
            task: 'classification',
            input: { text: JSON.stringify(ctx.outputs?.['fetch-data']) },
          }),
        },
      ],
    };

    const result = await runFlow(flow, {}, modules);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.outputs?.['fetch-data']).toEqual(storedRows);
      expect(result.context.outputs?.['classify']).toEqual(classification);
      expect(result.steps).toEqual([
        { id: 'fetch-data', status: 'ok', output: storedRows },
        { id: 'classify', status: 'ok', output: classification },
      ]);
    }

    expect(storageExecutor).toHaveBeenCalledTimes(1);
    expect(aiExecutor).toHaveBeenCalledTimes(1);

    // Second step received the output of the first step
    const aiCallArg = aiExecutor.mock.calls[0][0] as any;
    expect(aiCallArg.input.text).toBe(JSON.stringify(storedRows));
  });

  it('skips steps whose condition evaluates to false', async () => {
    const storageExecutor = mockOk([]);
    const commExecutor = jest.fn();

    const modules: Modules = {
      storage: storageExecutor,
      communication: commExecutor,
    };

    const flow: Flow = {
      id: 'conditional-flow',
      steps: [
        {
          id: 'fetch',
          type: 'storage',
          input: () => ({ provider: 'sheets', operation: 'read', resource: 'sheet1' }),
        },
        {
          id: 'notify',
          type: 'communication',
          condition: (ctx) => Array.isArray(ctx.outputs?.['fetch']) && (ctx.outputs!['fetch'] as unknown[]).length > 0,
          input: () => ({ to: '+1234567890', message: 'Report ready' }),
        },
      ],
    };

    const result = await runFlow(flow, {}, modules);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps[0]).toMatchObject({ id: 'fetch', status: 'ok' });
      expect(result.steps[1]).toEqual({ id: 'notify', status: 'skipped' });
    }

    expect(commExecutor).not.toHaveBeenCalled();
  });

  it('stops the flow on first failed step and returns ok:false', async () => {
    const storageExecutor = mockFail('Sheet not found');
    const aiExecutor = jest.fn();

    const modules: Modules = {
      storage: storageExecutor,
      intelligence: aiExecutor,
    };

    const flow: Flow = {
      id: 'failing-flow',
      steps: [
        {
          id: 'fetch',
          type: 'storage',
          input: () => ({ provider: 'sheets', operation: 'read', resource: 'missing-sheet' }),
        },
        {
          id: 'classify',
          type: 'intelligence',
          input: (ctx) => ({
            provider: 'openai',
            task: 'classification',
            input: { text: String(ctx.outputs?.['fetch']) },
          }),
        },
      ],
    };

    const result = await runFlow(flow, {}, modules);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('fetch');
      expect(result.error).toBe('Sheet not found');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({ id: 'fetch', status: 'failed' });
    }

    expect(aiExecutor).not.toHaveBeenCalled();
  });

  it('captures executor exceptions as failed steps', async () => {
    const modules: Modules = {
      intelligence: mockThrow('OpenAI unreachable'),
    };

    const flow: Flow = {
      id: 'exception-flow',
      steps: [
        {
          id: 'infer',
          type: 'intelligence',
          input: () => ({ provider: 'openai', task: 'qa', input: { text: 'data' }, options: { question: 'What?' } }),
        },
      ],
    };

    const result = await runFlow(flow, {}, modules);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('infer');
      expect(result.error).toBe('OpenAI unreachable');
    }
  });

  it('returns failed step when module is not provided for step type', async () => {
    const modules: Modules = {}; // no storage module

    const flow: Flow = {
      id: 'missing-module-flow',
      steps: [
        {
          id: 'fetch',
          type: 'storage',
          input: () => ({ provider: 'sheets', operation: 'read', resource: 'sheet1' }),
        },
      ],
    };

    const result = await runFlow(flow, {}, modules);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('fetch');
      expect(result.error).toContain('No module provided');
    }
  });

  it('passes initial context state to the first step', async () => {
    const commExecutor = mockOk(null);

    const modules: Modules = { communication: commExecutor };

    const flow: Flow = {
      id: 'initial-ctx-flow',
      steps: [
        {
          id: 'send',
          type: 'communication',
          input: (ctx) => ({ to: ctx.state?.phone as string, message: ctx.state?.body as string }),
        },
      ],
    };

    const initial: ExecutionContext = { state: { phone: '+9999999999', body: 'Hello' } };
    const result = await runFlow(flow, initial, modules);

    expect(result.ok).toBe(true);
    expect(commExecutor).toHaveBeenCalledWith({ to: '+9999999999', message: 'Hello' });
  });
});
