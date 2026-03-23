import { run } from '../src/pipeline';
import { registerAdapter, registerTask } from '../src/registry';
import type { AIAdapter, TaskHandler, Prompt, AIInput, TaskValidationResult } from '../src/types';

// Mock registry so tests control registrations without side effects
jest.mock('../src/registry', () => ({
  getAdapter: jest.fn(),
  getTask: jest.fn(),
  registerAdapter: jest.fn(),
  registerTask: jest.fn(),
}));

// Mock internal parser
jest.mock('../src/utils/parser', () => ({
  parse: jest.fn(),
}));

import { getAdapter, getTask } from '../src/registry';
import { parse } from '../src/utils/parser';

const mockGetAdapter = getAdapter as jest.MockedFunction<typeof getAdapter>;
const mockGetTask = getTask as jest.MockedFunction<typeof getTask>;
const mockParse = parse as jest.MockedFunction<typeof parse>;

function makeAdapter(callResult: () => Promise<string>): AIAdapter {
  return { execute: jest.fn().mockImplementation(callResult) };
}

function makeHandler(
  promptResult: Partial<Prompt>,
  validateResult: TaskValidationResult
): TaskHandler {
  return {
    buildPrompt: jest.fn().mockReturnValue({ system: 'sys', user: 'usr', ...promptResult }),
    validate: jest.fn().mockReturnValue(validateResult),
  };
}

const BASE_INPUT: AIInput = {
  provider: 'openai',
  task: 'classification',
  input: { text: 'some text' },
};

describe('AI Pipeline — run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns unknown_task when task is not registered', async () => {
    mockGetTask.mockImplementation(() => { throw new Error('No handler'); });

    const result = await run(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_task');
  });

  it('returns unknown_provider when provider is not registered', async () => {
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output: {} }));
    mockGetAdapter.mockImplementation(() => { throw new Error('No adapter'); });

    const result = await run(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_provider');
  });

  it('returns provider_error when adapter.execute throws', async () => {
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output: {} }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.reject(new Error('API failure'))));

    const result = await run(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('provider_error');
      expect(result.error).toBe('API failure');
    }
  });

  it('returns parse_error when LLM returns invalid JSON', async () => {
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output: {} }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.resolve('not json at all')));
    mockParse.mockReturnValue({ success: false, error: { code: 'LLM_ERROR', message: 'LLM response could not be parsed as valid JSON' } });

    const result = await run(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse_error');
  });

  it('returns validation_error when output fails task validation', async () => {
    mockGetTask.mockReturnValue(makeHandler({}, { valid: false, error: 'Missing label' }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.resolve('{"label":""}')));
    mockParse.mockReturnValue({ success: true, parsed: { label: '' } });

    const result = await run(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('validation_error');
      expect(result.error).toBe('Missing label');
    }
  });

  it('returns ok result for classification', async () => {
    const output = { label: 'spam', confidence: 0.95, reasoning: 'contains spam keywords' };
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.resolve(JSON.stringify(output))));
    mockParse.mockReturnValue({ success: true, parsed: output });

    const result = await run({ ...BASE_INPUT, task: 'classification' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toBe('classification');
      expect(result.output).toEqual(output);
    }
  });

  it('returns ok result for extraction', async () => {
    const output = { fields: { name: 'John', email: 'john@example.com' } };
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.resolve(JSON.stringify({ name: 'John', email: 'john@example.com' }))));
    mockParse.mockReturnValue({ success: true, parsed: { name: 'John', email: 'john@example.com' } });

    const result = await run({ ...BASE_INPUT, task: 'extraction' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toBe('extraction');
      expect(result.output).toEqual(output);
    }
  });

  it('returns ok result for qa', async () => {
    const output = { answer: 'Paris', confidence: 0.99 };
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.resolve(JSON.stringify(output))));
    mockParse.mockReturnValue({ success: true, parsed: output });

    const result = await run({ ...BASE_INPUT, task: 'qa', options: { question: 'What is the capital?' } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toBe('qa');
      expect(result.output).toEqual(output);
    }
  });

  it('returns ok result for reasoning', async () => {
    const output = { conclusion: 'Growth is positive', steps: ['Step 1', 'Step 2'], confidence: 0.85 };
    mockGetTask.mockReturnValue(makeHandler({}, { valid: true, output }));
    mockGetAdapter.mockReturnValue(makeAdapter(() => Promise.resolve(JSON.stringify(output))));
    mockParse.mockReturnValue({ success: true, parsed: output });

    const result = await run({ ...BASE_INPUT, task: 'reasoning' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toBe('reasoning');
      expect(result.output).toEqual(output);
    }
  });
});
