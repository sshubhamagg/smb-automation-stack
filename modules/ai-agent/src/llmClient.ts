import { Config } from './config';
import { Prompt } from './promptBuilder';

export type LLMResult =
  | { success: true; rawResponse: string }
  | { success: false; error: { code: string; message: string } };

function buildAnthropicRequest(prompt: Prompt, config: Config): { url: string; init: RequestInit } {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      }),
    },
  };
}

function buildOpenAIRequest(prompt: Prompt, config: Config): { url: string; init: RequestInit } {
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
    },
  };
}

function extractRawResponse(provider: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  if (provider === 'anthropic') {
    const content = (d.content as Array<{ type: string; text: string }>)?.[0];
    return content?.text ?? '';
  }
  const choices = d.choices as Array<{ message: { content: string } }>;
  return choices?.[0]?.message?.content ?? '';
}

async function attempt(prompt: Prompt, config: Config): Promise<LLMResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.llmTimeoutMs);

  try {
    const { url, init } =
      config.llmProvider === 'anthropic'
        ? buildAnthropicRequest(prompt, config)
        : buildOpenAIRequest(prompt, config);

    const response = await fetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      return {
        success: false,
        error: { code: 'LLM_ERROR', message: `LLM API returned HTTP ${response.status}` },
      };
    }

    const data = (await response.json()) as unknown;
    const rawResponse = extractRawResponse(config.llmProvider, data);
    if (!rawResponse || rawResponse.trim() === '') {
      return {
        success: false,
        error: { code: 'LLM_ERROR', message: 'LLM returned empty response' },
      };
    }
    return { success: true, rawResponse };
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e.name === 'AbortError') {
      return { success: false, error: { code: 'LLM_ERROR', message: 'LLM call timed out' } };
    }
    throw err; // network-level error — rethrow for retry
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callLLM(prompt: Prompt, config: Config): Promise<LLMResult> {
  try {
    return await attempt(prompt, config);
  } catch {
    // Network-level failure: retry once
    try {
      return await attempt(prompt, config);
    } catch (err: unknown) {
      const e = err as { message?: string };
      return {
        success: false,
        error: { code: 'LLM_ERROR', message: e.message ?? 'LLM network error after retry' },
      };
    }
  }
}
