jest.mock('@anthropic-ai/sdk');

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../src/adapters/anthropic';
import type { Prompt } from '../src/types';

const MockAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

const PROMPT: Prompt = {
  system: 'You are a helpful assistant. Respond with valid JSON.',
  user: 'Classify this text: "The machine is broken"',
};

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate = jest.fn();
    MockAnthropic.mockImplementation(() => ({
      messages: { create: mockCreate },
    }) as unknown as Anthropic);

    adapter = new AnthropicAdapter('test-api-key');
  });

  it('returns raw text content from a successful API call', async () => {
    const expectedText = '{"label":"maintenance","confidence":0.95}';
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: expectedText }],
    });

    const result = await adapter.execute(PROMPT);

    expect(result).toBe(expectedText);
  });

  it('calls messages.create with correct model, system, and user message', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
    });

    await adapter.execute(PROMPT);

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: PROMPT.system,
      messages: [{ role: 'user', content: PROMPT.user }],
    });
  });

  it('uses custom model when provided in options', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
    });

    await adapter.execute(PROMPT, { model: 'claude-sonnet-4-6' });

    const call = mockCreate.mock.calls[0][0] as { model: string };
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('throws a structured error when the API rejects', async () => {
    mockCreate.mockRejectedValueOnce(new Error('rate limit exceeded'));

    await expect(adapter.execute(PROMPT)).rejects.toThrow(
      'Anthropic API error: rate limit exceeded',
    );
  });

  it('throws when response content block is missing', async () => {
    mockCreate.mockResolvedValueOnce({ content: [] });

    await expect(adapter.execute(PROMPT)).rejects.toThrow(
      'Anthropic response missing text content',
    );
  });

  it('throws when content block type is not text', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 'x', name: 'tool', input: {} }],
    });

    await expect(adapter.execute(PROMPT)).rejects.toThrow(
      'Anthropic response missing text content',
    );
  });
});
