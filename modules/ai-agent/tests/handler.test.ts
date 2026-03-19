import { handle } from '../src/handler';

jest.mock('../src/llmClient', () => ({
  callLLM: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  log: jest.fn(),
}));

jest.mock('../src/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    llmApiKey: 'test-key',
    llmProvider: 'anthropic',
    llmTimeoutMs: 5000,
    logLevel: 'silent',
  }),
}));

import * as llmClient from '../src/llmClient';
import * as logger from '../src/logger';

const mockCallLLM = llmClient.callLLM as jest.MockedFunction<typeof llmClient.callLLM>;
const mockLog = logger.log as jest.MockedFunction<typeof logger.log>;

const validInput = {
  data: [
    { product: 'cement', stock: '50' },
    { product: 'steel', stock: '20' },
  ],
  question: 'Which product has the lowest stock?',
};

const validLLMRaw = JSON.stringify({
  answer: 'Steel has the lowest stock with a value of 20.',
  rows: [{ product: 'steel', stock: '20' }],
  confidence: 'high',
  status: 'ok',
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Success flow ──────────────────────────────────────────────────────────────

describe('handle — success', () => {
  it('returns success response for valid input and LLM response', async () => {
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: validLLMRaw });

    const result = await handle(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.answer).toBe('Steel has the lowest stock with a value of 20.');
      expect(result.data.rows).toEqual([{ product: 'steel', stock: '20' }]);
      expect(result.data.confidence).toBe('high');
    }
  });

  it('calls logger once on success', async () => {
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: validLLMRaw });

    await handle(validInput);
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'analyze', status: 'success' })
    );
  });

  it('handles empty rows in success response', async () => {
    const raw = JSON.stringify({
      answer: 'No products are out of stock.',
      rows: [],
      confidence: 'high',
      status: 'ok',
    });
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rows).toEqual([]);
  });
});

// ── Validation failure ────────────────────────────────────────────────────────

describe('handle — validation failure', () => {
  it('returns INVALID_INPUT when data is missing', async () => {
    const result = await handle({ question: 'q' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('returns INVALID_INPUT when question is empty', async () => {
    const result = await handle({ data: [{ a: 'b' }], question: '' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('calls logger once on validation failure', async () => {
    await handle({ question: 'q' });
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorCode: 'INVALID_INPUT' })
    );
  });
});

// ── LLM failure ───────────────────────────────────────────────────────────────

describe('handle — LLM failure', () => {
  it('returns LLM_ERROR when LLM call fails', async () => {
    mockCallLLM.mockResolvedValueOnce({
      success: false,
      error: { code: 'LLM_ERROR', message: 'Timeout' },
    });

    const result = await handle(validInput);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });
});

// ── Parse failure ─────────────────────────────────────────────────────────────

describe('handle — parse failure', () => {
  it('returns LLM_ERROR when LLM returns invalid JSON', async () => {
    mockCallLLM.mockResolvedValueOnce({
      success: true,
      rawResponse: 'The answer is definitely steel. Not JSON.',
    });

    const result = await handle(validInput);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });
});

// ── Post-validation failures ──────────────────────────────────────────────────

describe('handle — post-validation failure', () => {
  it('returns LLM_ERROR when required field missing from LLM response', async () => {
    const raw = JSON.stringify({ answer: 'Steel', rows: [], confidence: 'high' }); // missing status
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns LLM_ERROR when LLM returns hallucinated row', async () => {
    const raw = JSON.stringify({
      answer: 'Iron has low stock.',
      rows: [{ product: 'iron', stock: '5' }],
      confidence: 'high',
      status: 'ok',
    });
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns INSUFFICIENT_DATA when LLM signals insufficient_data', async () => {
    const raw = JSON.stringify({
      answer: '',
      rows: [],
      confidence: 'low',
      status: 'insufficient_data',
    });
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INSUFFICIENT_DATA');
  });

  it('returns AMBIGUOUS_QUESTION when LLM signals ambiguous', async () => {
    const raw = JSON.stringify({
      answer: '',
      rows: [],
      confidence: 'low',
      status: 'ambiguous',
    });
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('AMBIGUOUS_QUESTION');
  });
});

// ── Parser handles fenced JSON ────────────────────────────────────────────────

describe('handle — parser extraction', () => {
  it('succeeds when LLM wraps response in markdown fences', async () => {
    const raw = '```json\n' + validLLMRaw + '\n```';
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(true);
  });

  it('succeeds when LLM response has surrounding text', async () => {
    const raw = 'Here is my analysis:\n' + validLLMRaw + '\nEnd of analysis.';
    mockCallLLM.mockResolvedValueOnce({ success: true, rawResponse: raw });

    const result = await handle(validInput);
    expect(result.success).toBe(true);
  });
});
