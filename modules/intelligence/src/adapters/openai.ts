import type { AIAdapter, Prompt } from '../types';

export class OpenAIAdapter implements AIAdapter {
  constructor(private readonly apiKey: string) {}

  async execute(prompt: Prompt, options?: any): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI response missing content');
    }

    return content;
  }
}
