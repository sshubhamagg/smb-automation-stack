import { callLLM } from '../src/llmClient';
import { Prompt } from '../src/promptBuilder';

const prompt: Prompt = { system: 'You are helpful.', user: 'Analyze this.' };

const config = {
  llmApiKey: 'test-key',
  llmProvider: 'anthropic',
  llmTimeoutMs: 5000,
  logLevel: 'silent',
};

const anthropicSuccessBody = {
  content: [{ type: 'text', text: '{"answer":"Steel","rows":[],"confidence":"high","status":"ok"}' }],
};

const openaiSuccessBody = {
  choices: [{ message: { content: '{"answer":"Steel","rows":[],"confidence":"high","status":"ok"}' } }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('callLLM — Anthropic provider', () => {
  it('returns success with rawResponse on 200', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => anthropicSuccessBody,
    } as Response);

    const result = await callLLM(prompt, config);
    expect(result.success).toBe(true);
    if (result.success) expect(result.rawResponse).toContain('Steel');
  });

  it('returns LLM_ERROR on non-200 response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
    } as Response);

    const result = await callLLM(prompt, config);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });
});

describe('callLLM — OpenAI provider', () => {
  it('returns success with rawResponse on 200', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => openaiSuccessBody,
    } as Response);

    const result = await callLLM(prompt, { ...config, llmProvider: 'openai' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.rawResponse).toContain('Steel');
  });
});

describe('callLLM — timeout', () => {
  it('returns LLM_ERROR when AbortError is thrown', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    global.fetch = jest.fn().mockRejectedValueOnce(abortError);

    const result = await callLLM(prompt, { ...config, llmTimeoutMs: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('LLM_ERROR');
      expect(result.error.message).toContain('timed out');
    }
  });
});

describe('callLLM — network error retry', () => {
  it('retries once on network error and returns success', async () => {
    const networkError = new Error('ECONNREFUSED');

    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => anthropicSuccessBody,
      } as Response);

    const result = await callLLM(prompt, config);
    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns LLM_ERROR after both attempts fail', async () => {
    const networkError = new Error('ECONNREFUSED');

    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError);

    const result = await callLLM(prompt, config);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-200 HTTP response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    await callLLM(prompt, config);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
