import Anthropic from '@anthropic-ai/sdk';
import type { AIAdapter, Prompt } from '../types';

export class AnthropicAdapter implements AIAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async execute(prompt: Prompt, options?: { model?: string }): Promise<string> {
    const model = options?.model ?? 'claude-haiku-4-5-20251001';

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt.user },
    ];

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model,
        max_tokens: 1024,
        system: prompt.system,
        messages,
      });
    } catch (err) {
      throw new Error(
        `Anthropic API error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const block = response.content[0];
    if (!block || block.type !== 'text') {
      throw new Error('Anthropic response missing text content');
    }

    return block.text;
  }
}
